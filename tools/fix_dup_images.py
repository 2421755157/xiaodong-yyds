#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""给重名景点分别抓本地照片（按「省|市|名」分键）。

背景：img_db 一直按裸景点名做键，46 个重名景点（101 处）共用同一张主图，
杭州西湖的照片被惠州西湖、绍兴东湖的照片被武汉东湖拿去当实拍图。
简介库、坐标库早已按「省|市|名」分键（见 2026-11-04 / 11-05 两轮），图片库是最后一块。

做法：对每个重名景点用「城市+景点名」搜 360 图搜（JSON 接口，不碰百科 HTML），
只接受标题里同时出现景点名或城市、且不是地图/徽标/路牌的候选，
下载压到 800px 存本地（同源托管），写进 img_db 的「省|市|名」键。
抓不到的就不写——宁可显示主题占位图，也不挂外地照片。

用法：
    python tools/fix_dup_images.py --probe     # 只探测命中率，不写文件
    python tools/fix_dup_images.py             # 抓图并写库
    python tools/fix_dup_images.py --limit 10  # 小批量试跑
"""
import collections
import hashlib
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_baike_api as F
from common import DATA, load_json, save_json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'img', 'baike')
IMG_API = F.IMG_API
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      'Chrome/120.0 Safari/537.36')

PROBE = '--probe' in sys.argv
LIMIT = None
if '--limit' in sys.argv:
    LIMIT = int(sys.argv[sys.argv.index('--limit') + 1])

# 地图 / 徽标 / 路牌 / 非照片：一旦标题命中就整条丢弃
BAD_TITLE = re.compile(
    r'(地图|政区|行政区|位置图|交通图|线路图|示意|logo|標誌|标志|徽|印章|'
    r'\bmap\b|locator|flag|coat of arms|seal|sign_no_name|\.svg)', re.I)

# 旅行社线路海报 / 多图拼贴：标题里带这些词的多半是「上海+苏州+杭州」一屏拼图，
# 当景点实拍图会很怪（一张图里好几个城市）。
PROMO_TITLE = re.compile(
    r'(双飞|跟团|纯玩|二选一|自由行|行程|报价|定制游|旅游攻略|门票预订|'
    r'旅行社|旅游网|酒店|机票|自驾|几日游|\d+日游)', re.I)

try:
    from PIL import Image
except Exception:
    Image = None


def key_of(s):
    return '%s|%s|%s' % (s['prov'], s['city'], s['name'])


def search(name, city, prov):
    """返回 [(url, title)]，按「城市+名」优先。"""
    queries = ['%s%s' % (city, name), '%s%s' % (name, city)]
    if prov and prov != city:
        queries.append('%s%s' % (prov, name))
    out, seen = [], set()
    for q in queries:
        url = IMG_API + '?' + urllib.parse.urlencode({'q': q, 'pn': 0, 'rn': 30})
        d = F.jget(url, referer='https://image.so.com/') or {}
        for it in (d.get('list') or []):
            u = (it.get('thumb') or '').strip()
            t = (it.get('title') or '').strip()
            if not u.startswith('http') or u in seen:
                continue
            if F.IMG_BAD_URL.search(u) or BAD_TITLE.search(t) or PROMO_TITLE.search(t):
                continue
            try:
                w = int(it.get('width') or 0)
                h = int(it.get('height') or 0)
            except Exception:
                w = h = 0
            if w and h and (w < 480 or h < 280):
                continue
            ratio = (w / h) if h else 1.5
            if w and h and not (0.95 <= ratio <= 2.8):
                continue
            seen.add(u)
            out.append((u, t, w, h))
        if len(out) >= 8:
            break
    return out


def score(cand, name, city):
    u, t, w, h = cand
    s = 0.0
    if name and name in t:
        s += 5
    if city and city in t:
        s += 5          # 标题点名城市：这是「本地那一处」最硬的证据
    if 1.2 <= (w / h if h else 1.5) <= 2.0:
        s += 1.0
    return s


def download(url, path):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Referer': 'https://image.so.com/'})
    with urllib.request.urlopen(req, timeout=25) as r:
        raw = r.read()
    if len(raw) < 8000:
        return 0
    if Image:
        try:
            im = Image.open(io.BytesIO(raw))
            im = im.convert('RGB')
            if im.width > 800:
                im = im.resize((800, round(im.height * 800 / im.width)), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, 'JPEG', quality=80, optimize=True, progressive=True)
            raw = buf.getvalue()
        except Exception:
            return 0
    with open(path, 'wb') as f:
        f.write(raw)
    return len(raw)


def one(s):
    """抓一处景点的本地照片，返回 (key, 结果字典) 或 (key, None)

    只接受「标题里同时有城市与景点名」的候选（tier3）。
    仅有景点名的候选（tier2）实测会把马鞍山太白楼抓成歙县太白楼、青海白马寺抓成洛阳的，
    这类宁可空着让前端显示主题占位图，也不当成本地实拍图。
    """
    k = key_of(s)
    h = hashlib.md5(k.encode('utf-8')).hexdigest()[:16]
    path = os.path.join(OUT_DIR, h + '.jpg')
    rel = 'img/baike/%s.jpg' % h
    cands = search(s['name'], s['city'], s['prov'])
    cands.sort(key=lambda c: -score(c, s['name'], s['city']))
    tier3 = [c for c in cands if s['city'] in c[1]]
    for conf, pool in ((3, tier3),):
        if not pool:
            continue
        c = pool[0]
        # 同批里再取两张作详情页补充图组（导出时统一换 720px 缩放地址）
        extra = [x[0] for x in pool[1:] if x[0] != c[0]][:2]
        if PROBE:
            return k, {'u': rel, 't': c[1], 'src': 'baike', 'conf': conf,
                       'extra': extra, 'probing': True}
        # 文件已存在说明本工具之前抓过同一张，直接复用，避免重跑换图
        if os.path.exists(path) and os.path.getsize(path) > 8000:
            return k, {'u': rel, 't': c[1], 'src': 'baike', 'conf': conf, 'extra': extra}
        try:
            n = download(c[0], path)
        except Exception:
            n = 0
        if n > 8000:
            return k, {'u': rel, 't': c[1], 'src': 'baike', 'conf': conf, 'extra': extra}
    return k, None


def main():
    spots = load_json(os.path.join(DATA, 'spots_uniq.json'), [])
    img = load_json(os.path.join(DATA, 'img_db.json'), {})
    by = collections.defaultdict(list)
    for s in spots:
        by[s['name']].append(s)
    dups = {n: v for n, v in by.items() if len(v) > 1}
    todo = [s for n, v in dups.items() for s in v]
    if LIMIT:
        todo = todo[:LIMIT]
    print('重名景点名 %d 个 / 待抓 %d 处%s' % (len(dups), len(todo), '（探测模式，不写文件）' if PROBE else ''))

    got, miss = {}, []
    with ThreadPoolExecutor(4) as ex:
        futs = {ex.submit(one, s): s for s in todo}
        for fu in as_completed(futs):
            s = futs[fu]
            try:
                k, v = fu.result()
            except Exception as e:
                k, v = key_of(s), None
                print('  ERR %s: %s' % (k, e))
            if v:
                got[k] = v
            else:
                miss.append(k)

    print('命中 %d / 缺失 %d' % (len(got), len(miss)))
    tiers = collections.Counter(v.get('conf') for v in got.values())
    print('证据档位（3=标题含城市+景点名，2=仅景点名）:', dict(sorted(tiers.items())))
    for k in miss:
        print('  缺图:', k)
    if PROBE:
        for k, v in list(got.items())[:5]:
            print('  ', k, '->', v['t'][:50])
        return

    # 只覆盖分城键；裸名键的处理交给 export_db 的「重名不回落」规则
    for k, v in got.items():
        img[k] = v
    save_json(os.path.join(DATA, 'img_db.json'), img)
    save_json(os.path.join(DATA, 'img_dup_missing.json'), miss)
    print('已写回 data/img_db.json：分城键 %d 条，缺失清单 %d 条' % (len(got), len(miss)))


if __name__ == '__main__':
    main()
