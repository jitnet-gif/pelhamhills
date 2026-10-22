/**
 * 상품 사진(0068)과 **사진으로 상품 찾기**.
 *
 * - 사진 올리기: Products 탭의 상품 창에서 찍거나 고른 사진을 800px WebP 로 줄여 Supabase Storage
 *   `product-photos` 에 올리고, `pelham_staff_pos_product_photo` 로 상품에 주소를 적는다.
 * - 사진으로 찾기: 계산대 카메라의 셔터가 지금 프레임을 1024px JPEG 로 찍어 FastAPI
 *   (`backend/api/routes/product_photo.py`)에 보낸다. 서버가 Claude 로 상품 사진들과 비교해 후보를 돌려준다.
 *   직원 확인은 요청에 붙는 로그인 토큰으로 SQL 이 한다(단말기와 같다).
 */

import { paymentsApiBase } from "@/lib/booking/payments";
import { ApiError } from "@/lib/teeSheet/api";
import { PUBLISHABLE_KEY, SUPABASE_URL, accessToken } from "@/lib/teeSheet/session";
import { staffRpc } from "@/lib/teeSheet/staffRpc";

import type { Product } from "./types";

const PHOTO_BUCKET = "product-photos";
/** 상품 사진. 비교에는 이 정도면 충분하고, 90장을 한 번에 보내도 가볍다. */
const PHOTO_MAX_PX = 800;
/** 계산대에서 찍은 사진. 라벨 글자까지 읽히도록 상품 사진보다 크게. */
const SNAPSHOT_MAX_PX = 1024;

async function toCanvasBlob(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxPx: number,
  type: "image/webp" | "image/jpeg",
): Promise<Blob> {
  const scale = Math.min(1, maxPx / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
  if (!blob) throw new ApiError(422, "The picture could not be read.");
  return blob;
}

/** 상품 사진을 올리고 상품에 적는다. 새 상품 정보(사진 주소 포함)를 돌려준다. */
export async function uploadProductPhoto(productId: number, file: Blob): Promise<Product> {
  if (!file.type.startsWith("image/")) throw new ApiError(422, "Choose a picture file (JPG, PNG or WebP).");
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in again to upload pictures.");

  const bitmap = await createImageBitmap(file);
  let blob: Blob;
  try {
    blob = await toCanvasBlob(bitmap, bitmap.width, bitmap.height, PHOTO_MAX_PX, "image/webp");
  } finally {
    bitmap.close();
  }
  // Safari 일부는 WebP 로 못 굽고 PNG 를 준다. 버킷이 받는 형식이면 그대로 쓴다.
  const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/png" ? "png" : "jpg";
  const path = `${productId}/${crypto.randomUUID()}.${ext}`;

  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
      method: "POST",
      headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, "Content-Type": blob.type },
      body: blob,
    });
  } catch {
    throw new ApiError(0, "Network error");
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body?.message === "string" && body.message) message = body.message;
    } catch {
      // 본문이 JSON 이 아니면 상태 줄 그대로.
    }
    if (/bucket not found/i.test(message)) {
      message = "The product photo store is missing — run migration 0068 in the Supabase SQL Editor.";
    } else if (/row-level security|unauthorized|403/i.test(message)) {
      message = "This account can't upload pictures. Sign in with a pro shop account (and check migration 0068).";
    }
    throw new ApiError(response.status, message);
  }
  return setProductPhoto(productId, `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`);
}

/** 사진 주소를 적는다. null 이면 사진을 뗀다(올린 파일은 남는다 — 지난 영수증 화면이 참조할 수 있다). */
export function setProductPhoto(productId: number, url: string | null): Promise<Product> {
  return staffRpc<Product>("pelham_staff_pos_product_photo", { p_id: productId, p_url: url });
}

// ===== 사진으로 찾기 ======================================================

export type PhotoCandidate = { product_id: number; confidence: "high" | "medium" | "low" };

export type PhotoMatch = {
  /** match = 확실한 것 하나(바로 담는다). choices = 직원이 고른다. none = 못 찾았다. */
  status: "match" | "choices" | "none";
  candidates: PhotoCandidate[];
  note: string;
  compared: number;
  skipped: number;
};

/** 영상의 지금 프레임을 JPEG(base64, 머리 없음)로. 전면 카메라여도 원본 방향 그대로 찍는다. */
export async function snapshotVideo(video: HTMLVideoElement): Promise<string> {
  if (!video.videoWidth || !video.videoHeight) throw new ApiError(422, "The camera is not ready yet.");
  const blob = await toCanvasBlob(video, video.videoWidth, video.videoHeight, SNAPSHOT_MAX_PX, "image/jpeg");
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buffer.length; i += 0x8000) {
    binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export async function matchPhoto(imageBase64: string): Promise<PhotoMatch> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in again to use photo search.");
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}/pos/photo-match`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ image: imageBase64, media_type: "image/jpeg" }),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check the connection and try again.");
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body?.detail === "string" && body.detail) message = body.detail;
    } catch {
      // JSON 이 아닌 오류 본문.
    }
    if (response.status === 404) message = "Photo search is not on the server yet. Deploy the API (Fly) first.";
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as PhotoMatch;
}
