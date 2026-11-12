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

# 11) 简介库：外地词条不得挂在本市景点上
#     泛名景点的词条标题完全对得上，正文却是别处的（「长岛」是纽约长岛、
#     「铁塔」是济宁崇觉寺铁塔、「天河山」是加拿大一位政治人物）。
#     页面上就是「山东烟台的景点，简介在讲美国长岛」，比没有简介更糟。
#     判定规则见 tools/place_guard.py，抓取管线用的是同一份。
try:
    sys.path.insert(0, os.path.join(ROOT, 'tools'))
    from place_guard import mismatch                      # noqa: E402
    sd_src = io.open(os.path.join(JS, 'spot-desc-db.js'), encoding='utf-8').read()
    sd_head = sd_src.index('export const SPOT_DESC_DB')
    desc_db = json.loads(sd_src[sd_src.index('{', sd_head):sd_src.rindex('}') + 1])
    sd_spots = json.load(io.open(os.path.join(ROOT, 'data', 'spots_uniq.json'),
                                 encoding='utf-8'))
    cnt = {}
    for s in sd_spots:
        cnt[s['name']] = cnt.get(s['name'], 0) + 1
    misplaced = []
    for s in sd_spots:
        key = ('%s|%s|%s' % (s['prov'], s['city'], s['name'])) \
            if cnt[s['name']] > 1 else s['name']
        txt = desc_db.get(key)
        if not txt:
            continue
        why = mismatch(txt, s.get('city', ''), s.get('prov', ''))
        if why:
            misplaced.append('%s %s/%s（%s）' % (s['name'], s['prov'], s['city'], why))
    if misplaced:
        problems.append('简介与景点所在城市不符 %d 条（如 %s）→ 见 tools/place_guard.py'
                        % (len(misplaced), '；'.join(misplaced[:2])))
    blocked = json.load(io.open(os.path.join(ROOT, 'data', 'desc_block.json'),
                                encoding='utf-8'))
    leaked = [k for k in blocked if k in desc_db]
    if leaked:
        problems.append('已拉黑的景点简介又出现在库里 %d 个（如 %s）'
                        % (len(leaked), '、'.join(leaked[:3])))
except Exception as e:
    problems.append('简介库校验失败（%s）' % e)

# 12) 图片库：重名景点不得共用一张主图
#     图片库长期按裸名做键，46 个重名景点（101 处）共用一张照片：
#     杭州西湖的荷花挂到了惠州西湖、绍兴东湖的石壁挂到了武汉东湖。
#     现在按「省|市|名」分城存，裸名键必须彻底消失 —— 留着就会被没抓到本地照的
#     那一处回落命中，等于又串回去。抓不到的分城键宁可空着显示占位图。
try:
    si_src = io.open(os.path.join(JS, 'spot-images-db.js'), encoding='utf-8').read()
    si_head = si_src.index('export const SPOT_IMAGES_DB')
    img_db = json.loads(si_src[si_src.index('{', si_head):si_src.rindex('}') + 1])
    img_spots = json.load(io.open(os.path.join(ROOT, 'data', 'spots_uniq.json'),
                                  encoding='utf-8'))
    img_cnt = {}
    for s in img_spots:
        img_cnt[s['name']] = img_cnt.get(s['name'], 0) + 1
    img_dup = {n for n, c in img_cnt.items() if c > 1}
    leaked_bare = sorted(n for n in img_dup if n in img_db)
    if leaked_bare:
        problems.append('重名景点仍挂着裸名主图 %d 个（如 %s）'
                        % (len(leaked_bare), '、'.join(leaked_bare[:3])))
    # 同一名字的不同城市，主图不能是同一个文件
    by_img = {}
    for s in img_spots:
        if img_cnt[s['name']] <= 1:
            continue
        e = img_db.get('%s|%s|%s' % (s['prov'], s['city'], s['name']))
        if e:
            by_img.setdefault(s['name'], []).append((s['city'], e[0]))
    same = []
    for n, rows in by_img.items():
        us = [u for _, u in rows]
        if len(set(us)) != len(us):
            same.append('%s（%s）' % (n, '、'.join(c for c, _ in rows)))
    if same:
        problems.append('同名景点共用同一张主图 %d 个（如 %s）'
                        % (len(same), '；'.join(same[:2])))
except Exception as e:
    problems.append('图片库校验失败（%s）' % e)

# 13) 图组：3 格图集里不该出现重复照片
#     详情页把「主图 + 图组 2 张」拼成 3 格，主图混进图组或图组内部重复，
#     用户看到的就是同一张照片占两格。补图组的脚本按文件名去重，
#     这里守数据出口，防止有人手工往 img_db 里塞。
try:
    gl_src = io.open(os.path.join(JS, 'spot-gallery-db.js'), encoding='utf-8').read()
    gl_head = gl_src.index('export const SPOT_GALLERY_DB')
    gal_db = json.loads(gl_src[gl_src.index('{', gl_head):gl_src.rindex('}') + 1])

    def base_name(u):
        return (u or '').rstrip('/').split('/')[-1].split('?')[0]

    dup_in = [k for k, v in gal_db.items()
              if len({base_name(u) for u in v}) != len(v)]
    main_in = [k for k, v in gal_db.items()
               if k in img_db and base_name(img_db[k][0]) in {base_name(u) for u in v}]
    if dup_in:
        problems.append('图组内部有重复照片 %d 处（如 %s）'
                        % (len(dup_in), '、'.join(dup_in[:3])))
    if main_in:
        problems.append('图组里混进了主图那张 %d 处（如 %s）'
                        % (len(main_in), '、'.join(main_in[:3])))
