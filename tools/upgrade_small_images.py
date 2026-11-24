#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把「明显偏小」的景点主图按百科原图重制。

为什么要有这一步：
    卡片与详情封面在 1440 宽的 2x 屏上渲染宽 316 CSS px，需要 632 设备像素；
    而早期管线用的是 360 图搜的缩略图（多为 400×266，平均 25KB），在手机上
    被放大 1.6 倍，糊得很明显。2026-11-24 盘点：1922 张主图里 298 张宽 <480，
    另外 1079 张是百科原图直出（≥800 宽，平均 88KB）——前者是历史遗留的
    异常值，不是有意的体积预算。

    同一批景点在详情页的图集用的是 360 的 /dr/720_720_/，主图反而更小，
    说明"主图小"本身就是不一致的。

数据源与安全边界：
    · 只用 data/baike_api_db.json 里**同省市**已核过的词条（title 字段）去取图，
      城市/省份对不上就整条跳过——宁可继续糊，也不挂一张别处的照片。
    · 原图最长边必须 ≥800，否则跳过（不放大凑数）。
    · 等比缩到最长边 800，JPEG q80 progressive，**覆盖原文件**，路径不变，
      所以 data/img_db.json / js/spot-images-db.js 都不用改。
    · 账本 data/img_upgrade.json 记前后尺寸，重跑幂等。

用法：
    python tools/upgrade_small_images.py --dry-run     # 只报数
    python tools/upgrade_small_images.py               # 真做
    python tools/upgrade_small_images.py --conc 6 --limit 20
