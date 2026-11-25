// ═══ 景点真实照片系统（Wikimedia Commons）═══
// 三层策略：
//  1) 静态库 SPOT_IMAGES_DB（批量抓取，覆盖 99% 景点，真实照片）
//  2) 运行时 Wikimedia 精搜（打开详情时补搜，替换地区泛图 / 补齐图集）
//  3) 主题化 SVG 占位（终极降级，按类型生成渐变，非随机 picsum）
import { lazyDB } from './lazy-db.js';
import { ensureGalleryShard, galleryShardReady, galleryGet } from './gallery-shard.js';
import { GALLERY_SPOT_COUNT } from './gallery-shard-map.js';

// 静态图库 120KB（raw）/ 36KB（gzip）——是首屏最大的一块，但首屏只渲染省份网格，
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
// hint 是图上那行小字。默认「加载中」——图库还没到货时这是实话；图库已就绪、
// 这处景点确实凑不满格子时由调用方换成「暂无更多实景」，免得 145 处景点
// 永远停在一行假的"加载中"上。
function placeholder(spotName, type, hint = '实景图加载中…') {
  const [a, b] = gradFor(type);
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='400'>" +
    "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
    "<stop offset='0' stop-color='" + a + "'/><stop offset='1' stop-color='" + b + "'/>" +
    "</linearGradient></defs>" +
    "<rect width='600' height='400' fill='url(#g)'/>" +
    "<circle cx='480' cy='90' r='46' fill='rgba(255,255,255,.10)'/>" +
    "<text x='300' y='200' font-size='34' fill='rgba(255,255,255,.92)' text-anchor='middle' font-family='sans-serif'>" + spotName + "</text>" +
    "<text x='300' y='238' font-size='15' fill='rgba(255,255,255,.55)' text-anchor='middle' font-family='sans-serif'>" + hint + "</text>" +
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
// ── 同步：封面（卡片 / 3D 详情用）──
// key 是「省|市|名」分城键：重名景点（西湖/东湖/南湖…）各用本地那一处的照片。
// 导出层已经剔掉这些名字的裸名键，取不到就返回占位图——宁可没图，不挂外地照。
export function getSpotCover(spotName, provName, type, key) {
  const e = (key && IMAGES_DB.get(key)) || IMAGES_DB.get(spotName);
  if (e) return e[0];                         // 静态库真实照片
  const c = loadCache();
  if (c[spotName] && c[spotName][0]) {
    const v = normImgUrl(c[spotName][0]);
    if (v) return v;
  }
  return placeholder(spotName, type);
}

// ── 同步：图集（详情弹窗，count 张）──
// ── 补充图组：按省分片懒加载（292KB 整库 → 单片 1~16KB，见 gallery-shard.js）──
// 以前这里整库 import：打开一处景点要下完 1873 处景点的图组，只为图集第 2/3 格。
// 现在只取「该景点所在省」那一片，省份必需的 —— 传 undefined 等于没有图组。
export function ensureGallery(prov) {
  return ensureGalleryShard(prov);
}

// 该省图组分片是否已就绪（决定占位文案写「加载中」还是「暂无更多实景」）
export function galleryReady(prov) {
  return galleryShardReady(prov);
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
  // 图组库已不进前端，条数由分片表带过来（构建期算好，免得为了一个数字拉 292KB）
  return { total: keys.length, c3, c2, c1, galleryCount: GALLERY_SPOT_COUNT };
}

export function getSpotImages(spotName, provName, count = 3, type, key) {
  const out = [];
  // 用 Set 去重：原来用 indexOf 逐个查，图集满载时是 O(n²)
  const seen = new Set();
  const push = u => {
    const v = normImgUrl(u);
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  };
  const e = (key && IMAGES_DB.get(key)) || IMAGES_DB.get(spotName);
  if (e) {
    push(e[0]);
    // 补充图组（本省分片到货后才有）：让图集 3 张都是实景
    const g = (key && galleryGet(key)) || galleryGet(spotName);
    if (g) for (const u of g) push(u);
  }
  const c = loadCache();
  if (c[spotName]) for (const u of c[spotName]) push(u);
  // 占位图：同一景点的多张占位图内容完全相同（只有渐变+名字），
  // 全部走 push 会被去重掉 → 补位时直接 push，保留"每格一张"的视觉
  //
  // 两个库都就绪还凑不满，说明这处景点确实没有更多实景了（9 处只有主图、
  // 136 处只有主图+1 张图组）。这时候再写「加载中」是骗人：图集库早就到了，
  // 那几个格子永远不会变。改成「暂无更多实景」，把"还在等"和"就这些"分开。
  // 注意判的是**这一省**的分片：判全局的话，换到另一个省时会把别人那片
  // 的到货状态当成自己的，占位文案又说错。
  const exhausted = IMAGES_DB.ready() && galleryReady(provName);
  while (out.length < count) {
    out.push(placeholder(spotName, type, exhausted ? '暂无更多实景' : undefined));
  }
  return out.slice(0, count);
}
