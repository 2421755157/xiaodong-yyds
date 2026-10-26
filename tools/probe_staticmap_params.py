#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""百度 staticimage/v2 参数实测备忘

这个脚本的价值是**记录接口的真实边界**，避免以后凭文档想当然地写代码。
背景：官方文档的静态图参数表里根本没有 maptype，但很多示例代码会传
maptype=2 取卫星图 —— 实测会被静默忽略，仍返回标准路网图。
（瓦片服务 maponline*.bdimg.com/tile/ 现已 404，卫星图无路可走。）

实测结论（AK xfdsKWLy…w7CF，2026-10-24）：
  · maptype=0/1/2/3 → 四种取值返回**完全相同**的图（md5 一致），参数被忽略
  · qt=sate / qt=con,... 同样无效
  · width/height 上限随 scale 变：scale=1 → ≤1024；scale=2 → ≤512
    scaler=2 → ≤1024，输出 width*2（最高 2048px，清晰度最好）
  · scale=2 会让 zoom 自动 +1；scaler=2 只放大不改 zoom
  · markers 一旦带样式后缀（|color:red|label:xx）整图退化成 1×1 像素
    → 只能传纯坐标；markerStyles 作为独立参数反而正常
  · 接口不返回 CORS 头 → 只能用 <img> 加载，不能 fetch 取字节
  · 失败时返回 JSON（status 220/240/502/503…）而非 PNG

用法：
    python tools/probe_staticmap_params.py               # 用 config.js 里的 AK
    python tools/probe_staticmap_params.py <AK>          # 指定 AK
"""
import os, struct, sys, urllib.request

AK = sys.argv[1] if len(sys.argv) > 1 else ''
if not AK:
    import re
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'js', 'config.js')
    if os.path.exists(p):
        m = re.search(r"BAIDU_AK\s*=\s*['\"]([^'\"]*)['\"]", open(p, encoding='utf-8').read())
        AK = m.group(1).strip() if m else ''

REF = 'https://2421755157.github.io/xiaodong-yyds/'
LOC = '116.397428,39.90923'      # 天安门


def get(params):
    url = 'https://api.map.baidu.com/staticimage/v2?' + '&'.join(
        '%s=%s' % (k, v) for k, v in params.items())
    req = urllib.request.Request(url, headers={'Referer': REF, 'User-Agent': 'Mozilla/5.0'})
    try:
        r = urllib.request.urlopen(req, timeout=25)
        return r.read()
    except Exception as e:
        return str(e).encode('utf-8', 'ignore')


def size(b):
    return struct.unpack('>II', b[16:24]) if b[:8] == b'\x89PNG\r\n\x1a\n' else None


def base(**kw):
    p = {'ak': AK, 'location': LOC, 'coordtype': 'wgs84ll',
         'width': '400', 'height': '300', 'zoom': '15'}
    p.update(kw)
    return p


def show(tag, params):
    b = get(params)
    sz = size(b)
    print('  %-22s %-12s %dB %s' % (
        tag, ('%dx%d' % sz) if sz else 'ERR', len(b),
        '' if sz else b[:56].decode('utf-8', 'ignore')))


if __name__ == '__main__':
    if not AK:
        print('没找到 AK')
        sys.exit(1)
    print('AK: %s\n' % AK)
    print('=== maptype 是否有效（预期：全部相同 → 无效）===')
    for m in (0, 1, 2, 3):
        show('maptype=%d' % m, base(maptype=m))
    print('\n=== 分辨率档位 ===')
    show('scale=1', base(scale=1))
    show('scale=2', base(scale=2))
    show('scaler=2', base(scaler=2))
    show('scaler=2 w=1024', base(scaler=2, width=1024, height=1024))
    print('\n=== markers 样式后缀（预期：带后缀 → 1x1 像素）===')
    show('纯坐标', base(markers=LOC))
    show('|color:red', base(markers=LOC + '|color:red'))
    show('|label:天安门', base(markers=LOC + '|label:' + urllib.parse.quote('天安门')))
    print('\n=== 尺寸越界（预期：502 超出范围）===')
    show('scale=2 w=600', base(scale=2, width=600))
    show('scale=1 w=1024', base(scale=1, width=1024))
    show('scale=1 w=1025', base(scale=1, width=1025))
