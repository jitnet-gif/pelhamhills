"use client";

// 1번 티 스타터 폰의 티 시트. 회사 Android 폰의 Pelham Starter 앱이 이 주소를 띄운다(`android/starter`).
// 브라우저로 열어도 목록·찾기·체크인은 되고, 탭 결제와 인쇄만 앱 안에서 켜진다.
import AdminShell from "@/components/admin/AdminShell";
import StarterTeeSheet from "@/components/starter/StarterTeeSheet";

export default function StarterTeeSheetPage() {
  return (
    <AdminShell title="Tee Sheet" variant="starter">
      <StarterTeeSheet />
    </AdminShell>
  );
}
