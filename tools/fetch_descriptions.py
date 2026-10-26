#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抓取景点 / 省市的真实简介（中文维基百科词条首段 → 简体），并导出前端库。

用法：
    python tools/fetch_descriptions.py            # 景点 + 省市 全量（可断点续跑）
    python tools/fetch_descriptions.py --spots 50 # 只补前 50 个缺失的景点
    python tools/fetch_descriptions.py --regions   # 只跑省市

产出：
    data/desc_db.json      { 景点名: [简介, 词条名] }     原始缓存（断点续跑用）
    data/region_db.json    { "省名" | "省|市": 简介 }
    js/spot-desc-db.js     SPOT_DESC_DB
    js/region-desc-db.js   REGION_DESC_DB
"""
import argparse, json, os, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (DATA, JS, ZHW, clean_text, get_json, js_export,
                    load_json, save_json, search_title as _search_title)

SPOT_CACHE = os.path.join(DATA, 'desc_db.json')
REGION_CACHE = os.path.join(DATA, 'region_db.json')
WORKERS = 16


def fetch_batch(titles):
    """批量取词条首段（≤20 个/请求）→ {请求标题: (extract, 实际标题)}"""
    if not titles:
        return {}
    q = urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'redirects': '1',
        'prop': 'extracts', 'exintro': '1', 'explaintext': '1',
        'exlimit': 'max', 'variant': 'zh-cn', 'titles': '|'.join(titles)})
    d = get_json(ZHW + q)
    out = {}
    if not d or 'query' not in d:
        return out
    qy = d['query']
    alias = {}
    for x in qy.get('normalized', []):
        alias[x['to']] = x['from']
    for x in qy.get('redirects', []):
        alias[x['to']] = alias.get(x['from'], x['from'])
    for p in qy.get('pages', {}).values():
        if 'missing' in p:
            continue
        out[alias.get(p['title'], p['title'])] = (p.get('extract') or '', p['title'])
    return out


def run_batches(all_titles, workers=WORKERS):
    """并发批量抓取，返回 {标题: (extract, 标题)}"""
    batches = [all_titles[i:i + 20] for i in range(0, len(all_titles), 20)]
    got = {}
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for res in ex.map(fetch_batch, batches):
            got.update(res)
            done += 1
            if done % 10 == 0:
                print('  %d/%d 批' % (done, len(batches)), flush=True)
    return got


def search_title(name, city, prov):
    """搜索定位紧匹配词条（实现见 common.search_title）"""
    return _search_title(name, city, prov)


def load_spots():
    """景点索引（由 tools/build-spot-index.mjs 生成）"""
    return load_json(os.path.join(DATA, 'spots_uniq.json'), [])


def parse_regions():
    """省市索引（由 tools/build-spot-index.mjs 生成）"""
    return load_json(os.path.join(DATA, 'regions_uniq.json'), [])


def do_spots(limit):
    db = load_json(SPOT_CACHE, {})
    spots = load_spots()
    todo = [s for s in spots if s['name'] not in db]
    print('景点简介：已有 %d / %d，本轮待查 %d' % (len(db), len(spots), len(todo)), flush=True)
    if not todo:
        return db
    # 打乱顺序，避免失败批次被反复重试同一批（代理不稳时尤其重要）
    import random
    random.Random(20261003).shuffle(todo)
    if limit:
        todo = todo[:limit]

    # 阶段 A：精确标题批量
    names = [s['name'] for s in todo]
    got = run_batches(names)
    hit = 0
    for s in todo:
        rec = got.get(s['name'])
        if not rec:
            continue
        t = clean_text(rec[0], s['name'])
        if t:
            db[s['name']] = [t, rec[1]]
            hit += 1
    print('  阶段A 命中 %d' % hit, flush=True)
    save_json(SPOT_CACHE, db)

    # 阶段 B：漏网的用「城市+名」搜索定位
    miss = [s for s in todo if s['name'] not in db]
    if miss:
        print('  阶段B 搜索定位 %d 个' % len(miss), flush=True)
        titles = {}
        with ThreadPoolExecutor(max_workers=24) as ex:
            def work(s):
                try:
                    return s['name'], search_title(s['name'], s['city'], s['prov'])
                except Exception:
                    return s['name'], None
            for name, t in ex.map(work, miss):
                if t:
                    titles[name] = t
        got2 = run_batches(list(dict.fromkeys(titles.values())))
        hit2 = 0
        for name, t in titles.items():
            rec = got2.get(t)
            if not rec:
                continue
            txt = clean_text(rec[0], name)
            if txt:
                db[name] = [txt, rec[1]]
                hit2 += 1
        print('  阶段B 命中 %d' % hit2, flush=True)
    save_json(SPOT_CACHE, db)
    return db


def do_regions():
    db = load_json(REGION_CACHE, {})
    regs = parse_regions()
    todo = [r for r in regs if r['key'] not in db]
    print('省市简介：已有 %d / %d，本轮待查 %d' % (len(db), len(regs), len(todo)), flush=True)
    if not todo:
        return db
    allt = []
    for r in todo:
        for c in [r['name']] + r.get('alt', []):
            if c and c not in allt:
                allt.append(c)
    got = run_batches(allt)
    hit = 0
    for r in todo:
        for c in [r['name']] + r.get('alt', []):
            rec = got.get(c)
            if not rec:
                continue
            t = clean_text(rec[0], r['name'])
            if t and len(t) >= 12:
                db[r['key']] = t
                hit += 1
                break
    save_json(REGION_CACHE, db)
    print('  命中 %d / %d' % (hit, len(todo)), flush=True)
    return db


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--spots', type=int, default=0, help='本轮最多补查的景点数（0=不限）')
    ap.add_argument('--regions', action='store_true', help='只跑省市')
    ap.add_argument('--export-only', action='store_true', help='只用缓存导出，不抓取')
    a = ap.parse_args()

    t0 = time.time()
    if not a.export_only:
        if not a.regions:
            do_spots(a.spots)
        do_regions()

    spot_db = load_json(SPOT_CACHE, {})
    region_db = load_json(REGION_CACHE, {})
    if not spot_db and not region_db:
        print('缓存为空，拒绝覆盖现有前端库（先跑一次抓取）')
        sys.exit(0)
    # 空值（消歧义清理后回退手写文案的条目）直接剔除，避免导出空串
    spot_out = {k: v[0] for k, v in spot_db.items() if v and v[0]}
    open(os.path.join(JS, 'spot-desc-db.js'), 'w', encoding='utf-8').write(js_export(
        spot_out,
        '// ═══ 景点真实简介库（中文维基百科词条首段，已转简体）═══\n'
        '// 生成：tools/fetch_descriptions.py。格式：{ 景点名: 简介正文 }\n'
        'export const SPOT_DESC_DB = '))
    open(os.path.join(JS, 'region-desc-db.js'), 'w', encoding='utf-8').write(js_export(
        region_db,
        '// ═══ 省市真实简介库（中文维基百科词条首段，已转简体）═══\n'
        '// 生成：tools/fetch_descriptions.py。格式：{ "省" | "省|市": 简介 }\n'
        'export const REGION_DESC_DB = '))
    print('导出：景点 %d 条，省市 %d 条，用时 %.0fs'
          % (len(spot_db), len(region_db), time.time() - t0))
