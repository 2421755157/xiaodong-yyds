#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把长介绍库从「裸名」改成「省|市|名」分城键（只改重名景点）。

为什么必须改：
    短简介 / 坐标 / 图片三套库早就分了城，长介绍一直按裸名做键。
    46 组重名景点（西湖、南湖公园、凤凰山、太白楼…）共用一条正文，
    于是「广东惠州西湖」的详情页整段在讲「浙江杭州西湖」，
    「吉林长春南湖公园」讲的是「河北唐山南湖公园」的采煤沉陷区修复史。
    这不会 404、不会报错，只能靠扫描发现。

怎么判断这条正文属于哪一处：
    1) 正文里本市名出现次数严格最多 → 归这一处（杭州西湖 正文里「杭州」5 次）。
    2) 出现次数并列且都 > 0 → 各处都有，保留给每一处
       （开元寺正文同时讲泉州与潮州，武侯祠同时讲南阳与成都）。
    3) 一次都没出现 → 要么是泛概念词条（「博物馆」「天鹅湖」是芭蕾舞剧），
       要么讲的完全是别的城市（武汉沙湖 → 宁夏沙湖）。一律丢弃，宁可空着。
    4) data/long_owners.json 里的人工裁定优先于上面的自动判定
       （赛里木湖跨伊犁/博州、壶口瀑布跨山西/陕西，同一处景观两地都成立）。

产出：
    data/long_db.json          重名景点改成「省|市|名」键，其余保持裸名
    data/long_db_by_name.json  迁移前的裸名库（首跑留档，之后不再覆盖）
    data/long_dropped.json     被判为「不属于任何一处」的正文（含原因，供复查）

用法：
    python tools/rekey_long_desc.py --dry-run|--apply
"""
import argparse, json, os, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, load_json, save_json

CACHE = os.path.join(DATA, 'long_db.json')
SNAPSHOT = os.path.join(DATA, 'long_db_by_name.json')
DROPPED = os.path.join(DATA, 'long_dropped.json')
OWNERS = os.path.join(DATA, 'long_owners.json')


def load_spots_by_name():
    by = defaultdict(list)
    for s in load_json(os.path.join(DATA, 'spots_uniq.json'), []):
        by[s['name']].append({'prov': s.get('prov', ''), 'city': s.get('city', '')})
    return by


def decide(name, text, places, owners):
    """返回 (要保留的 [(prov, city)], 判定原因)。"""
    if name in owners:
        o = owners[name]
        if o.get('owners') == 'all':
            return [(p['prov'], p['city']) for p in places], o.get('why', '人工：各处都成立')
        keep = [tuple(x) for x in o.get('owners', [])]
        return keep, o.get('why', '人工裁定')

    counts = [(p, text.count(p['city'])) for p in places]
    top = max(c for _, c in counts) if counts else 0
    if top == 0:
        return [], '正文未提任何一处城市名（泛概念词条或讲的是别处）'
    winners = [p for p, c in counts if c == top]
    if len(winners) == 1:
        return [(winners[0]['prov'], winners[0]['city'])], '本市名出现 %d 次，最多' % top
    return ([(p['prov'], p['city']) for p in winners],
            '多地并列 %d 次，正文同时讲这几处' % top)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='真正写入；默认只打印计划')
    ap.add_argument('--dry-run', action='store_true', help='只打印，不写入（默认行为）')
    a = ap.parse_args()
    apply = a.apply and not a.dry_run

    db = load_json(CACHE, {})
    if not db:
        print('长介绍库为空，中止')
        return 1
    by = load_spots_by_name()
    owners = load_json(OWNERS, {}) or {}

    dup_names = {n for n, ps in by.items() if len({p['city'] for p in ps}) > 1}
    out, plans, dropped = {}, [], []

    for key, text in db.items():
        if '|' in key:                       # 已迁移过，原样保留（幂等）
            out[key] = text
            continue
        name = key
        places = by.get(name) or []
        if not places:
            # 景点已从列表里删掉，正文留着也没人看；进丢弃账本备查
            dropped.append((key, '景点不在当前列表里', [], text))
            continue
        if name not in dup_names:
            out[name] = text                 # 不重名：保持裸名，与简介库同一套约定
            continue
        keep, why = decide(name, text, places, owners)
        if not keep:
            dropped.append((name, why, [(p['prov'], p['city']) for p in places], text))
            continue
        for prov, city in keep:
            out['%s|%s|%s' % (prov, city, name)] = text
        plans.append((name, keep, why, [(p['city'], text.count(p['city'])) for p in places]))

    print('重名景点改造计划（%d 组）：' % len(plans))
    for name, keep, why, counts in plans:
        tag = '全部' if len(keep) == len(by[name]) else '、'.join('%s/%s' % k for k in keep)
        print('  %-8s → %-22s %s   %s' % (name, tag, counts, why))
    print('丢弃 %d 条：' % len(dropped))
    for name, why, places, _t in dropped:
        print('  %-8s %s  %s' % (name, places, why))

    print('\n键数 %d → %d（裸名 %d，分城 %d）' % (
        len(db), len(out), sum(1 for k in out if '|' not in k), sum(1 for k in out if '|' in k)))

    if not apply:
        print('\n[dry-run] 未写入。加 --apply 执行。')
        return 0

    if not os.path.exists(SNAPSHOT):
        save_json(SNAPSHOT, db)
        print('已留档迁移前裸名库 → data/long_db_by_name.json')
    save_json(CACHE, out)
    if dropped:
        book = load_json(DROPPED, {}) or {}
        for name, why, places, text in dropped:
            book[name] = {'reason': why, 'places': places, 'text': text}
        save_json(DROPPED, book)
        print('已记账 %d 条 → data/long_dropped.json' % len(dropped))
    print('已写入 data/long_db.json')
    return 0


if __name__ == '__main__':
    sys.exit(main())
