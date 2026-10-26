"""把百科图片下载到仓库本地，随站点托管。

为什么必须本地化：
    bkimg.cdn.bcebos.com 有防盗链——带 Referer 直连 403，跨站请求也 403。
    <img> 可以靠 referrerpolicy="no-referrer" 绕过，但 Three.js 的 TextureLoader
    无法设置该属性（3D 场景里的实景看板会直接失败）。
    下载到同源目录后，一切请求都同源，彻底摆脱防盗链与第三方可用性问题。

    so1.360tres.com（360 图搜返回的 CDN 镜像）虽然能直连，但同样不保证长期可用，
    且加载要走第三方域名，所以一并本地化。

数据源（按优先级，前者已下过的跳过）：
    1) data/baike_db.json      百科 HTML 抓到的 179 条（bkimg CDN）
    2) data/baike_api_db.json  openapi + 图搜抓到的（每条最多 3 个候选，逐个试）

文件名用景点名的 md5，避免中文路径在 Windows/GitHub Pages 上的编码问题。
下载后统一压到 800px 宽 / JPEG 80，1860 张图从约 150MB 降到约 90MB，
卡片与详情页的显示尺寸（≤800px）不受影响。

用法：python tools/download_baike_img.py [--conc 8] [--maxw 800] [--quality 80]
"""
import hashlib
import io
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
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      'Chrome/120.0 Safari/537.36')

CONC = 8
MAXW = 800
QUALITY = 80
FORCE = '--force' in sys.argv
if '--conc' in sys.argv:
    CONC = int(sys.argv[sys.argv.index('--conc') + 1])
if '--maxw' in sys.argv:
    MAXW = int(sys.argv[sys.argv.index('--maxw') + 1])
if '--quality' in sys.argv:
    QUALITY = int(sys.argv[sys.argv.index('--quality') + 1])

try:
    from PIL import Image
except Exception:                                    # 无 Pillow 时退化为原图直存
    Image = None

os.makedirs(OUT_DIR, exist_ok=True)
index = load_json(INDEX, {})
todo = []


def add(name, urls, ref):
    urls = [u.strip() for u in (urls or []) if u and u.strip().startswith('https://')]
    if not urls:
        return
    key = hashlib.md5(name.encode('utf-8')).hexdigest()[:16]
    path = os.path.join(OUT_DIR, key + '.jpg')
    rel = 'img/baike/%s.jpg' % key
    if not FORCE and os.path.exists(path) and os.path.getsize(path) > 5000:
        index[name] = rel
        return
    todo.append((name, urls, path, rel, ref))


# 1) 百科 HTML 源
for name, v in load_json(os.path.join(DATA, 'baike_db.json'), {}).items():
    if v.get('ok'):
        add(name, [v.get('img')], 'https://baike.baidu.com/')

# 2) openapi + 图搜源
for name, v in load_json(os.path.join(DATA, 'baike_api_db.json'), {}).items():
    add(name, v.get('imgs'), 'https://image.so.com/')

print('待下载 %d 张（已有 %d）｜压缩 %s｜并发 %d'
      % (len(todo), len(index), ('%dpx q%d' % (MAXW, QUALITY)) if Image else '关闭', CONC))


def shrink(data):
    """等比压到 MAXW 宽；失败则原样返回（宁可大图也不要没图）"""
    if not Image or MAXW <= 0:
        return data
    try:
        im = Image.open(io.BytesIO(data))
        if im.mode != 'RGB':
            im = im.convert('RGB')
        w, h = im.size
        if w > MAXW:
            im = im.resize((MAXW, max(1, round(h * MAXW / w))), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, 'JPEG', quality=QUALITY, optimize=True, progressive=True)
        out = buf.getvalue()
        return out if out and len(out) < len(data) * 1.3 else data
    except Exception:
        return data


def fetch(item):
    name, urls, path, rel, ref = item
    err = 'no-url'
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': ref})
            data = urllib.request.urlopen(req, timeout=20).read()
            if len(data) < 3000:
                err = 'too-small:%dB' % len(data)
                continue
            if data[:2] != b'\xff\xd8' and data[:4] != b'\x89PNG':
                err = 'not-image'
                continue
            io.open(path, 'wb').write(shrink(data))
            return name, rel, len(data)
        except Exception as e:
            err = str(e)[:50]
    return name, None, err


ok = 0
fail_eg = []
t0 = time.time()
with ThreadPoolExecutor(max_workers=CONC) as ex:
    futs = [ex.submit(fetch, it) for it in todo]
    for i, f in enumerate(as_completed(futs), 1):
        name, rel, info = f.result()
        if rel:
            index[name] = rel
            ok += 1
        elif len(fail_eg) < 5:
            fail_eg.append('%s: %s' % (name, info))
        if i % 50 == 0:
            print('  %d/%d 成功 %d' % (i, len(todo), ok), flush=True)
            save_json(INDEX, index)

save_json(INDEX, index)
total_size = 0
for rel in index.values():
    p = os.path.join(ROOT, rel.replace('/', os.sep))
    if os.path.exists(p):
        total_size += os.path.getsize(p)

print('\n下载完成：本次成功 %d，索引共 %d 条，占用 %.1f MB，用时 %.0fs'
      % (ok, len(index), total_size / 1024 / 1024, time.time() - t0))
if fail_eg:
    print('失败样例：' + '；'.join(fail_eg))
print('索引 →', INDEX)
