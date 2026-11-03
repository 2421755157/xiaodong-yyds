#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""补抓「本地简介库里还没有」的景点文案。

为什么要单独一个工具：`fetch_descriptions.py` 走的是维基接口，国内网络下
基本拿不到（zh.wikipedia.org 不可达），所以它只覆盖了早期的那批。
现役通道是百度百科 openapi，已有 1710 条来自它，但当初抓的时候有一批
恰好失败/被风控，于是留下 130 个空白（陆家嘴、龙华寺、南湖公园这些
明显有词条的也在里面）。

这里对这批景点重跑一次百科 openapi，并且比原来的判定多一层
**城市一致性**：像「南湖公园」这种全国同名的，标题和摘要都不区分城市，
直接取第一条很可能拿到长春的公园去描述唐山的公园。做法是：
    摘要里出现城市 +3，出现省份 +1，词条名完全相同 +1
取分数最高的候选；只有出现城市时提前结束（不用再试）。

产出直接写回 data/desc_db.json（[简介, 词条名]），
之后照常 `fetch_descriptions.py --export-only` 导出。

用法：
    python tools/fill_missing_desc.py --dry-run
    python tools/fill_missing_desc.py
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, load_json, save_json
import fetch_baike_api as F


def fetch_best(name, city, prov):
    """在候选查询串里找最匹配的一条，返回 (score, abstract, title, q)"""
    best = None
    for q in F.candidates(name, city, prov)[:6]:
        url = F.API + '?' + urllib.parse.urlencode({
            'scope': 103, 'format': 'json', 'appid': 379020,
            'bk_key': q, 'bk_length': 1000})
        d = F.jget(url)
        if not d or not d.get('title'):
            continue
        ok, _ = F.accept(d, name, q)
        if not ok:
            continue
        a = (d.get('abstract') or '').strip()
        title = (d.get('title') or '').strip()
        score = 0.0
        if city and city in a:
            score += 3
        if prov and prov in a:
            score += 1
        if title == name:
            score += 1
        score += min(len(a), 200) / 200.0
        # 地名必须落到这座城市/省份，否则宁可不写。
        # 反例：「盐官」（嘉兴的古镇）会精确命中「盐官」词条——那是秦汉管盐政的
        # 官职，摘要里只有盐城/江苏，跟海宁盐官镇毫无关系。标题相同不代表实体相同。
        if not ((city and city in a) or (prov and prov in a)):
            continue
        if best is None or score > best[0]:
            best = (score, a, title, q)
        if city and city in a:
            break                      # 城市对上了，不必再试
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--conc', type=int, default=4)
    ap.add_argument('--gap', type=float, default=0.12)
    args = ap.parse_args()

    spots = load_json(os.path.join(DATA, 'spots_uniq.json'), [])
    desc = load_json(os.path.join(DATA, 'desc_db.json'), {})
    todo = [s for s in spots if not desc.get(s['name'])]
    print('待补简介 %d 个' % len(todo))
    if args.dry_run:
        print('  ' + '、'.join(s['name'] for s in todo[:12]) + '…')
        return

    def work(s):
        try:
            r = fetch_best(s['name'], s.get('city', ''), s.get('prov', ''))
            time.sleep(args.gap)
            return s, r
        except Exception as e:
            return s, ('ERR:' + str(e)[:40])

    hit = noc = 0
    with ThreadPoolExecutor(max_workers=args.conc) as ex:
        for s, r in ex.map(work, todo):
            if isinstance(r, str):
                continue
            if not r:
                noc += 1
                continue
            score, a, title, q = r
            desc[s['name']] = [a, title]
            hit += 1
            if hit % 20 == 0:
                print('  …已补 %d' % hit)

    print('补上 %d 个｜无词条或地名对不上 %d 个' % (hit, noc))
    if not args.dry_run:
        save_json(os.path.join(DATA, 'desc_db.json'), desc)
        print('已写回 data/desc_db.json，下一步 fetch_descriptions.py --export-only')


if __name__ == '__main__':
    main()
