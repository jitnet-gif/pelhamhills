import json, os, shutil, subprocess

here = os.path.dirname(os.path.abspath(__file__))
r = lambda n: open(os.path.join(here, n)).read()
files = ["base.js", "s1_start.js", "s2_tee.js", "s3_pay.js", "s4_reg.js", "s5_gift.js", "s6_coupon.js", "s7_mem.js", "s8_guest.js", "s9_mkt.js", "s10_admin.js"]
bars = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", os.path.join(here, "bars.mjs")], capture_output=True, text=True, check=True).stdout
scenes = "const BARS = " + bars + ";\n" + "\n".join(r(f) for f in files)
page = r("head.html") + r("extra.css") + r("tailcss.html") + r("body.html") + "<script>\n" + scenes + "\n" + r("player.js") + "</script>\n"
open(os.path.join(here, "..", "index.html"), "w").write(page)
# the app serves its own copy at /guides/user-manual/, a standalone page with no artifact wrapper around it
guide = os.path.join(here, "..", "..", "..", "..", "frontend", "public", "guides", "user-manual")
shutil.copytree(os.path.join(here, ".."), guide, dirs_exist_ok=True, ignore=shutil.ignore_patterns("src", "index.html"))
standalone = '<!doctype html>\n<html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="robots" content="noindex">\n' + page
open(os.path.join(guide, "index.html"), "w").write(standalone)
# narration comes from the scenes themselves, so the screen text and the voice cannot drift apart
subprocess.run(["node", "-e", """
const fs=require('fs');const src=process.argv[1];
const S=new Function('document','localStorage','return (function(){var localStorage={getItem(){return null},setItem(){}};'+src+';return S})()')();
fs.writeFileSync(process.argv[2],JSON.stringify(S.map(s=>({id:s.id,ko:s.say.ko,en:s.say.en})),null,0));
console.log(S.length,'scenes',S.reduce((a,s)=>a+s.say.ko.length+s.say.en.length,0),'chars');
""", scenes, os.path.join(here, "narr.json")], check=True)
print(len(page))
