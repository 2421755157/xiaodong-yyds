#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抓取景点 / 省市的真实简介（中文维基百科词条首段 → 简体），并导出前端库。

用法：
    python tools/fetch_descriptions.py            # 景点 + 省市 全量（可断点续跑）
    python tools/fetch_descriptions.py --spots 50 # 只补前 50 个缺失的景点
    python tools/fetch_descriptions.py --regions   # 只跑省市

产出：
    data/desc_db.json      { 景点名 | 省|市|名: [简介, 词条名] }  原始缓存（断点续跑用）
    data/region_db.json    { "省名" | "省|市": 简介 }
    js/spot-desc-db.js     SPOT_DESC_DB
    js/region-desc-db.js   REGION_DESC_DB

注意：同名不同地的景点（西湖 / 象鼻山 / 世界之窗…）在维基是两个词条，
      缓存里用「省|市|名」做键，见 dup_names / resolve_dup。
"""
import argparse, json, os, re, sys, time, urllib.parse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (DATA, JS, ZHW, clean_text, get_json, is_disambig, js_export,
                    load_json, save_json, search_title as _search_title)
from place_guard import mismatch

SPOT_CACHE = os.path.join(DATA, 'desc_db.json')
REGION_CACHE = os.path.join(DATA, 'region_db.json')
# 「按名字查到的词条讲的不是这一处」的记账本：{缓存键: 被否掉的词条名}。
# 没有它，每次续跑都会把同一批泛名景点重新查一遍、又拿到同一篇外地词条，
# 白白多发上百条请求。
REJECT_CACHE = os.path.join(DATA, 'desc_reject.json')
# 人工判过「维基没有这一处的词条，只有同名的商品/传说/另一个地方」的景点：{键: 理由}。
# 自动校验只能看「有没有本市字样」，像「望儿山酒是营口出产的白酒」这种正文确实
# 落在本市、但讲的不是风景的，只能人工拉黑，否则每次重跑又把它捡回来。
BLOCK_CACHE = os.path.join(DATA, 'desc_block.json')
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


# ─── 同名不同地：西湖 / 象鼻山 / 世界之窗 … ───────────────────
# 这类名字在每个城市指的是一处不同的风景，维基也是不同词条。
# 早先只按「景点名」做键，后入库的城市直接复用了先入库城市那段话：
# 惠州西湖显示杭州西湖、呼和浩特的寺庙显示拉萨大昭寺、清远显示韶关丹霞山。
# 所以重名景点一律用「省|市|名」做键，前端也按同一规则查（见 js/lexicon.js）。
def dup_names(spots):
    c = Counter(s['name'] for s in spots)
    return {n for n, k in c.items() if k > 1}


def spot_desc_key(s, dup):
    if s['name'] in dup:
        return '%s|%s|%s' % (s.get('prov', ''), s.get('city', ''), s['name'])
    return s['name']


# 词条名后面接这些后缀，讲的通常是同名的基础设施 / 行政区 / 作品，不是这处风景。
# 实际踩过：「五当召」取到「五当召镇」、「南湖」取到「嘉兴南湖机场」、
# 「大别山」取到「大别山晨刊」（报纸）。
BAD_TAIL = ('机场', '车站', '站', '镇', '乡', '街道', '社区', '村', '路', '街',
            '区', '县', '大学', '中学', '小学', '公司', '集团', '专辑', '电影',
            '电视剧', '歌曲', '小说', '游戏', '品牌', '赛事',
            '日报', '晚报', '晨刊', '周刊', '月刊', '杂志', '电视台', '广播')

# 正文里出现这些词，说明是舞剧 / 影视 / 企业这类同名作品或机构，不是地理实体
OFF_TOPIC_WORDS = ('舞剧', '芭蕾', '歌剧', '交响', '音乐剧', '电影', '电视剧',
                   '小说', '专辑', '歌曲', '漫画', '动画', '游戏', '综艺',
                   '日报', '晚报', '晨刊', '周刊', '杂志', '电视台', '频道',
                   '有限公司', '股份', '人民政府', '委员会')

# 首句开头就是商品 / 传说：同名景点被商品名或志怪词条抢占。
# 实际踩过：「望儿山」查到「望儿山酒」（营口出产的白酒），
# 「铜山」查到「铜山湖水怪」。这类词条标题和景点名一模一样，
# 只是正文讲的根本不是风景，标题层面筛不出来，只能在首句筛。
SUBJECT_WORDS = ('白酒', '黄酒', '啤酒', '米酒', '果酒', '酒厂', '酒业',
                 '商标', '水怪', '矿泉水', '香烟', '传说')


def precise_title(title, name):
    """词条标题是否就是这处风景（允许「世界之窗 (深圳)」这种消歧义括号）"""
    if not title or not name:
        return False
    if title == name:
        return True
    if title.startswith(name):
        rest = title[len(name):]
    elif title.endswith(name):
        rest = title[:len(title) - len(name)]
    else:
        return False
    rest = rest.strip('·・-—()（） ')
    if not rest:
        return True
    # 括号消歧义（「世界之窗 (深圳)」）是好事，交给正文按城市校验
    if rest[0] in '(（' or rest[-1] in ')）':
        return True
    return not (rest.startswith(BAD_TAIL) or rest.endswith(BAD_TAIL))


def off_topic(text, name):
    """正文看起来不是讲这处风景的（同名作品 / 机构 / 人物 / 配套设施）"""
    head = (text or '')[:60]
    if head.lstrip().startswith('《'):          # 书名号开头 = 作品词条（天鹅湖是舞剧）
        return True
    if re.search(re.escape(name) + '(?:' + '|'.join(BAD_TAIL) + ')', head):
        return True
    if any(w in head for w in OFF_TOPIC_WORDS):
        return True
    # 首句讲的是同名商品/志怪：「望儿山酒是营口出产的一系列白酒」「铜山湖水怪又称泌阳龙」
    if any(w in head[:24] for w in SUBJECT_WORDS):
        return True
    # 人物词条：「陈镜湖（1901年—1933年）」
    return bool(re.search(r'^' + re.escape(name) + r'[（(]\d{4}年', head))


def search_pages(q, limit=6):
    """按关键词检索词条（含首段）→ [(标题, 正文)]"""
    u = urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'generator': 'search',
        'gsrsearch': q, 'gsrlimit': limit, 'gsrnamespace': '0',
        'prop': 'extracts', 'exintro': '1', 'explaintext': '1',
        'exlimit': 'max', 'variant': 'zh-cn'})
    d = get_json(ZHW + u, retries=2, timeout=20)
    if not d or 'query' not in d:
        return []
    ps = sorted(d['query'].get('pages', {}).values(), key=lambda p: p.get('index', 99))
    return [(p['title'], p.get('extract') or '') for p in ps]


def locate_title(name, city, prov):
    """定位景点对应的词条标题。

    先用 common.search_title（按标题匹配），它有两个已知落空/跑偏：
      · 繁体标题：「五当召」的词条标题是「五當召」，永远查不到；
      · 就近匹配到同名行政单位：「五当召镇」。
    所以补一道兜底：正文开头就是这个名字，也算命中；标题像"镇/站/机场"的先否掉。
    """
    t = search_title(name, city, prov)
    if t and precise_title(t, name):
        return t
    for ti, x in search_pages(name, 5):
        if not x or is_disambig(x) or off_topic(x, name):
            continue
        if precise_title(ti, name) or x.startswith(name):
            return ti
    return None


def desc_ok(text, name, city, prov):
    """这段首段能不能挂到这个景点下面。

    三道关：不是消歧义页、不是同名作品/机构、讲的地域确实是本市这一处
    （最后一条见 place_guard）。泛名景点（长岛 / 铁塔 / 大峡谷）栽在第三条上。
    """
    if not text or is_disambig(text) or off_topic(text, name):
        return False
    return mismatch(text, city, prov) is None


def locate_scoped(name, city, prov):
    """给泛名景点找「本地这一处」的词条：候选正文里必须出现本市名。

    按名字查到的词条是「总述词条」或外地那一处（长岛→纽约、大峡谷→科罗拉多），
    所以先按「城市+名」检索，再要求正文里明确出现城市名，才敢收。
    """
    if not city:
        return None, None
    cands = {}
    for q in (city + name, name + city):
        for t, x in search_pages(q):
            cands.setdefault(t, x)
    for t, x in cands.items():
        if not precise_title(t, name) or is_disambig(x) or off_topic(x, name):
            continue
        if city not in x:
            continue
        txt = clean_text(x, name)
        if txt and desc_ok(txt, name, city, prov):
            return t, txt
    return None, None


def resolve_dup(s, db, city_names, prov_names):
    """给重名景点找回「本地这一处」的词条。

    先按「城市+名」检索，只接受标题确实是这处风景、且正文明确落在本市的候选
    —— 少了这层校验，检索会把「大昭寺」原样返回，于是一路沿用拉萨那座；
    只按省匹配也不安全（清远的丹霞山会拿到韶关的、文山的老君山会拿到栾川的）。
    实在找不到就回退手写的一句话（宁可短，不要把外地简介挂上来）。
    """
    name, city, prov = s['name'], s.get('city', ''), s.get('prov', '')
    cands = {}
    for q in (city + name, name + ' ' + city, name):
        for t, x in search_pages(q):
            cands.setdefault(t, x)

    def rival_regions(text):
        """正文里出现的别的城市 / 别的省"""
        rs = [c for c in city_names if c and c != city and c in text]
        rs += [p for p in prov_names if p and p != prov and p in text]
        return rs

    best, best_score = None, 0
    for t, x in cands.items():
        if not precise_title(t, name) or is_disambig(x) or off_topic(x, name):
            continue
        if not city or city not in x:
            continue
        score = 4 + (1 if t.startswith(city) else 0)
        if score > best_score:
            best, best_score = (t, x), score
    if best:
        txt = clean_text(best[1], name)
        if txt and desc_ok(txt, name, city, prov):
            return [txt, best[0]], 'scoped'

    # 退一步：只有「纯总述词条」才敢用 —— 标题就是这个名字、正文确实讲到本市或本省、
    # 且没提别的省市（「孔庙」「塔克拉玛干」「大别山」这类）。提到别处就说明它讲的
    # 是那一处（洛阳的白马寺、韶关的丹霞山），宁可回退手写的一句话。
    plain = db.get(name)
    if (plain and plain[0] and plain[1] == name
            and not off_topic(plain[0], name)
            and (city in plain[0] or prov in plain[0])
            and not rival_regions(plain[0])):
        return [plain[0], plain[1]], 'generic'
    return None, 'none'


def parse_regions():
    """省市索引（由 tools/build-spot-index.mjs 生成）"""
    return load_json(os.path.join(DATA, 'regions_uniq.json'), [])


def do_spots(limit):
    db = load_json(SPOT_CACHE, {})
    # 缓存里可能有"标题查到了但正文为空"的记录（早期版本写进去的）。
    # 这些条目会让断点续跑把它们当成"已完成"永远跳过，而导出又会剔除空值，
    # 结果就是景点页面永远没有简介。加载时先清掉，让它们重新进入待查队列。
    empty = [k for k, v in db.items() if not (v and str(v[0] or '').strip())]
    for k in empty:
        db.pop(k, None)
    if empty:
        print('清理空简介缓存 %d 条（会重新抓）' % len(empty), flush=True)
    spots = load_spots()
    dup = dup_names(spots)
    by_key = {spot_desc_key(s, dup): s for s in spots}
    rejects = load_json(REJECT_CACHE, {})
    block = load_json(BLOCK_CACHE, {})
    for k in block:
        db.pop(k, None)

    # 库里已有的「讲的不是这一处」的条目先剔掉：它们留在缓存里，导出就会把
    # 外地那段话挂在本市景点上（邢台的景点写着加拿大政客）。剔掉后这些景点
    # 重新进入待查队列，本轮会按「城市+名」重找一次；找不到就回退手写文案。
    wrong = []
    for k in list(db):
        s = by_key.get(k)
        if not s:
            continue
        reason = mismatch(db[k][0], s.get('city', ''), s.get('prov', ''))
        if reason:
            wrong.append((k, s['name'], reason))
            db.pop(k)
    if wrong:
        print('清理地域错位简介 %d 条（改按城市重查）' % len(wrong), flush=True)
        for k, n, reason in wrong[:8]:
            print('   · %s：%s' % (n, reason), flush=True)

    todo = [s for s in spots
            if spot_desc_key(s, dup) not in db and spot_desc_key(s, dup) not in block]
    print('景点简介：已有 %d 键 / %d 处景点，本轮待查 %d（重名景点 %d）'
          % (len(db), len(spots), len(todo), sum(1 for s in todo if s['name'] in dup)), flush=True)
    if not todo:
        save_json(SPOT_CACHE, db)
        return db
    # 打乱顺序，避免失败批次被反复重试同一批（代理不稳时尤其重要）
    import random
    plain_todo = [s for s in todo if s['name'] not in dup]
    dup_todo = [s for s in todo if s['name'] in dup]
    random.Random(20261003).shuffle(plain_todo)
    if limit:
        plain_todo = plain_todo[:limit]

    # 阶段 A：精确标题批量（只处理不重名的：重名的走 resolve_dup 按城市校验）
    # 按裸名查过一次发现是外地词条的，不再重查（记在 desc_reject.json 里）。
    names = [s['name'] for s in plain_todo
             if s['name'] not in dup and s['name'] not in rejects]
    got = run_batches(names)
    hit = 0
    for s in plain_todo:
        rec = got.get(s['name'])
        if not rec:
            continue
        t = clean_text(rec[0], s['name'])
        # 消歧义页（「南湖公园，可能是指：…」）不能当简介；
        # 同名外地词条（「长岛」查到纽约长岛）同样不能，交给阶段B 按城市重找。
        if t and desc_ok(t, s['name'], s['city'], s['prov']):
            db[s['name']] = [t, rec[1]]
            hit += 1
        elif t:
            rejects[s['name']] = rec[1]
    print('  阶段A 命中 %d' % hit, flush=True)
    save_json(SPOT_CACHE, db)

    # 阶段 B：漏网的用「城市+名」搜索定位
    miss = [s for s in plain_todo if s['name'] not in db]
    if miss:
        print('  阶段B 搜索定位 %d 个（其中 %d 个是按名查错过的泛名）'
              % (len(miss), sum(1 for s in miss if s['name'] in rejects)), flush=True)
        # 并发别开太大：每个名字要发 4 条检索，24 路并发会被维基限流，
        # 结果就是整批静默失败（一轮下来 75 个全 0 命中）。
        with ThreadPoolExecutor(max_workers=6) as ex:
            def work(s):
                try:
                    # 泛名景点别再按裸名查了，那只会拿回同一篇外地词条
                    if s['name'] in rejects:
                        t, txt = locate_scoped(s['name'], s['city'], s['prov'])
                        return s, t, txt
                    return s, locate_title(s['name'], s['city'], s['prov']), None
                except Exception:
                    return s, None, None
            resolved = list(ex.map(work, miss))
        titles = {}
        hit2 = 0
        for s, t, txt in resolved:
            key = spot_desc_key(s, dup)
            if t and txt:
                db[key] = [txt, t]
                hit2 += 1
            elif t:
                titles[key] = (s, t)
        got2 = run_batches(list(dict.fromkeys(t for _, t in titles.values())))
        for key, (s, t) in titles.items():
            rec = got2.get(t)
            if not rec:
                continue
            txt = clean_text(rec[0], s['name'])
            # 标题跑偏（「五当召」定位到「五当召镇」）的不收
            if txt and (precise_title(t, s['name']) or txt.startswith(s['name'])) \
                    and desc_ok(txt, s['name'], s['city'], s['prov']):
                db[key] = [txt, rec[1]]
                hit2 += 1
        print('  阶段B 命中 %d' % hit2, flush=True)

    # 阶段 C：重名景点按城市逐处解析
    if dup_todo:
        cities = sorted({s.get('city', '') for s in spots if s.get('city')})
        provs = sorted({s.get('prov', '') for s in spots if s.get('prov')})
        tally = Counter()
        with ThreadPoolExecutor(max_workers=6) as ex:
            def work(s):
                try:
                    return s, resolve_dup(s, db, cities, provs)
                except Exception:
                    return s, (None, 'error')
            for s, (rec, how) in ex.map(work, dup_todo):
                tally[how] += 1
                if rec:
                    db[spot_desc_key(s, dup)] = rec
        print('  阶段C 重名景点 %d 处：本地词条 %d / 通用词条 %d / 无 %d'
              % (len(dup_todo), tally['scoped'], tally['generic'], tally['none']), flush=True)

    # 重名景点的裸名键必须清掉：它对其中某一处必然是错的，
    # 留着会让页面在缺分城条目时又退回到外地的简介。
    stale = [n for n in dup if n in db]
    for n in stale:
        db.pop(n)
    if stale:
        print('  清理重名裸名键 %d 个（改用 省|市|名）' % len(stale), flush=True)
    save_json(SPOT_CACHE, db)
    save_json(REJECT_CACHE, rejects)
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
    # 空值（消歧义清理后回退手写文案的条目）直接剔除，避免导出空串；
    # 人工拉黑的同理（--export-only 时也要挡住）
    block = load_json(BLOCK_CACHE, {})
    spot_out = {k: v[0] for k, v in spot_db.items()
                if v and v[0] and k not in block}
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
