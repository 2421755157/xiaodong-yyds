#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抓取景点坐标（WGS84），用于详情页小地图 / 街景 / 百度地图跳转。

来源（都不需要 key，按顺序回退）：
    1) 维基百科词条坐标  prop=coordinates
    2) Wikidata P625（坐标位置）
    3) Photon（OSM 数据的地理编码，国内可达，返回结构化省市区，便于校验）

产出：
    data/coords.json       { 键: [lng, lat, 来源] } 原始缓存
    data/coords_tried.json { 键: 日期 }             查过但确实没有的，下一轮不再重复请求
    js/coords-db.js        COORD_DB（详情页按需加载）

键的规则与简介库一致：重名景点用「省|市|名」，唯一名就用裸名。
裸名键对重名景点是错的——「南山」在烟台 / 邵阳 / 乌鲁木齐各有一处，
共用一条坐标等于把两处的游客送到第三处去。

旧缓存里的裸名坐标不会直接丢：先用同城景点坐标的中位数中心判定它属于
哪一处（见 assign_legacy），判不出来的才丢弃重查。维基/Wikidata 那两档
不做地名校验，出口处用国境经纬度范围兜一道（in_china），
否则「水晶宫」会拿到伦敦、「大峡谷」会拿到科罗拉多。

网络默认直连；要走本地代理时设 PROXY=http://127.0.0.1:7890。

