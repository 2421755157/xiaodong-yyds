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
const CACHE_KEY = 'ns_wiki_img_v2';
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
function saveCache(c) {
  cacheMemo = c;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* 满了静默 */ }
}

// 过滤明显非风景（地图/标志/扫描件等）
const BAD_RE = /(?:map|locator|location|logo|banner|collage|diagram|coat_of_arms|emblem|flag|seal|symbol|chart|graph|blank|satellite|aerial|landsat|nasa|sentinel|modis|cadal|siku|text|page|cover|title|index|old_|18[0-9]{2}|19[0-9]{2}|panoramio_id)/i;
// 涉独/分裂类图像：构建期与运行期统一拦截
const SENSITIVE_BLOCK = ['台独', '台獨', '台湾独立', '台灣獨立', '独立旗帜', '獨立旗幟',
  '港独', '港獨', '藏独', '藏獨', '疆独', '疆獨', '反分裂', '分裂国家', '分裂國家', '一中一台'];
function isBad(url, title) {
  const s = (url + ' ' + (title || '')).toLowerCase();
  if (BAD_RE.test(s)) return true;
  // 涉独/分裂类图像一律不展示（与构建期导出管线保持一致）
  return SENSITIVE_BLOCK.some(b => s.includes(b));
}

// 文件名与景点名的相关度：完整包含 100+，最长公共子串 ×4（与构建期同规则）
// DP 只需要上一行 → 用两个一维数组滚动，比每行 new Array 省掉 O(n) 次分配
// （原实现每行都 new Array(b.length+1).fill(0)，n 是文件名长度）
function lcsLen(a, b) {
  if (!a || !b) return 0;
  const n = b.length;
  let prev = new Array(n + 1).fill(0);
  let cur = new Array(n + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = 0;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        const v = prev[j - 1] + 1;
        cur[j] = v;
        if (v > best) best = v;
      } else {
        cur[j] = 0;
      }
    }
    // 交换两行（比每次 new 分配快得多）
    const t = prev; prev = cur; cur = t;
  }
  return best;
}
function relevanceOf(query, title) {
  const f = decodeURIComponent(String(title || '')).replace(/^File:/i, '').replace(/\.[a-zA-Z]{2,5}$/, '');
  if (!query) return 0;
  if (f.includes(query)) return 100 + query.length;
  const L = lcsLen(query, f);
  return L >= 2 ? L * 4 : 0;
}

// ── 运行时 Wikimedia Commons 搜索（CORS 友好，origin=*）──
// 带超时：网络挂起时不能把详情页的图集一直卡在骨架屏状态
const FETCH_TIMEOUT = 8000;
async function searchCommons(query, count = 3, spotName = '') {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json' +
    '&generator=search&gsrsearch=' + encodeURIComponent(query) +
    '&gsrnamespace=6&gsrlimit=' + (count * 3) +
    '&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=960&pilicense=any&origin=*';
  // AbortController 做超时（fetch 无内置 timeout）
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  let r;
  try {
    r = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new Error('http ' + r.status);
  const d = await r.json();
  const pages = (d.query && d.query.pages) || {};
  const out = [];
  for (const k of Object.keys(pages)) {
    const p = pages[k];
    const ii = p.imageinfo && p.imageinfo[0];
    if (!ii || !ii.thumburl) continue;
    const objName = ii.extmetadata && ii.extmetadata.ObjectName && ii.extmetadata.ObjectName.value;
    if (isBad(ii.thumburl, objName)) continue;
    // 相关性门槛：文件名或图片描述里必须能对上景点名
    // （英文文件名 + 中文描述是 Commons 上中国景点的常态）
    if (spotName) {
      const meta = ii.extmetadata || {};
      const desc = (meta.ImageDescription && meta.ImageDescription.value) || '';
      const blob = decodeURIComponent(String(p.title || '') + ' ' + desc);
      const rel = Math.max(relevanceOf(spotName, p.title), relevanceOf(spotName, desc));
      const nameHit = blob.includes(spotName);
      if (rel < 8 && !nameHit) continue;
    }
    out.push(ii.thumburl);
    if (out.length >= count) break;
  }
  return out;
}

// ── 同步：封面（卡片 / 3D 详情用）──
export function getSpotCover(spotName, provName, type) {
  const e = IMAGES_DB.get(spotName);
  if (e) return e[0];                         // 静态库真实照片
  const c = loadCache();
  if (c[spotName] && c[spotName][0]) return c[spotName][0];
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
  const push = u => { if (u && !seen.has(u)) { seen.add(u); out.push(u); } };
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
// 返回 Promise<urls[]>；成功则写入缓存并替换地区泛图。
//
// 记忆「已尝试过」：同一景点反复打开时不再重复打 Wikimedia。
// 原来失败会每次重发，用户来回点几个景点就是几十次无用请求。
const triedSpots = new Set();
export async function enrichSpotImages(spotName, provName, type, count = 3) {
  const cur = getSpotImages(spotName, provName, count, type);
  const realCount = cur.filter(u => !u.startsWith('data:')).length;
  const e = IMAGES_DB.get(spotName);
  const lowGrade = !e || e[1] <= 1;           // 地区泛图 / 缺失 → 努力精搜
  if (realCount >= count && !lowGrade) return cur;
  // 已经试过且没改善 → 不用再试（缓存里已有结果说明试成功了）
  if (triedSpots.has(spotName)) return cur;
  triedSpots.add(spotName);
  try {
    const q = lowGrade ? (spotName + ' ' + provName) : spotName;
    const found = await searchCommons(q, count, spotName);
    if (found.length) {
      const merged = [];
      const seen = new Set();
      if (e) { merged.push(e[0]); seen.add(e[0]); }
      for (const u of found) if (!seen.has(u)) { seen.add(u); merged.push(u); }
      const cache = loadCache();
      cache[spotName] = merged;
      saveCache(cache);
      return getSpotImages(spotName, provName, count, type);
    }
  } catch (e) { /* 网络/CORS 失败静默，沿用静态库/占位 */ }
  return cur;
}
