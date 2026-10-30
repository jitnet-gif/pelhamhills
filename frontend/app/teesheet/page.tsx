"use client";

// 티 시트 화면 셸. 실제 동작은 useTeeSheet 컨트롤러와 각 패널 컴포넌트가 담당한다.
//
// 사이드바 마크업과 메뉴 배열은 여기 있었지만 `AdminShell` 로 옮겼다. 복사본이던 시절
// 이 화면의 사이드바는 `hidden lg:block` 이라 휴대폰에서는 메뉴가 통째로 사라졌고,
// 티 시트를 열면 다른 어드민 화면으로 갈 방법이 뒤로 가기밖에 없었다.
// 이 페이지는 `fill` 모드를 쓴다 — 페이지 자체는 스크롤하지 않고 격자/상세만 스크롤한다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import AdminShell from "../../components/admin/AdminShell";
import BillDrawer from "../../components/pos/BillDrawer";
import BillPanel from "../../components/pos/BillPanel";
import BookingDialog, { STANDARD_SEATS_PER_TEE_TIME } from "../../components/teesheet/BookingDialog";
import DateNav from "../../components/teesheet/DateNav";
import IdCheckinDialog from "../../components/teesheet/IdCheckinDialog";
import ReservationDetail from "../../components/teesheet/ReservationDetail";
import WeekGrid from "../../components/teesheet/WeekGrid";
import { useBarcodeScanner } from "../../hooks/useBarcodeScanner";
import { useTeeSheet } from "../../hooks/useTeeSheet";
import { useSlotLocks } from "@/hooks/useSlotLocks";
import { billActions, getBillState, useCurrentBill } from "@/lib/pos/currentBill";
import { checkInByQr, checkinMessage, customerQrCode, type CheckinResult } from "@/lib/pos/customerQr";
import { isIdCardScan, parseIdCard, type IdCard } from "@/lib/pos/idCard";
import { isGiftCardCode, offerGiftCardCode } from "@/lib/pos/giftCard";
import { isRainCheckCode, offerRainCheckCode } from "@/lib/pos/rainCheck";
import { isPromoBarcode } from "@/lib/pos/promo";
import { retailApi, toRetailError } from "@/lib/retail/api";
import { findProductByCode } from "@/lib/retail/findProduct";
import { formatMoney } from "@/lib/retail/types";
import { confirmationCode } from "@/lib/teeSheet/receipt";
import { isSlotLocked } from "@/lib/teeSheet/sun";
import { GUEST_NAME, TONE_CLASS, TONE_LABEL, type PlayerTone } from "@/lib/teeSheet/tone";
import type { TeeSheetController } from "@/lib/teeSheet/types";

/** 티 시트 영수증 바코드: `ABCD-1234`(확인 코드), 뒤에 `-플레이어4자` 또는 `-ALL`. */
const TEE_TICKET = /^([A-Z0-9]{4}-[A-Z0-9]{4})(?:-([A-Z0-9]{4}|ALL))?$/;

