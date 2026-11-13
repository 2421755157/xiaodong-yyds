// ═══ 景点简介分片加载器 ═══
//
// 为什么要分片：简介库 656KB（gzip 276KB），但
//   · 景点列表只用得到「一个城市」那几十条
//   · 详情弹窗只用得到「一个景点」那一条
//   · 只有搜索的正文全文匹配需要整库
// 以前列表层和详情页都得先把整库下完才能出词条原文 —— 详情弹窗的
// `await` 直接压在这 656KB 上，4G 下就是一两秒的白等。
//
// 现在按省份归并成 8 片（tools/shard_desc.py 生成），每片约 82KB：
//   loadProvDesc('浙江')   → 只下浙江所在那一片（列表 / 详情）
//   loadAllDesc()          → 8 片全下（只有搜索会这么做）
//
// 分片号来自生成文件 spot-desc-shard-map.js，前端不自己算 —— 桶怎么排是
// 构建期的事，改规则也不会和运行时对不上。
//
// 失败语义照抄 long-db 的经验：**失败的结果不进缓存**，下次打开还能重试；
// 但「试过」会记账，避免渲染重绘时反复发起同一请求。
import { DESC_SHARD_COUNT, DESC_SHARD_OF } from './spot-desc-shard-map.js';

const cache = new Map();    // 片号 → Promise（成功/进行中）
const tried = new Set();    // 发起过请求的片号（失败也算，用于渲染侧判断）
const loaded = new Set();   // 真正到货的片号
const view = Object.create(null);   // 已到货条目合并视图（同步读）
let allDone = false;        // 搜索用的「整库尝试过一次」

/** 省份 → 片号；未知省份返回 -1 */
export function descShardOf(prov) {
  const i = prov == null ? -1 : DESC_SHARD_OF[prov];
  return Number.isInteger(i) ? i : -1;
}

function loadShard(i) {
  if (cache.has(i)) return cache.get(i);
  tried.add(i);
  const p = import('./spot-desc-shard-' + i + '.js')
    .then(m => {
      const obj = m['DESC_SHARD_' + i] || {};
      // 每片里的键互不重叠（一条简介只属于一个省），直接合并即可
      for (const k in obj) view[k] = obj[k];
      loaded.add(i);
      return obj;
    })
    .catch(() => {
      // 弱网下请求被掐断时不能把空对象留在缓存里：那样这一片约 220 个景点
      // 在本次会话里永远没有词条原文，只能刷新页面才回来。
      cache.delete(i);
      return {};
    });
  cache.set(i, p);
  return p;
}

/** 加载某省那一片。省份不认识时立即 resolve（调用方按"没有词条"处理） */
export function loadProvDesc(prov) {
  const i = descShardOf(prov);
  if (i < 0) return Promise.resolve({});
  return loadShard(i);
}

/** 整库（只有搜索的正文匹配需要） */
export function loadAllDesc() {
  if (allDone) return Promise.resolve(view);
  const jobs = [];
  for (let i = 0; i < DESC_SHARD_COUNT; i++) jobs.push(loadShard(i));
  return Promise.all(jobs).then(() => {
    allDone = true;
    return view;
  });
}

/** 该省分片是否已到货 */
export function descHas(prov) {
  const i = descShardOf(prov);
  return i >= 0 && loaded.has(i);
}

/** 该省分片是否已经请求过（失败也算，用于渲染侧避免重绘死循环） */
export function descTried(prov) {
  const i = descShardOf(prov);
  return i >= 0 && tried.has(i);
}

export function descAllLoaded() { return allDone; }

/** 同步读取一条简介（键优先「省|市|名」，裸名由 pickSpotDesc 兜底问） */
export function descGet(key) {
  return key == null ? undefined : view[key];
}
