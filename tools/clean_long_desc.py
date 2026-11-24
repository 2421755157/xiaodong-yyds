#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""清洗长介绍库：整段讲的是别处的正文必须剔掉

背景：短简介早就有地域闸门（place_guard + desc_block），长介绍却一直没人管——
fetch_long_desc.py 只判「是不是消歧义页」，抓回来直接入库。于是详情页的
「历史沿革」整块在讲别的城市：

    山东青岛「金沙滩」   ← 山西朔州金沙滩镇的镇史
    浙江嘉兴「南湖」     ← 唐山南湖公园的采煤沉陷区修复史
    广西梧州「中山公园」 ← 北京中山公园
    新疆昌吉「千佛洞」   ← 甘肃瓜州东千佛洞
    云南腾冲「热海」     ← 日本静冈县热海市

这类错误不会报错、不会 404，只能扫出来。判定规则与抓取管线共用
place_guard.long_reject()，人工核验过确实讲的是本市的写进 data/long_ok.json
放行（盘山正文里出现「北京市旅游局批准 5A」、横店影视城里有「香港街」，
按规则都会被误伤）。

11-24 补的第二类：**同名异地清单页**。整段是「万佛山 (东安)…万佛山 (舒城)…」
这种各地同名景点的罗列，正文里没有「可以指」，老的消歧义判据抓不到，
于是遂宁灵泉寺的历史沿革成了鄂州/汕头/柳州五座寺庙的清单。判据见
common.is_list_page()。另有几条短简介是对的、长介绍却配到了同名的另一处
（潮州牌坊街 → 济宁的牌坊街礼拜堂），既不能整条拉黑也没法用通用规则判，
记在 data/long_block.json（只挡长介绍，短简介照常保留）。

剔掉的正文不删档：连同原因一起存进 data/long_dropped.json，可复查可回滚。

用法：
    python tools/clean_long_desc.py --dry-run   # 只看会剔哪些
    python tools/clean_long_desc.py             # 剔掉并重新导出分片
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, load_json, save_json          # noqa: E402
from place_guard import long_reject                    # noqa: E402
from fetch_long_desc import export_chunks              # noqa: E402

CACHE = os.path.join(DATA, 'long_db.json')
SPOTS = os.path.join(DATA, 'spots_uniq.json')
OK_CACHE = os.path.join(DATA, 'long_ok.json')
BLOCK_CACHE = os.path.join(DATA, 'desc_block.json')
LONG_BLOCK_CACHE = os.path.join(DATA, 'long_block.json')
DROP_CACHE = os.path.join(DATA, 'long_dropped.json')


def places_by_name():
    """景点名 → [(省, 市), ...]；重名景点会有多条"""
    m = {}
    for s in load_json(SPOTS, []):
        m.setdefault(s['name'], []).append((s.get('prov', ''), s.get('city', '')))
    return m


def audit(db, places, ok, blocked, long_block):
    """返回 [(键, 原因)]

    键可能是裸名，也可能是「省|市|名」：清单页判定与人工拉黑都按**景点名**查，
    拿整个键去比对永远查不到（「福建|泉州|开元寺」不是景点名），所以先拆出名字。
    """
    bad = []
    for key in sorted(db):
        parts = key.split('|')
        name = parts[-1]
        own = [(parts[0], parts[1])] if len(parts) == 3 else places.get(name, [])
        why = long_reject(db[key], own,
                          ok=name in ok, blocked=name in blocked,
                          name=name, long_block=long_block.get(name))
        if why:
            bad.append((key, why))
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='只报告，不改数据')
    a = ap.parse_args()

    db = load_json(CACHE, {})
    if not db:
        print('长介绍库为空，无事可做')
        return 1
    places = places_by_name()
    ok = load_json(OK_CACHE, {})
    blocked = load_json(BLOCK_CACHE, {})
    long_block = load_json(LONG_BLOCK_CACHE, {})

    bad = audit(db, places, ok, blocked, long_block)
    print('长介绍 %d 条，判定「讲的是别处」%d 条' % (len(db), len(bad)))
    for key, why in bad:
        name = key.split('|')[-1]
        where = '、'.join('%s/%s' % (p, c) for p, c in places.get(name, [])) or '（无此景点）'
        print('  %-22s %-22s %s' % (key, where, why))
    if a.dry_run:
        print('\n--dry-run：未改动任何文件')
        return 0

    if not bad:
        print('无需清洗')
        return 0

    dropped = load_json(DROP_CACHE, {})
    for key, why in bad:
        name = key.split('|')[-1]
        dropped[key] = {'reason': why,
                        'places': places.get(name, []),
                        'text': db[key]}
        db.pop(key, None)
    save_json(DROP_CACHE, dropped)
    save_json(CACHE, db)
    buckets = export_chunks(db)
    print('\n已剔除 %d 条 → 长介绍剩 %d 条，分片导出 %s'
          % (len(bad), len(db), ', '.join('%d:%d' % (i, len(b)) for i, b in enumerate(buckets))))
    print('原文与原因存在 %s，可复查' % DROP_CACHE)
    return 0


if __name__ == '__main__':
    sys.exit(main())
