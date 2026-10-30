import json, pathlib, re
ROOT = pathlib.Path('/Users/kwangseobpark/golf-gps-pelhamhills-seven')
sp = pathlib.Path(__file__).parent
h = (ROOT/'frontend/public/admin/drone-guide.html').read_text()
slides, css, narr = (sp/'slides.html').read_text(), (sp/'extra.css').read_text(), json.load(open(sp/'narr.json'))
h = re.sub(r"<!-- 어드민 '드론.*?-->", "<!-- 어드민 'CCTV' 탭의 호프 가이드. drone-guide.html 의 화면과 플레이어를 그대로 씁니다. -->", h)
h = h.replace('<title>펠햄 힐스 드론 촬영 가이드</title>', '<title>Pelham Hills CCTV 연결도</title>')
a = h.index('<div class="stage" id="stage" aria-live="polite">') + len('<div class="stage" id="stage" aria-live="polite">')
b = h.index('<div class="bar">'); tail = h[:b].rstrip()
# stage 닫는 두 div 를 남깁니다
h = h[:a] + '\n' + slides + '    </div>\n  </div>\n\n  ' + h[b:]
h = h.replace('</style>\n\n</head>', css + '</style>\n\n</head>')
a = h.index('const NARR = ['); b = h.index('];', a) + 2
h = h[:a] + 'const NARR = ' + json.dumps(narr, ensure_ascii=False, indent=1) + ';' + h[b:]
h = h.replace("// Hope's clips, baked with ElevenLabs (voice OYTbf65OHHFELVut7v2H, eleven_multilingual_v2).", "// Hope's clips, baked with ElevenLabs (Hope natural, voice tnSpp4vdxKPjI9w0GnoV, eleven_multilingual_v2).")
h = h.replace("// 클립은 public/audio/drone/ 에 있습니다 (hope-tts 로 구움, voice OYTbf65OHHFELVut7v2H).\nconst clipUrl = (l, i) => `/audio/drone/slide-${i + 1}-${l}.mp3`;",
 "// 클립은 public/audio/cctv/ 에 있습니다.\nconst clipUrl = (l, i) => `/audio/cctv/slide-${i + 1}-${l}.mp3`;")
h = h.replace('ElevenLabs Hope 목소리', 'ElevenLabs Hope Natural').replace('ElevenLabs Hope voice', 'ElevenLabs Hope Natural')
h = h.replace("e.code === 'Lang2' ||", "e.code === 'Lang2' || e.code === 'KeyL' ||")
assert 'audio/drone' not in h and 'OYTbf' not in h and 'data:image/jpeg' not in h
(ROOT/'frontend/public/admin/cctv-guide.html').write_text(h)
# 아티팩트판: 뼈대는 게시 때 씌워지고, 소리는 옆의 audio/ 에서 읽습니다.
art = re.sub(r'^<!doctype html>.*?(<title>)', r'\1', h, flags=re.S).replace('</head>\n<body>\n','').replace('</body>\n</html>','').replace('`/audio/cctv/slide-', '`audio/slide-')
(sp.parent/'pelham-cctv-map.html').write_text(art)
s = re.findall(r'<script>(.*?)</script>', h, re.S)[-1]; (sp/'p.js').write_text(s)
print(len(h), len(art))
