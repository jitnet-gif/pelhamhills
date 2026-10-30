import json, os, subprocess, sys, urllib.request

here = os.path.dirname(os.path.abspath(sys.argv[0]))
key = None
for line in open("/Users/kwangseobpark/pelhamhills/.env"):
    if line.startswith("ELEVENLABS_API_KEY="):
        key = line.split("=", 1)[1].strip().strip('"')
durs = {}
for lang in ("ko", "en"):
    narr = json.load(open(os.path.join(here, f"narr_{lang}.json")))
    durs[lang] = []
    for i, text in enumerate(narr):
        out = os.path.join(here, "audio", lang, f"s{i + 1}.mp3")
        req = urllib.request.Request(
            "https://api.elevenlabs.io/v1/text-to-speech/tnSpp4vdxKPjI9w0GnoV",
            data=json.dumps({"text": text, "model_id": "eleven_multilingual_v2"}).encode(),
            headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        )
        open(out, "wb").write(urllib.request.urlopen(req).read())
        info = subprocess.run(["afinfo", out], capture_output=True, text=True).stdout
        sec = next(float(l.split()[-2]) for l in info.splitlines() if "estimated duration" in l)
        durs[lang].append(round(sec, 2))
json.dump(durs, open(os.path.join(here, "dur.json"), "w"))
print(durs)
