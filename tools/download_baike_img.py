"""把百科图片下载到仓库本地，随站点托管。

为什么必须本地化：
    bkimg.cdn.bcebos.com 有防盗链——带 Referer 直连 403，跨站请求也 403。
    <img> 可以靠 referrerpolicy="no-referrer" 绕过，但 Three.js 的 TextureLoader
    无法设置该属性（3D 场景里的实景看板会直接失败）。
    下载到同源目录后，一切请求都同源，彻底摆脱防盗链与第三方可用性问题。

文件名用景点名的 md5，避免中文路径在 Windows/GitHub Pages 上的编码问题。

用法：python tools/download_baike_img.py [--conc 8]
"""
import hashlib
import io
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, load_json, save_json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'img', 'baike')
INDEX = os.path.join(DATA, 'baike_img_local.json')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'

CONC = 8
if '--conc' in sys.argv:
    CONC = int(sys.argv[sys.argv.index('--conc') + 1])

os.makedirs(OUT_DIR, exist_ok=True)
baike = load_json(os.path.join(DATA, 'baike_db.json'), {})
index = load_json(INDEX, {})

# 只处理有图的
todo = []
for name, v in baike.items():
    url = (v.get('img') or '').strip() if v.get('ok') else ''
    if not url or not url.startswith('https://'):
        continue
    key = hashlib.md5(name.encode('utf-8')).hexdigest()[:16]
    path = os.path.join(OUT_DIR, key + '.jpg')
    rel = 'img/baike/%s.jpg' % key
    if os.path.exists(path) and os.path.getsize(path) > 5000:
        index[name] = rel
        continue
    todo.append((name, url, path, rel))

print('待下载 %d 张（已有 %d）' % (len(todo), len(index)))


def fetch(item):
    name, url, path, rel = item
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        data = urllib.request.urlopen(req, timeout=20).read()
        if len(data) < 3000:
            return name, None, 'too-small:%dB' % len(data)
        if data[:2] != b'\xff\xd8' and data[:4] != b'\x89PNG':
            return name, None, 'not-image'
        io.open(path, 'wb').write(data)
        return name, rel, len(data)
    except Exception as e:
        return name, None, str(e)[:60]


ok = 0
t0 = time.time()
with ThreadPoolExecutor(max_workers=CONC) as ex:
    futs = [ex.submit(fetch, it) for it in todo]
    for i, f in enumerate(as_completed(futs), 1):
        name, rel, info = f.result()
        if rel:
            index[name] = rel
            ok += 1
        if i % 30 == 0:
            print('  %d/%d 成功 %d' % (i, len(todo), ok))

save_json(INDEX, index)
total_size = 0
for rel in index.values():
    p = os.path.join(ROOT, rel.replace('/', os.sep))
    if os.path.exists(p):
        total_size += os.path.getsize(p)

print('\n下载完成：本次成功 %d，索引共 %d 条，占用 %.1f MB，用时 %.0fs'
      % (ok, len(index), total_size / 1024 / 1024, time.time() - t0))
print('索引 →', INDEX)
