/**
 * 손님 개인 QR(0084) — 신분증으로 등록한 손님마다 하나. 찍으면 오늘 예약에서 그 손님을 체크인한다.
 *
 * QR 에는 GPS 앱 주소가 들어간다: `https://<GPS 앱>/me?c=PHC-XXXXXXXXXX`. 손님이 휴대폰 카메라로
 * 열면 GPS 앱이 생년월일을 확인하고 그 계정에 잇는다(`pelham_gps_link`). 카운터 스캐너로 찍으면
 * 이 주소가 그대로 쳐 들어오고, 티 시트가 `PHC-` 를 알아본다. 토큰은 무작위라 이름·번호가 없다.
 */

import { paymentsApiBase } from "@/lib/booking/payments";
import { ApiError } from "@/lib/teeSheet/api";
import { accessToken } from "@/lib/teeSheet/session";
import { staffRpc } from "@/lib/teeSheet/staffRpc";

export const GPS_APP_ORIGIN = "https://golf-gps-pelhamhills-seven.vercel.app";

/** 헷갈리는 글자(0 O 1 I L U)가 없는 10자 — SQL `pelham_customer_qr_parse` 와 같은 규칙. */
const QR_CODE = /PHC-([2-9A-HJKMNP-TV-Z]{10})/i;

export function customerQrCode(raw: string): string | null {
  const match = QR_CODE.exec(raw);
  return match ? `PHC-${match[1].toUpperCase()}` : null;
}

export function customerQrUrl(code: string): string {
  return `${GPS_APP_ORIGIN}/me?c=${encodeURIComponent(code)}`;
}

export type CustomerCard = {
  customerRef: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  email: string | null;
  phone: string | null;
  memberNumber: string | null;
  isMember: boolean;
  qrCode: string | null;
  gpsLinked: boolean;
  idCheckedAt: string | null;
};

export type IdMatch = CustomerCard & { dobMatch: boolean; dobConflict: boolean };

export type CheckinResult = {
  status: "checked_in" | "already" | "none";
  customer: CustomerCard;
  bookingId?: string;
  date?: string;
  time?: string;
  player?: string;
};

export async function findIdMatches(firstName: string, lastName: string, dateOfBirth: string): Promise<IdMatch[]> {
  const body = await staffRpc<{ customers: IdMatch[] }>("pelham_staff_id_find", {
    p_first: firstName,
    p_last: lastName,
    p_dob: dateOfBirth,
  });
  return body.customers ?? [];
}

/** customerRef 가 없으면 새 손님(매니저 승인 창이 뜬다). */
export function registerFromId(
  customerRef: string | null,
  input: { firstName: string; lastName: string; dateOfBirth: string; email?: string; phone?: string },
): Promise<CustomerCard> {
  return staffRpc<CustomerCard>("pelham_staff_id_register", {
    p_ref: customerRef,
    p: {
      first_name: input.firstName,
      last_name: input.lastName,
      date_of_birth: input.dateOfBirth,
      email: input.email ?? "",
      phone: input.phone ?? "",
    },
  });
}

export function checkInByQr(code: string): Promise<CheckinResult> {
  return staffRpc<CheckinResult>("pelham_staff_customer_checkin", { p_key: code, p_how: "qr" });
}

export function checkInById(customerRef: string): Promise<CheckinResult> {
  return staffRpc<CheckinResult>("pelham_staff_customer_checkin", { p_key: customerRef, p_how: "id_scan" });
}

/**
 * QR 을 손님 휴대폰으로 문자(MMS) 보낸다 — FastAPI(`backend/api/routes/customer_qr.py`)가 Twilio 로.
 * 번호는 서버가 손님 기록에서 읽는다. 돌려주는 것은 보낸 번호 끝 4자리.
 */
export async function textCustomerQr(customerRef: string): Promise<string> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in again to text the QR code.");
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}/pos/customer-qr/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ customer_ref: customerRef }),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Try again in a moment.");
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const detail = ((await response.json()) as { detail?: unknown })?.detail;
      if (typeof detail === "string" && detail) message = detail;
    } catch {
      // JSON 이 아닌 오류 본문.
    }
    // 경로 자체가 없으면 FastAPI 기본 "Not Found" — 서버가 아직 옛 배포다.
    if (response.status === 404 && message === "Not Found") {
      message = "Texting QR codes is not on the server yet. Deploy the API (Fly) first.";
    }
    throw new ApiError(response.status, message);
  }
  const body = (await response.json()) as { last4?: unknown };
  return typeof body?.last4 === "string" ? body.last4 : "";
}

/** 체크인 결과 한 줄(토스트). */
export function checkinMessage(result: CheckinResult): string {
  const who = result.customer.name;
  if (result.status === "checked_in") return `${who} checked in — ${result.time}.`;
  if (result.status === "already") return `${who} is already checked in for ${result.time}.`;
  return `${who} has no tee time today. Book one, then scan again.`;
}
