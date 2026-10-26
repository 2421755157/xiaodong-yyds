#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""夜游神 · 数据管线公共模块
仅依赖标准库；默认走本地代理（可用 PROXY 环境变量覆盖，如 PROXY=http://127.0.0.1:7890）。"""
import json, os, re, time, urllib.parse, urllib.request

# ── 路径 ──
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, 'js')
DATA = os.path.join(ROOT, 'data')
os.makedirs(DATA, exist_ok=True)

PROXY = os.environ.get('PROXY', 'http://127.0.0.1:7890')
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({
    'http': PROXY, 'https': PROXY}))

UA = 'NightRoamer/1.0 (https://github.com/2421755157/xiaodong-yyds)'
# 端点用 https：Wikimedia 现会把 http 请求 301 到 https，走 https 可少一跳、更稳
ZHW = 'https://zh.wikipedia.org/w/api.php?'
CMW = 'https://commons.wikimedia.org/w/api.php?'
WD = 'https://www.wikidata.org/w/api.php?'

# ── 文本清洗 ──
NOISE_PAREN = re.compile(r'（[^）]{0,80}?(满语|蒙古语|穆麟德|转写|拼音|注音|拉丁|英语|藏语|维吾尔|闽南)[^）]{0,80}?）')
PINYIN_PAREN = re.compile(r'（[a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùüńňǹ\s]{1,12}）')
CJK = re.compile(r'[\u4e00-\u9fff]')


def get_json(url, retries=5, timeout=25):
    """带重试的 JSON 请求；失败返回 None（不抛异常）"""
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            return json.loads(_opener.open(req, timeout=timeout).read().decode('utf-8'))
        except Exception:
            if i == retries - 1:
                return None
            time.sleep(0.5)
    return None


def clean_text(text, name=''):
    """清洗维基词条首段：去注音/转换注、压空白、截取 2~3 句"""
    if not text:
        return ''
    t = text.replace('\n', '').replace('\r', '').strip()
    t = NOISE_PAREN.sub('', t)
    t = PINYIN_PAREN.sub('', t)
    t = re.sub(r'\s{2,}', '', t)
    parts = re.split(r'(?<=。)', t)
    out = ''
    for p in parts:
        if not p:
            continue
        if len(out) + len(p) > 170:
            break
        out += p
        if len(out) >= 60:
            break
    out = out.strip()
    if len(CJK.findall(out)) < 12:
        return ''
    if name and out.startswith(name) and len(out) <= len(name) + 4:
        return ''
    return out


# ── 图片相关 ──
BAD_EXT = ('.svg', '.gif', '.pdf', '.tif', '.djvu', '.ogv', '.webm', '.ogg')
BAD_RE = re.compile(
    r'(?:^|[_/\-.])(map|maps|locator|location|logo|banner|collage|diagram|'
    r'coat_of_arms|emblem|flag|seal|symbol|chart|graph|blank|'
    r'satellite|aerial|landsat|nasa|sentinel|modis|cadal|djvu|siku|'
    r'cover|title|index|station|metro|railway|subway|platform|plan)(?:[_/\-.]|$)', re.I)
BAD_ZH = re.compile(r'(位置|地图|示意|平面|区位|交通图|行政区划|卫星|遥感|古籍|站$|车站|地铁|铁路|消歧义|列表|索引|旧地图)')

# 政治敏感词：面向国内用户的站点，涉独/分裂类图像一律剔除
BLOCK = ['台独', '台獨', '台湾独立', '台灣獨立', '独立旗帜', '獨立旗幟', '港独', '港獨',
         '藏独', '藏獨', '疆独', '疆獨', '反分裂', '分裂国家', '分裂國家', '一中一台']


def fname_of(t):
    t = re.sub(r'^(File|文件|Image|圖片):', '', t or '')
    return re.sub(r'\.[a-zA-Z]{2,5}$', '', t)


