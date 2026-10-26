#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""清洗长介绍库里的消歧义残留

问题：is_disambig() 的旧实现只查开头 40 字里的「可以指」，
      「南湖公园，可能是指：…」这种带逗号的写法漏过，
      导致消歧义内容直接混进了长介绍（用户可见）。
做法：按新规则重新判定，把消歧义条目从库里剔除并导出。
      剔掉的条目保留到 data/long_disambig.json 供后续 resolve_disambig 处理。
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, is_disambig, load_json, save_json

CACHE = os.path.join(DATA, 'long_db.json')
QUAR = os.path.join(DATA, 'long_disambig.json')

if __name__ == '__main__':
    db = load_json(CACHE, {})
    if not db:
        print('缓存为空')
        sys.exit(1)
    bad = {k: v for k, v in db.items() if is_disambig(v)}
    if not bad:
        print('无消歧义残留 ✓')
        sys.exit(0)
    print('发现消歧义残留 %d 条：' % len(bad))
    for k in list(bad)[:10]:
        print('   %s | %s' % (k, bad[k][:50].replace('\n', ' ')))
    # 保留到单独文件，方便后续用 resolve_disambig 处理
    prev = load_json(QUAR, {})
    prev.update(bad)
    save_json(QUAR, prev)
    for k in bad:
        db.pop(k, None)
    save_json(CACHE, db)
    print('已剔除 %d 条，剩余 %d 条' % (len(bad), len(db)))
    print('消歧义条目已存到 %s（可用 resolve_disambig.py 解析）' % QUAR)
