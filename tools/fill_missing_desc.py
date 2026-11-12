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

产出直接写回 data/desc_db.json（[简介, 词条名]），键规则与导出/前端一致：
重名景点用「省|市|名」，其余用裸名；重名景点要求摘要里明确出现本市名，
只出现省名不算（韶关丹霞山的词条也写着「广东省」）。
之后照常 `fetch_descriptions.py --export-only` 导出。

用法：
    python tools/fill_missing_desc.py --dry-run
    python tools/fill_missing_desc.py
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, load_json, save_json
import fetch_baike_api as F
from fetch_descriptions import desc_ok, dup_names, spot_desc_key

# 词条讲的是「这一类」而不是「这一处」。典型：「矿山公园是以展示矿业遗迹景观为主体的
# 特定空间地域…根据管理级别分为国家级和省级」——黄石国家矿山公园只是文末举例，
# 挂到景点卡片上等于放了一段百科定义。
CONCEPT_RE = re.compile(r'特定空间地域|一类(?:景区|公园|建筑|景观|场所)|'
                        r'一种(?:景区|公园|建筑|景观)|泛指|分为国家级和省级')
# 开头就是「多地同名 / 多地共用的地名」——这是消歧义摘要。
# 「城子山为中国多地同名山体…」「下梅是中国多地共用的地名…」，
# 卡片只露前两行，用户看到的就是这句"这是好几个地方"。
MULTI_RE = re.compile(r'多地同名|多地共用|多地共有|多指')


def fetch_best(name, city, prov, need_city=False):
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
        # need_city：重名景点只认「本市」，省名命中不算数。韶关的丹霞山词条里
        # 明明白白写着「广东省」，清远那处会被省名放行，正文却讲的是韶关。
        if not ((city and city in a) or (prov and prov in a)):
            continue
        if need_city and not (city and city in a):
            continue
        # 讲「这一类」或「好几处」的摘要，不是这处景点的介绍
        if CONCEPT_RE.search(a[:60]) or MULTI_RE.search(a[:60]):
            continue
        # 与 fetch_descriptions 同一道闸：消歧义页 / 同名作品机构 / 地域错位
        if not desc_ok(a, name, city, prov):
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
    # 键规则必须和前端 spotDescKey / 导出脚本完全一致：
    # 重名景点存「省|市|名」，其余存裸名。早先这里用裸名判断+写入，
    # 重名景点会被判成"还没有"再抓一条按裸名存进去，前端 pickSpotDesc
    # 的 `read(key) || read(name)` 就会把这唯一一条发给所有同名景点——
    # 11-04 刚清掉的串城问题会原样长回来。
    dup = dup_names(spots)
    todo = [s for s in spots if not desc.get(spot_desc_key(s, dup))]
    print('待补简介 %d 个（其中重名景点 %d 个，只认本市词条）'
          % (len(todo), sum(1 for s in todo if s['name'] in dup)))
    if args.dry_run:
        print('  ' + '、'.join(s['name'] for s in todo[:12]) + '…')
        return

    def work(s):
        try:
            r = fetch_best(s['name'], s.get('city', ''), s.get('prov', ''),
                           need_city=s['name'] in dup)
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
            desc[spot_desc_key(s, dup)] = [a, title]
            hit += 1
            if hit % 20 == 0:
                print('  …已补 %d' % hit)

    print('补上 %d 个｜无词条或地名对不上 %d 个' % (hit, noc))
    if not args.dry_run:
        save_json(os.path.join(DATA, 'desc_db.json'), desc)
        print('已写回 data/desc_db.json，下一步 fetch_descriptions.py --export-only')


if __name__ == '__main__':
    main()
