#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""修掉图库里"打不开"和"太大"的外链图片。

两类问题（2026-11 实测）：

1. **死链域名**。图组里还留着 212 张 wikimedia 和 39 张 bcebos 地址：
   - `thumb/upload.wikimedia.org` 在国内网络不可达（返回空/超时）
   - `bkimg.cdn.bcebos.com` 有防盗链，跨站 <img> 直接 403
   这些格子打开详情页就是空白，一直在那儿。

2. **原图过大**。360 CDN 返回的是原图，单张常 1.2MB（1280×960），
   详情页一次拉主图 + 2 张补充图就是 3MB+。CDN 支持 `/dr/W_H_/` 端点，
   同图 600px 只要 71KB（-94%），卡片和 3 格图集根本用不到原图。

处理策略：
    - 主图必须是本地同源（img/baike/*.jpg）；仍是外链的（35 个冷门景点，
      百科抓取失败留下的 wiki 兜底）→ 图搜补一张并下载到本地
    - 补充图统一改写为 CDN 缩放地址；死链域名直接剔除
    - 剔除后没有补充图的景点 → 图搜补 1~2 张（同样用缩放地址，不落地）

用法：
    python tools/fix_remote_images.py --dry-run
    python tools/fix_remote_images.py            # 写回 data/img_db.json
"""
import argparse
import hashlib
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, base_of, load_json, save_json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'img', 'baike')
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

SHRINK_W = 720          # 3 格图集单格在桌面端 ≤ 340 CSS px，720 足够 2x
DEAD_HOSTS = ('wikimedia.org', 'bcebos.com')
CDN_HOSTS = ('qhimgs1.com', 'qhimgs2.com', 'qhimgs3.com', 'qhimgs4.com',
             'qhimgs5.com', 'qhimgs6.com')

try:
    from PIL import Image
except Exception:                                    # 无 Pillow 时直存原图
    Image = None

import fetch_baike_api as F                          # 复用图搜与排序


def host_of(u):
    try:
        return (urllib.parse.urlparse(u).hostname or '').lower()
    except Exception:
        return ''


def is_local(u):
    return bool(u) and u.startswith('img/')


def is_dead(u):
    h = host_of(u)
    return any(h == d or h.endswith('.' + d) for d in DEAD_HOSTS)


def shrink(u, w=SHRINK_W):
    """把 360 CDN 原图地址换成缩放地址；其它域名原样返回"""
    h = host_of(u)
    if not any(h.endswith(c) for c in CDN_HOSTS):
        return u
    p = urllib.parse.urlparse(u)
    if '/dr/' in p.path:
        return u
    path = '/dr/%d_%d_%s' % (w, w, p.path)
    return urllib.parse.urlunparse((p.scheme, p.netloc, path, p.params, p.query, ''))


def download(u, dest):
    req = urllib.request.Request(u, headers={
        'User-Agent': UA, 'Referer': 'https://image.so.com/'})
    raw = urllib.request.urlopen(req, timeout=25).read()
    if len(raw) < 4000:
        raise ValueError('too small: %d B' % len(raw))
    if Image is None:
        with open(dest, 'wb') as f:
            f.write(raw)
        return len(raw)
    im = Image.open(io.BytesIO(raw)).convert('RGB')
    w = min(800, im.width)
    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    im.save(dest, 'JPEG', quality=80, optimize=True, progressive=True)
    return os.path.getsize(dest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--mains-only', action='store_true', help='只补主图，跳过图组补抓')
    ap.add_argument('--gap', type=float, default=0.3)
    args = ap.parse_args()

    img_db = load_json(os.path.join(DATA, 'img_db.json'), {})
    spots = {s['name']: s for s in load_json(os.path.join(DATA, 'spots_uniq.json'), [])}
    api = load_json(os.path.join(DATA, 'baike_api_db.json'), {})
    local_idx = load_json(os.path.join(DATA, 'baike_img_local.json'), {})
    if not img_db:
        print('data/img_db.json 为空，先跑抓取')
        return

    dead_main = [k for k, v in img_db.items() if not is_local(v.get('u')) and is_dead(v.get('u'))]
    other_remote_main = [k for k, v in img_db.items()
                         if not is_local(v.get('u')) and not is_dead(v.get('u'))]
    n_drop = n_shrink = 0
    emptied = []
    for k, v in img_db.items():
        ex = []
        for u in (v.get('extra') or []):
            if is_dead(u):
                n_drop += 1
                continue
            s = shrink(u)
            n_shrink += 1
            if s not in ex and base_of(s) not in [base_of(x) for x in ex]:
                ex.append(s)
        v['extra'] = ex[:2]
        if is_local(v.get('u')) and not v['extra']:
            emptied.append(k)

    print('主图死链 %d 个｜其它外链主图 %d 个｜补充图剔除 %d 张 / 改写 %d 张'
          % (len(dead_main), len(other_remote_main), n_drop, n_shrink))
    print('补充图为空、可补抓的景点 %d 个' % len(emptied))
    if dead_main:
        print('  主图待补：' + '、'.join(dead_main[:10]) + ('…' if len(dead_main) > 10 else ''))
    if args.dry_run:
        return

    fixed_main = failed = 0
    for i, k in enumerate(dead_main + other_remote_main, 1):
        s = spots.get(k) or {}
        a = api.get(k) or {}
        title = a.get('title') or ''
        urls = F.fetch_images(k, title, s.get('city', ''))
        if not urls:
            # 冷门景点严格档会全否掉（标题带「攻略」、竖图、400px），放宽再来一次
            urls = F.fetch_images(k, title, s.get('city', ''), relaxed=True)
        if not urls:
            failed += 1
            print('  ✗ %-12s 图搜无结果' % k)
            continue
        rel = 'img/baike/%s.jpg' % hashlib.md5(k.encode('utf-8')).hexdigest()[:16]
        dest = os.path.join(ROOT, rel.replace('/', os.sep))
        got = False
        for u in urls[:3]:
            try:
                download(u, dest)
                got = True
                break
            except Exception as e:
                print('    试图失败 %s %s' % (str(e)[:34], u.split('/')[-1][:18]))
        if not got:
            failed += 1
            print('  ✗ %-12s 三张候选都下不动' % k)
            continue
        img_db[k]['u'] = rel
        img_db[k]['src'] = 'baike'
        local_idx[k] = rel
        fixed_main += 1
        if i % 10 == 0:
            print('  …主图 %d/%d' % (i, len(dead_main) + len(other_remote_main)))
        time.sleep(args.gap)
    print('主图补齐 %d 个，失败 %d 个' % (fixed_main, failed))

    # 主图刚补过的景点此时也没有补充图，一并纳入
    emptied = [k for k, v in img_db.items() if is_local(v.get('u')) and not v.get('extra')]
    if args.mains_only:
        emptied = []
        print('（--mains-only：跳过补充图补抓）')
    filled = 0
    for k in emptied:
        s = spots.get(k) or {}
        a = api.get(k) or {}
        urls = [shrink(u) for u in F.fetch_images(k, a.get('title') or '', s.get('city', ''))]
        urls = [u for u in urls if not is_dead(u)]
        # 首条常常就是主图那张，从第二条开始取，避免图集里出现同一张照片
        urls = urls[1:3] or urls[:2]
        if urls:
            img_db[k]['extra'] = urls
            filled += 1
        time.sleep(args.gap)
    print('补充图补抓 %d 个景点' % filled)

    save_json(os.path.join(DATA, 'img_db.json'), img_db)
    save_json(os.path.join(DATA, 'baike_img_local.json'), local_idx)
    print('已写回 data/img_db.json 与 data/baike_img_local.json')
    print('下一步：python tools/export_db.py && node tools/build_home_stats.mjs')


if __name__ == '__main__':
    main()
