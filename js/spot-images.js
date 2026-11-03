// ═══ 景点真实照片系统（Wikimedia Commons）═══
// 三层策略：
//  1) 静态库 SPOT_IMAGES_DB（批量抓取，覆盖 99% 景点，真实照片）
//  2) 运行时 Wikimedia 精搜（打开详情时补搜，替换地区泛图 / 补齐图集）
//  3) 主题化 SVG 占位（终极降级，按类型生成渐变，非随机 picsum）
import { lazyDB } from './lazy-db.js';

// 静态图库 372KB（raw）/ 66KB（gzip）——是首屏最大的一块，但首屏只渲染省份网格，
// 用的是渐变封面，一张景点照片都不需要。改成按需加载：
//   · 进入「景点列表」层前 await loadSpotImages()（renderNav 里）
//   · 首屏空闲时 warmUp 预热，用户点进去时基本已就绪
const IMAGES_DB = lazyDB(() => import('./spot-images-db.js'), m => m.SPOT_IMAGES_DB);
export function loadSpotImages() { return IMAGES_DB.load(); }
export function spotImagesReady() { return IMAGES_DB.ready(); }

// ── 类型 → 主题渐变（占位图 / 降级用）──
const TYPE_GRAD = {
  mountain: ['#1c3d4d', '#0f2027'], water: ['#1a4f6b', '#0e3a4d'],
  town: ['#3a4654', '#1a2230'], garden: ['#3e5151', '#decba4'],
  coast: ['#133a8a', '#1f9bb5'], city: ['#222831', '#485460'],
  snow: ['#5a7fa8', '#b6fbff'], desert: ['#a06a4a', '#d9a36b'],
  temple: ['#4a3018', '#b29f84'], park: ['#2f5d39', '#a8e063'],
  ruin: ['#3a3a3a', '#101010'], island: ['#1a6b4a', '#7ff0b0'],
  forest: ['#134e3a', '#71b280'], modern: ['#0f0c29', '#3a2f6b'],
};
function gradFor(type) {
  return TYPE_GRAD[type] || TYPE_GRAD.park;
}

// ── 主题占位图（SVG data URI）──
// 注：不需要序号参数 —— 占位图只按类型取渐变，同一景点的多张占位图本就相同
function placeholder(spotName, type) {
  const [a, b] = gradFor(type);
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='400'>" +
    "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
    "<stop offset='0' stop-color='" + a + "'/><stop offset='1' stop-color='" + b + "'/>" +
    "</linearGradient></defs>" +
    "<rect width='600' height='400' fill='url(#g)'/>" +
    "<circle cx='480' cy='90' r='46' fill='rgba(255,255,255,.10)'/>" +
    "<text x='300' y='200' font-size='34' fill='rgba(255,255,255,.92)' text-anchor='middle' font-family='sans-serif'>" + spotName + "</text>" +
    "<text x='300' y='238' font-size='15' fill='rgba(255,255,255,.55)' text-anchor='middle' font-family='sans-serif'>实景图加载中…</text>" +
    "</svg>";
  return 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg);
}

