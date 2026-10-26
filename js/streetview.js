// ═══ 实景街景：按坐标调用地图服务的真实全景/街景 ═══
// 百度：panorama/v2 + fov=360 → 等距柱状全景图，可直接进球面查看器
// 高德：/v3/streetview → 单视角街景图（用于静态对照）
// 没有配置密钥时全部静默降级，功能按钮不显示。
//
// 【重要】AK 存在 ≠ 服务已开通。
// 百度控制台的"服务"是逐个申请的，未开通的接口会返回
//   240 APP 服务被禁用
// （staticimage/v2 开通了，panorama/v2 和 place/v2/search 没开通）。
// 所以按钮的显隐必须由**构建期探测出的服务能力**决定，
// 而不是"AK 非空就显示"——否则用户点了只会看到一张报错的破图。
import { BAIDU_AK, AMAP_KEY, BAIDU_CAPS } from './config.js';
import { lazyDB } from './lazy-db.js';

// 服务能力：BAIDU_CAPS 由 tools/probe_baidu_api.py 生成后粘进 config.js
// { staticImage: true, panorama: false, placeSearch: false, checkedAt: '...' }
// 未探测过（老配置）时保守处理：只认 staticImage，街景一律不显示。
const CAPS = BAIDU_CAPS || { staticImage: false, panorama: false, placeSearch: false };

export function hasStreetView() {
  if (CAPS.panorama && BAIDU_AK) return true;
  if (AMAP_KEY) return true;      // 高德单视角街景是 Web 服务，需 Web 服务 Key
  return false;
}

export function baiduCaps() { return CAPS; }

// 合法经纬度（越界或 NaN 会让接口返回空图）
function validCoord(lng, lat) {
  return typeof lng === 'number' && typeof lat === 'number'
    && Number.isFinite(lng) && Number.isFinite(lat)
    && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
}

// 百度全景静态图：fov=360 即整幅等距柱状图
// 官方文档约束：width ∈ [10,4096]，height ∈ [10,512]（超了返回 501/502）
// 等距柱状必须 2:1，所以 fov=360 的上限就是 1024×512
export function baiduPanoUrl(lng, lat, opts = {}) {
  if (!BAIDU_AK || !CAPS.panorama) return null;
  // 有 poiid 时可以不给坐标（poiid 自带位置）
  if (lng == null && !opts.poiid) return null;
  if (lng != null && !validCoord(lng, lat)) return null;
  const fov = opts.fov || 360;
  let w = opts.width, h = opts.height;
  if (!w || !h) {
    if (fov >= 360) { w = 1024; h = 512; }      // 全幅等距柱状（2:1）
    else { w = 512; h = 300; }                  // 单视角
  }
  w = Math.min(4096, Math.max(10, w));
  h = Math.min(512, Math.max(10, h));
  const p = new URLSearchParams({
    ak: BAIDU_AK,
    width: String(w), height: String(h),
    fov: String(fov), heading: String(opts.heading || 0), pitch: String(opts.pitch || 0),
  });
  // poiid 由 place api 获取；文档：poiid > panoid > location，
  // 且"根据 poiid 获取的全景视角最佳"（是景点本身，而非附近气泡）
  if (opts.poiid) {
    p.set('poiid', opts.poiid);
  } else {
    p.set('location', lng.toFixed(6) + ',' + lat.toFixed(6));
    p.set('coordtype', 'wgs84ll');
  }
  return 'https://api.map.baidu.com/panorama/v2?' + p.toString();
}

// 高德静态街景（单视角）
export function amapStreetUrl(lng, lat, opts = {}) {
  if (!AMAP_KEY || !validCoord(lng, lat)) return null;
  const size = opts.size || '1024*512';
  const p = new URLSearchParams({
    key: AMAP_KEY,
    location: lng.toFixed(6) + ',' + lat.toFixed(6),
    size,
    pitch: String(opts.pitch || 0),
    heading: String(opts.heading || 0),
  });
  return 'https://restapi.amap.com/v3/streetview?' + p.toString();
}

// ── POI 库（构建期采集，懒加载）──
// poiid 指向"景点本身的全景点"（故宫就是故宫大门），比只传坐标准得多
// 统一用 lazyDB，与 app.js 里的其他静态库同一套懒加载语义
export const POIID_DB = lazyDB(() => import('./poiid-db.js'), m => m.POIID_DB);

// 街景坐标：优先百度（全景可环视），否则高德（单视角）
// opts.poiid 存在时用它取景点正门视角
export function streetViewFor(coord, opts = {}) {
  if (!coord && !opts.poiid) return null;
  if (BAIDU_AK && CAPS.panorama) {
    const url = baiduPanoUrl(coord ? coord[0] : null, coord ? coord[1] : null, opts);
    if (url) return { url, type: 'sphere', provider: 'baidu' };
  }
  if (coord) {
    const am = amapStreetUrl(coord[0], coord[1], opts);
    if (am) return { url: am, type: 'wide', provider: 'amap' };
  }
  return null;
}
