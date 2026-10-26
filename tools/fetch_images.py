#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抓取景点真实照片（Wikimedia Commons / 维基词条图），维护 data/img_db.json。

用法：
    python tools/fetch_images.py --mode main --limit 200   # 主图：严格相关性判定
    python tools/fetch_images.py --mode gallery --limit 500 # 补充图组：每景点最多 3 张

判定原则（重要）：
    主图只认「词条标题直接含景点名」或「词条首段含景点名且城市命中」，
    放宽阈值会引入大量错图（如「东方山」配成上海的东方明珠），宁可保留地区实景兜底。

产出：
    data/img_db.json  { 景点名: {u: 主图URL, t: 文件名, src: 来源, conf: 置信, extra: [附加图]} }
"""
import argparse, json, os, random, re, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (CMW, DATA, WD, ZHW, get_json, is_good, load_json,
                    lcs_len, relevance, save_json)

CACHE = os.path.join(DATA, 'img_db.json')
TRIED = os.path.join(DATA, 'img_tried.json')
WORKERS = 16


# ── 维基基础查询 ──
def page_props(title):
    """取词条的 wikibase_item（Q 号）"""
    u = urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'prop': 'pageprops',
        'ppprop': 'wikibase_item', 'redirects': '1', 'titles': title})
    d = get_json(ZHW + u)
    if not d or 'query' not in d:
        return None
    for p in d['query'].get('pages', {}).values():
        if 'missing' in p:
            continue
        q = (p.get('pageprops') or {}).get('wikibase_item')
        if q:
            return q
    return None


def p18_of_qid(qid):
    """Wikidata P18 = 该实体的代表图（最权威）"""
    u = urllib.parse.urlencode({'action': 'wbgetclaims', 'format': 'json',
                                'entity': qid, 'property': 'P18'})
    d = get_json(WD + u)
    if not d:
        return None
    for c in (d.get('claims', {}).get('P18') or []):
        val = (c.get('mainsnak', {}).get('datavalue', {}) or {}).get('value')
        if not val:
            continue
        u2 = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'titles': val,
                                     'prop': 'imageinfo', 'iiprop': 'url|mime|size',
                                     'iiurlwidth': '960'})
        d2 = get_json(CMW + u2)
        if not d2 or 'query' not in d2:
            continue
        for p in d2['query'].get('pages', {}).values():
            ii = (p.get('imageinfo') or [{}])[0]
            u3 = ii.get('thumburl') or ii.get('url')
            if u3 and (ii.get('mime') or '').startswith('image/') and is_good(u3, val):
                if (ii.get('width') or 0) < 500:
                    continue
                return {'u': u3.split('?')[0], 't': val, 'src': 'wikidata', 'conf': 4}
    return None


def article_images(article, name):
    """词条内配图里挑最相关的一张"""
    u = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'titles': article,
                                'prop': 'images', 'imlimit': '80'})
    d = get_json(ZHW + u)
    if not d or 'query' not in d:
        return None
    files = []
    for p in d['query'].get('pages', {}).values():
        for im in (p.get('images') or []):
            files.append(im['title'])
    cands = [f for f in files if relevance(name, f) >= 12 and is_good('', f)][:12]
    if not cands:
        return None
    u2 = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'titles': '|'.join(cands),
                                 'prop': 'imageinfo', 'iiprop': 'url|mime|size', 'iiurlwidth': '960'})
    d2 = get_json(CMW + u2)
    if not d2 or 'query' not in d2:
        return None
    best, bs = None, 0
    for p in d2['query'].get('pages', {}).values():
        ii = (p.get('imageinfo') or [{}])[0]
        u3 = ii.get('thumburl') or ii.get('url')
        if not u3 or not (ii.get('mime') or '').startswith('image/'):
            continue
        if (ii.get('width') or 0) < 500 or not is_good(u3, p.get('title', '')):
            continue
        s = relevance(name, p['title'])
        if s > bs:
            best, bs = {'u': u3.split('?')[0], 't': p['title'], 'src': 'article', 'conf': 2}, s
    return best


def search_titles(name, city, prov):
    """搜候选词条标题"""
    out = []
    for q in [name, (city + name) if city else name, (name + city) if city else name,
              (prov + name) if prov else name]:
        if not q:
            continue
        u = urllib.parse.urlencode({
            'action': 'query', 'format': 'json', 'generator': 'search',
            'gsrsearch': q, 'gsrlimit': '5', 'gsrnamespace': '0'})
        d = get_json(ZHW + u, retries=2, timeout=15)
        if not d or 'query' not in d:
            continue
        pages = sorted(d['query'].get('pages', {}).values(), key=lambda p: p.get('index', 99))
        for p in pages:
            if p['title'] not in out:
                out.append(p['title'])
        if len(out) >= 6:
            break
    return out[:6]


def probe(titles, name, city):
    """取候选词条的简介+主图，按「标题含名 / 首段含名且城市命中」判定相关性"""
    if not titles:
        return {}
    u = urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'redirects': '1', 'titles': '|'.join(titles),
        'prop': 'extracts|pageimages', 'exintro': '1', 'explaintext': '1',
        'exlimit': 'max', 'pithumbsize': '960', 'pilicense': 'any', 'variant': 'zh-cn'})
    d = get_json(ZHW + u)
    if not d or 'query' not in d:
        return {}
    out = {}
    for p in d['query'].get('pages', {}).values():
        if 'missing' in p:
            continue
        title, text = p['title'], (p.get('extract') or '')[:400]
        thumb = (p.get('thumbnail') or {}).get('source')
        blob = title + ' ' + text
        geo_ok = (not city) or (city in blob) or (city.rstrip('市') in blob)
        if name in title:
            sc = 100 + len(name)
        elif name in text[:200] and geo_ok:
            sc = 80 + len(name)
        else:
            L = lcs_len(name, blob)
            if L < 2 or L * 2 < len(name) or not geo_ok:
                continue
            sc = L * 10
        if thumb and is_good(thumb, title):
            out[title] = (sc, thumb.split('?')[0])
        else:
            out[title] = (sc, '')
    return out


def fetch_main(item, db):
    """为单个景点找主图（严格规则）"""
    name, city, prov = item['name'], item.get('city', ''), item.get('prov', '')
    cands = probe(search_titles(name, city, prov), name, city)
    if cands:
        title, (sc, img) = sorted(cands.items(), key=lambda kv: -kv[1][0])[0]
        if img:
            return {'u': img, 't': title, 'src': 'article', 'conf': 2}
        r = article_images(title, name)
        if r:
            return r
    return None


def fetch_gallery(item, db):
    """为已有主图的景点找补充图（同景点，文件名需相关）"""
    name, city, prov = item['name'], item.get('city', ''), item.get('prov', '')
    cur = db.get(name)
    if not cur:
        return None
    primary = cur['u']
    out = []
    for q in [(city + name) if city else name, name]:
        u = urllib.parse.urlencode({
            'action': 'query', 'format': 'json', 'generator': 'search',
            'gsrsearch': q, 'gsrlimit': '14', 'gsrnamespace': '6',
            'prop': 'imageinfo', 'iiprop': 'url|size|mime', 'iiurlwidth': '1200'})
        d = get_json(CMW + u, retries=2, timeout=18)
        if not d or 'query' not in d:
            continue
        pages = sorted(d['query']['pages'].values(), key=lambda p: p.get('index', 99))
        for p in pages:
            ii = (p.get('imageinfo') or [{}])[0]
            url = ii.get('thumburl') or ii.get('url')
            if not url or not (ii.get('mime') or '').startswith('image/'):
                continue
            if (ii.get('width') or 0) < 800 or not is_good(url, p.get('title', '')):
                continue
            if name not in urllib.parse.unquote(p['title']) and relevance(name, p['title']) < 8:
                continue
            u2 = url.split('?')[0]
            if u2 == primary or u2 in out:
                continue
            out.append(u2)
            if len(out) >= 3:
                return out
        if out:
            break
    return out



def strict_commons(name, city, prov):
    """严格模式：Commons 文件名必须直接包含景点名才采信（宁可没有也不要错图）"""
    plain = re.sub(r'[^0-9A-Za-z\u4e00-\u9fff]', '', name)
    for q in [(city + name) if city else name, name]:
        u = urllib.parse.urlencode({
            'action': 'query', 'format': 'json', 'generator': 'search',
            'gsrsearch': q, 'gsrlimit': '20', 'gsrnamespace': '6',
            'prop': 'imageinfo', 'iiprop': 'url|size|mime', 'iiurlwidth': '960'})
        d = get_json(CMW + u, retries=2, timeout=20)
        if not d or 'query' not in d:
            continue
        pages = sorted(d['query']['pages'].values(), key=lambda p: p.get('index', 99))
        for p in pages:
            ii = (p.get('imageinfo') or [{}])[0]
            url = ii.get('thumburl') or ii.get('url')
            if not url or not (ii.get('mime') or '').startswith('image/'):
                continue
            if (ii.get('width') or 0) < 500 or not is_good(url, p.get('title', '')):
                continue
            title = p.get('title', '')
            fname = re.sub(r'[^0-9A-Za-z\u4e00-\u9fff]', '', urllib.parse.unquote(title))
            if plain and plain in fname:
                return {'u': url.split('?')[0], 't': title, 'src': 'commons', 'conf': 2}
    return None

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', choices=['main', 'gallery', 'region'], default='main')
    ap.add_argument('--limit', type=int, default=100)
    ap.add_argument('--seed', type=int, default=4242)
    a = ap.parse_args()

    db = load_json(CACHE, {})
    spots = load_json(os.path.join(DATA, 'spots_uniq.json'), [])
    if not spots:
        print('缺少 data/spots_uniq.json，请先运行 tools/build_spot_index.py')
        sys.exit(1)
    tried = set(load_json(TRIED, []))
    random.Random(a.seed).shuffle(spots)

    if a.mode == 'region':
        pool = [s for s in spots if db.get(s['name'], {}).get('conf', 1) <= 1]
        todo = pool[:a.limit]
        fn = lambda it: strict_commons(it['name'], it.get('city', ''), it.get('prov', '')) or \
            fetch_main(it, db)
    elif a.mode == 'main':
        pool = [s for s in spots if s['name'] not in db]
        todo = pool[:a.limit]
        fn = lambda it: fetch_main(it, db)
    else:
        pool = [s for s in spots if db.get(s['name'], {}).get('conf', 1) >= 2
                and not db[s['name']].get('extra')]
        todo = pool[:a.limit]
        fn = lambda it: fetch_gallery(it, db)

    print('模式 %s：候选 %d，本轮 %d' % (a.mode, len(pool), len(todo)), flush=True)
    t0, done, hit = time.time(), 0, 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for item, r in zip(todo, ex.map(fn, todo)):
            done += 1
            if r:
                if a.mode == 'gallery':
                    db[item['name']]['extra'] = r
                else:
                    db[item['name']] = r
                hit += 1
            tried.add(item['name'])
            if done % 20 == 0:
                save_json(CACHE, db)
                save_json(TRIED, sorted(tried))
                print('  %d/%d 命中 %d  %.0fs [已保存]' % (done, len(todo), hit, time.time() - t0), flush=True)
    save_json(CACHE, db)
    save_json(TRIED, sorted(tried))
    print('完成：命中 %d / %d' % (hit, done))
