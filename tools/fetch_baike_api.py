# -*- coding: utf-8 -*-
"""景点图文抓取（API 版）：百度百科 openapi 取文案 + 360 图搜取真实照片。

为什么另起一个抓取器，而不是修 fetch_baike.mjs：
    baike.baidu.com 的 HTML 页面已被 IP 级风控（403「百度安全验证」），
    1836 条里 1651 条拿不到；但百科的 openapi
    （/api/openapi/BaikeLemmaCardApi）仍然 200，返回结构化 JSON：
    title / key / abstract / desc，无需浏览器、无需 CDP。
    照片则走 image.so.com 的 JSON 接口，返回的 thumb 本身就是
    360 CDN 上的原图镜像（实测与原图同字节数），可直连下载。

两个数据源都是 JSON，不解析 HTML，因此不受页面改版与 CSS 混淆影响。

命中的坑与对策：
    1) 冷门景点名 ≠ 词条名（「长城·八达岭」→「八达岭长城」、
       「清名桥古运河」→「清名桥」）→ 生成候选查询串逐个试。
    2) 同名歧义（「鸽子窝」是禾本科高粱属种质）→
       摘要命中「种质/学名/变种/禾本科」且无「位于/景区/公园」等景点信号时判否。
    3) 单 IP 高频会被限流 → 多线程 + 间隔 + 连续失败自动退避。

用法：
    python tools/fetch_baike_api.py --limit 20          # 试跑 20 条
    python tools/fetch_baike_api.py --all --missing     # 补齐所有缺的
    python tools/fetch_baike_api.py --all --text-only   # 只补文案
    python tools/fetch_baike_api.py --all --img-only    # 只补图片

断点续跑：结果写 data/baike_api_db.json。
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, load_json, save_json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(DATA, 'baike_api_db.json')

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
API = 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi'
IMG_API = 'https://image.so.com/j'

# 非景点信号：命中了但没景点词，基本就是同名物种/公司/影视歌
NEG = re.compile(r'种质|栽培|选育|变种|亚种|品系|禾本科|学名[:：]|药材|物种|'
                 r'属的植物|有限公司|股份|学校|学院|医院|小区|楼盘|招聘|'
                 r'小说|电视剧|电影|专辑|歌曲|歌词|演唱|单曲|主题曲|游戏|软件|动漫')
POS = re.compile(r'位于|坐落|景区|名胜|风景|公园|旅游|遗址|古建|建筑|文物|'
                 r'世界文化|AAAA|古镇|古城|博物馆|寺|塔|长城|故居|纪念馆')
# 摘要开头就在定义"歌/专辑"的，是歌曲词条而不是景点（「客天下」就是宋祖英唱的那首）。
# 只看开头 24 字：后面提到"景区""为某景区创作"不算数——那正是同名歌曲的写法；
# 而真景点后面提到拍过电影（「芙蓉镇是电影《芙蓉镇》的拍摄地」）不能被误伤，
# 所以这里只放歌曲类词，不放"电影/电视剧"。
EARLY_BAD = re.compile(r'演唱|歌曲|单曲|专辑|主题曲|歌词')
EARLY_OK = re.compile(r'位于|坐落|景区|名胜|公园|遗址|古镇|古城|建筑|文物')

# 图片标题里的非实景词：地图/门票/攻略这类不是"真实景象照片"
IMG_BAD = re.compile(r'地图|位置|路线|示意|平面图|门票|价格|攻略|大全|排行|榜单|'
                     r'logo|标志|旗帜|卫星|天气|酒店|住宿|机票|火车|广告|海报|'
                     r'文字|图表|二维码|头像|表情|壁纸下载')
# 文件名/URL 里的非照片特征（沿用 common.is_good 的思路再收紧一点）
IMG_BAD_URL = re.compile(r'\.(svg|gif|png|webp)(\?|$)|sprite|icon|blank', re.I)

SUFFIXES = ('风景名胜区', '风景区', '旅游区', '度假区', '景区', '古镇', '古城',
            '古运河', '老街', '步行街', '文化街', '公园')


def get(url, referer='', timeout=20, retries=2):
    """GET 返回文本；失败返回 None（不抛异常，交由上层计数）"""
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': UA,
                'Referer': referer or 'https://baike.baidu.com/',
                'Accept': 'application/json,text/html,*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9',
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode('utf-8', 'replace')
        except Exception:
            if i == retries:
                return None
            time.sleep(0.6 * (i + 1))
    return None


def jget(url, referer='', **kw):
    """GET 并解析 JSON；空对象/坏 JSON 一律 None"""
    t = get(url, referer, **kw)
    if not t or not t.lstrip().startswith('{'):
        return None
    try:
        d = json.loads(t)
    except Exception:
        return None
    return d if isinstance(d, dict) else None


# ─── 文案：百度百科 openapi ───

def candidates(name, city='', prov=''):
    """按命中概率从高到低生成候选查询串（去重保序）"""
    out = []

    def add(x):
        x = (x or '').strip()
        if x and x not in out:
            out.append(x)

    add(name)
    # 「长城·八达岭」这类：后半是具体景点，先试具体的那半，
    # 再试「具体+泛指」（八达岭+长城），最后才回落到泛指（长城）
    for sep in ('·', '・', '•', '-', '—', '–', '：', ':'):
        if sep in name:
            parts = [p for p in name.split(sep) if p]
            if len(parts) >= 2:
                for p in reversed(parts[1:]):
                    add(p)
                add(parts[-1] + parts[0])
                add(parts[0] + parts[-1])
            for part in parts:
                add(part)
                add(city + part)
    add(name.replace('·', ''))
    add(city + name)
    add(name + city)
    add(prov + name)
    # 「XX古镇」「XX风景区」这类后缀常不在词条名里
    for suf in SUFFIXES:
        if name.endswith(suf) and len(name) > len(suf) + 1:
            add(name[:-len(suf)])
    return out


def accept(resp, name, q=''):
    """判定返回结果是不是这个景点（挡掉同名物种/公司/影视歌）

    q 是真正发出去的候选查询串。必须一并参与判定：
    词条名常与景点名不同（「七宝老街」→「七宝古镇」、「应县木塔」→「佛宫寺释迦塔」），
    它们靠「七宝」「应县木塔」这类候选串才搜到，只拿景点全名比会把这些正确结果全判否。
    """
    t = (resp.get('title') or '').strip()
    k = (resp.get('key') or '').strip()
    a = (resp.get('abstract') or '').strip()
    if len(a) < 40:
        return False, 'short'
    aliases = {name}
    if q:
        aliases.add(q)
    for p in re.split(r'[·・•\-—–：:]', name):
        if len(p) >= 2:
            aliases.add(p)
    related = any(x in t or x in k or (t and t in x) or (k and k in x)
                  for x in aliases if x)
    if not related:
        return False, 'title:' + t[:12]
    if NEG.search(a) and not POS.search(a):
        return False, 'neg:' + t[:12]
    head = a[:24]
    if EARLY_BAD.search(head) and not EARLY_OK.search(head):
        return False, 'early-bad:' + t[:12]
    return True, ''


def fetch_text(name, city='', prov=''):
    """返回 {ok, title, abs, desc, q} 或 {ok: False, err}"""
    last = 'no-hit'
    for q in candidates(name, city, prov):
        url = API + '?' + urllib.parse.urlencode({
            'scope': 103, 'format': 'json', 'appid': 379020,
            'bk_key': q, 'bk_length': 1000})
        d = jget(url)
        if not d or not d.get('title'):
            continue
        good, why = accept(d, name, q)
        if not good:
            last = why
            continue
        return {
            'ok': True,
            'title': (d.get('title') or '').strip(),
            'abs': (d.get('abstract') or '').strip(),
            'desc': (d.get('desc') or '').strip(),
            'q': q,
        }
    return {'ok': False, 'err': last}


# ─── 图片：360 图搜 ───

def fetch_images(name, title, city=''):
    """返回候选图 URL 列表（按相关度/构图排序，最多 3 个）

    泛名要用城市限定，否则搜出来是别处的东西：
    「铁塔」（开封琉璃砖塔）单独搜回来的是埃菲尔铁塔和澳门电信塔；
    「客天下」（梅州）单独搜回来的多是同名歌曲配图。
    经验值：词条名 ≤4 字基本都会跑偏，此时优先用「城市+名称」去搜。
    """
    key = title or name
    queries = []
    if city and len(key) <= 4:
        queries.append(city + key)
    queries.append(key)
    if key != name:
        queries.append(name)
    if city and name not in queries[-1]:
        queries.append(city + name)

    items = []
    for q in queries:
        url = IMG_API + '?' + urllib.parse.urlencode({'q': q, 'pn': 0, 'rn': 20})
        d = jget(url, referer='https://image.so.com/')
        items = (d or {}).get('list') or []
        if len(items) >= 3:
            break

    scored = []
    for it in items:
        u = (it.get('thumb') or '').strip()
        ttl = (it.get('title') or '').strip()
        if not u.startswith('http') or IMG_BAD_URL.search(u) or IMG_BAD.search(ttl):
            continue
        try:
            w = int(it.get('width') or 0)
            h = int(it.get('height') or 0)
        except Exception:
            w = h = 0
        if w and h and (w < 480 or h < 280):
            continue
        ratio = (w / h) if h else 1.5
        if w and h and not (0.95 <= ratio <= 2.8):
            continue
        score = 0.0
        if name and name in ttl:
            score += 4
        if title and len(title) >= 3 and title[:3] in ttl:
            score += 2
        if 1.2 <= ratio <= 2.0:
            score += 1.5
        score += min(len(ttl), 28) / 28.0
        scored.append((score, u))
    scored.sort(key=lambda x: -x[0])
    return [u for _, u in scored[:3]]


# ─── 主流程 ───

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--missing', action='store_true', help='只抓没有成功记录的')
    ap.add_argument('--text-only', action='store_true')
    ap.add_argument('--img-only', action='store_true')
    ap.add_argument('--conc', type=int, default=4)
    ap.add_argument('--gap', type=float, default=0.25)
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()

    spots = load_json(os.path.join(DATA, 'spots_uniq.json'), [])
    db = load_json(OUT, {})
    local_img = load_json(os.path.join(DATA, 'baike_img_local.json'), {})
    img_db = load_json(os.path.join(DATA, 'img_db.json'), {})

    def needs(s):
        v = db.get(s['name']) or {}
        if args.text_only:
            return not v.get('ok')
        if args.img_only:
            return not (v.get('imgs') or [])
        # 默认：文案没拿到，或者还没有本地照片
        return not v.get('ok') or not (s['name'] in local_img or v.get('imgs'))

    todo = [s for s in spots if (not args.missing) or needs(s)]
    if args.limit:
        todo = todo[:args.limit]

    print('景点 %d｜已成功 %d｜本轮 %d｜并发 %d｜%s' % (
        len(spots), len([1 for v in db.values() if v.get('ok')]),
        len(todo), args.conc,
        '只文案' if args.text_only else ('只图片' if args.img_only else '图文')))

    lock = __import__('threading').Lock()
    stat = {'text': 0, 'img': 0, 'miss': 0, 'fail': 0, 'done': 0}
    t0 = time.time()
    stop = {'consec_fail': 0}

    def work(s):
        name, city, prov = s['name'], s.get('city', ''), s.get('prov', '')
        rec = db.get(name) or {}
        if not args.img_only:
            r = fetch_text(name, city, prov)
            if r.get('ok'):
                rec.update(r)
                rec['city'], rec['prov'] = city, prov
            elif not rec.get('ok'):
                rec.update({'ok': False, 'err': r.get('err', 'no-hit')})
        if not args.text_only:
            title = rec.get('title') or ''
            imgs = fetch_images(name, title, city)
            if imgs:
                rec['imgs'] = imgs
                rec['imgq'] = title or name
        rec['ts'] = int(time.time() * 1000)
        with lock:
            db[name] = rec
            stat['done'] += 1
            if rec.get('ok'):
                stat['text'] += 1
            if rec.get('imgs'):
                stat['img'] += 1
            if not rec.get('ok') and not rec.get('imgs'):
                (stat.__setitem__('miss', stat['miss'] + 1) if rec.get('err') == 'no-hit'
                 else stat.__setitem__('fail', stat['fail'] + 1))
            n = stat['done']
            if n % 20 == 0:
                el = time.time() - t0
                sp = n / max(0.1, el)
                eta = (len(todo) - n) / max(0.1, sp) / 60
                print('  %d/%d 文案 %d 图片 %d 未命中 %d 失败 %d · %.1f/s · 约剩 %.0f 分'
                      % (n, len(todo), stat['text'], stat['img'],
                         stat['miss'], stat['fail'], sp, eta), flush=True)
                save_json(OUT, db)
        return rec

    with ThreadPoolExecutor(max_workers=args.conc) as ex:
        futs = [ex.submit(work, s) for s in todo]
        for f in as_completed(futs):
            try:
                r = f.result()
                if r.get('ok') or r.get('imgs'):
                    stop['consec_fail'] = 0
                else:
                    stop['consec_fail'] += 1
            except Exception:
                stop['consec_fail'] += 1
            if stop['consec_fail'] >= 12:
                print('  ! 连续 12 条全空，疑似被限流，暂停 30s', flush=True)
                time.sleep(30)
                stop['consec_fail'] = 0
            time.sleep(args.gap / max(1, args.conc))

    save_json(OUT, db)
    ok_all = len([1 for v in db.values() if v.get('ok')])
    img_all = len([1 for v in db.values() if v.get('imgs')])
    print('\n完成：文案 %d/%d 有记录，图片 %d/%d 有记录，用时 %.0fs → %s'
          % (ok_all, len(spots), img_all, len(spots), time.time() - t0, OUT))


if __name__ == '__main__':
    main()
