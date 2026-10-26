# -*- coding: utf-8 -*-
"""生成省市卡片封面图库：js/cover-db.js。

为什么需要：
    全国页的省级卡片原来只有一层渐变底 + 一个单字（京/沪/冀…），
    冷门省份看上去一模一样，认不出是哪儿。
    封面换成该省最有辨识度的实景照片，一眼就知道点进去是哪。

两个层次的图源：
    1) 省 / 直辖市 / 自治区 / 特别行政区（34 个）：
       用手工指定的标志性景点去图搜（「山西 · 平遥古城」「安徽 · 黄山」），
       命中率高、不会张冠李戴。下载到 img/cover/ 并压到 1000px。
    2) 城市（354 个）：
       不额外抓图，直接复用该市第一个有本地照片的景点
       （img/baike/ 里已经有 1801 张），零新增体积。

用法：python tools/build_covers.py [--force] [--prov-only]
"""
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA, JS, load_json, save_json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'img', 'cover')
CACHE = os.path.join(DATA, 'cover_cache.json')
FORCE = '--force' in sys.argv
PROV_ONLY = '--prov-only' in sys.argv

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
IMG_API = 'https://image.so.com/j'
MAXW, QUALITY = 1000, 82

try:
    from PIL import Image
except Exception:
    Image = None

# 每个省级行政区：查询串 + 必须在图片标题里出现的关键词
# 关键词是质量闸门——「天津之眼」会搜出简笔画、「湖北」会搜出绘画素材，
# 标题里没有地名/景点名的候选一律不作为首选。
LANDMARK = {
    '北京': ('北京故宫太和殿', '故宫'),
    '天津': ('天津之眼', '天津'),
    '上海': ('上海外滩夜景', '外滩'),
    '重庆': ('重庆洪崖洞夜景', '洪崖洞'),
    '河北': ('承德避暑山庄', '避暑山庄'),
    '山西': ('平遥古城', '平遥'),
    '内蒙古': ('呼伦贝尔大草原', '呼伦贝尔'),
    '辽宁': ('大连星海广场', '星海'),
    '吉林': ('长白山天池', '长白山'),
    '黑龙江': ('哈尔滨圣索菲亚大教堂', '索菲亚'),
    '江苏': ('苏州拙政园', '拙政园'),
    '浙江': ('杭州西湖', '西湖'),
    '安徽': ('黄山云海', '黄山'),
    '福建': ('厦门鼓浪屿', '鼓浪屿'),
    '江西': ('庐山三叠泉', '庐山'),
    '山东': ('泰山日出', '泰山'),
    '台湾': ('日月潭', '日月潭'),
    '河南': ('洛阳龙门石窟', '龙门'),
    '湖北': ('武汉黄鹤楼', '黄鹤楼'),
    '湖南': ('张家界', '张家界'),
    '广东': ('广州塔', '广州塔'),
    '广西': ('桂林漓江', '漓江'),
    '海南': ('海南三亚海湾', '三亚'),
    '四川': ('九寨沟', '九寨沟'),
    '贵州': ('黄果树瀑布', '黄果树'),
    '云南': ('丽江古城四方街', '古城'),
    '西藏': ('布达拉宫', '布达拉宫'),
    '陕西': ('秦始皇兵马俑', '兵马俑'),
    '甘肃': ('敦煌莫高窟', '莫高窟'),
    '青海': ('青海湖', '青海湖'),
    '宁夏': ('中卫沙坡头', '沙坡头'),
    '新疆': ('喀纳斯', '喀纳斯'),
    '香港': ('香港维多利亚港夜景', '维'),
    '澳门': ('澳门大三巴牌坊', '大三巴'),
}

# 卡片是横构图，筛掉竖图与地图/门票/插画类
BAD_TITLE = re.compile(r'地图|位置|路线|示意|平面|门票|价格|攻略|排行|榜单|logo|标志|'
                       r'旗帜|卫星|天气|酒店|住宿|机票|广告|海报|二维码|头像|表情|'
                       r'简笔画|插画|手绘|绘画|素材|壁纸|漫画|课文|教材|配图|线稿|图标')


