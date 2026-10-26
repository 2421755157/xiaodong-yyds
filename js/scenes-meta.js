// ═══ 3D 场景的「轻量层」：画质档位 + 时辰主题 + 场景映射 ═══
// 拆分原因：app.js 首屏只需要 PRO_SCENES / spotSeed / 时辰主题这些纯数据，
// 但原来它们和 buildScene 写在同一个模块里，而该模块顶层 import 了 three →
// 首屏被迫下载 257KB(gzip) 的 three.js 才能渲染卡片列表。
// 这里零依赖，可被首屏安全静态引入；three 相关的部分留在 scenes.js 按需加载。

// ─── 画质档位（由 app.js 按设备设定）───
export const Q = { level: 'high', shadows: true, grass: 2600, shadowMap: 2048, waterSeg: 48 };
export function setQuality(level) {
  Q.level = level;
  Q.shadows = level !== 'low';
  Q.shadowMap = level === 'high' ? 2048 : 1024;
  Q.grass = level === 'high' ? 2600 : (level === 'mid' ? 1200 : 0);
  Q.waterSeg = level === 'low' ? 24 : 48;
}


// ─── 时辰主题 ───
// sunDir 注意点：各场景玩家默认朝 -z（南）看，sun/moon 避免直接放正前方挡视野
export const THEMES = {
  dawn: {
    key: 'dawn', label: '晨', zenith: 0x4a6a82, horizon: 0xe0b084, fog: 0xd8bb9a, fogD: 0.0078,
    sunColor: 0xffd9a0, sunI: 1.5, hemiSky: 0xa8bcca, hemiGnd: 0x6a5f4a, hemiI: 0.75,
    ambI: 0.28, stars: 0.0, water: 0x51798a, sunDir: [0.7, 0.22, 0.55], moon: false, clouds: 7,
  },
  day: {
    key: 'day', label: '昼', zenith: 0x5d9bd4, horizon: 0xdcebf0, fog: 0xcfdde2, fogD: 0.0058,
    sunColor: 0xfff3dd, sunI: 2.0, hemiSky: 0xbdd4e2, hemiGnd: 0x7a7260, hemiI: 0.9,
    ambI: 0.35, stars: 0.0, water: 0x4f88a0, sunDir: [0.25, 0.92, 0.3], moon: false, clouds: 9,
  },
  dusk: {
    key: 'dusk', label: '暮', zenith: 0x2c2c54, horizon: 0xe8845e, fog: 0x8a6258, fogD: 0.0085,
    sunColor: 0xff9a5e, sunI: 1.2, hemiSky: 0x6a5a7a, hemiGnd: 0x4a3f38, hemiI: 0.6,
    ambI: 0.22, stars: 0.25, water: 0x3c4a62, sunDir: [-0.7, 0.18, -0.3], moon: false, clouds: 5,
  },
  night: {
    key: 'night', label: '夜', zenith: 0x05070f, horizon: 0x14202e, fog: 0x0c141c, fogD: 0.0098,
    sunColor: 0xcdd8ea, sunI: 0.55, hemiSky: 0x2a3a52, hemiGnd: 0x141210, hemiI: 0.45,
    ambI: 0.14, stars: 1.0, water: 0x12222e, sunDir: [0.35, 0.78, 0.45], moon: true, clouds: 3,
  },
};

export function resolveTheme(key) {
  if (key && key !== 'auto') return key;
  const h = new Date().getHours();
  if (h >= 5 && h < 10) return 'dawn';
  if (h >= 10 && h < 17) return 'day';
  if (h >= 17 && h < 19) return 'dusk';
  return 'night';
}
export const THEME_ORDER = ['dawn', 'day', 'dusk', 'night'];
export const themeLabel = k => THEMES[k].label;

// ─── 种子工具（原本在 scenes.js 内部，app.js 也要用）───
export function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
export function rng(seed) { let s = seed || 1; return () => (s = (s * 9301 + 49297) % 233280) / 233280; }

// 精游映射：city|spot → spotId（app.js 查）
export const PRO_SCENES = {
  '无锡|鼋头渚': 'yuantouzhu',
  '无锡|梅园': 'meiyuan',
  '无锡|三国水浒城': 'sanguo',
  '无锡|惠山古镇': 'huishan',
};

// 给 app.js 用的 seed 工具
export function spotSeed(name) { return hashStr(name); }