// ── 运行时精搜缓存（localStorage）──
// v2 → v3：v2 里存的是 Wikimedia 年代的地址（国内已经不可达），
// 这些陈旧条目会排在静态图组后面抢图集格子，必须整体作废。
const CACHE_KEY = 'ns_wiki_img_v3';
// 内存镜像：原来每渲染一张卡片都要 localStorage.getItem + JSON.parse 一次，
// 1779 张卡片就是 1779 次全量解析（缓存越大越慢）。
// 改成解析一次后常驻内存，写入时同步更新镜像。
let cacheMemo = null;
function loadCache() {
  if (cacheMemo) return cacheMemo;
  try {
    cacheMemo = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch (e) {
    cacheMemo = {};
  }
  return cacheMemo;
}
// 运行期拿到的 URL 统一规整：
//   · wikimedia / bcebos 在国内不可达或有防盗链 → 直接丢弃
//   · 360 CDN 的原图换成 /dr/720_720_/ 缩放地址（原图常 1.2MB）
// 构建期已经处理过一轮，但 localStorage 里的历史缓存和运行时补搜
// 还会带进未规整的地址，这里是最后一道闸。
const DEAD_HOST = /(^|\.)(wikimedia\.org|bcebos\.com)$/i;
const CDN_HOST = /(^|\.)qhimgs\d*\.com$/i;
function normImgUrl(u) {
  if (!u || typeof u !== 'string') return '';
  if (u.startsWith('img/') || u.startsWith('data:')) return u;
  try {
    const p = new URL(u, location.href);
    if (DEAD_HOST.test(p.hostname)) return '';
    if (CDN_HOST.test(p.hostname) && !p.pathname.startsWith('/dr/')) {
      p.pathname = '/dr/720_720_' + p.pathname;
      return p.toString();
    }
  } catch (e) {
    return '';
  }
  return u;
}

// 过滤明显非风景（地图/标志/扫描件等）

// 文件名与景点名的相关度：完整包含 100+，最长公共子串 ×4（与构建期同规则）
// DP 只需要上一行 → 用两个一维数组滚动，比每行 new Array 省掉 O(n) 次分配
// （原实现每行都 new Array(b.length+1).fill(0)，n 是文件名长度）
// ── 同步：封面（卡片 / 3D 详情用）──
export function getSpotCover(spotName, provName, type) {
  const e = IMAGES_DB.get(spotName);
  if (e) return e[0];                         // 静态库真实照片
  const c = loadCache();
  if (c[spotName] && c[spotName][0]) {
    const v = normImgUrl(c[spotName][0]);
    if (v) return v;
  }
  return placeholder(spotName, type);
}

// ── 同步：图集（详情弹窗，count 张）──
// ── 补充图组：独立文件懒加载（282KB，不进首屏）──
const GALLERY_DB = lazyDB(() => import('./spot-gallery-db.js'), m => m.SPOT_GALLERY_DB);
export function ensureGallery() {
  return GALLERY_DB.load();
}

// 图集库是否已就绪（用于判断要不要等它再渲染图集）
export function galleryReady() {
  return GALLERY_DB.ready();
}

// ── 图片库统计（首页展示真实数据）──
export function imageStats() {
  const db = IMAGES_DB.data();          // 未就绪时为空对象 → 统计返回 0，由调用方补齐
  const keys = Object.keys(db);
  let c3 = 0, c2 = 0, c1 = 0;
  for (const k of keys) {
    const e = db[k];
    if (e[1] >= 3) c3++; else if (e[1] === 2) c2++; else c1++;
  }
  return { total: keys.length, c3, c2, c1, galleryCount: Object.keys(GALLERY_DB.data()).length };
}

export function getSpotImages(spotName, provName, count = 3, type) {
  const out = [];
  // 用 Set 去重：原来用 indexOf 逐个查，图集满载时是 O(n²)
  const seen = new Set();
  const push = u => {
    const v = normImgUrl(u);
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  };
  const e = IMAGES_DB.get(spotName);
  if (e) {
    push(e[0]);
    // 补充图组（懒加载后才有）：让图集 3 张都是实景
    const g = GALLERY_DB.get(spotName);
    if (g) for (const u of g) push(u);
  }
  const c = loadCache();
  if (c[spotName]) for (const u of c[spotName]) push(u);
  // 占位图：同一景点的多张占位图内容完全相同（只有渐变+名字），
  // 全部走 push 会被去重掉 → 补位时直接 push，保留"每格一张"的视觉
  while (out.length < count) out.push(placeholder(spotName, type));
  return out.slice(0, count);
}

// ── 异步：补搜 / 升级（打开详情时调用）──
// 返回 Promise<urls[]>。网络补搜已停用（见下），现在只是静态库的直通。
// ── 运行时补搜：已停用 ──
// 原来这里会向 commons.wikimedia.org 搜图补足图集。该域名在国内网络不可达，
// 图不足 3 张的景点每打开一次就挂到 8 秒超时，控制台还留 net::ERR_TIMED_OUT，
// 用户看到的是"加载半天再降级"——收益为零。静态图组已覆盖 1768/1836，
// 剩下用占位图（渐变+地名）反而更诚实。函数保留是为了不改调用方。
export async function enrichSpotImages(spotName, provName, type, count = 3) {
  return getSpotImages(spotName, provName, count, type);
}
