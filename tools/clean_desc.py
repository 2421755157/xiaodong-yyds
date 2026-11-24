#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""清洗景点简介库：挂上来的这段正文必须真在讲这处景点

背景：简介库（data/desc_db.json）里的老条目是更早的管线抓的，当年只校验了地域，
于是「百度百科是一部内容开放…」这种站点自述、鸽子窝的高粱变种学名、
《月河》这首 1961 年的歌曲，一直躺在库里；它们的地域校验是「真空通过」——
正文压根没提地名，mismatch 判不出来。

11-24 又发现一类：**同名异地清单页**。整段是「万佛山 (东安)…万佛山 (舒城)…」
这种各地同名景点的罗列，正文里没有一个「可以指」，消歧义判据抓不到，
于是无锡南禅寺的简介成了山西五台/福州/西宁七座寺庙的清单。

清洗逻辑本来就写在 fetch_descriptions.do_spots() 里，但那段代码要联网抓取才跑得到，
只想清缓存就没法用（弱网/风控时尤其尴尬）。这里把同一道闸门单独拎出来：
判定用 place_guard.desc_reject，与抓取管线、check_integrity 是同一份。

剔掉的条目不删档：原文与原因存进 data/desc_dropped.json。
之后照常重导出分片与首页统计。

用法：
    python tools/clean_desc.py --dry-run   # 只看会剔哪些
    python tools/clean_desc.py            # 剔掉并重新导出
"""
import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, JS, js_export, load_json, save_json      # noqa: E402
from place_guard import desc_reject                                # noqa: E402

CACHE = os.path.join(DATA, 'desc_db.json')
SPOTS = os.path.join(DATA, 'spots_uniq.json')
BLOCK_CACHE = os.path.join(DATA, 'desc_block.json')
DROP_CACHE = os.path.join(DATA, 'desc_dropped.json')
HERE = os.path.dirname(os.path.abspath(__file__))


def spot_of_key():
    """库键 → 景点记录。重名景点是「省|市|名」，其余是裸名。"""
    spots = load_json(SPOTS, [])
    dup = {}
    for s in spots:
        dup[s['name']] = dup.get(s['name'], 0) + 1
    m = {}
    for s in spots:
        key = ('%s|%s|%s' % (s['prov'], s['city'], s['name'])) if dup[s['name']] > 1 else s['name']
        m[key] = s
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='只报告，不改数据')
    a = ap.parse_args()

    db = load_json(CACHE, {})
    if not db:
        print('简介库为空，无事可做')
        return 1
    by_key = spot_of_key()
    blocked = load_json(BLOCK_CACHE, {})

    bad = []
    for key in sorted(db):
        entry = db[key]
        text = entry[0] if isinstance(entry, list) else entry
        s = by_key.get(key)
        if not s:
            continue
        if s['name'] in blocked:
            bad.append((key, '已人工拉黑：%s' % blocked[s['name']]))
            continue
        why = desc_reject(text or '', s.get('city', ''), s.get('prov', ''), name=s['name'])
        if why:
            bad.append((key, why))

    print('简介 %d 条，判定「不是这处景点」%d 条' % (len(db), len(bad)))
    for key, why in bad:
        s = by_key.get(key, {})
        print('  %-24s %-10s %s' % (key, '%s/%s' % (s.get('prov', ''), s.get('city', '')), why))
    if a.dry_run:
        print('\n--dry-run：未改动任何文件')
        return 0
    if not bad:
        print('无需清洗')
        return 0

    dropped = load_json(DROP_CACHE, {})
    for key, why in bad:
        dropped[key] = {'reason': why, 'text': db[key]}
        db.pop(key, None)
    save_json(DROP_CACHE, dropped)
    save_json(CACHE, db)
    print('\n已剔除 %d 条 → 简介剩 %d 条；原文与原因存在 %s'
          % (len(bad), len(db), DROP_CACHE))

    # 重新导出整库 + 8 个分片 + 首页统计（前端读的是分片，不是整库）
    spot_out = {k: (v[0] if isinstance(v, list) else v) for k, v in db.items()
                if (v[0] if isinstance(v, list) else v)}
    open(os.path.join(JS, 'spot-desc-db.js'), 'w', encoding='utf-8').write(js_export(
        spot_out,
        '// ═══ 景点真实简介库（中文维基百科词条首段，已转简体）═══\n'
        '// 生成：tools/fetch_descriptions.py。格式：{ 景点名: 简介正文 }\n'
        'export const SPOT_DESC_DB = '))
    for cmd in ('shard_desc.py', 'build_home_stats.mjs'):
        if cmd.endswith('.mjs'):
            subprocess.run(['node', os.path.join(HERE, cmd)], check=False)
        else:
            subprocess.run([sys.executable, os.path.join(HERE, cmd)], check=False)
    print('导出完成：%s / 分片 / 首页统计' % os.path.join(JS, 'spot-desc-db.js'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
