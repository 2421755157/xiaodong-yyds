// ═══ 中国省→市→景点数据 · 入口 ═══
// 数据分区域存放于 js/data/*.js，这里合并导出。
// 景点类型 t：mountain 山岳 / water 湖泊水景 / town 古镇 / garden 园林
//   coast 海岸 / city 都市 / temple 寺庙 / park 公园 / ruin 遗址
//   island 岛屿 / forest 森林 / snow 雪景 / modern 现代地标 / desert 沙漠
// 说明：省会及热门旅游城市景点较详；部分小城市为代表性列举，可后续校补。

import { ZHIXIA } from './data/zhixia.js';
import { HUABEI } from './data/huabei.js';
import { DONGBEI } from './data/dongbei.js';
import { HUADONG } from './data/huadong.js';
import { HUAZHONG } from './data/huazhong.js';
import { HUANAN } from './data/huanan.js';
import { XINAN } from './data/xinan.js';
import { XIBEI } from './data/xibei.js';
import { GANGAOTAI } from './data/gangaotai.js';

export const PROVINCES = [
  ...ZHIXIA, ...HUABEI, ...DONGBEI, ...HUADONG,
  ...HUAZHONG, ...HUANAN, ...XINAN, ...XIBEI, ...GANGAOTAI,
];

// 景点类型 → 中文标签 + 推荐 3D 模板
export const SPOT_TYPE = {
  mountain: { label: '山岳', scene: 'mountain' },
  water:    { label: '湖泊水景', scene: 'water' },
  town:     { label: '古镇', scene: 'town' },
  garden:   { label: '园林', scene: 'garden' },
  coast:    { label: '海岸', scene: 'coast' },
  city:     { label: '都市', scene: 'city' },
  temple:   { label: '寺庙', scene: 'temple' },
  park:     { label: '公园', scene: 'park' },
  ruin:     { label: '遗址古迹', scene: 'ruin' },
  island:   { label: '岛屿', scene: 'coast' },
  forest:   { label: '森林', scene: 'mountain' },
  snow:     { label: '雪景', scene: 'snow' },
  modern:   { label: '现代地标', scene: 'city' },
  desert:   { label: '沙漠', scene: 'desert' },
};

// 工具：按省市景点名查找
export function findSpot(provName, cityName, spotName) {
  const p = PROVINCES.find(x => x.n === provName);
  if (!p) return null;
  const c = p.cities.find(x => x.n === cityName);
  if (!c) return null;
  const s = c.spots.find(x => x.n === spotName);
  return s ? { prov: p, city: c, spot: s } : null;
}

// 统计
export function stats() {
  let cities = 0, spots = 0;
  for (const p of PROVINCES) { cities += p.cities.length; for (const c of p.cities) spots += c.spots.length; }
  return { provinces: PROVINCES.length, cities, spots };
}