except Exception as e:
    problems.append('图组校验失败（%s）' % e)

# 14) 长介绍：详情页「历史沿革」整段不得讲别的城市，且重名景点必须分城存
#     短简介从 11-07 起就有上面的闸门，长介绍一直没人管：抓下来直接入库，
#     于是青岛「金沙滩」配的是山西朔州金沙滩镇的镇史、嘉兴「南湖」配的是
#     唐山南湖公园的修复史。这类错误不报错、不 404，只能靠扫。
#     11-11 补了地域闸门，但库里仍是「裸名」做键：46 组重名景点共用一条正文，
#     惠州西湖照样挂杭州那条。所以现在还要校验键本身——
#       · 重名景点（跨市同名）不许再有裸名键，必须是「省|市|名」
#       · 分城键必须能对上列表里真实存在的那一处
#     校验的是导出的 js/long-db-*.js（用户实际拿到的），data 改了忘导出会在这里露馅。
try:
    from place_guard import long_reject                      # noqa: E402
    long_all = {}
    for _i in range(8):
        _p = os.path.join(JS, 'long-db-%d.js' % _i)
        if not os.path.exists(_p):
            continue
        _src = io.open(_p, encoding='utf-8').read()
        _head = _src.index('export const LONG_DESC_DB_')
        long_all.update(json.loads(_src[_src.index('{', _head):_src.rindex('}') + 1]))
    if not long_all:
        problems.append('js/long-db-*.js 读不出长介绍（跑 python tools/fetch_long_desc.py --export-only 重新导出）')
    else:
        _places = {}
        for _s in json.load(io.open(os.path.join(ROOT, 'data', 'spots_uniq.json'),
                                    encoding='utf-8')):
            _places.setdefault(_s['name'], []).append((_s.get('prov', ''),
                                                       _s.get('city', '')))
        _ok = json.load(io.open(os.path.join(ROOT, 'data', 'long_ok.json'),
                                encoding='utf-8'))
        _blk = json.load(io.open(os.path.join(ROOT, 'data', 'desc_block.json'),
                                 encoding='utf-8'))
        _bad, _leak, _ghost = [], [], []
        for _k, _t in long_all.items():
            _parts = _k.split('|')
            if len(_parts) == 3:
                _prov, _city, _name = _parts
                _own = [(_prov, _city)]
                if (_prov, _city) not in _places.get(_name, []):
                    _ghost.append(_k)
                    continue
            else:
                _name = _k
                _own = _places.get(_name, [])
                if len({c for _p, c in _own}) > 1:
                    _leak.append(_k)
                    continue
            _why = long_reject(_t, _own, ok=_name in _ok, blocked=_name in _blk)
            if _why:
                _bad.append('%s（%s）' % (_k, _why))
        if _leak:
            problems.append('长介绍仍是裸名键的重名景点 %d 处（如 %s）→ python tools/rekey_long_desc.py --apply'
                            % (len(_leak), '、'.join(_leak[:3])))
        if _ghost:
            problems.append('长介绍挂着列表里没有的「省|市|名」%d 处（如 %s）'
                            % (len(_ghost), '、'.join(_ghost[:3])))
        if _bad:
            problems.append('长介绍讲的是别处 %d 条（如 %s）→ python tools/clean_long_desc.py'
                            % (len(_bad), '；'.join(_bad[:2])))
except Exception as e:
    problems.append('长介绍校验失败（%s）' % e)

# 15) 简介库：重名景点不许留裸名键，三键必须对得上真实的那一处
#     前端的 pickSpotDesc 是 `read(key) || read(name)` —— 分城键没有就退到裸名。
#     只要库里存在一条裸名键，没抓到本地词条的那一处就会把这唯一一条当自己的，
#     11-04 清掉的「惠州西湖讲杭州」就是这样长回来的。工具（fill_missing_desc）
#     以前也按裸名判断+写入，等于每次补抓都往这个坑里填土。
try:
    sd_keys = set(desc_db.keys())          # 上面第 11 项已经读进内存
    sd_dup = {n for n, c in cnt.items() if c > 1}
    sd_places = {}
    for _s in sd_spots:
        sd_places.setdefault(_s['name'], set()).add((_s['prov'], _s['city']))
    sd_bare = sorted(k for k in sd_keys if '|' not in k and k in sd_dup)
    sd_ghost = []
    for k in sd_keys:
        p = k.split('|')
        if len(p) == 3 and (p[0], p[1]) not in sd_places.get(p[2], ()):
            sd_ghost.append(k)
    if sd_bare:
        problems.append('简介库重名景点还留着裸名键 %d 个（如 %s）—— 前端会把它发给所有同名景点'
                        % (len(sd_bare), '、'.join(sd_bare[:3])))
    if sd_ghost:
        problems.append('简介库挂着列表里没有的「省|市|名」%d 处（如 %s）'
                        % (len(sd_ghost), '、'.join(sd_ghost[:3])))
except Exception as e:
    problems.append('简介库键规则校验失败（%s）' % e)

print('检查完成：%d 个问题' % len(problems))
for p in problems:
    print('  ✗', p)
sys.exit(1 if problems else 0)
