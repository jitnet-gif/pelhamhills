import json, os, pathlib, sys, time, urllib.request
ROOT = pathlib.Path('/Users/kwangseobpark/golf-gps-pelhamhills-seven')
key = next(l.split('=',1)[1].strip().strip('"\'') for l in (ROOT/'.env.local').read_text().splitlines() if l.startswith('ELEVENLABS_API_KEY'))
VOICE = 'tnSpp4vdxKPjI9w0GnoV'  # Hope natural
out = ROOT/'frontend/public/audio/cctv'; out.mkdir(exist_ok=True)
narr = json.load(open(pathlib.Path(__file__).parent/'narr.json'))
for i, s in enumerate(narr, 1):
    for lang in ('ko', 'en'):
        f = out/f'slide-{i}-{lang}.mp3'
        if f.exists() and f.stat().st_size: continue
        body = {'text': s[lang], 'model_id': 'eleven_multilingual_v2', 'voice_settings': {'stability': .5, 'similarity_boost': .75, 'style': .2, 'speed': 1.0}}
        req = urllib.request.Request(f'https://api.elevenlabs.io/v1/text-to-speech/{VOICE}?output_format=mp3_22050_32', json.dumps(body).encode(), {'xi-api-key': key, 'Content-Type': 'application/json'})
        f.write_bytes(urllib.request.urlopen(req, timeout=120).read()); print(f.name, f.stat().st_size); time.sleep(.3)
