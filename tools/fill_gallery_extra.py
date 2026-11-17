#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""给「只有 1 张补充图」的景点补上第二张，让详情页 3 格图集不再有两格是占位渐变。

为什么需要它
------------
2026-11-17 盘点：`spot-gallery-db.js` 里 630 处景点只有 0~1 张补充图 —— 打开详情页就是
「主图 + 1 张实景 + 1 张写着『实景图加载中…』的渐变占位」。这些景点的百科
词条只给了 1~2 张图，旧管线（merge_baike 取 imgs[1:3]）拿不到更多，于是
一直空着。而 360 图搜对同一批景点其实还有结果，只是严格档（要求横构图 /
宽≥480）把它们全否了。

做法
----
对每个缺口景点，用 `fetch_baike_api.fetch_images(relaxed=True, with_titles=True)`
宽松档取回候选，再过四道闸：
  1) 图片标题必须**含完整景点名**（「XX山」收到别处的山景不会被收）；
  2) 重名景点（西湖/南湖…）额外要求标题里含本市名 —— 分城键只保证查得到，
     保证不了搜回来的标题讲的是哪一处；
  3) 标题里带图库站名（汇图网/昵图网…）的不要，那些图上压着大白条水印；
  4) 落库前真下一遍：搜索接口给的尺寸是原图尺寸，实际可能只有 1.8KB 的空白图。
文件名去重（同一张图的 960px/1200px 缩略图算同一张）另算一道。
只往 `img_db` 的 `extra` 追加，不动主图、不动置信分。

幂等：图组已满 2 张的景点不在候选里；试过且没结果的记在
`data/gallery_fill_tried.json`，默认不再重试（`--retry` 可强制重来）。

用法
----
    python tools/fill_gallery_extra.py --dry-run          # 只看命中率
    python tools/fill_gallery_extra.py --limit 200        # 小步跑
    python tools/fill_gallery_extra.py                    # 跑完剩余的
    python tools/export_db.py                             # 再导出前端库
