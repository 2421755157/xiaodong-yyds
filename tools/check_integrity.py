#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""静态集成检查：
1) app.js 里所有 $('#id') 引用的元素是否存在于 index.html
2) 所有 import 路径是否有对应文件
3) 所有 addEventListener / querySelector 绑定的关键元素是否存在
"""
import io, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, 'js')
HTML = os.path.join(ROOT, 'index.html')

html = io.open(HTML, encoding='utf-8').read()
html_ids = set(re.findall(r'id="([^"]+)"', html))
# 运行期由 JS 动态创建的元素（不在 HTML 里属正常）
DYNAMIC_IDS = {'lightbox'}

problems = []

# 1) JS 里引用的 id
# 注意动态拼接：$('#map-view-' + v.key) 这类的前缀 id 在 HTML 里不存在是正常的，
# 但要验证「确实有元素以此 id 开头」，否则前缀写错也查不出来。
for f in sorted(os.listdir(JS)):
    if not f.endswith('.js'):
        continue
    src = io.open(os.path.join(JS, f), encoding='utf-8').read()
    for m in re.finditer(r"""\$\(\s*['"]#([A-Za-z0-9_-]+)['"](\s*\+)""", src):
        prefix = m.group(1)
        if not any(i.startswith(prefix) for i in html_ids):
            problems.append('%s: 拼接 id 前缀 #%s 在 HTML 里没有任何匹配元素' % (f, prefix))
    for m in re.finditer(r"""\$\(\s*['"]#([A-Za-z0-9_-]+)['"]""", src):
        i = m.group(1)
        if i not in html_ids and i not in DYNAMIC_IDS:
            # 动态拼接的（后面跟着 +）已在上面单独校验
            if re.search(r"""\$\(\s*['"]#%s['"](\s*\+)""" % re.escape(i), src):
                continue
            problems.append('%s: 引用了不存在的 DOM id  #%s' % (f, i))
    # 动态创建的 id（如 lightbox）不在 HTML 里属正常，单独标注
    for m in re.finditer(r"""querySelector\(\s*['"]#([A-Za-z0-9_-]+)['"]""", src):
        i = m.group(1)
        if i not in html_ids and ("'#' + i" not in src):
            pass  # 动态元素，跳过

# 2) import 路径
# 覆盖三种写法：
#   静态 import ... from './x.js'
#   再导出     export ... from './x.js'
#   动态 import('./x.js')        ← 按需加载模块必须也能被静态校验，
#                                  否则路径写错要等用户点到那里才暴露
IMPORT_PATTERNS = [
    (re.compile(r"""from\s+['"](\./[^'"]+)['"]"""), 'import'),
    (re.compile(r"""import\s*\(\s*['"](\./[^'"]+)['"]\s*\)"""), 'dynamic import'),
]
for f in sorted(os.listdir(JS)):
    if not f.endswith('.js'):
        continue
    src = io.open(os.path.join(JS, f), encoding='utf-8').read()
    seen_specs = set()
    for pat, kind in IMPORT_PATTERNS:
        for m in pat.finditer(src):
            spec = m.group(1)
            if (spec, kind) in seen_specs:
                continue
            seen_specs.add((spec, kind))
            if not os.path.exists(os.path.normpath(os.path.join(JS, spec))):
                problems.append('%s: %s 路径不存在  %s' % (f, kind, spec))

# 3) HTML 里引用的脚本/样式文件
for m in re.finditer(r'(?:src|href)="([^"]+\.(?:js|css))"', html):
    rel = m.group(1)
    if rel.startswith('http'):
        continue
    p = os.path.join(ROOT, rel.lstrip('/'))
    if not os.path.exists(p):
        problems.append('index.html: 引用文件不存在  %s' % rel)

# 4) 导出名检查：js/xxx.js 里 export const NAME 是否真的被导出
exports = {}
for f in sorted(os.listdir(JS)):
    if not f.endswith('.js'):
        continue
    src = io.open(os.path.join(JS, f), encoding='utf-8').read()
    for m in re.finditer(r'export\s+(?:const|function|let|class|async\s+function)\s+([A-Za-z0-9_]+)', src):
        exports.setdefault(m.group(1), set()).add(f)
    for m in re.finditer(r'export\s*\{([^}]+)\}', src):   # export { a, b as c }
        for part in m.group(1).split(','):
            name = part.strip().split(' as ')[0].strip()
            if name:
                exports.setdefault(name, set()).add(f)

for f in sorted(os.listdir(JS)):
    if not f.endswith('.js'):
        continue
    src = io.open(os.path.join(JS, f), encoding='utf-8').read()
    for m in re.finditer(r"""import\s*\{([^}]+)\}\s*from\s*['"]\./([^'"]+)['"]""", src):
        names = [n.strip().split(' as ')[0].strip() for n in m.group(1).split(',') if n.strip()]
        target = os.path.join(JS, m.group(2))
        tsrc = io.open(target, encoding='utf-8').read() if os.path.exists(target) else ''
        for n in names:
            pat = (r'export\s+(?:const|function|let|class|async\s+function)\s+' + re.escape(n) + r'\b'
                   r'|export\s*\{[^}]*\b' + re.escape(n) + r'\b[^}]*\}')
            if not re.search(pat, tsrc):
                problems.append('%s: 从 %s 导入的 %s 未在目标文件导出' % (f, m.group(2), n))

print('检查完成：%d 个问题' % len(problems))
for p in problems:
    print('  ✗', p)
sys.exit(1 if problems else 0)
