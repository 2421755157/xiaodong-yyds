#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把景点简介库切成 8 个「按省归并」的分片，供前端按需加载。

背景（2026-11-13）：
    详情页只要一个景点的简介，景点列表只要一个城市的，却要先把 656KB（gzip 276KB）
    的整库下完才能开弹窗、才能把卡片摘要从手写文案换成词条原文。
    这和「历史沿革」当年遇到的是同一个问题，解法也照它来：分片。

分片规则：
    · 归属省份：键是「省|市|名」的取第一段；键是裸名的，用 data/spots_uniq.json
      里该景点名唯一的省份（重名景点一律走分城键，裸名键不会命中重名景点）
    · 8 个桶，按「字符总量从大到小、放进当前最小的桶」装（LPT），各片体积接近
    · 省份 → 桶号的映射写进 js/spot-desc-shard-map.js，前端只查表，不自己算，
      这样桶号怎么排是构建期的事，改规则也不会和运行时对不上

产物（全部生成，不要手改）：
    js/spot-desc-shard-0.js …  js/spot-desc-shard-7.js
    js/spot-desc-shard-map.js

js/spot-desc-db.js 仍是唯一的源（抓取管线写它，搜索与构建期统计读它）；
本工具只做派生。派生结果是否与源一致由 check_integrity.py 第 16 项把关。

用法：
    python tools/shard_desc.py            # 生成
    python tools/shard_desc.py --check    # 只比对，不写盘（有差异返回 1）
"""
import io, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, JS, js_export, load_json

SHARDS = 8
SRC = os.path.join(JS, 'spot-desc-db.js')
MAP = os.path.join(JS, 'spot-desc-shard-map.js')


def shard_path(i):
    return os.path.join(JS, 'spot-desc-shard-%d.js' % i)


def read_source_db():
    s = io.open(SRC, encoding='utf-8').read()
    a = s.index('export const SPOT_DESC_DB')
    return json.loads(s[s.index('{', a):s.rindex('}') + 1])


def entry_prov(key, prov_by_name):
    """键 → 省份。分城键取第一段；裸名键查景点索引。查不到返回 None。"""
    if '|' in key:
        return key.split('|')[0]
    return prov_by_name.get(key)


def build(db, prov_by_name):
    """返回 (buckets, mapping)。buckets[i] 是第 i 片的 {键: 正文}。"""
    groups = {}
    unknown = []
    for k, v in db.items():
        p = entry_prov(k, prov_by_name)
        if not p:
            unknown.append(k)
            continue
        groups.setdefault(p, {})[k] = v
    if unknown:
        raise SystemExit('有 %d 条简介找不到归属省份（如 %s）—— 先修 data/spots_uniq.json'
                         % (len(unknown), '、'.join(unknown[:3])))

    def weight(d):
        return sum(len(k) + len(t) for k, t in d.items())

    # 大块先装，且稳定排序：同重量按省名，保证每次生成结果一致
    order = sorted(groups, key=lambda p: (-weight(groups[p]), p))
    buckets = [{} for _ in range(SHARDS)]
    sizes = [0] * SHARDS
    mapping = {}
    for p in order:
        i = sizes.index(min(sizes))
        buckets[i].update(groups[p])
        sizes[i] += weight(groups[p])
        mapping[p] = i
    return buckets, mapping, sizes


def render_map(mapping):
    head = ('// ═══ 景点简介分片映射（生成文件，勿手改）═══\n'
            '// 生成：tools/shard_desc.py。省份 → 分片号，前端只查表。\n'
            'export const DESC_SHARD_COUNT = %d;\n'
            'export const DESC_SHARD_OF = ' % SHARDS)
    return head + json.dumps({k: mapping[k] for k in sorted(mapping)},
                             ensure_ascii=False, indent=1) + ';\n'


def render_shard(i, data):
    head = ('// ═══ 景点简介分片 %d/%d（生成文件，勿手改）═══\n'
            '// 生成：tools/shard_desc.py。按省份归并，源是 js/spot-desc-db.js。\n'
            'export const DESC_SHARD_%d = ' % (i, SHARDS, i))
    return js_export(data, head)


def plan():
    """算出「应该写成什么样」：{路径: 全文}。main 用它写盘，check_integrity 用它比对。

    返回 (plan, buckets, mapping, sizes)。
    """
    db = read_source_db()
    spots = load_json(os.path.join(DATA, 'spots_uniq.json'), [])
    prov_by_name = {}
    name_cnt = {}
    for s in spots:
        name_cnt[s['name']] = name_cnt.get(s['name'], 0) + 1
    # 重名景点在库里没有裸名键，裸名一旦出现必然唯一；重复就取第一条，由完整性检查兜底
    for s in spots:
        if name_cnt[s['name']] == 1:
            prov_by_name[s['name']] = s['prov']

    buckets, mapping, sizes = build(db, prov_by_name)

    out = {MAP: render_map(mapping)}
    for i, b in enumerate(buckets):
        out[shard_path(i)] = render_shard(i, b)
    return out, buckets, mapping, sizes, len(db)


def main():
    check_only = '--check' in sys.argv[1:]
    files, buckets, mapping, sizes, total = plan()

    if check_only:
        bad = []
        for path, text in files.items():
            cur = io.open(path, encoding='utf-8').read() if os.path.exists(path) else ''
            if cur != text:
                bad.append(os.path.basename(path))
        if bad:
            print('分片与源不一致：%s → python tools/shard_desc.py' % '、'.join(bad))
            return 1
        print('简介分片与源一致（%d 片，%d 条）' % (SHARDS, total))
        return 0

    for path, text in files.items():
        io.open(path, 'w', encoding='utf-8', newline='\n').write(text)
    print('简介库 %d 条 → %d 片，各省归并，单片字符量 %d~%d'
          % (total, SHARDS, min(sizes), max(sizes)))
    for i in range(SHARDS):
        provs = [p for p in sorted(mapping) if mapping[p] == i]
        print('  片 %d：%d 条 / %dKB ← %s'
              % (i, len(buckets[i]), os.path.getsize(shard_path(i)) // 1024,
                 '、'.join(provs)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
