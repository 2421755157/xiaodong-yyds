#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抓取景点坐标（WGS84），用于调用街景/全景服务。

来源（都不需要任何 key）：
    1) 维基百科词条坐标  prop=coordinates
    2) Wikidata P625（坐标位置）

产出：
    data/coords.json  { 景点名: [lng, lat, 来源] }
    js/coords-db.js  COORD_DB（详情页按需加载）
"""
import json, os, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (DATA, JS, WD, ZHW, get_json, js_export, load_json, save_json)

CACHE = os.path.join(DATA, 'coords.json')
WORKERS = 8


def wiki_batch(titles):
    """一次取多个词条的坐标 + wikibase item"""
    if not titles:
        return {}
    url = ZHW + urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'redirects': '1',
        'titles': '|'.join(titles), 'prop': 'coordinates|pageprops'})
    d = get_json(url, retries=4, timeout=25)
    if not d or 'query' not in d:
        return {}
    qy = d['query']
    alias = {}
    for x in qy.get('normalized', []):
        alias[x['to']] = x['from']
    for x in qy.get('redirects', []):
        alias[x['to']] = alias.get(x['from'], x['from'])
    out = {}
    for p in qy.get('pages', {}).values():
        req = alias.get(p['title'], p['title'])
        co = p.get('coordinates') or []
        c = co[0] if co else None
        out[req] = {
            'lon': c['lon'] if c else None,
            'lat': c['lat'] if c else None,
            'qid': (p.get('pageprops') or {}).get('wikibase_item'),
        }
    return out


def wikidata_coords(qids):
    """批量取 Wikidata P625"""
    out = {}
    qids = [q for q in qids if q]
    for i in range(0, len(qids), 50):
        chunk = qids[i:i + 50]
        url = WD + urllib.parse.urlencode({
            'action': 'wbgetentities', 'format': 'json',
            'ids': '|'.join(chunk), 'props': 'claims'})
        d = get_json(url, retries=4, timeout=30)
        for qid, ent in (d or {}).get('entities', {}).items():
            for cl in (ent.get('claims', {}) or {}).get('P625', [])[:1]:
                v = (cl.get('mainsnak', {}).get('datavalue', {}) or {}).get('value')
                if isinstance(v, dict) and 'latitude' in v:
                    out[qid] = (v['longitude'], v['latitude'])
    return out


def main():
    db = load_json(CACHE, {})
    short = load_json(os.path.join(DATA, 'desc_db.json'), {})
    # 只对有词条的景点取坐标
    items = []
    for name, v in short.items():
        if not v:
            continue
        title = v[1] if isinstance(v, list) and len(v) > 1 else name
        items.append((name, title))

    todo = [it for it in items if it[0] not in db]
    print('坐标：已有 %d / %d，本轮查 %d' % (len(db), len(items), len(todo)), flush=True)
    if not todo:
        return export(db)

    t0 = time.time()
    # 1) 维基词条坐标（批量）
    titles = list(dict.fromkeys(t[1] for t in todo))
    got = {}
    for i in range(0, len(titles), 20):
        got.update(wiki_batch(titles[i:i + 20]))
    hit = 0
    need_wd = []
    for name, title in todo:
        r = got.get(title)
        if r and r['lon'] is not None:
            db[name] = [r['lon'], r['lat'], 'wiki']
            hit += 1
        elif r and r['qid']:
            need_wd.append((name, r['qid']))
    print('  维基词条坐标命中 %d' % hit, flush=True)

    # 2) Wikidata P625 兜底
    if need_wd:
        wd = wikidata_coords([q for _, q in need_wd])
        got2 = 0
        for name, qid in need_wd:
            v = wd.get(qid)
            if v:
                db[name] = [v[0], v[1], 'wikidata']
                got2 += 1
        print('  Wikidata 坐标命中 %d' % got2, flush=True)

    save_json(CACHE, db)
    print('总计 %d / %d，用时 %.0fs' % (len(db), len(items), time.time() - t0))
    export(db)


def export(db):
    if not db:
        print('坐标为空，拒绝导出')
        return
    open(os.path.join(JS, 'coords-db.js'), 'w', encoding='utf-8').write(js_export(
        db,
        '// ═══ 景点坐标库（WGS84，来自维基百科 / Wikidata）═══\n'
        '// 生成：tools/fetch_coords.py。格式：{ 景点名: [lng, lat, 来源] }\n'
        '// 用途：为街景/全景服务提供定位参数\n'
        'export const COORD_DB = '))
    print('导出 %d 条 → js/coords-db.js' % len(db))


if __name__ == '__main__':
    main()
