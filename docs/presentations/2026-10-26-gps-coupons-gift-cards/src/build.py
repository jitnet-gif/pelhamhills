import json, os

here = os.path.dirname(os.path.abspath(__file__))
r = lambda n: open(os.path.join(here, n)).read()
narr = {"ko": json.load(open(os.path.join(here, "narr_ko.json"))), "en": json.load(open(os.path.join(here, "narr_en.json")))}
dur = json.load(open(os.path.join(here, "dur.json"))) if os.path.exists(os.path.join(here, "dur.json")) else {"ko": [], "en": []}
scenes = r("scenes.js").replace("__NARR__", json.dumps(narr, ensure_ascii=False)).replace("__DUR__", json.dumps(dur))
body = r("body.html").replace("<script>\n", "")
page = r("head.html") + r("extra.css") + r("tailcss.html") + body + "<script>\n" + scenes + "\n" + r("player.js")
open(os.path.join(here, "index.html"), "w").write(page)
print(len(page))
