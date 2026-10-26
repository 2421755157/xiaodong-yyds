// ═══ 百度地图 · 静态位置图 ═══
// 用 staticimage/v2 生成带标记的位置小图：让用户一眼看到景点在城里的位置。
//
// 【实测约束（2026-10-24，AK xfdsKWLy…w7CF）——别凭文档想当然】
//  1. 官方参数表只有 ak/width/height/center/zoom/coordtype/scale/scaler/
//     bbox/markers/markerStyles/dpiType/copyright。
//     **没有 maptype** → 传 maptype=2 卫星图会被静默忽略，仍返回标准路网图。
//     静态图接口无法出卫星图（瓦片服务 maponline*.bdimg.com 已 404）。
//  2. width/height 上限随 scale 变化：scale=1 时 ≤1024，scale=2 时 ≤512。
//     用 scaler=2 则 width/height 可到 1024，输出 2048px（更清晰）。
//  3. scale=2 会让 zoom 自动 +1；scaler=2 只放大不改 zoom。
//  4. markers 一旦带样式后缀（|color:red|label:xx）整张图会退化成 1×1 像素，
//     所以这里只传纯坐标，标记针由百度默认样式绘制。
//  5. markerStyles 是独立参数，可正常用（但视觉收益有限，暂未用）。
//  6. 接口不返回 CORS 头 → 只能用 <img> 加载，不能 fetch 取字节。
//  7. 失败时返回 JSON（status 220/240/502…）而非 PNG，前端靠 onerror 兜底。
import { BAIDU_AK } from './config.js';

export function hasStaticMap() { return !!BAIDU_AK; }

// 尺寸上限：scaler=2 时 width/height 可到 1024；scale=2 时只能到 512。
// 这里统一用 scaler=2（输出 2 倍分辨率），所以按 1024 卡。
const MAX_DIM = 1024;

// 合法经纬度范围（百度接口对越界坐标会返回空图或错误）
const LNG_MIN = -180, LNG_MAX = 180;
const LAT_MIN = -90, LAT_MAX = 90;

function validCoord(lng, lat) {
  return typeof lng === 'number' && typeof lat === 'number'
    && Number.isFinite(lng) && Number.isFinite(lat)
    && lng >= LNG_MIN && lng <= LNG_MAX
    && lat >= LAT_MIN && lat <= LAT_MAX;
}

/**
 * 生成静态图 URL
 * @param {number} lng  WGS84 经度
 * @param {number} lat  WGS84 纬度
 * @param {object} opts  zoom / width / height / marker / bbox
 * @returns {string|null}  参数非法或未配 AK 时返回 null
 */
export function staticMapUrl(lng, lat, opts = {}) {
  if (!BAIDU_AK) return null;
  // 坐标非法（NaN / 越界 / 非数字）时直接拒绝，避免请求出一个空白图
  if (!validCoord(lng, lat)) return null;
  // scale=2 时上限 512，scaler=2 时上限 1024 —— 取宽的
  const w = Math.min(MAX_DIM, Math.max(10, Math.round(opts.width || 512)));
  const h = Math.min(MAX_DIM, Math.max(10, Math.round(opts.height || 384)));
  // zoom 有效范围 [3,19]，越界会被服务端拒绝
  // 注意不能用 `opts.zoom || 15` —— zoom=0 是 falsy，会被当成 15 绕过了下限检查
  const zRaw = Number(opts.zoom);
  const zoom = Math.min(19, Math.max(3, Math.round(Number.isFinite(zRaw) ? zRaw : 15)));
  const p = new URLSearchParams({
    ak: BAIDU_AK,
    width: String(w),
    height: String(h),
    scaler: '2',                 // 输出 2 倍分辨率（2048 级），zoom 不变
    coordtype: 'wgs84ll',        // 我们的坐标库是 WGS84
    zoom: String(zoom),
  });
  if (opts.bbox) {
    // bbox = minX,minY;maxX,maxY，用它可以精确控制视野而不依赖 zoom
    p.set('bbox', opts.bbox);
  } else {
    p.set('location', lng.toFixed(6) + ',' + lat.toFixed(6));
  }
  // markers 只传纯坐标：带样式后缀会导致整图退化成 1×1 像素
  if (opts.marker !== false) {
    p.set('markers', lng.toFixed(6) + ',' + lat.toFixed(6));
  }
  return 'https://api.map.baidu.com/staticimage/v2?' + p.toString();
}

// ═══ 视野档位 ═══
// 静态图没有图层切换，但缩放级别是真的能切的，而且对"景点在城里的方位"很有用：
// 街区（看清门牌）→ 城区（看清在哪一片）→ 全域（看清离市中心多远）
export const MAP_VIEWS = [
  { key: 'block', label: '街区', zoom: 17, w: 512, h: 384 },
  { key: 'area', label: '城区', zoom: 14, w: 512, h: 384 },
  { key: 'city', label: '全域', zoom: 11, w: 512, h: 384 },
];

export function mapViewByKey(key) {
  return MAP_VIEWS.find(v => v.key === key) || MAP_VIEWS[0];
}

// ═══ 跳转百度地图（可交互版）═══
// api.map.baidu.com/marker 会 302 到 map.baidu.com 的可交互地图页，
// 带标题与自动打开标注。已实测 302 → 200，302KB 的完整地图应用页面。
export function baiduMapLink(lng, lat, title) {
  if (!BAIDU_AK || !validCoord(lng, lat)) return null;
  const p = new URLSearchParams({
    ak: BAIDU_AK,
    location: lng.toFixed(6) + ',' + lat.toFixed(6),
    coordtype: 'wgs84ll',
    title: title || '',
    content: title || '',
    output: 'html',
  });
  return 'https://api.map.baidu.com/marker?' + p.toString();
}
