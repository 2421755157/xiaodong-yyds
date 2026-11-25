#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把景点「补充图组」库按省份切片，供详情页按需加载。

背景（2026-11-25）：
    图组库 292KB（gzip 63KB）一直是整库懒加载：打开任意一处景点，为了图集
    第 2、3 格那两张缩略图，先下完 1873 处景点的全部图组。而详情页真正需要的
    只是「这一省」那几十条。
    简介库（11-13）、历史沿革（11-23）都已经按省切过，困境完全一样：
    一省一片，单片 7~110 处，最大约 17KB。

分片规则（与 shard_desc / shard_long 完全一致，不另立规则）：
    · 归属省份：键是「省|市|名」的取第一段；键是裸名的，用 data/spots_uniq.json
      里该景点名唯一的省份（重名景点一律走分城键）
    · **一省一片**，不做桶合并：省名排序决定片号，写进 js/gallery-shard-map.js，
      前端只查表不自己算
    · 找不到归属省份的键直接报错，不静默丢图

产物（全部生成，不要手改）：
    js/gallery-shard-0.js … js/gallery-shard-<N-1>.js
    js/gallery-shard-map.js

js/spot-gallery-db.js 仍是导出的源（tools/export_db.py 生成，build_home_stats 与
check_integrity 读它）；本工具只做派生。export_db 收尾会自动重跑一次，免得
「补完图忘了分片」——那样前端看得到旧图组，最难查。

用法：
    python tools/shard_gallery.py            # 生成
    python tools/shard_gallery.py --check    # 只比对，不写盘（有差异返回 1）
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, JS, js_export, load_json

SRC = os.path.join(JS, 'spot-gallery-db.js')
MAP = os.path.join(JS, 'gallery-shard-map.js')


def shard_path(i):
    return os.path.join(JS, 'gallery-shard-%d.js' % i)


def read_src():
    """读导出的图组库（js 文件里的对象字面量，格式与 js_export 一致）。"""
    if not os.path.exists(SRC):
        raise SystemExit('js/spot-gallery-db.js 不存在 —— 先跑 python tools/export_db.py')
    s = io.open(SRC, encoding='utf-8').read()
    a = s.index('SPOT_GALLERY_DB')
    return json.loads(s[s.index('{', a):s.rindex('}') + 1])


def entry_prov(key, prov_by_name):
    """键 → 省份。分城键取第一段；裸名键查景点索引。查不到返回 None。"""
    if '|' in key:
        return key.split('|')[0]
    return prov_by_name.get(key)


def province_index(db, spots):
    """返回 (buckets, mapping, provs)。"""
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
        raise SystemExit('有 %d 条图组找不到归属省份（如 %s）—— 先修 data/spots_uniq.json'
                         % (len(unknown), '、'.join(unknown[:3])))

    provs = sorted(set(s['prov'] for s in spots) | set(groups))
    buckets = [groups.get(p, {}) for p in provs]
    mapping = {p: i for i, p in enumerate(provs)}
    return buckets, mapping, provs


def render_map(mapping, spot_count):
    head = ('// ═══ 景点图组分片映射（生成文件，勿手改）═══\n'
            '// 生成：tools/shard_gallery.py。省份 → 分片号，前端只查表。\n'
            'export const GALLERY_SHARD_OF = ')
    body = head + json.dumps({k: mapping[k] for k in sorted(mapping)},
                             ensure_ascii=False, indent=1) + ';\n'
    # 「有几处景点有图组」也写进表里：首页统计与 imageStats 不能再靠整库
    # Object.keys() —— 整库已经不进前端了。
    body += '\nexport const GALLERY_SPOT_COUNT = %d;\n' % spot_count
    return body


def render_shard(i, prov, data, total):
    head = ('// ═══ 景点补充图组 · %s（分片 %d/%d）═══\n'
            '// 生成：tools/shard_gallery.py。源是 js/spot-gallery-db.js，一省一片，详情页按需加载。\n'
            'export const GALLERY_SHARD_%d = ' % (prov, i + 1, total, i))
    return js_export(data, head)


def plan():
    """算出「应该写成什么样」：{路径: 全文}。main 用它写盘，check_integrity 用它比对。

    返回 (files, buckets, mapping, provs, total)。
    """
    db = read_src()
    if not db:
        raise SystemExit('js/spot-gallery-db.js 为空，拒绝分片')
    spots = load_json(os.path.join(DATA, 'spots_uniq.json'), [])
    buckets, mapping, provs = province_index(db, spots)
    n = len(buckets)
    files = {MAP: render_map(mapping, len(db))}
    for i, b in enumerate(buckets):
        files[shard_path(i)] = render_shard(i, provs[i], b, n)
    return files, buckets, mapping, provs, len(db)


def write(files=None):
    """写盘（供 main 与 export_db.py 复用）。"""
    if files is None:
        files = plan()[0]
    # 旧规则残留的分片：片号多于新方案时必须删掉，否则前端会请求到
    # 一份永远不该被读的旧内容。
    keep = {os.path.basename(p) for p in files}
    for f in os.listdir(JS):
        if f.startswith('gallery-shard-') and f.endswith('.js') and f not in keep:
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
            print('图组分片与源库不一致：%s → python tools/shard_gallery.py' % '、'.join(bad))
            return 1
        print('图组分片与源库一致（%d 片，%d 处景点）' % (len(buckets), total))
        return 0

    write(files)
    sizes = [os.path.getsize(shard_path(i)) for i in range(len(buckets))]
    print('图组 %d 处 → %d 片（一省一片），单片 %d~%dKB，中位 %dKB'
          % (total, len(buckets), min(sizes) // 1024, max(sizes) // 1024,
             sorted(sizes)[len(sizes) // 2] // 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
