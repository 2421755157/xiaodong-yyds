// ═══ 景点补充图组分片加载器 ═══
//
// 为什么要分片：图组库 292KB（gzip 63KB），详情页图集却只用得到「这一处景点」
// 那 2 张缩略图。以前每打开一处景点都要把 1873 处景点的图组整库下完，
// 图集第 2/3 格才亮起来 —— 等于为了两张 720px 的缩略图买下全国图库。
//
// 现在按省份切成 34 片（tools/shard_gallery.py 生成），单片 1~16KB、中位 8KB：
//   ensureGallery('浙江')  → 只下浙江那片
//   galleryReady('浙江')   → 那片是否到货（决定占位文案写「加载中」还是「暂无更多」）
//
// 分片号来自生成文件 gallery-shard-map.js，前端不自己算 —— 桶怎么排是构建期
// 的事，改规则也不会和运行时对不上。
//
// 失败语义照抄 desc-shard / long-db：**失败的结果不进缓存**，下次打开还能重试。
import { GALLERY_SHARD_OF } from './gallery-shard-map.js';

const cache = new Map();    // 片号 → Promise（成功/进行中）
const loaded = new Set();   // 真正到货的片号
const view = Object.create(null);   // 已到货条目合并视图（同步读）

/** 省份 → 片号；未知省份返回 -1 */
export function galleryShardOf(prov) {
  const i = prov == null ? -1 : GALLERY_SHARD_OF[prov];
  return Number.isInteger(i) ? i : -1;
}

function loadShard(i) {
  if (cache.has(i)) return cache.get(i);
  const p = import('./gallery-shard-' + i + '.js')
    .then(m => {
      const obj = m['GALLERY_SHARD_' + i] || {};
      // 一个景点只属于一个省，各片键互不重叠，直接合并即可
      for (const k in obj) view[k] = obj[k];
      loaded.add(i);
      return obj;
    })
    .catch(() => {
      // 弱网下请求被掐断时不能把空对象留在缓存里：那样这个省的所有景点
      // 在本次会话里永远只有 1 张图，只能刷新页面才回来。
      cache.delete(i);
      return {};
    });
  cache.set(i, p);
  return p;
}

/** 加载某省那一片。省份不认识时立即 resolve */
export function ensureGalleryShard(prov) {
  const i = galleryShardOf(prov);
  if (i < 0) return Promise.resolve({});
  return loadShard(i);
}

/** 该省分片是否已到货 */
export function galleryShardReady(prov) {
  const i = galleryShardOf(prov);
  return i >= 0 && loaded.has(i);
}

/** 同步读取一处景点的补充图组（键优先「省|市|名」，裸名由调用方兜底） */
export function galleryGet(key) {
  return key == null ? undefined : view[key];
}