export default function TeeSheetPage() {
  const controller = useTeeSheet({ live: true }); // 5초마다 Supabase 에서 예약을 다시 읽는다
  // 컨트롤러 객체는 useMemo 지만 bookings·busy·toasts 에 딸려 있어 변경 한 번마다
  // 새로 만들어진다. 아래 콜백이 통째로 그 객체에 의존하면 격자(셀 버튼 수백 개)가
  // 그때마다 다시 그려지므로, 쓰는 것만 꺼내 쓴다 — 이 넷은 useCallback 으로 고정이다.
  const { bookings, focusedDate, pushToast, select, setFocusedDate, slots } = controller;
  // `/teesheet?date=YYYY-MM-DD&booking=<id>` — 다른 화면(Calls & SMS 의 예약 통화)에서 그 예약을 연 채로 온다.
  // 처음 한 번만 읽는다. 예약이 아직 안 읽혔어도 선택은 id 로 걸어 두면 읽히는 대로 상세가 열린다.
  // 그 예약 칸은 격자에 그려지는 대로 화면 가운데로 굴리고 몇 번 깜빡여서 어디 있는지 보인다.
  const blinkRef = useRef<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const date = params.get("date");
    const booking = params.get("booking");
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) setFocusedDate(date);
    if (booking) {
      select(booking);
      blinkRef.current = booking;
    }
  }, [select, setFocusedDate]);
  // 예약을 읽기 전에는 칸이 없다 — 예약·날짜·뷰가 바뀔 때마다 다시 찾고, 찾으면 한 번만 한다.
  // 깜빡임은 React 가 모르는 `data-blink` 속성으로 건다. 5초 폴링으로 다시 그려도 className 처럼 지워지지 않는다.
  useEffect(() => {
    const id = blinkRef.current;
    if (!id) return;
    const cells = document.querySelectorAll<HTMLElement>(`[data-booking-id="${CSS.escape(id)}"]`);
    if (cells.length === 0) return;
    blinkRef.current = null;
    cells[0].scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    for (const cell of cells) {
      cell.dataset.blink = "";
      cell.addEventListener("animationend", () => delete cell.dataset.blink, { once: true });
    }
  }, [bookings, focusedDate, controller.view]);
  // 다이얼로그는 이제 **막다른 길을 막는 용도**로만 남는다 (아래 addReservation 참고).
  const [dialogOpen, setDialogOpen] = useState(false);
  // 합산 계산서 서랍. 그린피를 담고 여기서 바로 결제하거나, 리테일 화면으로 넘어가 상품을 더 담는다.
  const [billOpen, setBillOpen] = useState(false);
  // 상품을 스캔해 담았을 때 서랍의 결제 칸으로 스크롤시키는 값(BillPanel 참고).
  const [revealPayments, setRevealPayments] = useState(0);
  // 면허증을 스캔하면 뜨는 신분증 체크인 창(0084).
  const [idCard, setIdCard] = useState<IdCard | null>(null);
  const billState = useCurrentBill();
  // 티 시트 두 장 나란히 보기(Chronogolf 의 "Add Tee Sheet"). 오른쪽 시트는 SecondSheet 참고.
  const [split, setSplit] = useState(false);
  // 스캐너가 못 읽는 바코드(화면·구겨진 종이)를 손으로 친다. 친 값은 스캔과 똑같이 처리한다.
  const [typedCode, setTypedCode] = useState("");
  const [detailHost, setDetailHost] = useState<HTMLDivElement | null>(null);
  const clearSelection = useCallback(() => select(null), [select]);
  // 예전에는 빈 칸이 넘겨주는 날짜·시각을 ref 에 담아 뒀는데, 그 ref 를 렌더 중에
  // 읽는 바람에 react-hooks/refs 가 걸렸다. 지금 시드는 "보고 있는 날짜" 하나뿐이라
  // 그냥 계산하면 된다.
  const dialogSeed = useMemo(() => ({ date: focusedDate }), [focusedDate]);

  // 격자의 빈 칸(`+`)은 더 이상 다이얼로그를 띄우지 않는다. 예약 한 건을 그 자리에
  // 바로 만들고 곧장 선택해서, 아래 상세 패널이 그대로 열리게 한다 — 클릭 한 번에
  // 이름·요금제·결제를 편집하는 그 화면이다. 상세 패널은 이미 플레이어 단위 자동
  // 저장(debounce)이라 다이얼로그가 하던 "폼을 채우고 Create" 단계가 통째로 필요 없다.
  //
  // 빈 칸은 좌석이 남은 자리에만 그려지므로 정원 검사는 여기서 다시 하지 않는다.
  // 남의 브라우저가 먼저 채워 경합이 나면 서버의 require_capacity 가 막고
  // controller 가 에러 토스트를 띄운다 (createBooking 이 null 을 돌려준다).
  //
  // 중복 생성만 막는다. `controller.busy` 를 보면 안 된다 — 상세 패널의 이름 입력이
  // 0.7초마다 patchPlayer 를 날리며 같은 busy 를 켜므로, 이름을 치다가 다른 칸을
  // 누르면 아무 일도 일어나지 않는 "눌렀는데 안 나오는" 상태가 된다. 그건 지금
  // 고치려는 바로 그 증상이다. 막아야 할 건 이 칸의 더블클릭뿐이다.
  const createAt = useCreateAt(controller);

  // 잠긴 칸(일출 전·일몰 2시간 전 이후·직원 블록)은 Add 가 고르지 않는다.
  const { locks: slotLocks } = useSlotLocks([focusedDate]);

  /**
   * 보고 있는 날짜에서 **자리가 남은 가장 이른 티 타임**. 없으면 null.
   *
   * 취소된 예약은 좌석을 잡지 않는다 (백엔드의 정원 계산과 같은 규칙).
   * 슬롯은 분 단위로 정렬해서 본다 — "6:58 AM" 같은 라벨을 문자열로 비교하면
   * 오전 10시가 오전 7시보다 앞에 온다.
   */
  const firstFreeTime = useMemo(() => {
    const taken = new Map<string, number>();
    for (const booking of bookings) {
      if (booking.date !== focusedDate || booking.status === "cancelled") continue;
      taken.set(booking.time, (taken.get(booking.time) ?? 0) + booking.players.length);
    }
    return (
      [...slots]
        .sort((a, b) => a.minutes - b.minutes)
        .find(
          (slot) => !isSlotLocked(focusedDate, slot.minutes, slotLocks) && (taken.get(slot.time) ?? 0) < STANDARD_SEATS_PER_TEE_TIME,
        )
        ?.time ?? null
    );
  }, [bookings, focusedDate, slotLocks, slots]);

  /**
   * 상단바의 Add. 격자의 빈 칸과 같은 결과를 내야 한다 — 창을 띄우지 않고 예약을
   * 만들어 아래 상세 패널을 연다. 다른 점은 누른 자리가 없다는 것뿐이라, 그 날의
   * 첫 빈 타임을 대신 고른다. 타임이 틀렸으면 패널 안의 날짜·티 타임 드롭다운으로
   * 바로 옮길 수 있다.
   *
   * 그 날이 꽉 찼거나 슬롯이 아직 안 왔으면 다이얼로그를 연다. 버튼이 아무 반응도
   * 없는 것보다 낫고, 거기서는 다른 날짜를 고를 수 있다.
   */
  const addReservation = useCallback(() => {
    if (firstFreeTime) void createAt(focusedDate, firstFreeTime);
    else setDialogOpen(true);
  }, [createAt, firstFreeTime, focusedDate]);

  /**
   * 프로 샵 스캐너(DS2208)로 티 시트 영수증을 쏘면 그 예약을 연다 — 재인쇄·결제 확인·환불 문의 때
   * 종이를 들고 온 손님의 예약을 격자에서 찾지 않아도 된다.
   *
   * 확인 코드는 id 의 **뒤 8자**라 되돌릴 수 없다. 그래서 서버에 묻지 않고 지금 읽어 둔 예약
   * (보이는 주) 안에서만 찾는다. 다른 주의 영수증이면 그 주로 가서 다시 쏘라고 알린다.
   */
  /**
   * 티 시트 영수증이 아니면 상품 바코드로 본다 — 카운터에서 그린피와 함께 물건을 사는 손님.
   * 그 상품을 지금 계산서에 담고 결제 서랍을 연다(리테일 계산대와 같다).
   * 상품 목록은 스캔할 때마다 새로 읽는다. 수십 개라 가볍고, 방금 Products 탭에서 등록한
   * 상품도 바로 찾는다.
   */
  const sellScannedProduct = useCallback(
    async (raw: string) => {
      let products;
      try {
        products = await retailApi.listProducts({ active: true });
      } catch (error) {
        pushToast("error", toRetailError(error).message);
        return;
      }
      const product = findProductByCode(products, raw);
      if (!product) {
        pushToast(
          "error",
          `"${raw}" is not a tee sheet receipt or a product. Add it on Retail → Products — scan it into the Barcode field.`,
        );
        return;
      }
      const bill = await billActions.addProduct(product.id, "tee_sheet");
      // 실패해도 서랍은 연다 — 오류 문구가 서랍 안 BillPanel 에 뜬다.
      setBillOpen(true);
      if (bill) setRevealPayments((n) => n + 1);
    },
    [pushToast],
  );

  /** 체크인된 예약을 격자에서 연다(다른 날이면 그날로). 격자는 다음 폴링 전에 바로 다시 읽는다. */
  const showCheckin = useCallback(
    (result: CheckinResult) => {
      if (!result.bookingId) return;
      if (result.date && result.date !== focusedDate) setFocusedDate(result.date);
      select(result.bookingId);
      void controller.refresh();
    },
    [controller, focusedDate, select, setFocusedDate],
  );

  const onScan = useCallback(
    (raw: string) => {
      // 손님 개인 QR(0084): 오늘 예약에서 그 손님을 바로 체크인한다.
      const qr = customerQrCode(raw);
      if (qr) {
        checkInByQr(qr)
          .then((result) => {
            pushToast(result.status === "none" ? "error" : "success", checkinMessage(result));
            showCheckin(result);
          })
          .catch((error: unknown) => pushToast("error", error instanceof Error ? error.message : "QR check-in failed."));
        return;
      }
      // 면허증 뒷면(PDF417): 이름·생년월일을 읽어 신분증 체크인 창을 연다. 못 읽으면 다시 찍게 한다.
      if (isIdCardScan(raw)) {
        const card = parseIdCard(raw);
        if (card) setIdCard(card);
        else pushToast("error", "Couldn't read the name and date of birth from that ID. Scan the barcode on the back again.");
        return;
      }
      // 레인체크 전표: 계산서 서랍의 결제 칸으로 넘긴다. 쓸 곳(계산서 줄)이 먼저 있어야 한다.
      if (isRainCheckCode(raw)) {
        const current = getBillState().bill;
        if (!current || current.lines.length === 0) {
          pushToast("error", "That is a rain check. Add the green fee to the bill first, then scan the rain check again.");
          return;
        }
        offerRainCheckCode(raw);
        setBillOpen(true);
        setRevealPayments((n) => n + 1);
        return;
      }
      // 기프트카드(0120): 레인체크처럼 계산서 서랍의 결제 칸으로 넘긴다.
      if (isGiftCardCode(raw)) {
        const current = getBillState().bill;
        if (!current || current.lines.length === 0) {
          pushToast("error", "That is a gift card. Add the green fee to the bill first, then scan the gift card again.");
          return;
        }
        offerGiftCardCode(raw);
        setBillOpen(true);
        setRevealPayments((n) => n + 1);
        return;
      }
      // 프로모션 바코드(0078): 계산서의 그린피에 할인을 건다. 금액·조건은 서버가 판정하고, 안 되면
      // 그 까닭이 서랍 안 BillPanel 에 뜬다.
      if (isPromoBarcode(raw)) {
        const current = getBillState().bill;
        if (!current || !current.lines.some((line) => line.kind === "tee_player")) {
          pushToast("error", "That is a promo code. Add the green fee to the bill first, then scan it again.");
          return;
        }
        setBillOpen(true);
        void billActions.applyPromo(raw, "tee_sheet");
        return;
      }
      const match = TEE_TICKET.exec(raw.trim().toUpperCase());
      if (!match) {
        void sellScannedProduct(raw);
        return;
      }
      const found = bookings.find((booking) => confirmationCode(booking.id) === match[1]);
      if (!found) {
        pushToast(
          "error",
          `No reservation ${match[1]} in the loaded week — go to the receipt's date and scan again.`,
        );
        return;
      }
      if (found.date !== focusedDate) setFocusedDate(found.date);
      select(found.id);
    },
    [bookings, focusedDate, pushToast, select, sellScannedProduct, setFocusedDate, showCheckin],
  );
  // 직접 입력 칸에서 쏜 스캔도 여기로 온다(data-scan-target). 칸에 찍힌 글자는 비운다.
  const onScanOrTyped = useCallback(
    (raw: string) => {
      setTypedCode("");
      onScan(raw);
    },
    [onScan],
  );
  useBarcodeScanner(onScanOrTyped);

  // 한 화면 고정: 페이지 자체는 절대 스크롤하지 않고, 티 시트와 상세 패널이
  // 각자 내부에서만 스크롤한다. 그래야 예약을 클릭했을 때 격자와 상세가 동시에 보인다.
  return (
    <AdminShell
      actions={
        // 레퍼런스에서는 파란 Add 버튼이 상단바 오른쪽 끝에 있다. 예전에는 티 시트가
        // 자기 헤더 줄을 하나 더 그려서 거기 달았는데, 그래서 화면 머리가 세 겹이었다.
        <span className="flex items-center gap-1.5">
        <ToneLegend />
        {/* 2026-10-29: 스캔이 안 될 때 바코드(GIFT-·RC-·PROMO-·상품·영수증 번호)를 직접 친다. */}
        <form
          className="hidden md:block"
          onSubmit={(event) => {
            event.preventDefault();
            const code = typedCode.trim();
            if (code) onScanOrTyped(code);
          }}
        >
          <input
            aria-label="Type a barcode"
            autoComplete="off"
            className="w-44 border border-[#c7c7cc] bg-white px-2 py-1.5 text-xs uppercase placeholder:normal-case"
            data-scan-target=""
            onChange={(event) => setTypedCode(event.target.value)}
            placeholder="Type barcode + Enter"
            spellCheck={false}
            value={typedCode}
          />
        </form>
        <button
          aria-pressed={split}
          className={`hidden items-center border px-2 py-1.5 lg:inline-flex ${
            split ? "border-[#4533ff] bg-[#eef0ff] text-[#4533ff]" : "border-[#c7c7cc] bg-white text-[#3f4650]"
          }`}
          onClick={() => setSplit((on) => !on)}
          title={split ? "Close the second tee sheet" : "Add Tee Sheet — compare two dates side by side"}
          type="button"
        >
          <SplitIcon />
        </button>
        {billState.missing ? null : (
          <button
            className="inline-flex min-h-11 items-center gap-1 border border-[#4533ff] bg-white px-3 text-xs font-bold text-[#4533ff] lg:min-h-0 lg:py-1.5"
            onClick={() => setBillOpen(true)}
            title="Open the current bill: green fees, pro shop and snack bar on one payment"
            type="button"
          >
            {billState.bill
              ? `Bill #${billState.bill.id} · ${formatMoney(billState.bill.total)}`
              : billState.openBills.length > 0
                ? `Bills (${billState.openBills.length})`
                : "Bill"}
          </button>
        )}
        <button
          className="inline-flex min-h-11 items-center gap-1 bg-[#4533ff] px-4 text-xs font-bold text-white lg:min-h-0 lg:py-1.5"
          onClick={addReservation}
          type="button"
        >
          Add
          <span aria-hidden className="text-[9px] leading-none">
            &#9662;
          </span>
        </button>
        </span>
      }
      fill
      title="Tee Sheet"
    >
        {/* 암시적 컬럼 트랙도 minmax(0,1fr) 로 못박는다 (위와 같은 이유).
            행: 티 시트(남는 높이 전부) / 상세(auto). 티 시트 칸 안이 다시 헤더(auto) / 격자(1fr) 이고,
            나눠 보면(split) 그 칸이 좌우 두 장이 된다.
            minmax(0,1fr) 이어야 티 시트 칸이 내용 높이만큼 부풀지 않고 내부 스크롤한다. */}
        {/* 하단은 언제나 `auto` — 상세 패널이 **자기 내용 높이**만 가져간다.
            예전에는 예약을 고르면 티 시트와 상세가 1fr 씩 반반으로 나눠 가졌는데,
            그러면 카드 넉 장이 400px 이 안 되는데도 늘 화면 절반을 먹어서 Discount ·
            Payment 줄과 노란 메모가 접힌 아래로 내려갔다. 상세가 커지면 티 시트 칸이
            그만큼 줄고 티 시트 안에서 스크롤한다 (아래 `max-h-[85dvh]` 주석 참고). */}
        <section className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto]">
          <div className={`grid min-h-0 min-w-0 ${split ? "grid-cols-2" : "grid-cols-[minmax(0,1fr)]"}`}>
            <section className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]">
              {/* DateNav 은 Fragment 로 header + 툴바 + 토스트를 반환한다. 감싸지 않으면
                  각각이 별도 grid 아이템이 되어 행 배정이 밀리고, minmax(0,1fr) 트랙에
                  걸린 툴바가 0 높이로 눌려 사라진다. */}
              <div className="min-w-0">
                <DateNav controller={controller} />
              </div>

              <section className="min-h-0 min-w-0 overflow-hidden">
                <WeekGrid controller={controller} onCreateAt={createAt} />
              </section>
            </section>

            {split ? (
              <SecondSheet
                detailHost={detailHost}
                initialDate={focusedDate}
                onClose={() => setSplit(false)}
                onSelected={clearSelection}
                otherSelectedId={controller.selectedId}
              />
            ) : null}
          </div>

          {/* 상세 패널은 하단 영역 안에서만 스크롤한다. 이 상한이 티 시트의 최소 높이를
              보장하므로, 예약을 선택해도 위의 티 시트는 항상 보인다.
              예약을 고르기 전에는 아예 렌더하지 않아 티 시트가 화면 전체를 쓴다.

              여기에는 Operations 바도 함께 있었지만 레퍼런스 화면에 없어서 뺐다
              (기능은 `/admin/integrations` 로 옮겼다 — 그 파일 머리말 참고).

              상한은 화면의 85% 다. 예전 상한 50vh 는 카드 아래쪽(Subtotal · Select)을 잘라
              상세 패널 안에서 위아래로 굴려야 했다(2026-10-18) — 직원은 패널이 통째로 보이고
              움직이지 않기를 원한다. 그래서 상세는 자기 높이를 다 갖고, 줄어드는 쪽은 티 시트다.
              85dvh 는 상세가 비정상적으로 길 때도 위 티 시트 몇 줄을 남기는 안전장치일 뿐이다.
              `max-h-[85%]` 를 쓰면 안 된다 — 이 칸은 `auto` 트랙이라 백분율 상한이 화면이 아니라
              **자기 콘텐츠 높이**를 기준으로 풀린다.

              오른쪽 비교 시트에서 고른 예약의 상세도 이 칸에 포털로 들어온다(SecondSheet 참고). */}
          <div className="max-h-[85dvh] min-h-0 overflow-y-auto" ref={setDetailHost}>
            {controller.selected ? <ReservationDetail controller={controller} /> : null}
          </div>
        </section>

      {billOpen ? (
        <BillDrawer
          onClose={() => {
            setBillOpen(false);
            setRevealPayments(0);
          }}
        >
          <BillPanel onPaid={() => void controller.refresh()} revealPayments={revealPayments} station="tee_sheet" />
        </BillDrawer>
      ) : null}

      {idCard ? (
        <IdCheckinDialog card={idCard} onCheckedIn={showCheckin} onClose={() => setIdCard(null)} />
      ) : null}

      <BookingDialog
        controller={controller}
        initial={dialogSeed}
        onClose={() => setDialogOpen(false)}
        open={dialogOpen}
      />
    </AdminShell>
  );
}

