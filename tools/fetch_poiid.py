#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""百度地图 · 景点 POI 检索（构建期批量采集 poiid）

为什么需要 poiid：
    只传经纬度时，百度返回的是"该坐标附近的气泡"，可能是隔壁马路；
    传 poiid（POI 的 uid）则直接取"景点本身的全景点"——
    故宫就是故宫大门，兵马俑就是俑坑入口。

用法：
    export BAIDU_AK=你的AK        # 或在 js/config.js 里填好后用 --ak-from-config
    python tools/fetch_poiid.py
    python tools/fetch_poiid.py --limit 30      # 小样本先验
    python tools/fetch_poiid.py --export-only    # 只导出，不抓取

产物：
    data/poiid_db.json   原始缓存（断点续跑用）
    js/poiid-db.js       前端静态库 { 景点名: { uid, name, lng, lat, addr } }
"""
import argparse, json, math, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, JS, get_json, load_json, save_json

# ── 坐标：百度返回 BD-09，我们的库是 WGS84 → 需要换算后比距离 ──
PI = 3.1415926535897932384626
X_PI = PI * 3000.0 / 180.0
A = 6378245.0
EE = 0.00669342162296594323


def _out_of_china(lat, lon):
    return not (73.66 < lon < 135.05 and 3.86 < lat < 53.55)


def _tlat(x, y):
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * PI) + 20.0 * math.sin(2.0 * x * PI)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * PI) + 40.0 * math.sin(y / 3.0 * PI)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * PI) + 320 * math.sin(y * PI / 30.0)) * 2.0 / 3.0
    return ret


def _tlon(x, y):
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * PI) + 20.0 * math.sin(2.0 * x * PI)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * PI) + 40.0 * math.sin(x / 3.0 * PI)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * PI) + 300.0 * math.sin(x / 30.0 * PI)) * 2.0 / 3.0
    return ret


def wgs84_to_bd09(lat, lon):
    """WGS84 → BD-09（百度坐标）"""
    if _out_of_china(lat, lon):
        return lon, lat
    dlat = _tlat(lon - 105.0, lat - 35.0)
    dlon = _tlon(lon - 105.0, lat - 35.0)
    radlat = lat / 180.0 * PI
    magic = math.sin(radlat)
    magic = 1 - EE * magic * magic
    sq = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((A * (1 - EE)) / (magic * sq) * PI)
    dlon = (dlon * 180.0) / (A / sq * math.cos(radlat) * PI)
    gcj_lat = lat + dlat
    gcj_lon = lon + dlon
    zb = math.sqrt(gcj_lon * gcj_lon + gcj_lat * gcj_lat) + 0.00002 * math.sin(gcj_lon * X_PI)
    th = math.atan2(gcj_lat, gcj_lon) + 0.000003 * math.cos(gcj_lon * X_PI)
    return zb * math.cos(th) + 0.0065, zb * math.sin(th) + 0.006


def haversine(lng1, lat1, lng2, lat2):
    """米距离"""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def lcs_len(a, b):
    """最长公共子串长度（中文名相似度用）"""
    if not a or not b:
        return 0
    prev = [0] * (len(b) + 1)
    best = 0
    for i in range(1, len(a) + 1):
        cur = [0] * (len(b) + 1)
        for j in range(1, len(b) + 1):
            if a[i - 1] == b[j - 1]:
                cur[j] = prev[j - 1] + 1
                if cur[j] > best:
                    best = cur[j]
        prev = cur
    return best


def read_ak(args):
    ak = args.ak or os.environ.get('BAIDU_AK', '').strip()
    if ak:
        return ak
    # 从 js/config.js 里读
    p = os.path.join(JS, 'config.js')
    if os.path.exists(p):
        txt = open(p, encoding='utf-8').read()
        m = re.search(r"BAIDU_AK\s*=\s*['\"]([^'\"]*)['\"]", txt)
        if m:
            return m.group(1).strip()
    return ''


PLACE_API = 'https://api.map.baidu.com/place/v2/search'


def probe_place_service(ak):
    """前置探测：地点检索服务是否已开通

    百度控制台的服务要逐个申请。未开通时所有请求都返回 240
    「APP 服务被禁用」——若不先探测就跑完 773 条，结果只是一库空值，
    还白白消耗配额和时间。这里直接探测并快速失败。
    """
    import urllib.parse
    url = PLACE_API + '?' + urllib.parse.urlencode({
        'query': '故宫', 'region': '北京', 'output': 'json', 'ak': ak, 'scope': '2',
    })
    d = get_json(url, retries=2, timeout=20)
    if not d:
        return False, '网络请求失败（检查 PROXY 代理设置）'
    if d.get('status') == 0:
        return True, '可用（样例查询命中 %d 条）' % len(d.get('results') or [])
    msg = d.get('message', '')
    code = d.get('status', '')
    if str(code) == '240':
        return False, ('240 APP 服务被禁用 —— 需在百度控制台应用详情页的'
                       '「服务管理」中勾选开通「地点检索」')
    return False, '%s(%s)' % (msg, code)


# 非景点类 POI：搜「鼓浪屿」会返回「鼓浪屿街道办事处」，这类要排除
NOT_SCENIC = re.compile(
    r'(街道办|街道办事处|人民政府|派出所|居委会|村委会|社区服务|'
    r'卫生院|诊所|医院|学校|中学|小学|幼儿园|大学|学院|'
    r'宾馆|酒店|旅馆|客栈|餐厅|饭店|小吃|咖啡|茶楼|酒吧|'
    r'火车站|客运站|汽车站|地铁站|公交站|停车场|加油站|ATM|银行|'
    r'派出所|广场管理|管理处|售票处(?!景)|超市|商场|购物中心|公园管理处)')


def search_poi(ak, query, region, city, name, lng, lat, radius=5000):
    """检索景点 POI，返回 (uid, poi_name, dist_m) 或 None"""
    import urllib.parse
    url = PLACE_API + '?' + urllib.parse.urlencode({
        'query': query, 'region': region, 'city_limit': 'true',
        'output': 'json', 'ak': ak, 'scope': '2', 'page_size': '10',
    })
    d = get_json(url, retries=3, timeout=20)
    if not d:
        return None
    if d.get('status') not in (0, None):
        return ('ERR', d.get('message', ''), d.get('status'))
    results = d.get('results') or []
    if not results:
        return None
    # 我们的 WGS84 坐标 → BD-09，用来算距离
    blng, blat = wgs84_to_bd09(lat, lng)
    best = None
    for r in results:
        rname = (r.get('name') or '').strip()
        loc = r.get('location') or {}
        rlng, rlat = loc.get('lng'), loc.get('lat')
        if rlng is None or rlat is None:
            continue
        dist = haversine(blng, blat, rlng, rlat)
        # 非景点类 POI 直接排除
        if NOT_SCENIC.search(rname):
            continue
        # 名字相似度是主判据：景点名要么包含于 POI 名，要么有较长公共子串
        sim = lcs_len(name, rname)
        ok_name = (name in rname) or (rname in name) or (sim >= max(2, len(name) - 2))
        if not ok_name:
            continue
        # 距离只做排序（超过 radius 仍可保留但排到后面），不硬性排除：
        # GCJ-02 与 WGS84 换算有数百米误差，且大景区本身占地 1km 以上
        if dist > radius:
            continue
        score = sim * 1000 - dist
        if best is None or score > best[0]:
            best = (score, r.get('uid'), rname, dist, rlng, rlat,
                    r.get('address') or '', r.get('detail_info') or {})
    if best is None:
        return None
    return best[1], best[2], best[3], best[4], best[5], best[6]


def collect(ak, limit=None, workers=6):
    # 前置探测：服务没开通就别跑，跑了也是一库空值
    ok, detail = probe_place_service(ak)
    print('地点检索服务探测：%s → %s' % ('可用' if ok else '不可用', detail), flush=True)
    if not ok:
        print('\n已中止。请先在百度控制台开通「地点检索」服务：')
        print('  https://lbsyun.baidu.com/ → 应用管理 → 服务管理 → 勾选「地点检索」')
        print('开通后重跑本脚本。')
        return None

    spots = load_json(os.path.join(DATA, 'spots_uniq.json'), [])
    coords = load_json(os.path.join(DATA, 'coords.json'), {})
    cache_path = os.path.join(DATA, 'poiid_db.json')
    db = load_json(cache_path, {})

    todo = []
    for s in spots:
        n = s['name']
        if n in db and db[n]:
            continue
        c = coords.get(n)
        if not c:
            continue
        todo.append((n, s.get('city', ''), s.get('prov', ''), c[0], c[1]))
    # 打乱顺序，避免失败的头部反复占用名额
    import random
    random.Random(20261024).shuffle(todo)
    if limit:
        todo = todo[:limit]
    print('待查 %d 个（已有 %d 条缓存）' % (len(todo), len(db)), flush=True)
    if not todo:
        return db

    done = hit = 0
    stat = {}
    fatal = []          # 致命错误（服务被禁用等）：一旦出现立即停止

    def work(item):
        n, city, prov, lng, lat = item
        region = city or prov
        if not region:
            return n, None
        try:
            res = search_poi(ak, n, region, city, n, lng, lat)
        except Exception:
            res = None
        # 服务被禁用这类致命错误要冒泡，不能当成"没查到"吞掉
        if res and res[0] == 'ERR' and str(res[2]) == '240':
            return n, res
        return n, res

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for n, res in ex.map(work, todo):
            done += 1
            if res and res[0] == 'ERR':
                stat[res[2]] = stat.get(res[2], 0) + 1
                if str(res[2]) == '240':
                    # 服务被禁用：立刻停止，别把剩下的都写成空值
                    fatal.append(res[1])
                    break
                db[n] = ''
            elif res:
                uid, rname, dist, rlng, rlat, addr = res
                db[n] = {'uid': uid, 'name': rname, 'lng': rlng, 'lat': rlat,
                         'addr': addr, 'dist': int(dist)}
                hit += 1
            else:
                db[n] = ''
            if done % 20 == 0:
                save_json(cache_path, db)
                print('  进度 %d/%d 命中 %d' % (done, len(todo), hit), flush=True)

    if fatal:
        print('\n致命错误：%s —— 地点检索服务被禁用，已停止。' % fatal[0], flush=True)
        print('请在百度控制台开通「地点检索」后重跑。', flush=True)
        return None

    save_json(cache_path, db)
    print('本轮 %d 个，命中 %d，缓存共 %d' % (done, hit, len(db)), flush=True)
    if stat:
        print('接口错误分布：%s（错误码含义见百度文档）' % stat, flush=True)
    return db


def export():
    db = load_json(os.path.join(DATA, 'poiid_db.json'), {})
    out = {}
    for k, v in db.items():
        if not v or not isinstance(v, dict) or not v.get('uid'):
            continue
        out[k] = {'uid': v['uid'], 'name': v.get('name', ''),
                   'lng': v.get('lng'), 'lat': v.get('lat'),
                   'addr': v.get('addr', '')}
    if not out:
        print('缓存为空，拒绝导出（先跑一次抓取）')
        return
    js = ('// ═══ 百度地图 POI 检索结果（构建期批量采集）═══\n'
          '// 生成：tools/fetch_poiid.py。格式：{ 景点名: { uid, name, lng, lat, addr } }\n'
          '// uid 即 poiid，传给 panorama/v2 可取"景点本身的全景点"而非附近气泡。\n'
          'export const POIID_DB = ' + json.dumps(out, ensure_ascii=False, indent=0) + ';\n')
    open(os.path.join(JS, 'poiid-db.js'), 'w', encoding='utf-8').write(js)
    print('导出 %d 条 → js/poiid-db.js (%.0f KB)'
          % (len(out), os.path.getsize(os.path.join(JS, 'poiid-db.js')) / 1024))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--ak', default='')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--export-only', action='store_true')
    a = ap.parse_args()
    if a.export_only:
        export()
    else:
        ak = read_ak(a)
        if not ak:
            print('未找到 AK。请 export BAIDU_AK=xxx 或在 js/config.js 里填 BAIDU_AK。')
            sys.exit(1)
        print('使用 AK: %s...' % ak[:8])
    db = collect(ak, a.limit or None, a.workers)
    if db is None:
        sys.exit(2)
    export()
