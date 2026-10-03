// ═══ 景点真实照片系统（Wikimedia Commons）═══
// 三层策略：
//  1) 静态库 SPOT_IMAGES_DB（批量抓取，覆盖 99% 景点，真实照片）
//  2) 运行时 Wikimedia 精搜（打开详情时补搜，替换地区泛图 / 补齐图集）
//  3) 主题化 SVG 占位（终极降级，按类型生成渐变，非随机 picsum）
import { SPOT_IMAGES_DB } from './spot-images-db.js';

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
function placeholder(spotName, type, idx = 0) {
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
function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; }
}
function saveCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* 满了静默 */ }
}

// 过滤明显非风景（地图/标志/扫描件等）
const BAD_RE = /(?:map|locator|location|logo|banner|collage|diagram|coat_of_arms|emblem|flag|seal|symbol|chart|graph|blank|satellite|aerial|landsat|nasa|sentinel|modis|cadal|siku|text|page|cover|title|index|old_|18[0-9]{2}|19[0-9]{2}|panoramio_id)/i;
function isBad(url, title) {
  const s = (url + ' ' + (title || '')).toLowerCase();
  return BAD_RE.test(s);
}

// ── 运行时 Wikimedia Commons 搜索（CORS 友好，origin=*）──
async function searchCommons(query, count = 3) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json' +
    '&generator=search&gsrsearch=' + encodeURIComponent(query) +
    '&gsrnamespace=6&gsrlimit=' + (count * 3) +
    '&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=960&pilicense=any&origin=*';
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('http ' + r.status);
  const d = await r.json();
  const pages = (d.query && d.query.pages) || {};
  const out = [];
  for (const k of Object.keys(pages)) {
    const p = pages[k];
    const ii = p.imageinfo && p.imageinfo[0];
    if (!ii || !ii.thumburl) continue;
    if (isBad(ii.thumburl, ii.extmetadata && ii.extmetadata.ObjectName && ii.extmetadata.ObjectName.value)) continue;
    out.push(ii.thumburl);
    if (out.length >= count) break;
  }
  return out;
}

// ── 同步：封面（卡片 / 3D 详情用）──
export function getSpotCover(spotName, provName, type) {
  const e = SPOT_IMAGES_DB[spotName];
  if (e) return e[0];                         // 静态库真实照片
  const c = loadCache();
  if (c[spotName] && c[spotName][0]) return c[spotName][0];
  return placeholder(spotName, type);
}

// ── 同步：图集（详情弹窗，count 张）──
// ── 补充图组：独立文件懒加载（282KB，不进首屏）──
let GALLERY = null;
let galleryPromise = null;
export function ensureGallery() {
  if (GALLERY) return Promise.resolve(GALLERY);
  if (!galleryPromise) {
    galleryPromise = import('./spot-gallery-db.js')
      .then(m => { GALLERY = m.SPOT_GALLERY_DB || {}; return GALLERY; })
      .catch(() => { GALLERY = {}; return GALLERY; });
  }
  return galleryPromise;
}

// ── 图片库统计（首页展示真实数据）──
export function imageStats() {
  const keys = Object.keys(SPOT_IMAGES_DB);
  let c3 = 0, c2 = 0, c1 = 0;
  for (const k of keys) {
    const e = SPOT_IMAGES_DB[k];
    if (e[1] >= 3) c3++; else if (e[1] === 2) c2++; else c1++;
  }
  return { total: keys.length, c3, c2, c1, galleryCount: GALLERY ? Object.keys(GALLERY).length : 0 };
}

export function getSpotImages(spotName, provName, count = 3, type) {
  const out = [];
  const e = SPOT_IMAGES_DB[spotName];
  if (e) {
    out.push(e[0]);
    // 补充图组（懒加载后才有）：让图集 3 张都是实景
    const g = GALLERY && GALLERY[spotName];
    if (g) for (const u of g) if (u && out.indexOf(u) < 0) out.push(u);
  }
  const c = loadCache();
  if (c[spotName]) for (const u of c[spotName]) if (out.indexOf(u) < 0) out.push(u);
  while (out.length < count) out.push(placeholder(spotName, type, out.length));
  return out.slice(0, count);
}

// ── 异步：补搜 / 升级（打开详情时调用）──
// 返回 Promise<urls[]>；成功则写入缓存并替换地区泛图。
export async function enrichSpotImages(spotName, provName, type, count = 3) {
  const cur = getSpotImages(spotName, provName, count, type);
  const realCount = cur.filter(u => !u.startsWith('data:')).length;
  const e = SPOT_IMAGES_DB[spotName];
  const lowGrade = !e || e[1] <= 1;           // 地区泛图 / 缺失 → 努力精搜
  if (realCount >= count && !lowGrade) return cur;
  try {
    const q = lowGrade ? (spotName + ' ' + provName) : spotName;
    const found = await searchCommons(q, count);
    if (found.length) {
      const merged = [];
      if (e) merged.push(e[0]);
      for (const u of found) if (merged.indexOf(u) < 0) merged.push(u);
      const cache = loadCache();
      cache[spotName] = merged;
      saveCache(cache);
      return getSpotImages(spotName, provName, count, type);
    }
  } catch (e) { /* 网络/CORS 失败静默，沿用静态库/占位 */ }
  return cur;
}
