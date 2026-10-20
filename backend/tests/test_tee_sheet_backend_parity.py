"""티 시트 API 를 json / supabase 두 저장 엔진에서 똑같이 돌려 보는 동등성 테스트.

실행: `cd E:\\PELHAMHILLS && python -m pytest backend/tests/test_tee_sheet_backend_parity.py -q`

- `backend_env` 픽스처가 엔진별로 한 번씩 돈다. supabase 는 `fake_postgrest.install()`
  의 인메모리 PostgREST 이고, 실제 네트워크로는 한 건도 나가지 않는다.
- 결과가 결정적인 흐름은 `test_crud_transcript_is_identical_across_backends` 가 한 테스트
  안에서 두 엔진을 차례로 돌려 정규화한 응답을 **그대로** 비교한다.
- ⚠️ 실패 메시지에 예약 내용을 싣지 않는다 (id·상태·건수만). 정리 작업 결과에는
  예약 제목이 들어 있다.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterator

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.routes import tee_sheet as module
from backend.services import tee_sheet_store as store
from backend.services import tee_sheet_supabase as sb
from backend.tests.fake_postgrest import FakePostgrest, install

API = "/api/v1"
BACKENDS = ("json", "supabase")
SEED_DATE = "2026-09-08"
SEED_COUNT = 11


@dataclass
class Env:
    kind: str
    client: TestClient
    fake: FakePostgrest | None
    data_file: Path


@contextmanager
def open_backend(kind: str, mp: pytest.MonkeyPatch, data_dir: Path) -> Iterator[Env]:
    data_file = data_dir / "tee_sheet.json"
    # supabase 모드에서도 데이터 파일을 tmp 로 돌린다. 어떤 경로가 엔진 판정을 놓쳐
    # json 쪽으로 떨어져도 실제 backend/data/tee_sheet.json 을 시드로 덮어쓰지 않게.
    mp.setenv(store.ENV_VAR, str(data_file))
    mp.setenv(store.BACKEND_ENV_VAR, "json")
    store._cache = None
    store._cache_path = None
    with module._task_lock:
        module._tasks.clear()

    fake = install(mp) if kind == "supabase" else None
    store.reset()

    app = FastAPI()
    app.include_router(module.router, prefix=API)
    try:
        with TestClient(app) as client:
            yield Env(kind, client, fake, data_file)
    finally:
        store._cache = None
        store._cache_path = None


@pytest.fixture(params=BACKENDS)
def backend_env(request, tmp_path, monkeypatch) -> Iterator[Env]:
    with open_backend(request.param, monkeypatch, tmp_path) as env:
        yield env
        if env.fake is not None:
            assert not env.data_file.exists(), "supabase mode must never touch the JSON file"


# ===== 헬퍼 ===========================================================


def wait_for_tasks(client: TestClient, task_ids: list[str], timeout: float = 15.0) -> dict[str, dict]:
    deadline = time.time() + timeout
    last: dict[str, dict] = {}
    while time.time() < deadline:
        status = client.get(f"{API}/tee-sheet/orchestration/status").json()
        last = {t["id"]: t for t in status["tasks"]}
        if all(last.get(tid, {}).get("state") in ("success", "failed") for tid in task_ids):
            return last
        time.sleep(0.05)
    # 작업 dict 를 통째로 찍지 않는다. cleanup 결과에는 예약 제목(= 이름)이 있다.
    states = {tid: last.get(tid, {}).get("state") for tid in task_ids}
    raise AssertionError(f"tasks did not reach a terminal state: {states}")


def run_task(client: TestClient, path: str, **params: str) -> dict:
    ack = client.post(f"{API}/tee-sheet/{path}", params=params)
    assert ack.status_code == 200, ack.status_code
    task_id = ack.json()["tasks"][0]["id"]
    task = wait_for_tasks(client, [task_id])[task_id]
    assert task["state"] == "success", task["state"]
    return task["result"]


def posted_rows(fake: FakePostgrest, since: int) -> list[dict]:
    """`since` 번째 요청 이후 POST 로 보낸 행들."""
    rows: list[dict] = []
    for request in fake.raw_requests[since:]:
        if request.method == "POST":
            rows.extend(json.loads(request.content))
    return rows


def write_count(fake: FakePostgrest) -> int:
    return sum(1 for method, _, _ in fake.requests if method in ("POST", "DELETE", "PATCH"))


_VOLATILE = {"createdAt", "updatedAt", "ts", "timestamp"}
# 서버가 찍는 시각이지만 "찍혔는가 / 비었는가" 는 두 엔진이 같아야 한다 — 값만 자리표시자로 바꾼다.
_STAMPED = {"paidAt"}


def normalize(value: Any, ids: dict[str, str]) -> Any:
    """엔진과 무관하게 매번 달라지는 값(uuid·시각)을 걷어낸다.

    uuid 는 지우지 않고 **처음 등장한 순서대로** 자리표시자로 바꾼다. 그래야
    "같은 플레이어를 가리키는가" 같은 구조는 비교에 남는다. 시드 예약 id (`b-...`) 는
    결정적이라 그대로 둔다.
    """
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if key in _VOLATILE:
                continue
            if key in _STAMPED:
                out[key] = None if item is None else "<ts>"
                continue
            if key == "id" and isinstance(item, str) and not item.startswith("b-"):
                out[key] = ids.setdefault(item, f"<id{len(ids)}>")
            else:
                out[key] = normalize(item, ids)
        return out
    if isinstance(value, list):
        return [normalize(item, ids) for item in value]
    if isinstance(value, str) and value in ids:
        return ids[value]
    return value


# ===== 공통 시나리오 ===================================================
# 지어낸 이름만 쓴다. 이동 목적지는 **빈 티 타임**이다 — 같은 티 타임 안의 순서는
# json 은 쓰기 이력(안정 정렬), supabase 는 created_at 이 정해서 동률이면 갈릴 수 있다.

NEW_DATE = "2026-09-10"
NEW_TIME = "9:04 AM"
MOVED_DATE = "2026-09-11"
MOVED_TIME = "10:07 AM"


def crud_scenario(env: Env) -> list[tuple[str, int, Any]]:
    """목록 → 생성 → 조회 → 이동 → 플레이어 추가/수정/삭제 → 상태 전이 → 삭제.

    각 단계의 (이름, HTTP 상태, 본문) 을 돌려준다. supabase 모드에서는 테이블에
    실제로 무엇이 남는지도 여기서 확인한다.
    """
    client, fake = env.client, env.fake
    transcript: list[tuple[str, int, Any]] = []

    def step(name: str, response: httpx.Response, expected: int) -> Any:
        assert response.status_code == expected, (name, response.status_code)
        body = response.json() if response.content else None
        transcript.append((name, response.status_code, body))
        return body

    listed = step("list", client.get(f"{API}/tee-sheet/bookings"), 200)
    assert len(listed) == SEED_COUNT

    made = step("create", client.post(f"{API}/tee-sheet/bookings", json={
        "date": NEW_DATE, "time": NEW_TIME, "title": "Quackenbush, Zebulon", "cartCount": 1,
        "players": [{"firstName": "Zebulon", "lastName": "Quackenbush"}, {"name": "Guest"}],
    }), 201)
    booking_id = made["id"]
    if fake is not None:
        row = fake.rows[booking_id]
        assert (row["booking_date"], row["tee_time"], row["status"]) == (NEW_DATE, NEW_TIME, "reserved")
        assert row["doc"]["id"] == booking_id

    step("get", client.get(f"{API}/tee-sheet/bookings/{booking_id}"), 200)
    step("list-by-date", client.get(f"{API}/tee-sheet/bookings", params={"date": NEW_DATE}), 200)

    step("move", client.patch(f"{API}/tee-sheet/bookings/{booking_id}", json={
        "date": MOVED_DATE, "time": MOVED_TIME, "notes": "Moved by phone.", "cartCount": 2,
    }), 200)
    if fake is not None:
        # 파생 컬럼도 doc 과 함께 옮겨졌는가 (날짜별 조회 인덱스가 이것을 쓴다).
        row = fake.rows[booking_id]
        assert (row["booking_date"], row["tee_time"]) == (MOVED_DATE, MOVED_TIME)
    step("old-date-empty", client.get(f"{API}/tee-sheet/bookings", params={"date": NEW_DATE}), 200)

    added = step("add-player", client.post(f"{API}/tee-sheet/bookings/{booking_id}/players", json={
        "firstName": "Philippa", "lastName": "Oddbody", "type": "Existing Customer",
    }), 200)
    new_player = added["players"][-1]["id"]
    step("patch-player", client.patch(
        f"{API}/tee-sheet/bookings/{booking_id}/players/{new_player}",
        json={"lastName": "Oddbody-Smythe", "paid": True},
    ), 200)
    step("remove-player", client.delete(
        f"{API}/tee-sheet/bookings/{booking_id}/players/{new_player}"), 200)

    for status in ("checked_in", "paid", "cancelled", "reserved"):
        payload: dict[str, Any] = {"status": status}
        if status == "cancelled":
            payload["cancelReason"] = "Weather."
        step(f"status-{status}", client.patch(f"{API}/tee-sheet/bookings/{booking_id}", json=payload), 200)
    if fake is not None:
        assert fake.rows[booking_id]["status"] == "reserved"

    # 꽉 찬 티 타임(6:58 AM, 4명)에 한 명 더 → 409. mutate 블록이 예외로 끝났으니
    # 저장소에는 아무것도 쓰이지 않아야 한다.
    writes_before = write_count(fake) if fake is not None else None
    file_before = env.data_file.read_bytes() if fake is None else None
    step("full-tee-time", client.post(f"{API}/tee-sheet/bookings", json={
        "date": SEED_DATE, "time": "6:58 AM", "title": "Wobblesworth, Octavius",
        # 6:58 AM 은 4명. 직원 시트 한계 8명을 넘기려면 5명이 필요하다.
        "players": [{"name": f"Octavius Wobblesworth{i}"} for i in range(5)],
    }), 409)
    if fake is not None:
        assert write_count(fake) == writes_before
    else:
        assert env.data_file.read_bytes() == file_before

    step("daily-report", client.get(f"{API}/tee-sheet/reports/daily", params={"date": SEED_DATE}), 200)
    step("week-report", client.get(
        f"{API}/tee-sheet/reports/week", params={"from": SEED_DATE, "to": MOVED_DATE}), 200)

    step("delete", client.delete(f"{API}/tee-sheet/bookings/{booking_id}"), 204)
    step("get-deleted", client.get(f"{API}/tee-sheet/bookings/{booking_id}"), 404)
    if fake is not None:
        assert booking_id not in fake.rows

    final = step("list-final", client.get(f"{API}/tee-sheet/bookings"), 200)
    assert len(final) == SEED_COUNT
    return transcript


# ===== 엔진별 (같은 단언을 두 엔진에서) ===============================


def test_crud_flow(backend_env: Env):
    transcript = crud_scenario(backend_env)
    assert [name for name, _, _ in transcript][-3:] == ["delete", "get-deleted", "list-final"]
    if backend_env.fake is not None:
        assert set(backend_env.fake.rows) == {b["id"] for b in transcript[-1][2]}


def test_crud_transcript_is_identical_across_backends(tmp_path):
    transcripts = {}
    for kind in BACKENDS:
        with pytest.MonkeyPatch.context() as mp:
            with open_backend(kind, mp, tmp_path / kind) as env:
                ids: dict[str, str] = {}
                transcripts[kind] = [
                    (name, status, normalize(body, ids)) for name, status, body in crud_scenario(env)
                ]

    json_steps, supa_steps = transcripts["json"], transcripts["supabase"]
    # 정규화가 본문을 다 걷어내면 "둘이 같다" 는 공허하다. 실질 값이 남았는지 먼저 본다.
    assert len(json_steps) == 19
    bodies = {name: body for name, _, body in json_steps}
    moved = bodies["move"]
    assert (moved["date"], moved["time"], moved["cartCount"]) == (MOVED_DATE, MOVED_TIME, 2)
    assert moved["notes"] == "Moved by phone." and len(moved["players"]) == 2
    assert moved["id"].startswith("<id")
    # 감사 로그는 최신순이다. 이동 PATCH 는 이동·카트·메모 세 줄을 남긴다.
    assert [e["message"] for e in moved["audit"][:3]] == [
        "Notes updated.", "Cart count set to 2.", f"Moved to {MOVED_DATE} {MOVED_TIME}."]
    assert [b["id"] for b in bodies["list"]][:2] == ["b-xeric", "b-dune"]
    assert bodies["daily-report"]["booked_slots"] == 32
    assert bodies["week-report"]["summary"]["total_days"] == 4

    assert [s[:2] for s in json_steps] == [s[:2] for s in supa_steps]
    # 본문을 메시지에 싣지 않고 어긋난 단계 이름만 알린다.
    differing = [a[0] for a, b in zip(json_steps, supa_steps) if a != b]
    assert differing == [], differing


def test_delete_removes_row_everywhere(backend_env: Env):
    client, fake = backend_env.client, backend_env.fake
    assert client.delete(f"{API}/tee-sheet/bookings/b-elm").status_code == 204
    assert client.get(f"{API}/tee-sheet/bookings/b-elm").status_code == 404
    assert client.delete(f"{API}/tee-sheet/bookings/b-elm").status_code == 404
    assert "b-elm" not in {b["id"] for b in store.load_bookings()}
    assert len(store.load_bookings()) == SEED_COUNT - 1
    if fake is not None:
        assert "b-elm" not in fake.rows
        assert len(fake.rows) == SEED_COUNT - 1


def test_cleanup_orchestration_removes_old_rows(backend_env: Env):
    client, fake = backend_env.client, backend_env.fake
    later = client.post(f"{API}/tee-sheet/bookings", json={
        "date": "2026-09-12", "time": "9:04 AM", "title": "Fumblewick, Henrietta",
        "players": [{"name": "Henrietta Fumblewick"}],
    })
    assert later.status_code == 201, later.status_code
    later_id = later.json()["id"]

    result = run_task(client, "orchestration/cleanup", before="2026-09-12")
    assert (result["deleted"], result["remaining"]) == (SEED_COUNT, 1)
    assert [b["id"] for b in client.get(f"{API}/tee-sheet/bookings").json()] == [later_id]
    if fake is not None:
        assert set(fake.rows) == {later_id}

    # 두 번째는 지울 게 없다. supabase 에서는 DELETE 요청도 나가지 않아야 한다.
    deletes_before = len(fake.calls("DELETE")) if fake is not None else 0
    assert run_task(client, "orchestration/cleanup", before="2026-09-12")["deleted"] == 0
    if fake is not None:
        assert len(fake.calls("DELETE")) == deletes_before


def test_worker_sync_marks_no_show_and_persists(backend_env: Env):
    client, fake = backend_env.client, backend_env.fake
    past = (date.today() - timedelta(days=400)).isoformat()
    stale = client.post(f"{API}/tee-sheet/bookings", json={
        "date": past, "time": "6:40 AM", "title": "Quackenbush, Zebulon",
        "players": [{"name": "Zebulon Quackenbush"}],
    })
    assert stale.status_code == 201, stale.status_code
    stale_id = stale.json()["id"]

    first = run_task(client, "worker/run", date=past)
    assert (first["scanned"], first["updated"]) == (1, 1)
    assert first["findings"][0]["action"] == "marked_no_show"
    booking = client.get(f"{API}/tee-sheet/bookings/{stale_id}").json()
    assert booking["status"] == "no_show" and booking["players"][0]["no_show"] is True
    if fake is not None:
        # 행 전체가 아니라 컬럼 하나를 본다 (synced_at 은 쓸 때마다 바뀐다).
        assert fake.rows[stale_id]["status"] == "no_show"
        assert fake.rows[stale_id]["doc"]["status"] == "no_show"

    second = run_task(client, "worker/run", date=past)
    assert (second["updated"], second["findings"]) == (0, [])


def test_save_bookings_subset_drops_the_rest(backend_env: Env):
    everything = store.load_bookings()
    keep = everything[:3]
    store.save_bookings(keep)
    assert [b["id"] for b in store.load_bookings()] == [b["id"] for b in keep]
    if backend_env.fake is not None:
        # 테이블은 파일처럼 통째로 덮이지 않는다. 빠진 행을 명시적으로 지웠는지 본다.
        assert set(backend_env.fake.rows) == {b["id"] for b in keep}
        assert backend_env.fake.calls("DELETE")


def test_save_bookings_empty_list_empties_the_store(backend_env: Env):
    store.save_bookings([])
    assert store.load_bookings() == []
    assert backend_env.client.get(f"{API}/tee-sheet/bookings").json() == []
    if backend_env.fake is not None:
        assert backend_env.fake.rows == {}


def test_mutate_exception_writes_nothing(backend_env: Env):
    before = store.load_bookings()
    writes = write_count(backend_env.fake) if backend_env.fake is not None else None
    with pytest.raises(RuntimeError):
        with store.mutate() as bookings:
            bookings.clear()
            raise RuntimeError("abort")
    assert store.load_bookings() == before
    if backend_env.fake is not None:
        assert write_count(backend_env.fake) == writes


# ===== 일일 배치 (병렬성) ==============================================


class ConcurrentReads:
    """GET 마다 `delay` 초 걸리는 전송 계층. 동시에 진행 중인 GET 의 최댓값을 잰다.

    일일 배치의 세 파트가 저장소를 **동시에** 읽는지를 타이밍 비율이 아니라 직접 본다.
    읽기가 이벤트 루프를 막으면 GET 이 한 줄로 늘어서 peak 가 1 에 머문다.
    """

    def __init__(self, fake: FakePostgrest, delay: float) -> None:
        self.fake = fake
        self.delay = delay
        self.inflight = 0
        self.peak = 0
        self._lock = threading.Lock()
        self.transport = httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        if request.method != "GET":
            return self.fake._handle(request)
        with self._lock:
            self.inflight += 1
            self.peak = max(self.peak, self.inflight)
        try:
            time.sleep(self.delay)
            return self.fake._handle(request)
        finally:
            with self._lock:
                self.inflight -= 1


def _deterministic_batch_view(result: dict) -> list[dict]:
    drop = {"duration_ms"}
    return [{k: v for k, v in sub.items() if k not in drop} for sub in result["subtasks"]]


EXPECTED_BATCH = [
    {"task": "send_reminders", "date": SEED_DATE, "bookings": 11, "recipients": 32, "sent": 32,
     "failed": 0, "status": "success"},
    {"task": "generate_report", "date": SEED_DATE, "total_tee_times": 11, "booked_slots": 32,
     "total_revenue": 1529.28, "occupancy_rate": 9.64, "status": "success"},
    # 격자가 6:58 PM 까지라 하루 83슬롯이다 (6:40 AM 부터 9분 간격).
    {"task": "refresh_availability", "date": SEED_DATE, "total_slots": 83, "taken_slots": 9,
     "open_slots": 74, "status": "success"},
]


def test_daily_batch_reads_in_parallel(backend_env: Env, monkeypatch):
    probe = None
    if backend_env.fake is not None:
        probe = ConcurrentReads(backend_env.fake, delay=0.1)
        monkeypatch.setattr(sb, "_transport", probe.transport)

    # 엔드포인트 대신 코루틴을 직접 돌린다. 상태 폴링도 GET 을 보내므로 동시성 측정을 흐린다.
    result = asyncio.run(module.run_daily_batch(SEED_DATE))

    assert result["failed_subtasks"] == 0
    assert _deterministic_batch_view(result) == EXPECTED_BATCH
    assert result["duration_ms"] < result["sequential_ms"] * 0.75, (result["duration_ms"], result["sequential_ms"])
    assert result["speedup"] > 1.3, result["speedup"]
    if probe is not None:
        assert probe.peak >= 2, probe.peak


def test_daily_batch_endpoint_succeeds(backend_env: Env):
    result = run_task(backend_env.client, "orchestration/daily-batch", date=SEED_DATE)
    assert result["failed_subtasks"] == 0
    assert _deterministic_batch_view(result) == EXPECTED_BATCH
    assert result["speedup"] > 1.3, result["speedup"]


# ===== supabase 전용: 최소 쓰기 =======================================


def test_supabase_patch_writes_only_the_changed_row(tmp_path, monkeypatch):
    with open_backend("supabase", monkeypatch, tmp_path) as env:
        client, fake = env.client, env.fake
        # 첫 쓰기는 시드 전체를 다시 쓸 수 있다. 시드 doc 은 모델을 거치지 않아
        # (source 키 없음, "+00:00" 시각) API 가 한 번 정규화해 저장한다.
        mark = len(fake.raw_requests)
        assert client.patch(f"{API}/tee-sheet/bookings/b-elm", json={"notes": "warm-up"}).status_code == 200
        assert posted_rows(fake, mark)

        mark = len(fake.raw_requests)
        assert client.patch(f"{API}/tee-sheet/bookings/b-ash", json={"notes": "second"}).status_code == 200
        rows = posted_rows(fake, mark)
        assert [row["id"] for row in rows] == ["b-ash"]
        assert not [r for r in fake.raw_requests[mark:] if r.method == "DELETE"]

        mark = len(fake.raw_requests)
        assert client.delete(f"{API}/tee-sheet/bookings/b-ash").status_code == 204
        assert posted_rows(fake, mark) == []
        assert [r.method for r in fake.raw_requests[mark:]].count("DELETE") == 1
