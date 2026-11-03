#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成拼音索引，让搜索支持「gugong」「bj」这类输入。

中文站点上，手机端用户常常直接敲拼音（尤其是不确定字怎么写的时候）。
原来搜索只做 `name.includes(q)`，输 "gugong" 一条都搜不到。

这里的索引是 { 名称: "gugong|gg" }：
  · 前半是全拼（无声调、小写）
  · 后半是首字母串
存在一起是为了省一个字典层，匹配时对整串做 includes 也能工作，
但首字母要单独判断（"gg" 不是 "gugong" 的子串）。

覆盖范围：景点（1836）+ 城市（354）+ 省份（34）。
体积约 60KB，gzip 后 ~20KB，按需懒加载，不进首屏。

用法：python tools/build_pinyin_db.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import JS, load_json

try:
    from pypinyin import lazy_pinyin
except ImportError:                                  # 没装就跳过，别把构建搞崩
    lazy_pinyin = None


def py(name):
    if not name or lazy_pinyin is None:
        return ''
    full = ''.join(lazy_pinyin(name)).lower()
    full = ''.join(c for c in full if c.isalnum())
    ini = ''.join(p[0] for p in lazy_pinyin(name) if p and p[0].isalnum()).lower()
    return full + '|' + ini if full else ''


def main():
    if lazy_pinyin is None:
        print('未安装 pypinyin，跳过（pip install pypinyin）')
        return
    spots = load_json(os.path.join('data', 'spots_uniq.json'), [])
    names = []
    seen = set()
    for s in spots:
        for n in (s.get('name'), s.get('city'), s.get('prov')):
            if n and n not in seen:
                seen.add(n)
                names.append(n)

    db = {}
    for n in names:
        v = py(n)
        if v:
            db[n] = v

    out = os.path.join(JS, 'pinyin-db.js')
    with open(out, 'w', encoding='utf-8') as f:
        f.write('// ═══ 拼音索引（懒加载，搜索用）═══\n'
                '// 生成：tools/build_pinyin_db.py。格式：{ 名称: "全拼|首字母" }\n'
                'export const PINYIN_DB = ')
        json.dump(db, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')
    print('拼音索引 %d 条 → %s（%.0fKB）' % (len(db), out, os.path.getsize(out) / 1024))
    for k in ('故宫', '布达拉宫', '西湖', '江苏'):
        if k in db:
            print('  %s → %s' % (k, db[k]))


if __name__ == '__main__':
    main()
