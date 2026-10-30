import { code128Svg } from "../../../../frontend/lib/retail/barcode.ts";
const codes = ["GIFT-1A2B3C4D5E", "PROMO-FALL18", "CPN-7F3A91C04B"];
console.log(JSON.stringify(Object.fromEntries(codes.map((c) => [c, code128Svg(c)]))));
