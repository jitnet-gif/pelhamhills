import { chromium } from "playwright";

const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
];

const browser = await chromium.launch();
const failures = [];

for (const viewport of viewports) {
  const page = await browser.newPage({ viewport });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });

  const title = await page.locator("h1").innerText();
  const ctaVisible = await page.getByRole("link", { name: "Book a Tee-Time" }).first().isVisible();
  const bookingHref = await page.getByRole("link", { name: "Book Now" }).getAttribute("href");
  const visitVisible = await page.getByText("196 Webber Road, Welland, ON").isVisible();

  if (!title.includes("Play golf and dine year-round")) {
    failures.push(`${viewport.name}: unexpected h1 "${title}"`);
  }
  if (!ctaVisible) {
    failures.push(`${viewport.name}: primary tee-time CTA is not visible`);
  }
  if (bookingHref !== "/booking") {
    failures.push(`${viewport.name}: booking CTA href is "${bookingHref}"`);
  }
  if (!visitVisible) {
    failures.push(`${viewport.name}: visit section heading is not visible`);
  }
  if (consoleErrors.length) {
    failures.push(`${viewport.name}: console errors: ${consoleErrors.join(" | ")}`);
  }

  await page.screenshot({
    path: `playwright-${viewport.name}.png`,
    fullPage: true,
  });
  await page.close();
}

const bookingPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await bookingPage.goto("http://localhost:3000/booking", { waitUntil: "networkidle" });
await bookingPage.evaluate(() => window.localStorage.clear());
await bookingPage.reload({ waitUntil: "networkidle" });
await bookingPage.getByLabel("Partners").fill("Alex, Jordan");
await bookingPage.getByLabel("SMS Notification").fill("+19057356768");
await bookingPage.getByRole("button", { name: "Create Wanted Slot" }).click();

const createdMessage = await bookingPage.getByText("Wanted tee-time request created.").isVisible();
const createdPartners = await bookingPage.getByText("Partners: Alex, Jordan").isVisible();
await bookingPage.getByRole("button", { name: "Mark Booked" }).first().click();
const bookedVisible = await bookingPage.getByText("booked").first().isVisible();
await bookingPage.screenshot({ path: "playwright-booking.png", fullPage: true });

if (!createdMessage) {
  failures.push("booking: creation confirmation is not visible");
}
if (!createdPartners) {
  failures.push("booking: created partners are not visible");
}
if (!bookedVisible) {
  failures.push("booking: booked status is not visible after marking booked");
}
await bookingPage.close();

const adminPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await adminPage.goto("http://localhost:3000/admin", { waitUntil: "networkidle" });
const adminTeeSheetVisible = await adminPage.getByText("Tee Sheet").first().isVisible();
const adminGridVisible = await adminPage.getByText("Xeric, Micah").first().isVisible();
await adminPage.screenshot({ path: "playwright-admin.png", fullPage: true });

if (!adminTeeSheetVisible) {
  failures.push("admin: tee sheet title is not visible");
}
if (!adminGridVisible) {
  failures.push("admin: tee sheet reservation grid is not visible");
}
await adminPage.close();

const teeSheetPage = await browser.newPage({ viewport: { width: 1440, height: 760 } });
await teeSheetPage.goto("http://localhost:3000/teesheet", { waitUntil: "networkidle" });
const teeSheetVisible = await teeSheetPage.getByText("Tee Sheet").first().isVisible();
const selectedBookingVisible = await teeSheetPage.getByText("Xeric, Micah").first().isVisible();
const collectButton = teeSheetPage.getByRole("button", { name: "Collect" }).first();
if (await collectButton.isVisible().catch(() => false)) {
  await collectButton.click();
  await teeSheetPage.getByRole("button", { name: "Paid" }).first().waitFor({ state: "visible" });
}
const paidVisible =
  (await teeSheetPage.getByRole("button", { name: "Paid" }).first().isVisible().catch(() => false)) ||
  (await teeSheetPage.getByRole("button", { name: "Collect" }).first().isVisible().catch(() => false));
await teeSheetPage.screenshot({ path: "playwright-teesheet.png", fullPage: true });

if (!teeSheetVisible) {
  failures.push("teesheet: title is not visible");
}
if (!selectedBookingVisible) {
  failures.push("teesheet: seeded reservation is not visible");
}
if (!paidVisible) {
  failures.push("teesheet: payment controls are not visible");
}
await teeSheetPage.close();

const menuPages = [
  ["/pricing", "Tee Times & Pricing"],
  ["/dynamic-pricing", "Dynamic Pricing"],
  ["/events", "Events"],
  ["/customers", "Customers"],
  ["/tour-operators", "Tour Operators"],
  ["/promotions", "Promotions"],
  ["/reports", "Reports"],
  ["/business-intelligence", "Business Intelligence"],
  ["/integrations", "Integrations"],
  ["/settings", "Settings"],
];

for (const [path, label] of menuPages) {
  const menuPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await menuPage.goto(`http://localhost:3000${path}`, { waitUntil: "networkidle" });
  const labelVisible = await menuPage.getByText(label).first().isVisible();
  if (!labelVisible) {
    failures.push(`menu ${path}: "${label}" is not visible`);
  }
  await menuPage.close();
}

await browser.close();

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  "Homepage, booking, admin, and tee sheet verified with Playwright. Screenshots: playwright-desktop.png, playwright-mobile.png, playwright-booking.png, playwright-admin.png, playwright-teesheet.png",
);