"""
import argparse
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, base_of, load_json, save_json
from fetch_baike_api import IMG_BAD_HARD, fetch_images

IMG_DB = os.path.join(DATA, 'img_db.json')
TRIED = os.path.join(DATA, 'gallery_fill_tried.json')
REJECT = os.path.join(DATA, 'img_gallery_reject.json')

# 图搜结果里混着「1×1 空白图」「占位图」这类东西：搜索接口给的
# width/height 是原图尺寸，真下下来只有 1~2KB（2026-11-17 实拍：石梅湾那张
# 只有 1820 字节，铺到图集里就是一格纯白）。所以落到图集前要真读一遍字节。
MIN_IMG_BYTES = 8192
MAGIC = (b'\xff\xd8\xff', b'\x89PNG', b'RIFF', b'GIF8')

# 图库站的图多半压着一整条水印（「汇图网 www.huitu.com 编号…」），铺到 340px 的
# 图集格子里就是半张图糊着白字。标题里带站名的直接不要。
STOCK_SITE = re.compile(r'汇图|昵图|千图|摄图|图库网|素材网|全景网|视觉中国|'
                        r'dreamstime|shutterstock|istock|depositphotos', re.I)

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_opener.addheaders = [('User-Agent', 'Mozilla/5.0'), ('Referer', 'https://image.so.com/')]


def image_ok(url, tries=2):
    """真取一次，确认是个像样的位图（不是空白图/错误页）"""
    for _ in range(tries):
        try:
            with _opener.open(url, timeout=15) as r:
                body = r.read()
                if len(body) < MIN_IMG_BYTES:
                    return False
                return body[:4].startswith(MAGIC) or body[:3].startswith(MAGIC)
        except Exception:
            time.sleep(0.6)
    return False


def spot_key(spot, img_db):
    """与前端/导出层一致的取键规则：有分城键就用分城键"""
    scoped = spot['prov'] + '|' + spot['city'] + '|' + spot['name']
    return scoped if scoped in img_db else spot['name']


def pick(name, city, need_city, cands, have, want):
    """从候选里挑出可用图；cands 形如 [(url, 图片标题)]

    need_city=True 用于重名景点：标题里光有「南湖」不知道是唐山那一处还是
    长春那一处，必须同时出现本市名才收。普通景点不强求城市 —— 标题常是
    「XX景区一日游」这类，拗城市反而把能用的图全否掉。
    """
    out = []
    for u, ttl in cands:
        if not u or not ttl:
            continue
        b = base_of(u)
        if b in have:
            continue
        if name not in ttl:                 # 闸 1：标题必须含完整景点名
            continue
        if need_city and city and city not in ttl:   # 闸 2：重名景点按城市消歧
            continue
        if IMG_BAD_HARD.search(ttl):
            continue
        if STOCK_SITE.search(ttl):           # 闸 3：图库站的水印图不要
            continue
        have.add(b)
        out.append(u)
        if len(out) >= want:
            break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--retry', action='store_true', help='连上次没结果的也重试')
    ap.add_argument('--conc', type=int, default=4)
    ap.add_argument('--names', default='', help='只处理这几处（逗号分隔）')
    args = ap.parse_args()

    spots = load_json(os.path.join(DATA, 'spots_uniq.json'), [])
    img_db = load_json(IMG_DB, {})
    reject = load_json(REJECT, {})
    tried = set(load_json(TRIED, []))
    only = {x.strip() for x in args.names.split(',') if x.strip()}

    dup = {n for n in {s['name'] for s in spots}
           if sum(1 for s in spots if s['name'] == n) > 1}

    todo = []
    for s in spots:
        k = spot_key(s, img_db)
        if k not in img_db:
            continue                        # 连主图都没有的（图集根本用不上），不在这里补
        if len((img_db[k].get('extra') or [])) >= 2:
            continue
        if k in reject or s['name'] in reject:
            continue
        if only and s['name'] not in only:
            continue
        if k in tried and not args.retry:
            continue
        todo.append((s, k))
    if args.limit:
        todo = todo[:args.limit]

    gap = sum(1 for s in spots
              if spot_key(s, img_db) in img_db
              and len(img_db[spot_key(s, img_db)].get('extra') or []) < 2)
    print('缺口景点 %d 处｜本轮处理 %d｜并发 %d｜%s'
          % (gap, len(todo), args.conc, '演练' if args.dry_run else '写库'), flush=True)

    stat = {'ok': 0, 'miss': 0, 'added': 0, 'done': 0}
    lock = __import__('threading').Lock()
    t0 = time.time()

    def work(item):
        s, k = item
        rec = img_db.get(k) or {}
        have = {base_of(rec.get('u', ''))}
        have |= {base_of(u) for u in (rec.get('extra') or [])}
        need = 2 - len([u for u in (rec.get('extra') or [])])
        cands = fetch_images(s['name'], s['name'], s.get('city', ''),
                             relaxed=True, with_titles=True)
        # 多挑两张备选：万一选中的是空白图/占位图，还能顺位换下一个
        pool = pick(s['name'], s.get('city', ''), s['name'] in dup,
                    cands, have, need + 2)
        got = []
        for u in pool:
            if image_ok(u):
                got.append(u)
                if len(got) >= need:
                    break
        return s, k, got

    with ThreadPoolExecutor(max_workers=args.conc) as ex:
        for s, k, got in ex.map(work, todo):
            with lock:
                stat['done'] += 1
                tried.add(k)
                if got:
                    stat['ok'] += 1
                    stat['added'] += len(got)
                    if not args.dry_run:
                        rec = img_db[k]
                        rec['extra'] = ((rec.get('extra') or []) + got)[:2]
                else:
                    stat['miss'] += 1
                n = stat['done']
                if n % 40 == 0:
                    if not args.dry_run:
                        save_json(IMG_DB, img_db)
                        save_json(TRIED, sorted(tried))
                    print('  %d/%d 命中 %d 处 / 新增 %d 张  %.0fs'
                          % (n, len(todo), stat['ok'], stat['added'], time.time() - t0),
                          flush=True)

    if not args.dry_run:
        save_json(IMG_DB, img_db)
        save_json(TRIED, sorted(tried))
    print('完成：处理 %d 处，命中 %d 处，新增 %d 张，落空 %d 处，用时 %.0fs'
          % (stat['done'], stat['ok'], stat['added'], stat['miss'], time.time() - t0))
    if not args.dry_run and stat['added']:
        print('下一步：python tools/export_db.py 重新导出 js/spot-gallery-db.js')


if __name__ == '__main__':
    main()