为什么不用 Nominatim：它明文限制 1 次/秒，批量跑一千多个景点会持续撞 429，
实测跑到一半就被限流到连接超时。Photon 返回 GeoJSON，properties 里直接带
city / county / state / country，校验比字符串匹配靠谱得多。
"""
import argparse, json, math, os, sys, threading, time, urllib.error, urllib.parse, urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (DATA, JS, WD, ZHW, get_json, js_export, load_json, open_url, save_json)

CACHE = os.path.join(DATA, 'coords.json')
TRIED = os.path.join(DATA, 'coords_tried.json')

PHOTON_API = 'https://photon.komoot.io/api/'
UA = ('xiaodong-yyds/1.0 (static travel guide build; '
      '+https://github.com/2421755157/xiaodong-yyds)')
GAP = 0.25          # 公共地理编码服务，靠并发盖住延迟，总速率仍压着打

# 这些类别是同名的非景点机构/设施，命中它会把地图指到校区、医院或服务区里
BAD_VALUES = {'school', 'university', 'college', 'kindergarten', 'hospital',
              'clinic', 'restaurant', 'fast_food', 'cafe', 'bar', 'pub',
              'bank', 'fuel', 'supermarket', 'convenience', 'hotel',
              'pharmacy', 'bus_stop', 'parking', 'motorway_junction',
              'services', 'rest_area', 'company', 'office', 'townhall'}

# 这些类别的同名对象通常就是景点本身（山、湖、寺、景区…），排序时优先
GOOD_KEYS = {'tourism', 'natural', 'historic', 'leisure', 'waterway',
             'place', 'man_made', 'amenity'}

# 自治州/地区简称 → 全称前缀，用来和 Photon 的 city 字段对上
CITY_ALIAS = {
    '博州': '博尔塔拉', '巴州': '巴音郭楞', '伊犁州': '伊犁',
}

# 台湾、香港、澳门都是中国的一部分；Photon 的 country 字段对台港澳的标注
# 与大陆不同，这里一并认作中国境内，否则这三地的景点会全部取不到坐标。
CN_COUNTRY = {'中国', 'China', '臺灣', '台湾', 'Taiwan', '香港', 'Hong Kong',
              '澳门', '澳門', 'Macao', 'Macau'}

# 国境经纬度范围（含台港澳与南海诸岛）：西、南、东、北
CN_BBOX = (73.0, 3.0, 136.0, 54.0)

# 同名景点在境外遍地都是，维基/Wikidata 这两档不做地名校验，只能在这道出口挡住：
# 实测「水晶宫」命中的是伦敦水晶宫（-0.08, 51.42）、「大峡谷」是科罗拉多大峡谷
# （-112.6, 36.3）、「死海」在约旦、「鲁朗」在法国、「长岛」是纽约长岛。
# 这些坐标会让详情页的小地图把用户送到国外去。
def in_china(coord):
    return bool(coord) and (CN_BBOX[0] <= coord[0] <= CN_BBOX[2]
                            and CN_BBOX[1] <= coord[1] <= CN_BBOX[3])


def spot_key(s, dup):
    if s['name'] in dup:
        return '%s|%s|%s' % (s.get('prov', ''), s.get('city', ''), s['name'])
    return s['name']


# ─── 旧裸名坐标的归属判定 ───
# 上一版缓存只有一个「景点名 → 坐标」，重名景点共用一条。
# 直接丢会把杭州西湖这种"裸名恰好对"的也一起丢，用户白白少一个地图；
# 全留着又会让邵阳南山指向乌鲁木齐。折中办法是给它找个证据：
# 同城景点在地理上聚集，用该城已确认坐标的中位数中心比距离，
# 只有一个城市明显更近时才算归属确定。

LEGACY_MAX_KM = 60      # 超出这个距离，说明这条坐标根本不在候选城市
LEGACY_MARGIN = 3.0     # 次近城市要比最近城市远这么多倍，才算"没歧义"
LEGACY_SECOND_KM = 180  # 次近城市本身就 >180km 时，不比倍数也算远


def haversine_km(a, b):
    """两点球面距离（km）。a/b 都是 [lng, lat]"""
    lon1, lat1, lon2, lat2 = a[0], a[1], b[0], b[1]
    p = 3.141592653589793 / 180
    h = (0.5 - math.cos((lat2 - lat1) * p) / 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2)
    return 2 * 6371 * math.asin(math.sqrt(h))


def city_centroids(db, spots, dup):
    """各城市已确认坐标的中位数中心 {(省, 市): (lng, lat, 样本数)}

    用中位数而不是均值：个别偏远景点（市郊的山、县里的故居）会把均值拖出去。
    样本 <2 的城市不参与判定——只有一个点时"中心"就是它自己，没有参考价值。
    """
    buckets = {}
    for s in spots:
        v = db.get(spot_key(s, dup))
        if isinstance(v, list) and len(v) >= 2:
            buckets.setdefault((s.get('prov', ''), s.get('city', '')), []).append((v[0], v[1]))
    out = {}
    for c, pts in buckets.items():
        if len(pts) < 2:
            continue
        lons = sorted(p[0] for p in pts)
        lats = sorted(p[1] for p in pts)
        out[c] = (lons[len(lons) // 2], lats[len(lats) // 2], len(pts))
    return out


def assign_legacy(coord, cities):
    """旧裸名坐标属于哪个城市？

    cities: [((省, 市), (lng, lat), 样本数)]
    返回 ((省, 市), 距离) 或 (None, 最近距离)。

    判定：最近城市 ≤60km，且次近城市距离 ≥3 倍（或本身 >180km）。
    长三角、珠三角的城市彼此只隔几十公里，倍数不够就放弃——
    写错坐标会把游客导航到另一个城市的同名景点，比不显示地图糟得多。
    """
    if not cities:
        return None, None
    ds = sorted(((haversine_km(coord, c[1]), c[0]) for c in cities), key=lambda x: x[0])
    best_d, best = ds[0]
    if best_d > LEGACY_MAX_KM:
        return None, best_d
    if len(ds) > 1:
        second_d = ds[1][0]
        if second_d < best_d * LEGACY_MARGIN and second_d < LEGACY_SECOND_KM:
            return None, best_d
    return best, best_d


def norm_region(x):
    """去掉行政区划后缀，便于「北京市」和「北京」互认"""
    x = (x or '').strip()
    for suf in ('特别行政区', '维吾尔自治区', '壮族自治区', '回族自治区',
                '自治区', '自治州', '地区', '新区', '省', '市', '盟', '区', '县'):
        if x.endswith(suf) and len(x) > len(suf):
            return x[:-len(suf)]
    return x


def region_match(field, want):
    a, b = norm_region(field), norm_region(want)
    if not a or not b:
        return False
    return a == b or a.startswith(b) or b.startswith(a)


# ─── 全局限速 ───
_rate_lock = threading.Lock()
_rate_last = [0.0]


def _rate_wait():
    with _rate_lock:
        wait = GAP - (time.time() - _rate_last[0])
        if wait > 0:
            time.sleep(wait)
        _rate_last[0] = time.time()


def photon_search(q, limit=10):
    url = PHOTON_API + '?' + urllib.parse.urlencode({'q': q, 'limit': limit})
    for attempt in range(3):
        _rate_wait()
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        try:
            return json.loads(open_url(req, timeout=20).read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:
                time.sleep(3 + attempt * 3)
                continue
            if e.code == 429:
                raise
            return {'features': []}
    return {'features': []}


def feature_ok(f, name, city, prov):
    """判定这条 Photon 结果是不是这处景点

    四道关，缺一条就宁可不写坐标——错坐标比没坐标更糟，用户会真按导航开过去：
      ① 名字对得上（同名加上后缀也算，如「金山」→「金山公园」）；
      ② 落在本市或本省（只对省不对市的话，「龙泉寺·廊坊」会拿到邢台的廊坊村）；
      ③ 类别不是学校/医院/餐馆/高速服务区这类同名对象；
      ④ 在中国境内。
    """
    p = f.get('properties') or {}
    nm = (p.get('name') or '')
    if not nm or (name not in nm and nm not in name):
        return False
    if (p.get('osm_value') or '') in BAD_VALUES:
        return False
    if (p.get('country') or '') not in CN_COUNTRY:
        return False
    regions = [p.get('city'), p.get('county'), p.get('district'),
               p.get('locality'), p.get('state')]
    if not any(region_match(r, city) or region_match(r, prov) for r in regions):
        return False
    return True


def photon_lookup(name, city, prov):
    """返回 ('ok', [lng, lat]) / ('miss', None) / ('err', None)。

    查询串按「名字+城市 → 名字+省份 → 裸名」逐级放宽。
    'err' 与 'miss' 必须分开：网络失败不能记成"这地方查不到"，否则永远不再重试。
    """
    # 先查裸名：Photon 是前缀/模糊检索，带上城市反而会把结果压到 1 条
    # （「故宫 北京」只回 1 条，「故宫」回 8 条，其中就有北京市那条）。
    # 裸名一次查询就能覆盖大多数景点，城市由后面的结构化字段校验。
    city_q = CITY_ALIAS.get(city, city)
    queries = [name]
    if city and city != prov:
        queries.append('%s %s' % (name, city_q))
    if prov:
        queries.append('%s %s' % (name, prov))
    for q in queries:
        try:
            d = photon_search(q)
        except Exception:
            return 'err', None
        feats = [f for f in (d.get('features') or []) if feature_ok(f, name, city, prov)]
        if not feats:
            continue
        # 同名候选按「名字完全一致 > 天然/人文景点类」排序
        feats.sort(key=lambda f: (
            (f['properties'].get('name') or '') != name,
            (f['properties'].get('osm_key') or '') not in GOOD_KEYS))
        c = feats[0]['geometry']['coordinates']
        if not in_china((float(c[0]), float(c[1]))):
            continue            # country 字段偶尔缺失，坐标范围是最后一道关
        return 'ok', [round(float(c[0]), 5), round(float(c[1]), 5)]
    return 'miss', None


# ─── 维基 / Wikidata（国内通常不通，通了就先用它）───

def wiki_batch(titles):
    """一次取多个词条的坐标 + wikibase item"""
    if not titles:
        return {}
    url = ZHW + urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'redirects': '1',
        'titles': '|'.join(titles), 'prop': 'coordinates|pageprops'})
    d = get_json(url, retries=1, timeout=8)
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
        d = get_json(url, retries=1, timeout=10)
        for qid, ent in (d or {}).get('entities', {}).items():
            for cl in (ent.get('claims', {}) or {}).get('P625', [])[:1]:
                v = (cl.get('mainsnak', {}).get('datavalue', {}) or {}).get('value')
                if isinstance(v, dict) and 'latitude' in v:
                    out[qid] = (v['longitude'], v['latitude'])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0, help='本轮最多查多少个（试跑用）')
    ap.add_argument('--no-photon', action='store_true', help='不请求 Photon，只跑维基/Wikidata')
    ap.add_argument('--no-wiki', action='store_true', help='跳过维基/Wikidata 探测，直接走 Photon')
    ap.add_argument('--retry-miss', action='store_true', help='重查上轮没查到的')
    ap.add_argument('--conc', type=int, default=8, help='并发数（总速率仍受令牌桶限制）')
    args = ap.parse_args()

    db = load_json(CACHE, {})
    # 旧缓存里混进了境外同名景点（伦敦水晶宫、科罗拉多大峡谷…）。
    # 这里先清掉，指到国外的坐标比没有坐标更误导。
    out_cn = [k for k, v in db.items() if isinstance(v, list) and len(v) >= 2
              and not in_china((v[0], v[1]))]
    for k in out_cn:
        del db[k]
    if out_cn:
        print('  清掉境外坐标 %d 条：%s' % (len(out_cn), '、'.join(out_cn[:6])), flush=True)
    tried = {} if args.retry_miss else load_json(TRIED, {})
    spots = load_json(os.path.join(DATA, 'spots_uniq.json'), [])
    short = load_json(os.path.join(DATA, 'desc_db.json'), {})
    dup = {n for n, k in Counter(s['name'] for s in spots).items() if k > 1}

    # 旧缓存是裸名键，分不清是哪个城市的那一处。
    # 先看能不能判定归属（同城邻点质心），判不出来的才丢掉重查，
    # 免得「南山」三条全指向同一个地方。
    centroids = city_centroids(db, spots, dup)
    by_name = {}
    for s in spots:
        if s['name'] in dup:
            by_name.setdefault(s['name'], set()).add((s.get('prov', ''), s.get('city', '')))
    dropped = [k for k in list(db) if k in dup]
    adopted = 0
    for k in dropped:
        coord = db.pop(k)
        if not (isinstance(coord, list) and len(coord) >= 2):
            continue
        cands = [((p, c), centroids[(p, c)][:2], centroids[(p, c)][2])
                 for (p, c) in by_name.get(k, ()) if (p, c) in centroids]
        target, _d = assign_legacy((coord[0], coord[1]), cands)
        if not target:
            continue
        nk = '%s|%s|%s' % (target[0], target[1], k)
        if nk not in db:
            db[nk] = coord
            adopted += 1

    todo = []
    for s in spots:
        k = spot_key(s, dup)
        if k in db or k in tried:
            continue
        todo.append((k, s))
    print('坐标：缓存 %d 条（重名裸键 %d 条：判定归属 %d 条、丢弃 %d 条）｜待查 %d / %d 景点'
          % (len(db), len(dropped), adopted, len(dropped) - adopted, len(todo), len(spots)),
          flush=True)
    if args.limit:
        todo = todo[:args.limit]

    # 1) 维基词条坐标（批量）
    #    国内网络下这条基本不通。先拿第一批试探：整批一个坐标都没拿到，
    #    就判定对端不可达，直接走下一档——否则 1000 多个标题按 20 个一批
    #    挨个超时，光这一步就得耗十几分钟还一条都拿不到。
    by_title = {}
    for k, s in todo:
        v = short.get(k) or short.get(s['name'])
        by_title[k] = v[1] if isinstance(v, list) and len(v) > 1 else s['name']
    titles = list(dict.fromkeys(by_title.values()))
    got = {}
    if titles and not args.no_wiki:
        probe = wiki_batch(titles[:20])
        if any((r or {}).get('lon') is not None for r in probe.values()):
            got.update(probe)
            for i in range(20, len(titles), 20):
                got.update(wiki_batch(titles[i:i + 20]))
        else:
            print('  维基坐标接口不可达，跳过（直接走 Photon）', flush=True)
    need_wd = []
    for k, s in todo:
        r = got.get(by_title[k]) or {}
        if r.get('lon') is not None and in_china((r['lon'], r['lat'])):
            db[k] = [r['lon'], r['lat'], 'wiki']
        elif r.get('qid'):
            need_wd.append((k, r['qid']))
    if need_wd:
        wd = wikidata_coords([q for _, q in need_wd])
        for k, qid in need_wd:
            v = wd.get(qid)
            if v and in_china(v):
                db[k] = [v[0], v[1], 'wikidata']

    # 2) Photon 兜底（维基那档在国内基本是空的，这里才是主力）
    hit = err = 0
    if not args.no_photon:
        pending = [(k, s) for k, s in todo if k not in db]

        def work(item):
            k, s = item
            return k, photon_lookup(s['name'], s.get('city', ''), s.get('prov', ''))

        with ThreadPoolExecutor(max_workers=args.conc) as ex:
            for i, (k, (st, pts)) in enumerate(ex.map(work, pending), 1):
                if st == 'ok':
                    db[k] = [pts[0], pts[1], 'osm']
                    hit += 1
                elif st == 'miss':
                    tried[k] = time.strftime('%Y-%m-%d')
                else:
                    err += 1
                if i % 50 == 0:
                    print('  …%d/%d（命中 %d，失败待重试 %d）'
                          % (i, len(pending), hit, err), flush=True)
                    save_json(CACHE, db)
                    save_json(TRIED, tried)

    save_json(CACHE, db)
    save_json(TRIED, tried)
    print('本轮命中 %d 个（网络失败 %d 个，下轮重试）｜缓存共 %d 条（维基 %d / Wikidata %d / OSM %d）'
          % (hit, err, len(db),
             sum(1 for v in db.values() if v[2] == 'wiki'),
             sum(1 for v in db.values() if v[2] == 'wikidata'),
             sum(1 for v in db.values() if v[2] == 'osm')))
    export(db)


def export(db):
    if not db:
        print('坐标为空，拒绝导出')
        return
    open(os.path.join(JS, 'coords-db.js'), 'w', encoding='utf-8').write(js_export(
        db,
        '// ═══ 景点坐标库（WGS84，来自维基百科 / Wikidata / OpenStreetMap）═══\n'
        '// 生成：tools/fetch_coords.py。格式：{ 键: [lng, lat, 来源] }\n'
        '// 键：重名景点为「省|市|名」，唯一名为裸名；前端按同样顺序回退查找\n'
        'export const COORD_DB = '))
    print('导出 %d 条 → js/coords-db.js' % len(db))


if __name__ == '__main__':
    main()
