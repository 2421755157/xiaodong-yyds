#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""百度地图 · 接口服务能力探测

为什么需要这个：
    百度控制台的"服务"是逐个申请的。AK 存在不等于所有接口都能用。
    没开通的服务会返回 240「APP 服务被禁用」，前端若只看 AK 非空就显示按钮，
    用户点下去只会看到一张报错破图。

    所以要在构建期把"哪些服务真能用"探出来，写进 js/config.js 的
    BAIDU_CAPS，前端据此决定按钮显隐。

用法：
    python tools/probe_baidu_api.py
    python tools/probe_baidu_api.py --ak xxxxx --referer https://your.site/
    python tools/probe_baidu_api.py --write     # 探测后自动改写 js/config.js

探测结果会打印成可直接粘贴的 JS 片段：
    export const BAIDU_CAPS = { staticImage: true, ... };
"""
import argparse, json, os, re, sys, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import JS

# 探测用的样例坐标与词条（必须用真实存在的，否则测不出"服务可用"）
SAMPLE_LOC = '116.397428,39.90923'      # 天安门
SAMPLE_QUERY = '故宫'
SAMPLE_REGION = '北京'


def _req(url, referer, timeout=25):
    """返回 (http_status, content_type, body_bytes)"""
    req = urllib.request.Request(url, headers={
        'Referer': referer, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, r.headers.get('Content-Type', ''), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('Content-Type', ''), e.read()
    except Exception as e:
        return 0, '', str(e).encode('utf-8', 'ignore')


def _is_png(b):
    return b[:8] == b'\x89PNG\r\n\x1a\n'


def _is_jpeg(b):
    return b[:3] == b'\xff\xd8\xff'


def _err(b):
    """接口失败时返回 JSON 错误体，解析出 message"""
    try:
        d = json.loads(b.decode('utf-8'))
        return '%s(%s)' % (d.get('message', ''), d.get('status', ''))
    except Exception:
        return b[:60].decode('utf-8', 'ignore')


def probe_static_image(ak, referer):
    url = ('https://api.map.baidu.com/staticimage/v2?'
           'ak=%s&location=%s&coordtype=wgs84ll&width=512&height=384&zoom=15&scaler=2'
           '&markers=%s' % (ak, SAMPLE_LOC, SAMPLE_LOC))
    st, ct, b = _req(url, referer)
    if _is_png(b):
        return True, 'PNG %dB' % len(b)
    return False, _err(b)


def probe_panorama(ak, referer):
    url = ('https://api.map.baidu.com/panorama/v2?'
           'ak=%s&location=%s&coordtype=wgs84ll&width=1024&height=512&fov=360' % (ak, SAMPLE_LOC))
    st, ct, b = _req(url, referer)
    if _is_jpeg(b) or _is_png(b):
        return True, '%s %dB' % (ct.split(';')[0], len(b))
    return False, _err(b)


def probe_place_search(ak, referer):
    url = ('https://api.map.baidu.com/place/v2/search?'
           'query=%s&region=%s&city_limit=true&output=json&scope=2&ak=%s'
           % (urllib.parse.quote(SAMPLE_QUERY), urllib.parse.quote(SAMPLE_REGION), ak))
    st, ct, b = _req(url, referer)
    try:
        d = json.loads(b.decode('utf-8'))
    except Exception:
        return False, _err(b)
    if d.get('status') == 0:
        return True, 'results=%d' % len(d.get('results') or [])
    return False, '%s(%s)' % (d.get('message', ''), d.get('status', ''))


def probe_geocoding(ak, referer):
    url = ('https://api.map.baidu.com/reverse_geocoding/v3/?'
           'ak=%s&output=json&coordtype=wgs84ll&location=%s' % (ak, SAMPLE_LOC))
    st, ct, b = _req(url, referer)
    try:
        d = json.loads(b.decode('utf-8'))
    except Exception:
        return False, _err(b)
    if d.get('status') == 0:
        return True, (d.get('result') or {}).get('formatted_address', '')[:30]
    return False, '%s(%s)' % (d.get('message', ''), d.get('status', ''))


def read_ak_from_config():
    p = os.path.join(JS, 'config.js')
    if not os.path.exists(p):
        return ''
    txt = open(p, encoding='utf-8').read()
    m = re.search(r"BAIDU_AK\s*=\s*['\"]([^'\"]*)['\"]", txt)
    return m.group(1).strip() if m else ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ak', default='')
    ap.add_argument('--referer', default='https://2421755157.github.io/xiaodong-yyds/')
    ap.add_argument('--write', action='store_true', help='探测后改写 js/config.js')
    args = ap.parse_args()

    ak = (args.ak or read_ak_from_config()).strip()
    if not ak:
        print('没有找到 AK：用 --ak 指定，或先在 js/config.js 里填好')
        return 1
    print('AK   : %s' % ak)
    print('Referer: %s' % args.referer)
    print()

    probes = [
        ('staticImage', '静态图 staticimage/v2', probe_static_image),
        ('panorama', '全景静态图 panorama/v2', probe_panorama),
        ('placeSearch', '地点检索 place/v2/search', probe_place_search),
        ('geocoding', '逆地理编码 reverse_geocoding', probe_geocoding),
    ]
    caps = {}
    for key, label, fn in probes:
        try:
            ok, detail = fn(ak, args.referer)
        except Exception as e:
            ok, detail = False, str(e)[:60]
        caps[key] = bool(ok)
        print('  [%s] %-32s %s' % ('可用' if ok else '禁用', label, detail))

    from datetime import datetime
    caps['checkedAt'] = datetime.now().strftime('%Y-%m-%d')
    print()
    print('粘贴到 js/config.js：')
    print("export const BAIDU_CAPS = %s;" % json.dumps(
        {k: v for k, v in caps.items()}, ensure_ascii=False))

    if args.write:
        p = os.path.join(JS, 'config.js')
        txt = open(p, encoding='utf-8').read()
        line = "export const BAIDU_CAPS = %s;" % json.dumps(
            {k: v for k, v in caps.items()}, ensure_ascii=False)
        if 'BAIDU_CAPS' in txt:
            txt = re.sub(r'export const BAIDU_CAPS\s*=\s*\{[^;]*\};', line, txt)
        else:
            txt = txt.rstrip() + '\n\n// 由 tools/probe_baidu_api.py 生成：控制台各服务的真实开通状态\n' + line + '\n'
        open(p, 'w', encoding='utf-8').write(txt)
        print('\n已写入 %s' % p)
    return 0


if __name__ == '__main__':
    import urllib.parse
    sys.exit(main())
