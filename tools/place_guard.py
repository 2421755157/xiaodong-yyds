#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""景点简介「张冠李戴」检测：这段话讲的真是本市这一处吗？

背景：维基是按标题给首段的，而景点名经常是更大范围里的一个泛名。
「长岛」在山东烟台是渤海海峡的列岛，词条却是纽约的长岛；
「铁塔」在开封是开宝寺塔，词条却是济宁的崇觉寺铁塔；
「天河山」在邢台是太行山里的景区，词条却成了加拿大一位政治人物。
这种错位在页面上表现为「河北邢台的景点，简介在讲加拿大政客」，
比没有简介更糟——宁可回退手写的一句话，也不要把外地那段挂上来。

判定顺序（每条都朝「宁可漏判，不可误判」写，因为误杀会白丢一条好简介）：
  1) 全文出现本市名或本省简称 → 直接放行。
     边境景点写「与俄罗斯隔江相望」、澳门景点写「葡萄牙语」都属正常表述，
     不能因为看见国名就判错。
  2) 首句（前 80 字）出现「别的省 + 省/市/自治区」或直辖市名 → 判错位。
     「别的省」必须带行政区划后缀才算，否则「什刹海南岸」会被当成海南。
  3) 首句出现境外国名，且它处在「定位」语境里（前面有位于/隶属/是…，
     或者紧跟州/省/市/建筑/法人/政治人物这类名词）→ 判错位。
     只写「尼泊尔称萨加玛塔峰」「在朝鲜半岛称白头山」这类命名说明不算，
     否则珠峰、长白山这些正经词条会被误杀。

用法：
    from place_guard import mismatch
    mismatch(text, city, prov)   # 返回原因字符串；None 表示通过
"""
import re

# 省级名（去掉「省/市/自治区/特别行政区」后缀后的写法）
PROV_SUFFIX = re.compile(r'(省|市|自治区|特别行政区|壮族|回族|维吾尔|自治州)+$')

PROVINCE_NAMES = (
    '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建',
    '江西', '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州',
    '云南', '陕西', '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏',
    '新疆',
)
# 直辖市/特别行政区：本身是省级，出现时通常不带「市」字（「北京紫禁城」）
MUNICIPALITIES = ('北京', '天津', '上海', '重庆', '香港', '澳门')

# 「别的省」必须带上行政区划后缀才算，否则「什刹海南岸」会被当成海南、
# 「长白山北坡」会被当成山北。
_RIVAL_PROV = re.compile(
    '(' + '|'.join(PROVINCE_NAMES) + r')(?:省|市|自治区|特别行政区)')
_RIVAL_MUNI = re.compile('|'.join(MUNICIPALITIES))

# 境外国名。后面紧跟「族/人/语/半岛/海/江/河/湖/山/边界」时是民族、语言、
# 地理接壤表述，不算讲境外。
FOREIGN_WORDS = (
    '美国', '加拿大', '墨西哥', '巴西', '阿根廷', '智利', '英国', '法国',
    '德国', '意大利', '西班牙', '葡萄牙', '荷兰', '比利时', '瑞士', '奥地利',
    '希腊', '波兰', '瑞典', '挪威', '芬兰', '丹麦', '爱尔兰', '俄罗斯',
    '乌克兰', '白俄罗斯', '日本', '韩国', '朝鲜', '泰国', '越南', '柬埔寨',
    '老挝', '缅甸', '马来西亚', '新加坡', '印度尼西亚', '菲律宾', '印度',
    '巴基斯坦', '尼泊尔', '斯里兰卡', '伊朗', '伊拉克', '土耳其', '以色列',
    '埃及', '南非', '肯尼亚', '澳大利亚', '新西兰', '南极洲', '格陵兰',
    '哈萨克斯坦', '乌兹别克斯坦', '蒙古国',
)
_FOREIGN = re.compile(
    '(' + '|'.join(FOREIGN_WORDS) + ')'
    r'(?!族|人|语|半岛|海|江|河|湖|山|边界|边境|使馆|联邦|军|籍)')

# 「定位」语境：国名前面这几个词说明它是在交代地理位置，
# 而不是在讲命名来源（「尼泊尔称萨加玛塔峰」）。
_LOCATOR = re.compile(r'(位于|地处|隶属|属于|坐落|座落|是|在|来自)[^，。；]{0,12}$')
# 国名后面直接跟这些词，同样说明是地点/机构，不是命名说明。
_FOREIGN_NOUN = re.compile(
    r'^(州|省|市|国|岛|地区|东部|西部|南部|北部|中部|建筑|法人|公司|集团|'
    r'政治人物|城市|大学|政府|球队|电影|作品|军队|政府)')

HEAD_LEN = 80


def prov_base(prov):
    """『山西省』→『山西』；『内蒙古自治区』→『内蒙古』"""
    return PROV_SUFFIX.sub('', (prov or '').strip())


def _own_region(text, city, prov):
    """全文里能不能找到本地证据（本市名或本省简称）"""
    if city and city in text:
        return True
    pb = prov_base(prov)
    return bool(pb and pb in text)


def mismatch(text, city, prov):
    """返回错位原因；None 表示这段话没有明显地域冲突。"""
    if not text:
        return None
    if _own_region(text, city, prov):
        return None

    head = text[:HEAD_LEN]
    pb = prov_base(prov)

    for m in _RIVAL_PROV.finditer(head):
        if m.group(1) != pb:
            return '首句讲的是%s的事，全文未提%s' % (m.group(1), city or prov)

    for m in _RIVAL_MUNI.finditer(head):
        if m.group(0) not in (pb, city):
            return '首句讲的是%s的事，全文未提%s' % (m.group(0), city or prov)

    for m in _FOREIGN.finditer(head):
        word, start, end = m.group(1), m.start(), m.end()
        # 开头就是国名（「朝鲜民主主义人民共和国的自然公园，…」）
        if start == 0:
            return '首句讲的是境外（%s），全文未提%s' % (word, city or prov)
        if _FOREIGN_NOUN.match(head[end:]):
            return '首句讲的是境外（%s），全文未提%s' % (word, city or prov)
        if _LOCATOR.search(head[:start]):
            return '首句讲的是境外（%s），全文未提%s' % (word, city or prov)
    return None
