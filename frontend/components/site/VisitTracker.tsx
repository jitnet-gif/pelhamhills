"use client";

/** 손님이 들어온 입구를 기억한다(0067, `lib/booking/attribution.ts`). 화면에는 아무것도 그리지 않는다. */

import { useEffect } from "react";

import { captureVisit } from "@/lib/booking/attribution";

export default function VisitTracker() {
  useEffect(() => {
    captureVisit();
  }, []);
  return null;
}