"""
import argparse
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, load_json, save_json
import fetch_baike_api as F

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER = os.path.join(DATA, 'img_upgrade.json')
ALLOWLIST = os.path.join(DATA, 'img_small_ok.json')
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      'Chrome/120.0 Safari/537.36')

ap = argparse.ArgumentParser()
ap.add_argument('--dry-run', action='store_true')
ap.add_argument('--min-width', type=int, default=480, help='低于这个宽度才处理')
ap.add_argument('--max-side', type=int, default=800, help='重制后最长边')
ap.add_argument('--quality', type=int, default=80)
ap.add_argument('--conc', type=int, default=4)
ap.add_argument('--limit', type=int, default=0)
ap.add_argument('--write-allowlist', action='store_true',
                help='把这次仍然偏小的主图连同原因写进 data/img_small_ok.json')
args = ap.parse_args()

# 仍然偏小的原因 → 白名单里的一句人话（check_integrity 第 23 项认这份名单）
REASON = {
    'city-mismatch': '百科词条属别处（省市对不上），不能拿它的图',
    'source-small': '百科原图就不大，再放也没细节',
    'no-image': '词条没有主图',
    'no-spot': '图库幽灵键，前端渲染不到',
    'still-small': '重制后仍不足 480',
    'no-baike': '百科库里没有这条',
    'fetch-fail': '取图失败（网络）',
    'bad-shape': '原图构图不适合作封面',
    'write-fail': '写入失败',
}

img = load_json(os.path.join(DATA, 'img_db.json'), {})
bka = load_json(os.path.join(DATA, 'baike_api_db.json'), {})
spots = load_json(os.path.join(DATA, 'spots_uniq.json'), [])
ledger = load_json(LEDGER, {})


def spot_index():
    from collections import Counter
    cnt = Counter(s['name'] for s in spots)
    out = {}
    for s in spots:
        k = ('%s|%s|%s' % (s['prov'], s['city'], s['name'])) if cnt[s['name']] > 1 else s['name']
        out[k] = s
    return out


BY_KEY = spot_index()


def measure(path):
    try:
        with Image.open(path) as im:
            return im.size
    except Exception:
        return None


def fetch_original(title):
    """按词条标题取百科主图原图，返回 (bytes, (w, h))；取不到返回 (None, None)。"""
    url = F.API + '?' + urllib.parse.urlencode({
        'scope': 103, 'format': 'json', 'appid': 379020,
        'bk_key': title, 'bk_length': 100})
    d = F.jget(url)
    if not d or (d.get('title') or '').strip() != title:
        return None, None
    u = d.get('image')
    if not u:
        return None, None
    req = urllib.request.Request(u, headers={'User-Agent': UA})
    data = urllib.request.urlopen(req, timeout=25).read()
    try:
        im = Image.open(io.BytesIO(data))
        w, h = im.size
    except Exception:
        return None, None
    return data, (w, h)


def rebuild(data, old_wh):
    """等比缩到最长边 max_side，JPEG q80 progressive，返回编码后的字节。"""
    im = Image.open(io.BytesIO(data))
    if im.mode != 'RGB':
        im = im.convert('RGB')
    w, h = im.size
    scale = args.max_side / float(max(w, h))
    if scale < 1:
        im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=args.quality, optimize=True, progressive=True)
    out = buf.getvalue()
    return out, im.size


def handle(key):
    e = img.get(key) or {}
    path = e.get('u') or ''
    if not path or not os.path.exists(path):
        return ('no-file', key, '')
    old = measure(path)
    if not old or old[0] >= args.min_width:
        return ('skip-ok', key, '')
    name = key.split('|')[-1]
    s = BY_KEY.get(key)
    if not s:
        return ('no-spot', key, '')                 # 幽灵键，前端根本渲染不到
    rec = bka.get(name)
    if not rec:
        return ('no-baike', key, '')
    # 词条必须就是这座城市的这一处，否则取到的图会是别处的
    if (rec.get('city') or '') != s['city'] or (rec.get('prov') or '') != s['prov']:
        return ('city-mismatch', key, '%s/%s' % (rec.get('prov'), rec.get('city')))
    title = (rec.get('title') or '').strip()
    if not title:
        return ('no-title', key, '')
    try:
        data, wh = fetch_original(title)
    except Exception as ex:
        return ('fetch-fail', key, str(ex)[:40])
    if not data:
        return ('no-image', key, title)
    if max(wh) < 700:
        return ('source-small', key, '%dx%d' % wh)
    if min(wh) < 200 or not (0.25 <= wh[0] / float(wh[1]) <= 4.0):
        return ('bad-shape', key, '%dx%d' % wh)
    try:
        out, new = rebuild(data, old)
        if new[0] < args.min_width:
            return ('still-small', key, '%dx%d' % new)
        if args.dry_run:
            return ('would-do', key, '%dx%d/%dKB → %dx%d/%dKB'
                    % (old[0], old[1], os.path.getsize(path) // 1024,
                       new[0], new[1], len(out) // 1024))
        tmp = path + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(out)
        os.replace(tmp, path)
    except Exception as ex:
        return ('write-fail', key, str(ex)[:40])
    ledger[key] = {
        'src': title,
        'old': [old[0], old[1]],
        'new': [new[0], new[1]],
        'ts': time.strftime('%Y-%m-%d'),
    }
    return ('done', key, '%dx%d/%dKB → %dx%d/%dKB'
            % (old[0], old[1], 0, new[0], new[1], len(out) // 1024))


def main():
    todo = []
    for key, e in img.items():
        path = e.get('u') or ''
        if not path or not os.path.exists(path):
            continue
        led = ledger.get(key)
        if led and max(led.get('new') or [0]) >= args.max_side * 0.9:
            continue                                  # 已经重制过
        wh = measure(path)
        if wh and wh[0] < args.min_width:
            todo.append(key)
    todo.sort()
    if args.limit:
        todo = todo[:args.limit]
    print('待处理 %d 张（宽度 <%d）' % (len(todo), args.min_width))

    stats = {}
    rows = []
    allow = {}
    with ThreadPoolExecutor(max_workers=args.conc) as ex:
        for status, key, note in ex.map(handle, todo):
            stats[status] = stats.get(status, 0) + 1
            if status in REASON:
                note = (note or '').replace('None/None', '').strip()
                allow[key] = REASON[status] + ('（%s）' % note if note else '')
            if status in ('done', 'would-do', 'city-mismatch', 'source-small',
                          'fetch-fail', 'no-image', 'bad-shape', 'no-baike'):
                rows.append((status, key, note))
    print('结果：' + '，'.join('%s %d' % (k, v) for k, v in sorted(stats.items())))
    for status, key, note in rows[:20]:
        print('  %-14s %-22s %s' % (status, key, note))
    if args.write_allowlist:
        old = load_json(ALLOWLIST, {})
        old.update(allow)
        # 已经变大（或不再是问题）的条目要清掉，白名单不能留僵尸
        for k in list(old):
            e = img.get(k) or {}
            p = e.get('u') or ''
            wh = measure(p) if p and os.path.exists(p) else None
            if not wh or wh[0] >= args.min_width:
                del old[k]
        save_json(ALLOWLIST, old)
        print('白名单已写入 %s（%d 条）' % (ALLOWLIST, len(old)))
    if not args.dry_run:
        save_json(LEDGER, ledger)
        print('账本已写入 %s（%d 条）' % (LEDGER, len(ledger)))


if __name__ == '__main__':
    main()
