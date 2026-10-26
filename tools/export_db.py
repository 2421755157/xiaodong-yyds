#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""导出前端静态库：
    data/img_db.json → js/spot-images-db.js（主图，首屏必需）
                   → js/spot-gallery-db.js（补充图组，详情页懒加载）

导出时统一做三件事：
    1) 政治敏感内容过滤（涉独/分裂类图像剔除；主图命中则回退干净版本或交前端占位图）
    2) 按文件名去重（同一文件的 960px/1200px 缩略图是同一张照片）
    3) 附加图上限 2 张（主图 + 2 = 图集正好 3 格）

用法：python tools/export_db.py
"""
import json, os, sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, JS, base_of, is_blocked, js_export, load_json

SRC_CONF = {'wikidata': 3, 'wiki': 3, 'kept3': 3, 'kept2': 2, 'commons': 2,
            'wiki-search': 2, 'article': 2, 'region': 1}


def main():
    db = load_json(os.path.join(DATA, 'img_db.json'), {})
    if not db:
        print('data/img_db.json 为空，拒绝覆盖现有前端库（先跑 fetch_images.py）')
        return
    # 上一版主图库作为干净回退源
    prev = {}
    p = os.path.join(JS, 'spot-images-db.js')
    if os.path.exists(p):
        s = open(p, encoding='utf-8').read()
        a = s.index('SPOT_IMAGES_DB')
        prev = json.loads(s[s.index('{', a):s.rindex('}') + 1])

    data, gallery = {}, {}
    cleaned = dropped = 0
    for k, v in db.items():
        main = v['u']
        seen = {base_of(main)}
        ex = []
        for u in (v.get('extra') or []):
            b = base_of(u)
            if is_blocked(u) or b in seen:
                cleaned += 1
                continue
            seen.add(b)
            ex.append(u)
        if is_blocked(main):
            alt = prev.get(k)
            if alt and not is_blocked(alt[0]):
                main = alt[0]
            else:
                dropped += 1
                continue
        data[k] = [main, SRC_CONF.get(v.get('src'), 1)]
        if ex:
            gallery[k] = ex[:2]

    open(os.path.join(JS, 'spot-images-db.js'), 'w', encoding='utf-8').write(js_export(
        data,
        '// ═══ 景点真实照片静态库（Wikimedia Commons / 维基词条图）═══\n'
        '// 生成：tools/fetch_images.py + tools/export_db.py\n'
        '// 格式：{ 景点名: [主图URL, 置信分] }；补充图组见 spot-gallery-db.js（懒加载）\n'
        '// 置信分：3=景点专属权威图, 2=Commons/词条精匹配, 1=地区泛图(运行时再精搜替换)\n'
        'export const SPOT_IMAGES_DB = '))
    open(os.path.join(JS, 'spot-gallery-db.js'), 'w', encoding='utf-8').write(js_export(
        gallery,
        '// ═══ 景点补充图组（打开详情时懒加载）═══\n'
        '// 生成：tools/export_db.py。每景点最多 2 张，与主图合成 3 格图集。\n'
        'export const SPOT_GALLERY_DB = '))

    print('主图库 %d 条，置信分布 %s' % (len(data), dict(Counter(v[1] for v in data.values()))))
    print('图组库 %d 处；过滤/去重 %d 条；主图敏感剔除 %d 条' % (len(gallery), cleaned, dropped))


if __name__ == '__main__':
    main()