def lcs_len(a, b):
    prev = [0] * (len(b) + 1)
    best = 0
    for i in range(1, len(a) + 1):
        cur = [0] * (len(b) + 1)
        for j in range(1, len(b) + 1):
            if a[i - 1] == b[j - 1]:
                cur[j] = prev[j - 1] + 1
                if cur[j] > best:
                    best = cur[j]
        prev = cur
    return best


def relevance(query, title):
    """标题/文件名与查询词的相关度：完全包含 100+，最长公共子串 ×4"""
    f = fname_of(urllib.parse.unquote(title))
    if not query:
        return 0
    if query in f:
        return 100 + len(query)
    L = lcs_len(query, f)
    return L * 4 if L >= 2 else 0


def is_good(u, title=''):
    """过滤非照片类（地图/标志/车站等）与黑名单命中"""
    if not u:
        return False
    pure = urllib.parse.unquote(u.split('?')[0])
    if pure.lower().endswith(BAD_EXT) or BAD_RE.search(pure):
        return False
    if BAD_ZH.search(urllib.parse.unquote(title or '') + ' ' + pure):
        return False
    return True


def is_blocked(u):
    """政治敏感内容过滤"""
    try:
        f = urllib.parse.unquote(u or '')
    except Exception:
        return True
    return any(b in f for b in BLOCK)


def base_of(u):
    """URL → 规范化文件名（用于同一文件的缩略图变体去重）"""
    b = urllib.parse.unquote((u or '').rstrip('/').split('/')[-1])
    return re.sub(r'^\d+px-', '', b).lower()


def save_json(path, obj):
    json.dump(obj, open(path, 'w', encoding='utf-8'), ensure_ascii=False)


def load_json(path, default=None):
    try:
        return json.load(open(path, encoding='utf-8'))
    except Exception:
        return default if default is not None else {}


def search_title(name, city='', prov=''):
    """搜索定位「景点名」对应的维基词条标题。

    为什么需要：冷门景点的中文名常常不是维基词条名
    （「清名桥古运河」的词条叫「清名桥」，「淹城春秋」叫「淹城」），
    直接按原名查词条会 43/60 落空，必须先搜出真实标题。

    判定：标题里必须包含景点名，且长度差 ≤4（避免「XX山」匹配到
    完全不相干的词条）。依次尝试「城市+名」「名+城市」「省+名」「名」。

    返回词条标题，找不到返回 None。
    """
    for q in (city + name, name + city, prov + name, name):
        if not q:
            continue
        u = urllib.parse.urlencode({
            'action': 'query', 'format': 'json', 'generator': 'search',
            'gsrsearch': q, 'gsrlimit': '6', 'gsrnamespace': '0'})
        d = get_json(ZHW + u, retries=2, timeout=15)
        if not d or 'query' not in d:
            continue
        pages = sorted(d['query'].get('pages', {}).values(),
                        key=lambda p: p.get('index', 99))
        for p in pages:
            t = p.get('title', '')
            if t == name or (name in t and len(t) - len(name) <= 4):
                return t
    return None


def is_disambig(text):
    """判断词条正文是否为消歧义页

    消歧义页不能当简介用（曾有 106 条中招），
    需要走 resolve_disambig.py 选正确条目。

    坑：原实现只查开头 40 字里的「可以指」，
    但「南湖公园，可能是指：…」这种带逗号的写法会漏过 →
    消歧义内容直接混进了长介绍。改成全正则匹配。
    """
    if not text:
        return False
    return bool(DISAMBIG_RE.search(text[:60]))


# 消歧义页的多种写法：「可以指」「可能指」「指下列」「消歧义」「是指：」…
DISAMBIG_RE = re.compile(r'可以指|可能指|指下列|消歧义|是指以下|是指[:：]|或指')



def js_export(obj, header):
    return header + json.dumps(obj, ensure_ascii=False, indent=1) + ';\n'