def jget(url, referer='https://image.so.com/'):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Referer': referer, 'Accept': 'application/json,*/*'})
    with urllib.request.urlopen(req, timeout=20) as r:
        t = r.read().decode('utf-8', 'replace')
    return json.loads(t) if t.lstrip().startswith('{') else {}


def pick(q, kw=''):
    """图搜 → 最合适的一张（横构图、够大、标题不像地图/插画）

    两档候选：标题含关键词的优先，没有才退到「只要构图合格」。
    退档的情况会把标题打出来，方便人工复核。
    """
    d = jget(IMG_API + '?' + urllib.parse.urlencode({'q': q, 'pn': 0, 'rn': 30}))
    tiers = ([], [])
    for it in (d.get('list') or []):
        u = (it.get('thumb') or '').strip()
        ttl = (it.get('title') or '')
        if not u.startswith('http') or BAD_TITLE.search(ttl):
            continue
        try:
            w, h = int(it.get('width') or 0), int(it.get('height') or 0)
        except Exception:
            w = h = 0
        if w < 900 or h < 400:
            continue
        ratio = w / h if h else 0
        if not (1.35 <= ratio <= 2.6):      # 卡片 170px 高、宽度 280+，要横图
            continue
        score = min(w, 3000) / 100.0
        if ratio >= 1.5:
            score += 2
        item = (score, u, ttl, w, h)
        tiers[0 if (kw and kw in ttl) else 1].append(item)

    for i, tier in enumerate(tiers):
        if tier:
            tier.sort(key=lambda x: -x[0])
            score, u, ttl, w, h = tier[0]
            return (u, ttl, w, h), i
    return None, 0


def shrink(data):
    if not Image:
        return data
    try:
        im = Image.open(io.BytesIO(data))
        if im.mode != 'RGB':
            im = im.convert('RGB')
        w, h = im.size
        if w > MAXW:
            im = im.resize((MAXW, max(1, round(h * MAXW / w))), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, 'JPEG', quality=QUALITY, optimize=True, progressive=True)
        out = buf.getvalue()
        return out if len(out) < len(data) else data
    except Exception:
        return data


def fetch(url, dest):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Referer': 'https://image.so.com/'})
    with urllib.request.urlopen(req, timeout=25) as r:
        data = r.read()
    if len(data) < 8000:
        raise ValueError('too-small')
    if data[:2] != b'\xff\xd8' and data[:4] != b'\x89PNG':
        raise ValueError('not-image')
    io.open(dest, 'wb').write(shrink(data))
    return len(data)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    cache = load_json(CACHE, {})
    local_img = load_json(os.path.join(DATA, 'baike_img_local.json'), {})
    spots = load_json(os.path.join(DATA, 'spots_uniq.json'), [])

    prov_cover = {}
    task = []
    for prov, (q, kw) in LANDMARK.items():
        key = 'p:' + prov
        rel = 'img/cover/%s.jpg' % hashlib.md5(prov.encode('utf-8')).hexdigest()[:16]
        path = os.path.join(ROOT, rel.replace('/', os.sep))
        if not FORCE and cache.get(key, {}).get('file') and os.path.exists(path):
            prov_cover[prov] = rel
            continue
        task.append((prov, q, kw, rel, path))

    print('省份封面：已有 %d，待抓 %d' % (len(prov_cover), len(task)))

    def work(item):
        prov, q, kw, rel, path = item
        try:
            got, tier = pick(q, kw)
            if not got:
                return prov, None, 'no-image'
            n = fetch(got[0], path)
            return prov, {'file': rel, 'q': q, 'kw': kw, 'src': got[0],
                          'title': got[1], 'px': '%dx%d' % (got[2], got[3]),
                          'bytes': n, 'weak': tier}, ''
        except Exception as e:
            return prov, None, str(e)[:50]

    with ThreadPoolExecutor(max_workers=4) as ex:
        for f in as_completed([ex.submit(work, it) for it in task]):
            prov, rec, err = f.result()
            if rec:
                cache['p:' + prov] = rec
                prov_cover[prov] = rec['file']
                flag = '⚠弱' if rec.get('weak') else ' ✓ '
                print('  %s %-4s %-24s %s' % (flag, prov, rec['title'][:22], rec['px']))
            else:
                print('  ✗ %-4s %s' % (prov, err))
            time.sleep(0.2)

    # ── 城市封面：复用该市第一个有本地照片的景点，零新增体积 ──
    city_cover = {}
    if not PROV_ONLY:
        for s in spots:
            key = s.get('prov', '') + '|' + s.get('city', '')
            if key in city_cover or key == '|':
                continue
            p = local_img.get(s['name'])
            if p:
                city_cover[key] = p

    save_json(CACHE, cache)
    body = ('// ═══ 省市卡片封面（省份为手工指定的地标实景，城市取其首个景点照片）═══\n'
            '// 生成：tools/build_covers.py → 图片在 img/cover/ 与 img/baike/ 下同源托管\n'
            '// 缺项时前端回退到原渐变底色，不会出现破图\n'
            'export const PROV_COVER = ' + json.dumps(prov_cover, ensure_ascii=False, indent=0) + ';\n\n'
            'export const CITY_COVER = ' + json.dumps(city_cover, ensure_ascii=False, indent=0) + ';\n')
    open(os.path.join(JS, 'cover-db.js'), 'w', encoding='utf-8').write(body)

    size = sum(os.path.getsize(os.path.join(ROOT, r.replace('/', os.sep)))
               for r in prov_cover.values()
               if os.path.exists(os.path.join(ROOT, r.replace('/', os.sep))))
    print('\n封面库：省份 %d/%d，城市 %d 个，省份图片共 %.1f MB → js/cover-db.js'
          % (len(prov_cover), len(LANDMARK), len(city_cover), size / 1024 / 1024))


if __name__ == '__main__':
    main()
