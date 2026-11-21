// ═══ 搜索命中采集（纯函数，无 DOM）═══
//
// 单独成模块是为了能被 tools/unit_test.mjs 直接 import 做回归：
// 搜索的排序/截断规则以前埋在 doSearch() 里，只能靠 E2E 点进去看条数，
// 而"该出现的那处景点没出现"恰恰是条数断言看不出来的。
//
// ── 为什么要有 quotas ──
// 原实现是一条条往下收，收到 60 条就 break outer。但景点是按 省→市 顺序遍历的，
// 热门泛名（"岛""博物馆""山"）在北京/天津/河北的**正文**里就能凑满 60 条，
// 于是后面省份的**名称**命中直接被丢掉：
//   搜「岛」  → 名称命中 53 处，只收到 24 处，刘公岛/长岛/养马岛全没了
//   搜「博物馆」→ 陕西历史博物馆、甘肃省博物馆、青海博物馆全没了
// 用户搜的是名字，结果里连名字对得上的都看不见，这属于"搜不到"而不是"排得靠后"。
//
// 所以改成两条配额：名称命中一律收（只是字符串包含，1892 处跑一遍可忽略），
// 正文命中收满 MAX_DESC_HITS 条即止——一旦满了连 readDesc 都不再调用，
// 省下的正是最贵的那一步（整库 1680 条正文的 includes）。

import { SPOT_TYPE } from './china-data.js';

/** 正文命中的条数上限。名称命中不受它限制。 */
export const MAX_DESC_HITS = 60;

/** 排序档位：数字越小越靠前 */
export const RANK = {
  EXACT: 0,     // 景点名与关键词完全相同（搜「西湖」先给西湖，再给西湖公园、瘦西湖）
  NAME: 1,      // 景点名包含关键词
  DESC: 2,      // 只有正文提到
  CITY: 3,      // 城市名命中
  PROV: 4,      // 省份名命中
};

// 名称命中是否全等。同名异地（杭州西湖 / 惠州西湖）都算，
// 它们之间的先后仍按「省→市」的原始顺序，不做额外判断。
function nameRankOf(name, q) {
  return name === q ? RANK.EXACT : RANK.NAME;
}

/**
 * 采集搜索结果。
 * @param {Array} provinces  PROVINCES 结构（省→市→景点）
 * @param {string} q         已 trim 的关键词
 * @param {object} opts
 *   type      'all' | 'spot' | 'city' | 'prov'   与筛选条一致
 *   prov      限定省份名，空串=全国
 *   readDesc  (spot) => string  取景点正文（未加载时返回 ''）
 *   pyHit     (name) => boolean 拼音命中（纯中文搜索时传 undefined）
 *   maxDescHits 正文配额，默认 MAX_DESC_HITS
 * @returns {Array} 已排序的结果项，字段与原 doSearch 内联版一致
 */
export function collectHits(provinces, q, opts = {}) {
  const type = opts.type || 'all';
  const onlyProv = opts.prov || '';
  const readDesc = opts.readDesc || (() => '');
  const pyHit = opts.pyHit || (() => false);
  const maxDesc = opts.maxDescHits == null ? MAX_DESC_HITS : opts.maxDescHits;

  const out = [];
  let descHits = 0;

  for (const p of provinces) {
    if (onlyProv && p.n !== onlyProv) continue;

    // 省份：只有「全部 / 省份」两档要
    if (type === 'all' || type === 'prov') {
      if (p.n.includes(q) || (p.c || '').includes(q) || pyHit(p.n)) {
        out.push({
          rank: RANK.PROV, byName: true, type: 'prov', prov: p,
          label: p.n + '（省）',
          sub: '省会 ' + p.cap + ' · ' + p.cities.length + ' 市',
        });
      }
    }

    for (const c of p.cities) {
      // 城市：只有「全部 / 城市」两档要
      if (type === 'all' || type === 'city') {
        if (c.n.includes(q) || pyHit(c.n)) {
          out.push({
            rank: RANK.CITY, byName: true, type: 'city', prov: p, city: c,
            label: c.n + '（市）',
            sub: p.n + ' · ' + c.spots.length + ' 处风景',
          });
        }
      }
      if (type === 'city' || type === 'prov') continue;

      for (const s of c.spots) {
        const tag = (SPOT_TYPE[s.t] || {}).label || '';
        const byName = s.n.includes(q) || pyHit(s.n);
        if (byName) {
          out.push({
            rank: nameRankOf(s.n, q), byName: true, type: 'spot',
            prov: p, city: c, spot: s, label: s.n, sub: p.n + ' ' + c.n,
            tag, hit: s.n,
          });
          continue;
        }
        // 配额满了就不再读正文：这一步是整库 1680 条的字串搜索，最贵
        if (descHits >= maxDesc) continue;
        const d = readDesc(s) || '';
        if (!d.includes(q)) continue;
        descHits++;
        out.push({
          rank: RANK.DESC, byName: false, type: 'spot',
          prov: p, city: c, spot: s, label: s.n, sub: p.n + ' ' + c.n,
          tag, hit: d,
        });
      }
    }
  }

  // Array.prototype.sort 自 ES2019 起是稳定排序，同档内保持「省→市→景点」的原始顺序
  out.sort((a, b) => a.rank - b.rank);
  return out;
}
