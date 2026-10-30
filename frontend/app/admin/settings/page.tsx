"use client";

import { useState } from "react";

import AdminShell from "@/components/admin/AdminShell";
import ScreenLockCard from "@/components/admin/ScreenLockCard";

export default function SettingsPage() {
  const [courseName, setCourseName] = useState("Pelham Hills Golf Club");
  const [coursePhone, setCoursePhone] = useState("905-892-2196");
  const [interval, setInterval] = useState(9);
  const [taxRate, setTaxRate] = useState(13);
  const [cartFee, setCartFee] = useState(19.5);
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [smsAlerts, setSmsAlerts] = useState(true);
  const [cancelAlerts, setCancelAlerts] = useState(true);
  const [saved, setSaved] = useState("Unsaved local settings");

  return (
    <AdminShell
      actions={
        <>
          <span className="text-xs font-bold text-[#6b7280]">{saved}</span>
          <button
            className="tap-target bg-[#4533ff] px-5 py-2 text-xs font-bold text-white"
            onClick={() => setSaved("Saved locally")}
            type="button"
          >
            Save
          </button>
        </>
      }
      title="Settings"
    >
      <div className="min-w-0">
        <section className="grid grid-cols-[minmax(0,1fr)] gap-4 p-4 xl:grid-cols-[1fr_1fr]">
          <ScreenLockCard />

          <section className="border border-[#d6d6dc] bg-white">
            <div className="border-b border-[#d6d6dc] bg-[#d7d5da] px-3 py-2 text-xs font-bold">Course Information</div>
            <div className="grid gap-3 p-4 text-xs">
              <label className="font-bold">
                Course Name
                <input className="mt-1 w-full border border-[#d6d6dc] px-3 py-2 font-normal" value={courseName} onChange={(event) => { setCourseName(event.target.value); setSaved("Unsaved local settings"); }} />
              </label>
              <label className="font-bold">
                Phone
                <input className="mt-1 w-full border border-[#d6d6dc] px-3 py-2 font-normal" value={coursePhone} onChange={(event) => { setCoursePhone(event.target.value); setSaved("Unsaved local settings"); }} />
              </label>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="font-bold">
                  Tee Interval
                  <input className="mt-1 w-full border border-[#d6d6dc] px-3 py-2 font-normal" min={6} max={15} type="number" value={interval} onChange={(event) => { setInterval(Number(event.target.value)); setSaved("Unsaved local settings"); }} />
                </label>
                <label className="font-bold">
                  Tax %
                  <input className="mt-1 w-full border border-[#d6d6dc] px-3 py-2 font-normal" min={0} step="0.1" type="number" value={taxRate} onChange={(event) => { setTaxRate(Number(event.target.value)); setSaved("Unsaved local settings"); }} />
                </label>
                <label className="font-bold">
                  Cart Fee
                  <input className="mt-1 w-full border border-[#d6d6dc] px-3 py-2 font-normal" min={0} step="0.5" type="number" value={cartFee} onChange={(event) => { setCartFee(Number(event.target.value)); setSaved("Unsaved local settings"); }} />
                </label>
              </div>
            </div>
          </section>

          <section className="border border-[#d6d6dc] bg-white">
            <div className="border-b border-[#d6d6dc] bg-[#d7d5da] px-3 py-2 text-xs font-bold">Notification Settings</div>
            <div className="grid gap-3 p-4 text-xs">
              {[
                { label: "Email staff when a tee time is booked", checked: emailAlerts, set: setEmailAlerts },
                { label: "SMS pro shop for same-day changes", checked: smsAlerts, set: setSmsAlerts },
                { label: "Flag cancellation and refund tasks", checked: cancelAlerts, set: setCancelAlerts },
              ].map((item) => (
                <label className="flex items-center justify-between border border-[#ececf0] px-3 py-2 font-bold" key={item.label}>
                  <span>{item.label}</span>
                  <input checked={item.checked} onChange={(event) => { item.set(event.target.checked); setSaved("Unsaved local settings"); }} type="checkbox" />
                </label>
              ))}
              <div className="bg-[#fffbd5] p-3 leading-5 text-[#2f2f21]">
                <p className="font-bold">Preview</p>
                <p>{courseName} uses {interval}-minute tee intervals with {taxRate}% tax and ${cartFee.toFixed(2)} cart fee.</p>
              </div>
            </div>
          </section>
        </section>
      </div>
    </AdminShell>
  );
}
