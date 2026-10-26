#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""消歧义页解析：把「XX可以指：…」的词条重定向到正确的具体条目。

维基里像「盘山」「磁器口」「外八庙」这类词条是消歧义页，导语是一串候选项，
直接当景点简介会显示成「盘山可以指：盘山 (天津)…盘山厅，清代行政区划」——很糟。
本脚本取消歧义页的链接列表，按「标题含景点名 + 含本市名 + 地标后缀 + 出现顺序」
打分选出正确条目，再重抓该条目的导语（短简介）与正文（长介绍）。

用法：
    python tools/resolve_disambig.py --short     # 只修短简介
    python tools/resolve_disambig.py --both       # 短简介 + 长介绍一起修
"""
import argparse, json, os, re, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (DATA, NOISE_PAREN, PINYIN_PAREN, ZHW, clean_text, get_json,
                    is_disambig, load_json, save_json)

SHORT_DB = os.path.join(DATA, 'desc_db.json')
LONG_DB = os.path.join(DATA, 'long_db.json')
REGION_DB = os.path.join(DATA, 'region_db.json')

DISAMBIG = re.compile(r'可以指|可能指|指下列|消歧义|是指以下|可以指：|可能指：|是指：|或指')
# 地标类后缀：命中说明更像「景点本体」而非同名行政单位/人物
LANDMARK_SUFFIX = ('景区', '寺', '庙', '宫', '山', '湖', '江', '河', '瀑布', '峡谷', '湿地',
                   '公园', '古镇', '古城', '老街', '塔', '桥', '园', '故居', '遗址', '博物馆',
                   '石窟', '祠', '阁', '楼', '关', '岭', '岛', '泉', '潭', '洲', '草原', '沙')
# 明显不是景点本体的词条类型
NEGATIVE = ('行政区', '县', '厅', '街道', '铁路', '高速', '公路', '球队', '专辑', '电影', '公司',
            '大学', '中学', '小学', '医院', '银行', '人物', '消歧义')


def fetch_links(title, limit=100):
    """取词条内的链接（消歧义页的候选项就在链接里）"""
    q = urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'redirects': '1', 'titles': title,
        'prop': 'links', 'pllimit': str(limit)})
    d = get_json(ZHW + q, retries=2, timeout=25)
    if not d or 'query' not in d:
        return []
    out = []
    for p in d['query'].get('pages', {}).values():
        for l in (p.get('links') or []):
            out.append((l.get('index', 99), l['title']))
    out.sort()
    return out


def pick_candidate(name, city, links):
    """从候选链接里挑最像「这个景点本体」的条目"""
    best, bs = None, 0
    for idx, t in links:
        if t.startswith('Category:') or t.startswith('Template:'):
            continue
        if name not in t:
            continue
        score = 10
        if city and (city in t or city.rstrip('市') in t):
            score += 12
        if any(s in t for s in LANDMARK_SUFFIX):
            score += 6
        if any(n in t for n in NEGATIVE):
            score -= 8
        score += max(0, 6 - idx * 0.4)      # 排在前面的更可能是主条目
        if score > bs:
            best, bs = t, score
    return best if bs >= 12 else None


def fetch_lead(title):
    q = urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'redirects': '1', 'titles': title,
        'prop': 'extracts', 'exintro': '1', 'explaintext': '1',
        'exlimit': 'max', 'variant': 'zh-cn'})
    d = get_json(ZHW + q, retries=2, timeout=25)
    if not d or 'query' not in d:
        return '', ''
    for p in d['query'].get('pages', {}).values():
        if 'missing' in p:
            return '', ''
        return (p.get('extract') or ''), p.get('title', '')
    return '', ''


def fetch_full(title):
    q = urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'redirects': '1', 'titles': title,
        'prop': 'extracts', 'explaintext': '1', 'variant': 'zh-cn'})
    d = get_json(ZHW + q, retries=2, timeout=30)
    if not d or 'query' not in d:
        return ''
    for p in d['query'].get('pages', {}).values():
        return p.get('extract') or ''
    return ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--short', action='store_true', help='修短简介')
    ap.add_argument('--both', action='store_true', help='短简介 + 长介绍')
    ap.add_argument('--workers', type=int, default=5)
    a = ap.parse_args()

    spots = load_json(os.path.join(DATA, 'spots_uniq.json'), [])
    city_of = {s['name']: s.get('city', '') for s in spots}
    short = load_json(SHORT_DB, {})
    long_db = load_json(LONG_DB, {})

    targets = []
    for k, v in short.items():
        text = v[0] if isinstance(v, list) and v else (v or '')
        if is_disambig(text):
            targets.append((k, v[1] if isinstance(v, list) and len(v) > 1 else k))
    print('消歧义短简介：%d 条待修' % len(targets), flush=True)
    if not targets:
        return

    t0 = time.time()
    done = fixed = 0
    results = {}

    def work(item):
        name, title = item
        links = fetch_links(title)
        cand = pick_candidate(name, city_of.get(name, ''), links)
        if not cand:
            return name, None
        lead, real = fetch_lead(cand)
        if not lead:
            return name, None
        text = clean_text(lead, name)
        if not text or is_disambig(text):
            return name, None
        full = fetch_full(real) if a.both else ''
        return name, (text, real, full)

    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        for name, r in ex.map(work, targets):
            done += 1
            if r:
                results[name] = r
                fixed += 1
            if done % 20 == 0:
                print('  %d/%d 修复 %d  %.0fs' % (done, len(targets), fixed, time.time() - t0), flush=True)

    # 写回
    for name, (text, real, full) in results.items():
        short[name] = [text, real]
        if a.both and full:
            long_db[name] = full
    save_json(SHORT_DB, short)
    save_json(LONG_DB, long_db)
    print('修复 %d / %d，用时 %.0fs' % (fixed, done, time.time() - t0))

    # 复查还有没有消歧义残留
    rest = [k for k, v in short.items()
            if is_disambig(v[0] if isinstance(v, list) and v else (v or ''))]
    print('剩余消歧义短简介：%d 条（将回退手写文案）' % len(rest))
    if rest:
        for k in rest:
            short[k] = ['', short[k][1] if isinstance(short[k], list) and len(short[k]) > 1 else k]
        save_json(SHORT_DB, short)
        print('  已清空这 %d 条的简介，前端会回退到数据文件里的手写文案' % len(rest))


if __name__ == '__main__':
    main()
