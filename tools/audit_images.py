#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""配图相关性审计：检查库里每条主图的文件名是否真的对得上景点名。
对不上的标为可疑（suspect），供后续重抓或降级使用。"""
import json, os, re, sys, urllib.parse
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, base_of, lcs_len, load_json

img = load_json(os.path.join(DATA, 'img_db.json'), {})


def fname(u):
    b = urllib.parse.unquote((u or '').rstrip('/').split('/')[-1])
    return re.sub(r'^\d+px-', '', b)


rows = []
for name, v in img.items():
    f = fname(v['u'])
    plain = re.sub(r'[^0-9A-Za-z一-鿿]', '', f)
    if name in plain:
        rel = 'strong'          # 文件名直接含景点名
    else:
        L = lcs_len(name, plain)
        rel = 'weak' if L >= 2 else 'none'
    rows.append((name, v.get('conf', 1), rel, v.get('src', ''), f[:46]))

cnt = Counter((r[1], r[2]) for r in rows)
print('按置信分 × 相关性：')
for (conf, rel), n in sorted(cnt.items()):
    print('  conf=%d  %-6s : %d 条' % (conf, rel, n))

suspects = [r for r in rows if r[1] >= 2 and r[2] != 'strong']
print('\n可疑条目（conf>=2 但文件名不含景点名）：%d 条' % len(suspects))
for r in suspects[:18]:
    print('  %-12s conf=%d %-6s %s' % (r[0], r[1], r[2], r[4]))

region_none = [r for r in rows if r[1] == 1]
print('\n地区泛图（conf=1）：%d 条（本来就是城市实景兜底）' % len(region_none))
json.dump([r[0] for r in suspects], open(os.path.join(DATA, 'suspect_images.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print('可疑名单 → data/suspect_images.json')
