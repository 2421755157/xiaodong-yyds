"""把百科抓到的图与简介并入数据管线。

为什么需要这一步：
    Wikimedia 图片域名在国内网络完全不可达（清缓存实测 naturalWidth=0），
    现有 1766 张"真实照片"实际显示不出来。百科/图搜的图片 CDN 可达，
    因此把百科图作为首选源、原图作为兜底。

数据源（两个，按可信度合并）：
    1) data/baike_db.json      百科 HTML 抓取（meta description，600 字内）
    2) data/baike_api_db.json  百科 openapi 摘要 + 360 图搜照片（推荐，覆盖广）

处理三件事：
    1) img_db 主图换成百科图（src='baike'，配合 export_db.py 的置信分映射），
       补充图组换成图搜的第 2/3 张（原图组是 Wikimedia 地址，国内同样打不开）
    2) desc_db 缺失的用百科摘要补（截 200 字，卡片/详情页都够用）
    3) long_db 缺失的用百科摘要补（全文，300~400 字，超过折叠阈值）

注意：文字只补缺失，不覆盖已有内容——原有维基文案更自然，百科文案更重数据，
两者互补，覆盖不到的才用百科。图片则相反：宁可覆盖，因为旧地址在国内是空白。

用法：python tools/merge_baike.py [--dry-run]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, load_json, save_json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRY = '--dry-run' in sys.argv
TOTAL = len(load_json(os.path.join(DATA, 'spots_uniq.json'), []) or []) or 1892

# 本地已下载的图片（img/baike/*.jpg）优先：同源托管，不受防盗链影响，
# 3D 场景的 TextureLoader 也能正常加载（它没法设 referrerpolicy）
local_img = load_json(os.path.join(DATA, 'baike_img_local.json'), {})

entries = {}          # name -> {'text': str, 'imgs': [url...]}


def put(name, text='', imgs=None, overwrite_text=False):
    e = entries.setdefault(name, {'text': '', 'imgs': []})
    if text and (overwrite_text or len(text) > len(e['text'])):
        e['text'] = text
    for u in (imgs or []):
        if u and u not in e['imgs']:
            e['imgs'].append(u)


# ── 源 1：openapi + 图搜（覆盖面最广，先入为底） ──
api = load_json(os.path.join(DATA, 'baike_api_db.json'), {})
for name, v in api.items():
    if v.get('ok') and v.get('abs'):
        put(name, v['abs'], v.get('imgs'), overwrite_text=True)
    elif v.get('imgs'):
        put(name, '', v.get('imgs'))

# ── 源 2：百科 HTML（摘要略短但更接近卡片语境，仅在没有更长文案时采用） ──
baike = load_json(os.path.join(DATA, 'baike_db.json'), {})
html_ok = {k: v for k, v in baike.items() if v.get('ok')}
for name, v in html_ok.items():
    put(name, (v.get('desc') or '').strip(), [v.get('img')])

print('合并源：openapi %d 条可用，HTML %d 条可用，合计 %d 个景点有素材'
      % (len([1 for v in api.values() if v.get('ok')]), len(html_ok), len(entries)))

img_db = load_json(os.path.join(DATA, 'img_db.json'), {})
desc_db = load_json(os.path.join(DATA, 'desc_db.json'), {})
long_db = load_json(os.path.join(DATA, 'long_db.json'), {})

# ─── 1) 主图：本地图 > 百科图 > 图搜首图 ───
img_add = img_replace = gal_replace = 0
for name, e in entries.items():
    main = local_img.get(name) or (e['imgs'][0] if e['imgs'] else '')
    if not main or not (main.startswith('https://') or main.startswith('img/')):
        continue
    extra = [u for u in e['imgs'][1:3] if u != main]
    if name in img_db:
        cur = img_db[name]
        if (cur.get('u') or '') != main:
            cur['u'] = main
            cur['src'] = 'baike'
            cur['conf'] = 3
            img_replace += 1
        # 旧图组是 Wikimedia 地址，国内打不开；有图搜候选就换掉
        if extra and extra != (cur.get('extra') or []):
            cur['extra'] = extra
            gal_replace += 1
    else:
        img_db[name] = {'u': main, 't': name, 'src': 'baike', 'conf': 3, 'extra': extra}
        img_add += 1
print('主图：替换 %d，新增 %d，覆盖 %d/%d' % (img_replace, img_add, len(img_db), TOTAL))
print('图组：刷新 %d 处' % gal_replace)

# ─── 2) 短简介：只补缺失 ───
desc_add = 0
for name, e in entries.items():
    d = (e['text'] or '').strip()
    if not d or name in desc_db:
        continue
    desc_db[name] = [d[:200], api.get(name, {}).get('title') or name]
    desc_add += 1
print('短简介：新增 %d，覆盖 %d/%d' % (desc_add, len(desc_db), TOTAL))

# ─── 3) 长介绍：只补缺失，太短的不要（长介绍是"历史沿革"，太短没意义）───
long_add = 0
for name, e in entries.items():
    d = (e['text'] or '').strip()
    if len(d) < 140 or name in long_db:
        continue
    long_db[name] = d
    long_add += 1
print('长介绍：新增 %d，覆盖 %d/%d' % (long_add, len(long_db), TOTAL))

if DRY:
    print('\n[dry-run] 未写盘')
    sys.exit(0)

save_json(os.path.join(DATA, 'img_db.json'), img_db)
save_json(os.path.join(DATA, 'desc_db.json'), desc_db)
save_json(os.path.join(DATA, 'long_db.json'), long_db)
print('\n已写回 data/*.json，接下来执行导出：')
print('  python tools/export_db.py')
print('  python tools/fetch_descriptions.py --export-only')
print('  python tools/fetch_long_desc.py --export-only')
