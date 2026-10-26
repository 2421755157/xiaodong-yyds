"""把百度百科抓到的图与简介并入数据管线。

为什么需要这一步：
    Wikimedia 图片域名在国内网络完全不可达（清缓存实测 naturalWidth=0），
    现有 1766 张"真实照片"实际显示不出来。百度百科图片 CDN 可达，
    因此把百科主图作为首选源、原图作为兜底。

处理三件事：
    1) img_db 主图换成百科图（src='baike'，配合 export_db.py 的置信分映射）
    2) desc_db 缺失的用百科简介补（截 200 字，卡片/详情页都够用）
    3) long_db 缺失的用百科简介补（全文，平均 400 字，超过折叠阈值）

注意：只补缺失，不覆盖已有内容——原有维基文案更自然，百科文案更重数据，
两者互补，覆盖不到的才用百科。

用法：python tools/merge_baike.py [--dry-run]
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, load_json, save_json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BAIKE = os.path.join(DATA, 'baike_db.json')
DRY = '--dry-run' in sys.argv

if not os.path.exists(BAIKE):
    print('缺少 data/baike_db.json，先跑 node tools/fetch_baike.mjs --all')
    sys.exit(1)

baike = load_json(BAIKE, {})
ok = {k: v for k, v in baike.items() if v.get('ok')}
print('百科库：%d 条记录，%d 条可用' % (len(baike), len(ok)))

# 本地已下载的图片（img/baike/*.jpg）优先：同源托管，不受防盗链影响，
# 3D 场景的 TextureLoader 也能正常加载（它没法设 referrerpolicy）
local_img = load_json(os.path.join(DATA, 'baike_img_local.json'), {})

img_db = load_json(os.path.join(DATA, 'img_db.json'), {})
desc_db = load_json(os.path.join(DATA, 'desc_db.json'), {})
long_db = load_json(os.path.join(DATA, 'long_db.json'), {})

# ─── 1) 主图：百科优先 ───
img_add = img_replace = 0
for name, v in ok.items():
    url = local_img.get(name) or (v.get('img') or '').strip()
    if not url:
        continue
    if not (url.startswith('https://') or url.startswith('img/')):
        continue
    if name in img_db:
        old = (img_db[name].get('u') or '')
        if old != url:
            img_db[name]['u'] = url
            img_db[name]['src'] = 'baike'
            img_db[name]['conf'] = 3
            img_replace += 1
    else:
        img_db[name] = {'u': url, 't': name, 'src': 'baike', 'conf': 3, 'extra': []}
        img_add += 1
print('主图：替换 %d，新增 %d，覆盖 %d/%d' % (img_replace, img_add, len(img_db), 1892))

# ─── 2) 短简介：只补缺失 ───
desc_add = 0
for name, v in ok.items():
    d = (v.get('desc') or '').strip()
    if not d or name in desc_db:
        continue
    desc_db[name] = [d[:200], v.get('title') or name]
    desc_add += 1
print('短简介：新增 %d，覆盖 %d/1892' % (desc_add, len(desc_db)))

# ─── 3) 长介绍：只补缺失，太短的不要（长介绍是"历史沿革"，太短没意义）───
long_add = 0
for name, v in ok.items():
    d = (v.get('desc') or '').strip()
    if len(d) < 140 or name in long_db:
        continue
    long_db[name] = d
    long_add += 1
print('长介绍：新增 %d，覆盖 %d/1892' % (long_add, len(long_db)))

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
