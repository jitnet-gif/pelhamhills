"""ElevenLabs Hope 로 장면 소리를 만든다. 톤·속도는 Fly `/ai-marketing/narrate` 와 같은 voice_settings 다.

  python3 tts.py                      # natural · 1× (목소리에 저장된 설정 그대로)
  TONE=lively SPEED=1.1 python3 tts.py

ElevenLabs 속도는 0.7–1.2. 그보다 빠른 것과 피치는 페이지(player.js)가 재생할 때 바꾼다.
"""

import json, os, subprocess, sys, urllib.request

here = os.path.dirname(os.path.abspath(sys.argv[0]))
key = None
for line in open("/Users/kwangseobpark/pelhamhills/.env"):
    if line.startswith("ELEVENLABS_API_KEY="):
        key = line.split("=", 1)[1].strip().strip('"')

TONES = {"calm": {"stability": 0.75, "style": 0.0}, "natural": {}, "lively": {"stability": 0.3, "style": 0.45}}
voice = dict(TONES[os.getenv("TONE", "natural")])
speed = min(1.2, max(0.7, float(os.getenv("SPEED", "1"))))
if round(speed, 2) != 1.0:
    voice["speed"] = round(speed, 2)

durs = {}
for lang in ("ko", "en"):
    narr = json.load(open(os.path.join(here, f"narr_{lang}.json")))
    durs[lang] = []
    for i, text in enumerate(narr):
        out = os.path.join(here, "audio", lang, f"s{i + 1}.mp3")
        payload = {"text": text, "model_id": "eleven_multilingual_v2"}
        if voice:
            payload["voice_settings"] = voice
        req = urllib.request.Request(
            "https://api.elevenlabs.io/v1/text-to-speech/tnSpp4vdxKPjI9w0GnoV",
            data=json.dumps(payload).encode(),
            headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        )
        open(out, "wb").write(urllib.request.urlopen(req).read())
        info = subprocess.run(["afinfo", out], capture_output=True, text=True).stdout
        sec = next(float(l.split()[-2]) for l in info.splitlines() if "estimated duration" in l)
        durs[lang].append(round(sec, 2))
json.dump(durs, open(os.path.join(here, "dur.json"), "w"))
print(voice or "natural 1x", durs)
