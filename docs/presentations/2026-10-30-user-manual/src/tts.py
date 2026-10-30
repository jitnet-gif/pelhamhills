import json, os, subprocess, sys, urllib.request, urllib.error

# Hope, Natural tone = the voice's saved settings, same as the AI Manager's "natural" (no voice_settings sent).
here = os.path.dirname(os.path.abspath(sys.argv[0]))
key = None
for line in open("/Users/kwangseobpark/pelhamhills/.env"):
    if line.startswith("ELEVENLABS_API_KEY="):
        key = line.split("=", 1)[1].strip().strip('"')
narr = json.load(open(os.path.join(here, "narr.json")))
old = {}
p = os.path.join(here, "said.json")
if os.path.exists(p):
    old = json.load(open(p))
sent = 0
for s in narr:
    for lang in ("ko", "en"):
        out = os.path.join(here, "..", "audio", lang, s["id"] + ".mp3")
        k = f"{lang}/{s['id']}"
        if old.get(k) == s[lang] and os.path.exists(out):
            continue
        req = urllib.request.Request(
            "https://api.elevenlabs.io/v1/text-to-speech/tnSpp4vdxKPjI9w0GnoV",
            data=json.dumps({"text": s[lang], "model_id": "eleven_multilingual_v2"}).encode(),
            headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        )
        try:
            data = urllib.request.urlopen(req, timeout=120).read()
        except urllib.error.HTTPError as e:
            print("FAILED", k, e.code, e.read()[:200])
            json.dump(old, open(p, "w"), ensure_ascii=False)
            sys.exit(1)
        open(out, "wb").write(data)
        old[k] = s[lang]
        sent += len(s[lang])
    json.dump(old, open(p, "w"), ensure_ascii=False)
print("sent chars", sent)
