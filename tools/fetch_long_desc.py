#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抓取景点「历史沿革 / 来历」长篇介绍（中文维基词条正文前若干段，简体）。

与短简介的区别：
    短简介 = 词条导语（exintro），1~3 句，用于卡片
    长介绍 = 词条正文开头若干段（含建造年代、布局沿革、历史事件、名人轶事），用于详情页

用法：
    python tools/fetch_long_desc.py --limit 100     # 本轮最多抓 100 个
    python tools/fetch_long_desc.py                 # 全量（断点续跑）
    python tools/fetch_long_desc.py --export-only   # 只导出前端分片

产出：
    data/long_db.json                    { 景点名: 长介绍正文 }
    js/long-db-0.js .. js/long-db-7.js  按首字哈希分 8 片，详情页按需加载单片
"""
import argparse, json, os, re, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (DATA, JS, NOISE_PAREN, PINYIN_PAREN, ZHW, get_json,
                    is_disambig, js_export, load_json, save_json, search_title)

CACHE = os.path.join(DATA, 'long_db.json')
WORKERS = 12
MAX_CHARS = 900          # 单个景点的长介绍上限
CHUNKS = 8

# 到这些标题就截断（正文结束，后面是参考信息/链接堆）
CUT_HEADS = re.compile(
    r'^\s*(参考资料|參考資料|外部链接|外部連結|参见|參見|注释|註釋|注解|扩展阅读|延伸阅读|'
    r'相关条目|相關條目|参考文献|參考文獻|延伸項目|轶事|軼事|备注|備註|'
    r'Bibliography|References|External links|See also|Further reading|Notes|Sources)\s*$')

# 需要剔除的行内噪声
NOISE_LINE = re.compile(r'^(编辑|編輯|注释|註釋|外部链接|参考资料|图片|圖片|视频|視頻|上一张|下一张)\s*$')
FOOTNOTE = re.compile(r'\[\^?\d+\]|\[\d+\]')
WS = re.compile(r'[ \t]+')


def fetch_full_text(title):
    """取词条全文（不含导语限制）"""
    q = urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'redirects': '1',
        'prop': 'extracts', 'explaintext': '1', 'variant': 'zh-cn', 'titles': title})
    d = get_json(ZHW + q, retries=2, timeout=30)
    if not d or 'query' not in d:
        return ''
    for p in d['query'].get('pages', {}).values():
        if 'missing' in p:
            return ''
        return p.get('extract') or ''
    return ''


def build_long(text, name):
    """从全文里截出「历史沿革 / 来历」段落"""
    if not text:
        return ''
    lines = text.split('\n')
    out = []
    total = 0
    for ln in lines:
        ln = WS.sub(' ', ln).strip()
        if not ln:
            continue
        if CUT_HEADS.match(ln):
            break
        if NOISE_LINE.match(ln):
            continue
        if len(ln) <= 12 and not ln.endswith(('。', '）', ')')) and out:
            # 孤立短行，多半是章节标题，跳过
            continue
        clean = FOOTNOTE.sub('', ln)
        clean = NOISE_PAREN.sub('', clean)
        clean = PINYIN_PAREN.sub('', clean)
        out.append(clean)
        total += len(clean)
        if total >= MAX_CHARS:
            break
    body = ''.join(out)
    if len(body) < 60:
        return ''
    # 与短简介重复的部分去掉（长介绍从新信息开始才有意义）
    return body


def chunk_of(name):
    """按首字码分片：JS 端用同样规则取片"""
    return ord(name[0]) % CHUNKS if name else 0


def strip_lead(long_text, short_text):
    """去掉长文开头与短简介重复的部分，避免页面上重复两遍"""
    if not short_text:
        return long_text
    head = short_text[:18]
    i = long_text.find(head)
    if i < 0:
        return long_text
    # 只在长文开头附近才截，避免误删正文中间的相似句
    if i > 12:
        return long_text
    rest = long_text[i + len(head):]
    rest = rest.lstrip('，。、；： ')
    return rest if len(rest) > 80 else long_text


def export():
    db = load_json(CACHE, {})
    if not db:
        print('缓存为空，拒绝导出')
        return
    short = load_json(os.path.join(DATA, 'desc_db.json'), {})
    cleaned = 0
    for k in list(db.keys()):
        # 1) 长文去注音/转换注噪声
        body = NOISE_PAREN.sub('', PINYIN_PAREN.sub('', db[k]))
        # 2) 短简介同样清洗后，取首句作为「重复段」基准
        st = short.get(k)
        st = st[0] if isinstance(st, list) and st else (st or '')
        st = NOISE_PAREN.sub('', PINYIN_PAREN.sub('', st)).strip()
        first_sent = st.split('。')[0] if st else ''
        # 3) 去掉长文开头与短简介首句重复的部分
        if first_sent and len(first_sent) >= 10:
            i = body.find(first_sent)
            if 0 <= i <= 12:
                body = body[i + len(first_sent):].lstrip('，。、；： ')
        if len(body) < 80:
            body = NOISE_PAREN.sub('', PINYIN_PAREN.sub('', db[k]))
        if body != db[k]:
            cleaned += 1
        db[k] = body
    buckets = [dict() for _ in range(CHUNKS)]
    for k, v in db.items():
        buckets[chunk_of(k)][k] = v
    for i, b in enumerate(buckets):
        open(os.path.join(JS, 'long-db-%d.js' % i), 'w', encoding='utf-8').write(js_export(
            b,
            '// ═══ 景点历史沿革长介绍（分片 %d/%d）═══\n'
            '// 生成：tools/fetch_long_desc.py。按首字哈希分片，详情页按需加载单片。\n'
            'export const LONG_DESC_DB_%d = ' % (i + 1, CHUNKS, i)))
    save_json(CACHE, db)          # 清洗结果回写缓存，避免下次重复处理
    print('清洗 %d 处（含注音去除与去重），已回写缓存' % cleaned)
    print('导出 %d 条 → %d 个分片（%s）' % (
        len(db), CHUNKS, ', '.join('%d:%d' % (i, len(b)) for i, b in enumerate(buckets))))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--export-only', action='store_true')
    ap.add_argument('--workers', type=int, default=6, help='并发数（代理不稳时调小）')
    ap.add_argument('--no-search', action='store_true',
                    help='跳过「搜索定位」阶段（只用短简介已记录的词条名）')
    a = ap.parse_args()

    if not a.export_only:
        db = load_json(CACHE, {})
        # 短简介库里有的词条才去抓长文（词条名 = 短简介的来源词条）
        short = load_json(os.path.join(DATA, 'desc_db.json'), {})
        todo = [(k, v[1] if isinstance(v, list) and len(v) > 1 else k) for k, v in short.items()]
        todo = [(k, t) for k, t in todo if k not in db]
        if a.limit:
            todo = todo[:a.limit]
        print('长介绍：已有 %d，本轮抓 %d' % (len(db), len(todo)), flush=True)
        t0 = time.time()
        done = hit = 0

        stat = {'fail': 0, 'short': 0, 'disambig': 0}

        def work(item):
            name, title = item
            try:
                full = fetch_full_text(title)
            except Exception:
                stat['fail'] += 1
                return name, ''
            if not full:
                stat['fail'] += 1
                return name, ''
            # 消歧义页（「XX可以指：…」）正文只有几十字，抓了也是废的
            if is_disambig(full):
                stat['disambig'] += 1
                return name, ''
            body = build_long(full, name)
            if not body:
                stat['short'] += 1
            return name, body

        with ThreadPoolExecutor(max_workers=a.workers) as ex:
            for name, body in ex.map(work, todo):
                done += 1
                if body:
                    db[name] = body
                    hit += 1
                if done % 20 == 0:
                    save_json(CACHE, db)
                    print('  %d/%d 命中 %d  %.0fs [已保存]' % (done, len(todo), hit, time.time() - t0), flush=True)
        save_json(CACHE, db)
        print('本轮命中 %d / %d，总计 %d（抓取失败 %d，正文过短 %d，消歧义 %d）'
              % (hit, done, len(db), stat['fail'], stat['short'], stat['disambig']))

        # ── 阶段B：短简介记录的词条名取不到时，用搜索反查真实词条名再抓 ──
        # 冷门景点的中文名常常不是维基词条名（「清名桥古运河」→「清名桥」），
        # 抽样 60 个里有 43 个按原名直接 404，不做这一步就是白跑。
        if not a.no_search:
            spots = load_json(os.path.join(DATA, 'spots_uniq.json'), [])
            meta = {s['name']: s for s in spots}
            # 只对「还没长介绍、但短简介有」的景点做搜索定位
            retry = [k for k, v in short.items() if k not in db]
            if retry:
                print('  阶段B 搜索定位 %d 个' % len(retry), flush=True)
                found = {}
                with ThreadPoolExecutor(max_workers=12) as ex:
                    def locate(k):
                        s = meta.get(k, {})
                        try:
                            return k, search_title(k, s.get('city', ''), s.get('prov', ''))
                        except Exception:
                            return k, None
                    for k, t in ex.map(locate, retry):
                        if t:
                            found[k] = t
                # 排除消歧义页与已抓过的
                todo2 = [(k, t) for k, t in found.items() if t not in db.values()]
                if todo2:
                    print('  阶段B 待抓 %d 个' % len(todo2), flush=True)
                    done2 = hit2 = 0
                    with ThreadPoolExecutor(max_workers=a.workers) as ex:
                        for name, body in ex.map(work, todo2):
                            done2 += 1
                            if body:
                                db[name] = body
                                hit2 += 1
                            if done2 % 20 == 0:
                                save_json(CACHE, db)
                                print('    %d/%d 命中 %d  %.0fs [已保存]'
                                      % (done2, len(todo2), hit2, time.time() - t0), flush=True)
                    save_json(CACHE, db)
                    print('  阶段B 命中 %d / %d，总计 %d' % (hit2, done2, len(db)))

    export()
