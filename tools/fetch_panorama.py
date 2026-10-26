#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抓取景点真实全景图（360° 球面 / 宽幅拼接），实现「线上逛景点」。

两种全景：
    sphere  等距柱状（宽高比 ≈ 2:1）→ 球面贴图，可 360° 环视 + 缩放
    wide   宽幅拼接（宽高比 > 2.4）  → 平面/柱面，可横向拖拽环视

检出策略：
    1) Commons 分类枚举：「Panoramas of China」等分类，名字明确的一批
    2) 关键词检索：<景点名> 全景 / panorama / 360，并按尺寸比判定类型
    3) 相关性要求：文件名或图片描述必须能对上景点名（与图片库同规则）

用法：
    python tools/fetch_panorama.py --limit 100   # 本轮抓 100 个（优先名景）
    python tools/fetch_panorama.py               # 全量（断点续跑）
    python tools/fetch_panorama.py --export-only

产出：
    data/panorama_db.json   { 景点名: {url, type, title, w, h} }
    js/panorama-db.js       PANORAMA_DB（详情页按需加载）
"""
import argparse, json, os, re, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (CMW, DATA, JS, get_json, is_good, js_export, load_json,
                    relevance, save_json)

CACHE = os.path.join(DATA, 'panorama_db.json')
WORKERS = 6

# 分类枚举：这些分类里的文件名已经点明了地点
CATEGORIES = [
    'Panoramas of China',
    'Panoramas of the Great Wall of China',
    'Panoramas of Beijing',
    'Panoramas of Shanghai',
]

# 分类文件名 → 景点名的手工映射（文件名不含中文时才需要）
MANUAL_MAP = {
    'jinshanling-panorama.jpg': '金山岭长城',
    'simatai great wall 1.jpg': '司马台长城',
    'jiqinglouwide.jpg': '鸡鸣楼',
    'zhuangyuan panorama.jpg': '承德避暑山庄',
    'wangshiyuan panorama': '网师园',
    'wuxiang new area skyline.png': '武乡',
    'nanning skyline.png': '南宁',
    'zhuhai-panorama-jida.jpg': '珠海',
    'chongqing - view yangtse.jpg': '重庆',
    'lanzhou skyline 201906.jpg': '兰州',
    'skyline of dinghai harbor waterfront.jpg': '定海',
    '1 guilin panorama 2011.jpg': '桂林',
    '1 lijiang old town 2012.jpg': '丽江古城',
    '1 zhangjiajie huangshizhai wulingyuan panorama 2012.jpg': '张家界国家森林公园',
    'zhangjiajie (17198899337).jpg': '张家界国家森林公园',
    'jinshanling-panorama.jpg ': '金山岭长城',
}


def search_files(query, limit=12):
    url = CMW + urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'generator': 'search',
        'gsrsearch': query, 'gsrlimit': str(limit), 'gsrnamespace': '6'})
    d = get_json(url, retries=3, timeout=25)
    if not d or 'query' not in d:
        return []
    return [p['title'] for p in sorted(d['query']['pages'].values(),
                                        key=lambda p: p.get('index', 99))]


def image_info(titles):
    """批量取尺寸与描述"""
    out = {}
    for i in range(0, len(titles), 20):
        chunk = titles[i:i + 20]
        url = CMW + urllib.parse.urlencode({
            'action': 'query', 'format': 'json', 'titles': '|'.join(chunk),
            'prop': 'imageinfo', 'iiprop': 'url|size|mime|extmetadata'})
        d = get_json(url, retries=3, timeout=25)
        for p in (d or {}).get('query', {}).get('pages', {}).values():
            ii = (p.get('imageinfo') or [{}])[0]
            meta = ii.get('extmetadata') or {}
            out[p['title']] = {
                'w': ii.get('width', 0), 'h': ii.get('height', 0),
                'url': (ii.get('thumburl') or ii.get('url') or '').split('?')[0],
                'desc': (meta.get('ImageDescription') or {}).get('value', '') or '',
            }
    return out


# 非实景照片：古籍画卷/拓片/地图等，宽高比容易误判成全景
NOT_PHOTO = re.compile(
    r'(绢本|设色|手卷|立轴|册页|年画|版画|水墨画|国画|书法|拓片|拓本|古籍|舆图|'
    r'图志|地图|画谱|绘画|绘画长卷|\bpainting\b|\bdrawing\b|\bscroll\b|\bengraving\b|'
    r'\bwoodcut\b|\bmanuscript\b|\bmap\b|\bchart\b|\bposter\b|\bbook\b)')


def classify(w, h):
    if not h:
        return None
    r = w / h
    if 1.75 <= r <= 2.3:
        return 'sphere'
    if r > 2.4:
        return 'wide'
    return None


# 城市冲突：标题里出现别的城市名 → 不是这个景点
CITY_NAMES = set()


def _load_cities():
    global CITY_NAMES
    if CITY_NAMES:
        return CITY_NAMES
    for s in load_json(os.path.join(DATA, 'spots_uniq.json'), []):
        c = s.get('city', '')
        if len(c) >= 2:
            CITY_NAMES.add(c)
            CITY_NAMES.add(c.rstrip('市'))
    return CITY_NAMES


def city_conflict(blob, spot_name, city):
    cities = _load_cities()
    for c in cities:
        if not c or c == city or c.rstrip('市') == (city or '').rstrip('市'):
            continue
        if c in spot_name:
            continue
        if c in blob:
            return True
    return False


def pick_for_spot(name, city, en_title, db):
    """为单个景点找全景（球面优先，其次宽幅）"""
    queries = ['%s 全景' % name, '%s panorama' % name]
    if en_title and en_title != name:
        queries.append('%s panorama' % en_title)
    queries.append('%s 360' % name)
    titles = []
    for q in queries:
        titles.extend(search_files(q, 10))
        if len(titles) >= 16:
            break
    titles = list(dict.fromkeys(titles))[:18]
    if not titles:
        return None
    infos = image_info(titles)
    best = None
    for t, info in infos.items():
        if info['w'] < 1200:
            continue
        kind = classify(info['w'], info['h'])
        if not kind:
            continue
        if not is_good(info['url'], t):
            continue
        blob = t + ' ' + info['desc']
        if NOT_PHOTO.search(blob):
            continue
        if city_conflict(blob, name, city):
            continue
        plain = re.sub(r'[^0-9A-Za-z一-鿿]', '', t)
        nplain = re.sub(r'[^0-9A-Za-z一-鿿]', '', name)
        rel = max(relevance(name, t), relevance(name, info['desc']))
        hit = bool(nplain) and (nplain in plain or nplain in re.sub(r'[^0-9A-Za-z一-鿿]', '', blob))
        if not hit and rel < 8:
            continue
        score = (2 if kind == 'sphere' else 1) * 1000 + min(info['w'], 12000) / 100
        if best is None or score > best[0]:
            best = (score, {'url': info['url'], 'type': kind, 'title': t,
                            'w': info['w'], 'h': info['h']})
    return best[1] if best else None


def sweep_categories(db):
    """分类枚举：文件名能对上景点名的直接收"""
    added = 0
    for cat in CATEGORIES:
        url = CMW + urllib.parse.urlencode({
            'action': 'query', 'format': 'json', 'list': 'categorymembers',
            'cmtitle': 'Category:' + cat, 'cmlimit': '500', 'cmtype': 'file'})
        d = get_json(url, retries=3, timeout=30)
        titles = [m['title'] for m in (d or {}).get('query', {}).get('categorymembers', [])]
        if not titles:
            continue
        infos = image_info(titles)
        for t, info in infos.items():
            kind = classify(info['w'], info['h'])
            if not kind or info['w'] < 2000:
                continue
            if NOT_PHOTO.search(t + ' ' + info['desc']):
                continue
            low = t.lower().replace('file:', '').strip()
            spot = MANUAL_MAP.get(low)
            if not spot:
                base = low.split('.')[0]
                spot = MANUAL_MAP.get(base)
            if not spot:
                # 文件名里含中文景点名 → 直接按名匹配
                for cand in db.keys():
                    if cand in t:
                        spot = cand
                        break
            if not spot:
                continue
            if spot in db:
                continue
            db[spot] = {'url': info['url'], 'type': kind, 'title': t,
                         'w': info['w'], 'h': info['h']}
            added += 1
    return added


def export():
    db = load_json(CACHE, {})
    if not db:
        print('缓存为空，拒绝导出')
        return
    sph = sum(1 for v in db.values() if v['type'] == 'sphere')
    open(os.path.join(JS, 'panorama-db.js'), 'w', encoding='utf-8').write(js_export(
        db,
        '// ═══ 景点真实全景图库（360°球面 / 宽幅拼接）═══\n'
        '// 生成：tools/fetch_panorama.py。格式：{ 景点名: {url, type, title, w, h} }\n'
        '// type: sphere=等距柱状(可360°环视) / wide=宽幅拼接(可横向环视)\n'
        'export const PANORAMA_DB = '))
    print('导出 %d 条（球面 %d / 宽幅 %d）→ js/panorama-db.js'
          % (len(db), sph, len(db) - sph))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--export-only', action='store_true')
    ap.add_argument('--workers', type=int, default=WORKERS)
    a = ap.parse_args()

    if not a.export_only:
        db = load_json(CACHE, {})
        spots = load_json(os.path.join(DATA, 'spots_uniq.json'), [])
        short = load_json(os.path.join(DATA, 'desc_db.json'), {})
        img = load_json(os.path.join(DATA, 'img_db.json'), {})
        # 优先名景：有权威配图(conf>=3) 或已有真实简介的
        cands = [s for s in spots if s['name'] not in db
                 and (img.get(s['name'], {}).get('conf', 1) >= 3 or s['name'] in short)]
        # 排序：conf 高的优先，名景在前
        cands.sort(key=lambda s: -(img.get(s['name'], {}).get('conf', 1)))
        if a.limit:
            cands = cands[:a.limit]
        print('待查全景 %d 个（总候选 %d）' % (len(cands), len(spots)), flush=True)

        n = sweep_categories(db)
        print('分类枚举新增 %d 条' % n, flush=True)
        save_json(CACHE, db)

        t0, done, hit = time.time(), 0, 0

        def work(s):
            en = short.get(s['name'])
            en = en[1] if isinstance(en, list) and len(en) > 1 else ''
            try:
                return s['name'], pick_for_spot(s['name'], s.get('city', ''), en, db)
            except Exception:
                return s['name'], None

        with ThreadPoolExecutor(max_workers=a.workers) as ex:
            for name, r in ex.map(work, cands):
                done += 1
                if r:
                    db[name] = r
                    hit += 1
                if done % 20 == 0:
                    save_json(CACHE, db)
                    print('  %d/%d 命中 %d  %.0fs [已保存]' % (done, len(cands), hit, time.time() - t0), flush=True)
        save_json(CACHE, db)
        print('本轮命中 %d / %d，总计 %d' % (hit, done, len(db)))

    export()
