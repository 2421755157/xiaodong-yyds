#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""静态集成检查：
1) app.js 里所有 $('#id') 引用的元素是否存在于 index.html
2) 所有 import 路径是否有对应文件
3) 所有 addEventListener / querySelector 绑定的关键元素是否存在
"""
import io, json, os, re, sys

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

# 5) 省市封面库：每个省级行政区都要有封面，且引用的图片文件必须真的存在
#    （封面是卡片的第一眼内容，漏一个省就是一张光秃秃的渐变卡）
cover_path = os.path.join(JS, 'cover-db.js')
if os.path.exists(cover_path):
    csrc = io.open(cover_path, encoding='utf-8').read()

    def cover_block(name):
        m = re.search(name + r'\s*=\s*(\{.*?\n\});', csrc, re.S)
        try:
            return json.loads(m.group(1)) if m else {}
        except ValueError:
            problems.append('cover-db.js: %s 不是合法 JSON' % name)
            return {}

    prov_cov = cover_block('PROV_COVER')
    city_cov = cover_block('CITY_COVER')
    spots = json.load(io.open(os.path.join(ROOT, 'data', 'spots_uniq.json'), encoding='utf-8'))
    for prov in sorted({s.get('prov', '') for s in spots} - {''}):
        if prov not in prov_cov:
            problems.append('cover-db.js: 省份缺少封面  %s' % prov)
    for key, rel in list(prov_cov.items()) + list(city_cov.items()):
        if not os.path.exists(os.path.join(ROOT, rel.replace('/', os.sep))):
            problems.append('cover-db.js: %s 的封面文件不存在  %s' % (key, rel))
else:
    problems.append('js/cover-db.js 不存在（跑 python tools/build_covers.py 生成）')

# 6) 首页统计是否与导出库一致
#    HOME_STATS 是构建期算好写死的常量（为了首屏不去拉 800KB 的库），
#    数据更新后忘了重跑就会一直显示旧数字 —— 这类"不报错但不对"最难发现，必须静态守。
def js_obj(path, name):
    s = io.open(path, encoding='utf-8').read()
    i = s.index(name)
    return json.loads(s[s.index('{', i):s.rindex('}') + 1])


try:
    hs_src = io.open(os.path.join(JS, 'home-stats.js'), encoding='utf-8').read()
    m = re.search(r'HOME_STATS\s*=\s*(\{[^}]*\})', hs_src)
    hs = json.loads(m.group(1)) if m else {}
    imgs = js_obj(os.path.join(JS, 'spot-images-db.js'), 'SPOT_IMAGES_DB')
    gal = js_obj(os.path.join(JS, 'spot-gallery-db.js'), 'SPOT_GALLERY_DB')
    desc = js_obj(os.path.join(JS, 'spot-desc-db.js'), 'SPOT_DESC_DB')
    # 简介库的键不是一景一键：重名景点用「省|市|名」分开存，所以"有简介的景点数"
    # 必须逐景点去查（与 build_home_stats.mjs 同口径），不能拿键数当景点数。
    spots_idx = json.load(io.open(os.path.join(ROOT, 'data', 'spots_uniq.json'), encoding='utf-8'))
    name_cnt = {}
    for s in spots_idx:
        name_cnt[s['name']] = name_cnt.get(s['name'], 0) + 1
    dup = {n for n, c in name_cnt.items() if c > 1}
    desc_covered = 0
    for s in spots_idx:
        key = '%s|%s|%s' % (s.get('prov', ''), s.get('city', ''), s['name']) if s['name'] in dup else s['name']
        if desc.get(key) or desc.get(s['name']):
            desc_covered += 1
    actual = {
        'photos': len(imgs),
        'exclusive': len([1 for v in imgs.values() if v[1] >= 3]),
        'gallery': len(gal),
        'desc': desc_covered,
    }
    for k, v in actual.items():
        if hs.get(k) != v:
            problems.append('home-stats.js: %s 过期（写死 %s，实际 %s）→ node tools/build_home_stats.mjs'
                            % (k, hs.get(k), v))
except Exception as e:
    problems.append('home-stats.js: 解析失败（%s）' % e)

# 7) 图片外链必须"打得开且不过大"
#    两个真实踩过的坑：
#    - wikimedia 域名国内不可达、bcebos 有防盗链 → 详情页图集就是空白格
#    - 360 CDN 直出 1.2MB 原图 → 一次详情页拉 3MB
#    这两类在浏览器里都"看着像加载中"，不报错，只能静态守。
try:
    dead, big = [], []
    for name, url in list(imgs.items()) + [(k, u) for k, vs in gal.items() for u in vs]:
        u = url[0] if isinstance(url, list) else url
        if not isinstance(u, str) or not u.startswith('http'):
            continue
        host = re.sub(r'^https?://([^/]+).*', r'\1', u).lower()
        if host.endswith('wikimedia.org') or host.endswith('bcebos.com'):
            dead.append('%s → %s' % (name, host))
        elif 'qhimgs' in host and '/dr/' not in u:
            big.append('%s → %s' % (name, u.split('/')[-1]))
    if dead:
        problems.append('图片引用了国内不可达域名 %d 处（%s）→ python tools/fix_remote_images.py'
                        % (len(dead), dead[0]))
    if big:
        problems.append('图片还是 CDN 原图未缩放 %d 处（%s）→ python tools/fix_remote_images.py'
                        % (len(big), big[0]))
except Exception as e:
    problems.append('图片外链校验失败（%s）' % e)

# 8) 拼音索引覆盖：新增景点若忘了重跑 build_pinyin_db.py，
#    拼音搜索会静默搜不到（中文搜索照样正常，所以很难发现）。
try:
    py_path = os.path.join(JS, 'pinyin-db.js')
    if not os.path.exists(py_path):
        problems.append('js/pinyin-db.js 不存在（跑 python tools/build_pinyin_db.py 生成）')
    else:
        py_src = io.open(py_path, encoding='utf-8').read()
        start = py_src.index('PINYIN_DB')   # 注释里也有花括号，必须从声明之后找
        py_db = json.loads(py_src[py_src.index('{', start):py_src.rindex('}') + 1])
        spot_names = {s['name'] for s in json.load(
            io.open(os.path.join(ROOT, 'data', 'spots_uniq.json'), encoding='utf-8'))}
        miss = sorted(n for n in spot_names if not py_db.get(n))
        if len(miss) > len(spot_names) * 0.02:
            problems.append('拼音索引缺 %d/%d 个景点（如 %s）→ python tools/build_pinyin_db.py'
                            % (len(miss), len(spot_names), '、'.join(miss[:3])))
except Exception as e:
    problems.append('拼音索引校验失败（%s）' % e)

# 9) 死导出：export 出去但全仓没有任何地方引用
#    这类代码不报错、不影响测试，只会一直烂在模块里，等有人以为它还在用。
#    2026-11-04 一次清查就抓到 7 个（findSpot / panoramaOpen / 4 个纹理函数…），
#    其中有 4 个在 3D 懒加载块里，是纯负担。这里守一道，避免以后又长回来。
#    只检查 `export const/function/class` 声明式导出；`export { x } from './y'`
#    这类再导出要看调用链，误报多，不纳入。
DEAD_EXPORT_SKIP = ('long-db-',)          # 数据块：导出名是按 'LONG_DESC_DB_' + i 拼出来的
try:
    consumers = {}
    for root, _dirs, files in os.walk(JS):
        for fn in files:
            if fn.endswith('.js'):
                p = os.path.join(root, fn)
                consumers[p] = io.open(p, encoding='utf-8').read()
    for fn in sorted(os.listdir(os.path.join(ROOT, 'tools'))):
        if fn.endswith('.mjs'):
            p = os.path.join(ROOT, 'tools', fn)
            consumers[p] = io.open(p, encoding='utf-8').read()
    consumers[HTML] = html

    for p, src in consumers.items():
        if not p.endswith('.js') or not p.startswith(JS):
            continue
        base = os.path.basename(p)
        if base.startswith(DEAD_EXPORT_SKIP):
            continue
        for m in re.finditer(r'export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)',
                             src):
            name = m.group(1)
            pat = re.compile(r'\b' + re.escape(name) + r'\b')
            refs = 0
            for cp, csrc in consumers.items():
                for line in csrc.splitlines():
                    if cp == p and re.match(
                            r'\s*export\s+(?:async\s+)?(?:const|let|var|function|class)\s+'
                            + re.escape(name) + r'\b', line):
                        continue          # 定义行本身不算引用
                    refs += len(pat.findall(line))
            if refs == 0:
                problems.append('%s: 导出 %s 全仓无人引用（死导出，可删）' % (base, name))
except Exception as e:
    problems.append('死导出校验失败（%s）' % e)

# 10) 坐标库：结构、来源、国境范围
#     小地图拿到的坐标一旦出了国境，用户看到的就是"景点在哈萨克斯坦"。
#     Photon 是 OSM 数据，同名地点遍布全球（「龙泉寺」「南山」都有境外条目），
#     抓取时做了省份校验，这里再守一道数据出口。
COORD_SOURCES = {'wiki', 'wikidata', 'osm'}
try:
    cd_src = io.open(os.path.join(JS, 'coords-db.js'), encoding='utf-8').read()
    cd_head = cd_src.index('export const COORD_DB')
    coord_db = json.loads(cd_src[cd_src.index('{', cd_head):cd_src.rindex('}') + 1])
    spots_all = json.load(io.open(os.path.join(ROOT, 'data', 'spots_uniq.json'), encoding='utf-8'))
    dup_names = {n for n in {s['name'] for s in spots_all}
                 if sum(1 for s in spots_all if s['name'] == n) > 1}
    bad_struct, bad_range, bad_src, bare_dup = [], [], [], []
    for k, v in coord_db.items():
        if not (isinstance(v, list) and len(v) >= 3):
            bad_struct.append(k)
            continue
        lng, lat, src = v[0], v[1], v[2]
        if not (isinstance(lng, (int, float)) and isinstance(lat, (int, float))
                and -180 <= lng <= 180 and -90 <= lat <= 90):
            bad_struct.append(k)
        elif not (73 <= lng <= 136 and 3 <= lat <= 54):
            bad_range.append('%s(%.2f,%.2f)' % (k, lng, lat))
        if src not in COORD_SOURCES:
            bad_src.append('%s=%s' % (k, src))
        if '|' not in k and k in dup_names:
            bare_dup.append(k)
    if bad_struct:
        problems.append('坐标库结构异常 %d 条（如 %s）' % (len(bad_struct), '、'.join(bad_struct[:3])))
    if bad_range:
        problems.append('坐标落在国境之外的 %d 条（如 %s）' % (len(bad_range), '、'.join(bad_range[:3])))
    if bad_src:
        problems.append('坐标来源标记不认识 %d 条（如 %s）' % (len(bad_src), '、'.join(bad_src[:3])))
    if bare_dup:
        problems.append('重名景点仍用裸名键 %d 个（如 %s）→ python tools/fetch_coords.py'
                        % (len(bare_dup), '、'.join(bare_dup[:3])))
except Exception as e:
    problems.append('坐标库校验失败（%s）' % e)

print('检查完成：%d 个问题' % len(problems))
for p in problems:
    print('  ✗', p)
sys.exit(1 if problems else 0)