/** 일간 시트 셀 색 범례. 색 규칙 자체는 tone.ts 하나에만 있다 — 여기선 목록만 그린다. */
function ToneLegend() {
  return (
    <details className="relative">
      <summary
        className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 border border-[#c7c7cc] bg-white px-3 text-xs font-bold text-[#3f4650] lg:min-h-0 lg:py-1.5"
        title="What the tee sheet colors mean"
      >
        Colors
      </summary>
      <ul className="absolute right-0 z-50 mt-1 w-52 space-y-1 border border-[#c7c7cc] bg-white p-2 text-xs shadow-lg">
        {(Object.keys(TONE_LABEL) as PlayerTone[]).map((tone) => (
          <li className={`px-2 py-1 font-semibold ${TONE_CLASS[tone]}`} key={tone}>
            {TONE_LABEL[tone]}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * 빈 칸(`+`)·Add 가 예약 한 건을 바로 만들고 선택하는 동작 (위 TeeSheetPage 의 주석 참고).
 * 왼쪽 시트와 오른쪽 비교 시트가 같은 규칙을 써야 해서 훅으로 뺐다 — 각 시트는 자기
 * 컨트롤러에 만들고 자기 상세 패널을 연다.
 */
function useCreateAt({
  createBooking,
  focusedDate,
  select,
  setFocusedDate,
}: Pick<TeeSheetController, "createBooking" | "focusedDate" | "select" | "setFocusedDate">) {
  const creatingRef = useRef(false);
  return useCallback(
    async (date: string, time: string) => {
      if (creatingRef.current) return;
      creatingRef.current = true;

      try {
        // 상세 패널의 티 타임 드롭다운은 controller.slots(= focusedDate 의 슬롯)에서
        // 나온다. 주간 뷰에서 다른 날 칸을 눌렀다면 시트를 그 날로 옮겨야 방금 만든
        // 예약과 슬롯 목록이 같은 날을 가리킨다 (다이얼로그도 같은 일을 했다).
        if (date !== focusedDate) setFocusedDate(date);

        // 이름 없는 자리는 "Guest" 다. title 은 서버 필수값이고 주간 뷰 막대에 찍히는
        // 이름이라 비워 둘 수 없는데, 서버도 빈 이름의 플레이어를 "Guest" 로 채우므로
        // (`pelham_tee_name`) 둘을 같은 말로 맞춘다. 상세 패널에서 이름을 적으면
        // 플레이어와 title 이 같이 바뀐다 (ReservationDetail 의 commitPlayer 참고).
        //
        // 빈 플레이어 한 명을 같이 만든다: 0명짜리 예약은 좌석을 잡지 않아서
        // 누른 칸이 그대로 `+` 로 남고, 격자 대신 off-grid 줄에 떨어진다.
        //
        // `type` 은 "Existing Customer" 로 넘긴다 — 이 자리는 익명 손님이 아니라 직원이
        // 이름을 채울 빈 자리다. 셀 색은 요금제(서버 기본 "Public" → 노랑)로 정해지고
        // (playerTone), 이름 없는 자리를 Guest 로 부르는 일은 playerLabel 의 폴백이 한다.
        const created = await createBooking({
          date,
          time,
          title: GUEST_NAME,
          players: [{ firstName: "", lastName: "", type: "Existing Customer" }],
        });

        // 실패하면 controller 가 이미 토스트를 띄웠다. 여기서는 아무것도 열지 않는다.
        if (created) select(created.id);
      } finally {
        creatingRef.current = false;
      }
    },
    [createBooking, focusedDate, select, setFocusedDate],
  );
}

/**
 * 오른쪽 비교 시트 — Chronogolf 의 "Add Tee Sheet" 와 같다(2026-10-21 요청). 두 날짜(또는 같은
 * 날짜)를 나란히 놓고 본다. 자기 컨트롤러(`useTeeSheet`)를 따로 가져서 날짜·선택이 왼쪽과
 * 따로 움직이고, 5초 폴링으로 왼쪽에서 바꾼 예약도 곧 여기 보인다.
 *
 * 페이지가 아니라 이 컴포넌트가 훅을 부르는 이유: 닫혀 있을 때는 마운트하지 않아서 두 번째
 * 폴링·주간 읽기가 아예 돌지 않는다.
 *
 * 상세 패널은 하나만 연다. 화면 아래 상세 자리는 왼쪽 시트 것이라, 여기서 고른 예약의 상세는
 * 그 자리(`detailHost`)에 포털로 그린다. 한쪽에서 예약을 고르면 다른 쪽 선택은 풀린다 —
 * 두 상세가 겹쳐 쌓이면 어느 예약을 고치는지 헷갈린다.
 */
function SecondSheet({
  detailHost,
  initialDate,
  onClose,
  onSelected,
  otherSelectedId,
}: {
  detailHost: HTMLElement | null;
  initialDate: string;
  onClose: () => void;
  onSelected: () => void;
  otherSelectedId: string | null;
}) {
  const controller = useTeeSheet({ live: true });
  const { select, selectedId, setFocusedDate } = controller;
  const createAt = useCreateAt(controller);

  // 처음 열 때는 왼쪽과 같은 날로 시작한다(레퍼런스도 같은 날을 복제해 연다). 그 뒤로는 따로 움직인다.
  const startRef = useRef(initialDate);
  useEffect(() => {
    setFocusedDate(startRef.current);
  }, [setFocusedDate]);

  useEffect(() => {
    if (otherSelectedId) select(null);
  }, [otherSelectedId, select]);
  useEffect(() => {
    if (selectedId) onSelected();
  }, [onSelected, selectedId]);

  return (
    <section className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] border-l-4 border-[#d4d4d8]">
      <div className="relative min-w-0">
        <DateNav controller={controller} />
        <button
          aria-label="Close this tee sheet"
          className="absolute right-2 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-[#e53935] text-sm font-bold leading-none text-white hover:bg-[#c62828]"
          onClick={onClose}
          title="Close this tee sheet"
          type="button"
        >
          ×
        </button>
      </div>
      <section className="min-h-0 min-w-0 overflow-hidden">
        <WeekGrid controller={controller} onCreateAt={createAt} />
      </section>
      {detailHost && controller.selected ? createPortal(<ReservationDetail controller={controller} />, detailHost) : null}
    </section>
  );
}

/** 상단바의 시트 나누기 버튼 글리프 — 레퍼런스의 "Add Tee Sheet" 아이콘(세로로 나뉜 창). */
function SplitIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 16 16">
      <rect height="12" rx="1" width="13" x="1.5" y="2" />
      <path d="M8 2v12" />
    </svg>
  );
}
