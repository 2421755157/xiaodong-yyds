#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把景点「历史沿革」长介绍库按省份切片，供详情页按需加载。

背景（2026-11-23）：
    长介绍库本来是「按景点名首字取模」分 8 片。这个规则唯一的优点是简单，
    代价是同一片里混着 8 分之一全国的景点：单片 213~411KB（gzip 68~155KB），
    而详情页打开一处景点只需要**那一条**正文。实测打开大理洱海要下 336KB，
    比它自己那条 900 字的正文大了 300 多倍。
    简介库 11-13 已经按省切过一次（tools/shard_desc.py），困境一模一样，
    这里照它的做法来：按省切片，一省一片。

分片规则：
    · 归属省份：键是「省|市|名」的取第一段；键是裸名的，用 data/spots_uniq.json
      里该景点名唯一的省份（重名景点一律走分城键，裸名键不会命中重名景点）
    · **一省一片**，不做桶合并：单片最大 136KB（广东 96 处），中位 65KB。
      省名排序决定片号，写进 js/long-shard-map.js，前端只查表不自己算 ——
      桶怎么排是构建期的事，改规则不会和运行时对不上
    · 找不到归属省份的键直接报错，不静默丢内容（丢了就是整段正文消失）

产物（全部生成，不要手改）：
    js/long-db-0.js … js/long-db-<N-1>.js
    js/long-shard-map.js

data/long_db.json 仍是唯一的源（抓取管线写它，clean_long_desc / rekey_long_desc
改它）；本工具只做派生。派生结果是否与源一致由 check_integrity.py 第 21 项把关，
前端「只拉本省那片」由 e2e 与 unit_test 各自把关。

用法：
    python tools/shard_long.py            # 生成
    python tools/shard_long.py --check    # 只比对，不写盘（有差异返回 1）
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, JS, js_export, load_json

SRC = os.path.join(DATA, 'long_db.json')
MAP = os.path.join(JS, 'long-shard-map.js')


def shard_path(i):
    return os.path.join(JS, 'long-db-%d.js' % i)


def entry_prov(key, prov_by_name):
    """键 → 省份。分城键取第一段；裸名键查景点索引。查不到返回 None。"""
    if '|' in key:
        return key.split('|')[0]
    return prov_by_name.get(key)


def province_index(db, spots):
    """返回 (buckets, mapping, unknown)。buckets[i] 是第 i 片的 {键: 正文}。"""
    name_cnt = {}
    for s in spots:
        name_cnt[s['name']] = name_cnt.get(s['name'], 0) + 1
    # 重名景点在库里没有裸名键，裸名一旦出现必然唯一
    prov_by_name = {s['name']: s['prov'] for s in spots if name_cnt[s['name']] == 1}

    groups = {}
    unknown = []
    for k, v in db.items():
        p = entry_prov(k, prov_by_name)
        if not p:
            unknown.append(k)
            continue
        groups.setdefault(p, {})[k] = v
    if unknown:
        raise SystemExit('有 %d 条长介绍找不到归属省份（如 %s）—— 先修 data/spots_uniq.json'
                         % (len(unknown), '、'.join(unknown[:3])))

    # 省份清单取「景点表里有的」∪「正文里出现的」：正文里挂着一个景点表里
    # 没有的省（脏数据）时也要把它切出来，不能因为没进清单就整片丢掉。
    provs = sorted(set(s['prov'] for s in spots) | set(groups))
    buckets = [groups.get(p, {}) for p in provs]
    mapping = {p: i for i, p in enumerate(provs)}
    return buckets, mapping, provs


def render_map(mapping):
    head = ('// ═══ 景点历史沿革分片映射（生成文件，勿手改）═══\n'
            '// 生成：tools/shard_long.py。省份 → 分片号，前端只查表。\n'
            'export const LONG_SHARD_OF = ')
    return head + json.dumps({k: mapping[k] for k in sorted(mapping)},
                             ensure_ascii=False, indent=1) + ';\n'


def render_shard(i, prov, data, total):
    head = ('// ═══ 景点历史沿革长介绍 · %s（分片 %d/%d）═══\n'
            '// 生成：tools/shard_long.py。源是 data/long_db.json，一省一片，详情页按需加载。\n'
            'export const LONG_DESC_DB_%d = ' % (prov, i + 1, total, i))
    return js_export(data, head)


def plan():
    """算出「应该写成什么样」：{路径: 全文}。main 用它写盘，check_integrity 用它比对。

    返回 (files, buckets, mapping, provs, total)。
    """
    db = load_json(SRC, {})
    if not db:
        raise SystemExit('data/long_db.json 为空，拒绝分片')
    spots = load_json(os.path.join(DATA, 'spots_uniq.json'), [])
    buckets, mapping, provs = province_index(db, spots)
    n = len(buckets)
    files = {MAP: render_map(mapping)}
    for i, b in enumerate(buckets):
        files[shard_path(i)] = render_shard(i, provs[i], b, n)
    return files, buckets, mapping, provs, len(db)


def write(files=None):
    """写盘（供 main 与 fetch_long_desc.py 复用）。"""
    if files is None:
        files = plan()[0]
    # 旧规则残留的分片文件：片号多于新方案时必须删掉，否则那些文件里
    # 的内容会被 check_integrity 当成「库里还有的正文」，前端却永远读不到。
    keep = {os.path.basename(p) for p in files}
    for f in os.listdir(JS):
        if f.startswith('long-db-') and f.endswith('.js') and f not in keep:
            os.remove(os.path.join(JS, f))
    for path, text in files.items():
        io.open(path, 'w', encoding='utf-8', newline='\n').write(text)
    return files


def main():
    check_only = '--check' in sys.argv[1:]
    files, buckets, mapping, provs, total = plan()

    if check_only:
        bad = []
        for path, text in files.items():
            cur = io.open(path, encoding='utf-8').read() if os.path.exists(path) else ''
            if cur != text:
                bad.append(os.path.basename(path))
        if bad:
            print('长介绍分片与源不一致：%s → python tools/shard_long.py' % '、'.join(bad))
            return 1
        print('长介绍分片与源一致（%d 片，%d 条）' % (len(buckets), total))
        return 0

    write(files)
    sizes = [os.path.getsize(shard_path(i)) for i in range(len(buckets))]
    print('长介绍 %d 条 → %d 片（一省一片），单片 %d~%dKB，中位 %dKB'
          % (total, len(buckets), min(sizes) // 1024,
             max(sizes) // 1024, sorted(sizes)[len(sizes) // 2] // 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
