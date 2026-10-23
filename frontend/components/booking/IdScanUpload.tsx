"use client";

/**
 * 예약 확정 화면에 붙는 "신분증 사진 올리기" 칸 (SQL 0082).
 *
 * 올린 사진은 골프 GPS 앱의 NFC 체크인 순간 카운터 직원 화면에 떠서 본인 확인에
 * 쓰인다. 손님은 이메일로 GPS 앱에 로그인해 카운터 태그에 폰을 대기만 하면 된다.
 *
 * - 선택 사항이다. 안 올려도 예약은 그대로고, 카운터에서 신분증을 보여 주면 된다.
 * - 사진은 브라우저에서 긴 변 1280px JPEG 로 줄여 보낸다(폰 사진은 5MB 를 넘는다).
 * - 올린 뒤 다시 볼 수 없다. 함수가 돌려주지 않는다 — 직원 화면에서만 보인다.
 */

import { useEffect, useState } from "react";

import { bookingRpc } from "@/lib/booking/rpc";
import { ApiError } from "@/lib/teeSheet/api";

type Props = { code: string; email: string };

const MAX_EDGE = 1280;

/** 사진을 줄여 base64 JPEG 로. data: 접두어는 뗀다. */
async function shrink(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.82).split(",")[1] ?? "";
}

export default function IdScanUpload({ code, email }: Props) {
  const [onFile, setOnFile] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    bookingRpc<boolean>("pelham_id_scan_exists", { p_code: code, p_email: email })
      .then((exists) => alive && setOnFile(exists === true))
      // 0082 를 아직 실행하지 않은 서버면 칸을 숨긴다.
      .catch(() => alive && setOnFile(null));
    return () => {
      alive = false;
    };
  }, [code, email]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const image = await shrink(file);
      await bookingRpc("pelham_id_scan_upload", {
        p_code: code,
        p_email: email,
        p_mime: "image/jpeg",
        p_image: image,
      });
      setOnFile(true);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status !== 0
          ? failure.message
          : "The photo could not be uploaded. Check your connection and try again."
      );
    } finally {
      setBusy(false);
    }
  };

  if (onFile === null) return null;

  return (
    <div className="mt-5 rounded-sm border border-[#d8d1c3] bg-white p-5 text-left">
      <h3 className="font-serif text-lg font-semibold text-[#214d2f]">Fast check-in with your phone</h3>
      <p className="mt-1 text-sm text-[#3d453d]">
        Add a photo of your photo ID now. On the day, sign in to the Pelham Hills GPS app with{" "}
        <b>{email}</b> and tap your phone on the NFC tag at the pro shop — you&apos;re checked in, and
        staff see your ID on their screen.
      </p>

      {onFile ? (
        <p className="mt-3 rounded-sm bg-[#e4efe4] p-3 text-sm font-semibold text-[#214d2f]" role="status">
          ✓ ID photo on file.{" "}
          <label className="cursor-pointer font-normal underline">
            Replace it
            <input
              accept="image/*"
              className="sr-only"
              disabled={busy}
              onChange={(e) => void upload(e.target.files?.[0])}
              type="file"
            />
          </label>
        </p>
      ) : (
        <label
          className={`tap-target mt-3 flex cursor-pointer items-center justify-center rounded-sm bg-[#214d2f] px-5 text-base font-bold text-white transition hover:bg-[#163820] ${busy ? "opacity-60" : ""}`}
        >
          {busy ? "Uploading..." : "Add ID photo"}
          <input
            accept="image/*"
            capture="environment"
            className="sr-only"
            disabled={busy}
            onChange={(e) => void upload(e.target.files?.[0])}
            type="file"
          />
        </label>
      )}

      {error ? (
        <p className="mt-2 text-sm text-[#a33b2b]" role="alert">
          {error}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-[#5c6459]">
        Optional. Only pro shop staff can see the photo, and it is deleted 30 days after your tee time.
      </p>
    </div>
  );
}
