// ═══ 3D 场景生成：鼋头渚 / 梅园 / 三国水浒城 / 惠山古镇 ═══
import * as THREE from 'three';
import {
  surfaceMat, finish, waterNormalTexture, grassBladeTexture,
  leafClumpTexture, roofTexture, wallTexture, woodTexture, buildingTexture, fbm, hash2,
} from './textures.js';

// ─── 画质档位（由 app.js 按设备设定）───
export const Q = { level: 'high', shadows: true, grass: 2600, shadowMap: 2048, waterSeg: 48 };
export function setQuality(level) {
  Q.level = level;
  Q.shadows = level !== 'low';
  Q.shadowMap = level === 'high' ? 2048 : 1024;
  Q.grass = level === 'high' ? 2600 : (level === 'mid' ? 1200 : 0);
  Q.waterSeg = level === 'low' ? 24 : 48;
}

export const SPOTS = [
  {
    id: 'yuantouzhu', name: '鼋头渚', tag: '太湖第一名胜', glyph: '鼋',
    desc: '樱花落尽的时候，太湖还是太湖。来湖边坐一会儿，让风把脑子吹空。',
    cover: 'linear-gradient(135deg,#2b4a5e 0%,#7a5a6e 55%,#d88ca0 100%)',
    long: '鼋头渚是横卧太湖西北岸的一个半岛，巨石突入湖中如神鼋翘首，故名。这里是观赏太湖烟波的绝佳处，郭沫若留过"太湖佳绝处，毕竟在鼋头"。园内有长春桥、十里芳径、广福古寺，三月樱花季落英如雪，十月芦花秋水长天。',
    meta: [['最佳时节', '3 月底樱花季 / 10 月芦花秋色'], ['门票参考', '85 元（含游船）'], ['关键词', '太湖 · 樱花 · 长春桥 · 落日'], ['心绪贴士', '适合放空、想通事、扔烦恼']],
    gallery: [
      ['https://upload.wikimedia.org/wikipedia/commons/thumb/6/61/Taihu_Yuantouzhu_%28North_Gate%29_%E5%A4%AA%E6%B9%96%E9%81%8A%E8%A6%A7%E8%88%B9_-_panoramio.jpg/960px-Taihu_Yuantouzhu_%28North_Gate%29_%E5%A4%AA%E6%B9%96%E9%81%8A%E8%A6%A7%E8%88%B9_-_panoramio.jpg', '樱花季 · 长春桥'],
      ['https://upload.wikimedia.org/wikipedia/commons/thumb/f/f7/Taihu_Yuantouzhu_%28North_Gate%29_%E5%A4%AA%E6%B9%96%E9%81%8A%E8%A6%A7%E8%88%B9_-_panoramio_%281%29.jpg/960px-Taihu_Yuantouzhu_%28North_Gate%29_%E5%A4%AA%E6%B9%96%E9%81%8A%E8%A6%A7%E8%88%B9_-_panoramio_%281%29.jpg', '太湖烟波'],
      ['https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ac/Wuxi_Taihu_lake_Changchun_bridge.jpg/960px-Wuxi_Taihu_lake_Changchun_bridge.jpg', '包孕吴越 · 落日'],
    ],
  },
  {
    id: 'meiyuan', name: '梅园', tag: '暗香浮动月黄昏', glyph: '梅',
    desc: '江南无所有，聊赠一枝春。山坡上走一走，沾一身香气再回去。',
    cover: 'linear-gradient(135deg,#3d2b33 0%,#8a4356 60%,#e8a0b4 100%)',
    long: '梅园始建于 1912 年，原是荣宗敬、荣德生兄弟的私家花园，背靠龙山、面朝太湖。园内植梅数千株，早春二月红白粉梅次第开，香雪海一般。念劬塔是园中制高点，登塔可览梅海全景；洗心泉、诵豳堂皆是清雅去处。',
    meta: [['最佳时节', '2 月中—3 月初梅花盛放'], ['门票参考', '60 元'], ['关键词', '梅花 · 念劬塔 · 香雪海'], ['心绪贴士', '适合沾点仙气、装文化人']],
    gallery: [
      ['https://upload.wikimedia.org/wikipedia/commons/thumb/3/31/Studying_House%2C_Wuxi_Plum_Garden_2.jpg/960px-Studying_House%2C_Wuxi_Plum_Garden_2.jpg', '红梅坡'],
      ['https://upload.wikimedia.org/wikipedia/commons/thumb/0/0a/Studying_House%2C_Wuxi_Plum_Garden.jpg/960px-Studying_House%2C_Wuxi_Plum_Garden.jpg', '香雪海'],
      ['https://upload.wikimedia.org/wikipedia/commons/7/7e/Meiyuan_Nianqu_Pagoda.jpg', '念劬塔'],
    ],
  },
  {
    id: 'sanguo', name: '三国水浒城', tag: '金戈铁马入梦来', glyph: '将',
    desc: '在这里谁都可以当一回主角。登上点将台，把烦心事挨个斩了。',
    cover: 'linear-gradient(135deg,#2e2620 0%,#6e4f2a 55%,#c9a86a 100%)',
    long: '中央电视台 1990 年代为拍《三国演义》《水浒传》而建的影视基地，依太湖而筑。三国城有吴王宫、点将台、水寨战船；水浒城有清明上河街、阳谷县、梁山泊。每日有"三英战吕布"实景演出，旌旗猎猎，鼓角争鸣。',
    meta: [['最佳时节', '四季皆可，秋日最爽'], ['门票参考', '三国城 70 元 / 联票 120 元'], ['关键词', '城门 · 点将台 · 战船 · 演出'], ['心绪贴士', '适合喊一嗓子、当一回主角']],
    gallery: [
      ['https://upload.wikimedia.org/wikipedia/commons/thumb/7/74/Wuxi%2C_China%2C_Three_Kingdom_City_Horse_Performance.jpg/960px-Wuxi%2C_China%2C_Three_Kingdom_City_Horse_Performance.jpg', '吴王宫 · 马术表演'],
      ['https://upload.wikimedia.org/wikipedia/commons/thumb/0/07/Wuxi%2C_Three_Kingdom_City_Horse_Performance_2.jpg/960px-Wuxi%2C_Three_Kingdom_City_Horse_Performance_2.jpg', '旌旗猎猎'],
      ['https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/%E7%84%A1%E9%8C%AB%E4%B8%89%E5%9C%8B%E5%BD%B1%E8%A6%96%E5%9F%8E_Wuxi_Three_Kingdoms_World_-_panoramio.jpg/960px-%E7%84%A1%E9%8C%AB%E4%B8%89%E5%9C%8B%E5%BD%B1%E8%A6%96%E5%9F%8E_Wuxi_Three_Kingdoms_World_-_panoramio.jpg', '三国城全景'],
    ],
  },
  {
    id: 'huishan', name: '惠山古镇', tag: '人间烟火最抚凡心', glyph: '镇',
    desc: '祠堂、泥人、一碗豆腐花。石板路慢慢走，走到哪算哪。',
    cover: 'linear-gradient(135deg,#22302b 0%,#4f6e60 55%,#8fb8a8 100%)',
    long: '惠山古镇依惠山东麓，龙头河蜿蜒其间，自南北朝起便是祠堂群集之地，现存 118 座古祠堂。寄畅园是江南名园，乾隆六下江南必至。泥人、豆腐花、二泉茶，老无锡的烟火气在这里原样保留。傍晚灯笼亮起，石板路映着暖光，最是抚凡人心。',
    meta: [['最佳时节', '四季皆宜，傍晚灯笼亮起最佳'], ['门票参考', '古镇免费 / 寄畅园 70 元'], ['关键词', '祠堂 · 龙头河 · 寄畅园 · 泥人'], ['心绪贴士', '适合慢慢走、吃碗豆腐花']],
    gallery: [
      ['https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Dongyue_Temple_in_Wuxi_Huishan_ancient_town_2.JPG/960px-Dongyue_Temple_in_Wuxi_Huishan_ancient_town_2.JPG', '祠堂 · 东岳庙'],
      ['https://upload.wikimedia.org/wikipedia/commons/thumb/8/80/Wuxi_Huishan_ancient_town%27s_past_and_present.jpg/960px-Wuxi_Huishan_ancient_town%27s_past_and_present.jpg', '古镇今昔'],
      ['https://upload.wikimedia.org/wikipedia/commons/thumb/2/2e/The_historical_photograph_about_Wuxi_Huishan_Ancient_Town.jpg/960px-The_historical_photograph_about_Wuxi_Huishan_Ancient_Town.jpg', '龙头河 · 老照片'],
    ],
  },
];

// ─── 时辰主题 ───
// sunDir 注意点：各场景玩家默认朝 -z（南）看，sun/moon 避免直接放正前方挡视野
const THEMES = {
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

// ─── 材质缓存 ───
const matCache = new Map();
function mat(color, opt = {}) {
  const key = color + JSON.stringify(opt);
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial(Object.assign({
      color, roughness: 0.92, metalness: 0.0, flatShading: true,
    }, opt)));
  }
  return matCache.get(key);
}

// ─── 带程序化纹理的材质（地表/建筑）───
const matTCache = new Map();
export function matT(kind, color, opt = {}) {
  const key = kind + '|' + color + '|' + (opt.repeat || 6) + '|' + (opt.roughness || 0.9) +
    '|' + (opt.flatShading ? 1 : 0) + '|' + (opt.seed || 0) + '|' + (opt.metalness || 0);
  if (!matTCache.has(key)) {
    matTCache.set(key, surfaceMat(kind, color, opt));
  }
  return matTCache.get(key);
}

// 当前主题（供窗户灯火等按时间调节）
let _theme = null;

// ─── 光晕贴图（共享）───
let glowTex = null;
function getGlowTex() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}
function makeGlowSprite(color, size, opacity = 0.8) {
  const m = new THREE.SpriteMaterial({
    map: getGlowTex(), color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const s = new THREE.Sprite(m);
  s.scale.set(size, size, 1);
  return s;
}

// ─── 天空：三段渐变 + 大气散射近似 + 太阳/月亮光晕 ───
function makeSky(theme) {
  const geo = new THREE.SphereGeometry(420, 48, 24);
  const mid = new THREE.Color(theme.zenith).lerp(new THREE.Color(theme.horizon), 0.42);
  const mtl = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(theme.zenith) },
      mid: { value: mid },
      bottom: { value: new THREE.Color(theme.horizon) },
      fogColor: { value: new THREE.Color(theme.fog) },
      sunDir: { value: new THREE.Vector3(...theme.sunDir).normalize() },
      sunColor: { value: new THREE.Color(theme.sunColor) },
      sunI: { value: theme.moon ? 0.55 : (theme.key === 'dusk' ? 1.5 : 1.15) },
    },
    vertexShader:
      'varying vec3 vP;' +
      'void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader:
      'uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; uniform vec3 fogColor;' +
      'uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunI;' +
      'varying vec3 vP;' +
      'void main(){' +
      '  vec3 d = normalize(vP);' +
      '  float h = d.y;' +
      // 三段渐变：地平线 → 中层 → 天顶
      '  vec3 col = mix(bottom, mid, smoothstep(-0.06, 0.16, h));' +
      '  col = mix(col, top, smoothstep(0.12, 0.66, h));' +
      // 大气散射：地平线附近增亮 + 太阳侧偏暖
      '  float sd = max(dot(d, normalize(sunDir)), 0.0);' +
      '  float horizonBand = exp(-abs(h) * 14.0);' +
      '  col += sunColor * horizonBand * sd * 0.16 * sunI;' +
      // 日轮 + 内晕 + 外晕
      '  float disk = pow(sd, 900.0) * 3.0;' +
      '  float g1 = pow(sd, 180.0) * 0.9;' +
      '  float g2 = pow(sd, 14.0) * 0.30;' +
      '  float g3 = pow(sd, 3.5) * 0.09;' +
      '  col += sunColor * (disk + g1 + g2 + g3) * sunI;' +
      // 地平线以下融入雾色，消除生硬边界
      '  col = mix(fogColor, col, smoothstep(-0.28, 0.015, h));' +
      '  gl_FragColor = vec4(col, 1.0);' +
      '}',
  });
  const m = new THREE.Mesh(geo, mtl);
  m.userData.noShadow = true;
  return m;
}

function makeStars(count) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const e = Math.random() * Math.PI * 0.48 + 0.05;
    const r = 390;
    pos[i * 3] = Math.cos(a) * Math.cos(e) * r;
    pos[i * 3 + 1] = Math.sin(e) * r;
    pos[i * 3 + 2] = Math.sin(a) * Math.cos(e) * r;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({
    color: 0xe8ecff, size: 1.6, sizeAttenuation: false,
    transparent: true, opacity: 0.9, fog: false, depthWrite: false,
  });
  return new THREE.Points(g, m);
}

function makeSunMoon(theme) {
  const grp = new THREE.Group();
  const d = new THREE.Vector3(...theme.sunDir).normalize().multiplyScalar(450);
  if (theme.moon) {
    const moon = new THREE.Mesh(
      new THREE.CircleGeometry(12, 32),
      new THREE.MeshBasicMaterial({ color: 0xe8eef8, fog: false })
    );
    moon.position.copy(d); moon.lookAt(0, 0, 0);
    const halo = makeGlowSprite(0xaec4e8, 50, 0.45);
    halo.position.copy(d);
    grp.add(moon, halo);
  } else {
    const sun = new THREE.Mesh(
      new THREE.CircleGeometry(16, 32),
      new THREE.MeshBasicMaterial({ color: theme.sunColor, fog: false })
    );
    sun.position.copy(d); sun.lookAt(0, 0, 0);
    const halo = makeGlowSprite(theme.sunColor, 65, 0.45);
    halo.position.copy(d);
    grp.add(sun, halo);
  }
  return grp;
}

// ─── 云层（高空半透明白色 sprite 飘动）───
let cloudTex = null;
function getCloudTex() {
  if (cloudTex) return cloudTex;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  for (let i = 0; i < 7; i++) {
    const x = 40 + Math.random() * 176, y = 60 + Math.random() * 136;
    const r = 30 + Math.random() * 50;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.4)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  }
  cloudTex = new THREE.CanvasTexture(c);
  return cloudTex;
}
function makeClouds(count, theme, animators) {
  const grp = new THREE.Group();
  const color = theme.moon ? 0xaec4e8 : (theme.key === 'dusk' ? 0xffd0a8 : 0xffffff);
  const opacity = theme.moon ? 0.18 : (theme.key === 'dusk' ? 0.55 : 0.7);
  const data = [];
  for (let i = 0; i < count; i++) {
    const m = new THREE.SpriteMaterial({
      map: getCloudTex(), color, transparent: true, opacity,
      depthWrite: false, fog: false,
    });
    const s = new THREE.Sprite(m);
    const sc = 60 + Math.random() * 70;
    s.scale.set(sc, sc * 0.5, 1);
    const a = Math.random() * Math.PI * 2;
    const r = 80 + Math.random() * 220;
    s.position.set(Math.cos(a) * r, 90 + Math.random() * 60, Math.sin(a) * r);
    data.push({ s, vx: 0.6 + Math.random() * 1.0 });
    grp.add(s);
  }
  animators.push((dt) => {
    for (const d of data) {
      d.s.position.x += d.vx * dt;
      if (d.s.position.x > 320) d.s.position.x = -320;
    }
  });
  return grp;
}

// ─── 顶点扰动：把规整几何体揉成自然形状 ───
function jitter(geo, amt, seed = 1) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n1 = (hash2((x * 97) | 0, (y * 89) | 0, seed) - 0.5) * amt;
    const n2 = (hash2((z * 83) | 0, (x * 71) | 0, seed + 7) - 0.5) * amt;
    const n3 = (hash2((y * 67) | 0, (z * 59) | 0, seed + 13) - 0.5) * amt;
    p.setXYZ(i, x * (1 + n1), y * (1 + n2 * 0.55), z * (1 + n3));
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// ─── 远景山（不规则山体，不再是标准圆锥）───
function mountainRing(scene, color, count, rMin, rMax, hMin, hMax) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
    const r = rMin + Math.random() * (rMax - rMin);
    const h = hMin + Math.random() * (hMax - hMin);
    const w = 30 + Math.random() * 50;
    const geo = new THREE.ConeGeometry(w, h, 6, 3);
    jitter(geo, 0.2, i + 3);
    // 远山略微褪色，模拟空气透视
    const c = new THREE.Color(color).lerp(new THREE.Color(0x9fb0bb), Math.min(0.42, r / 900));
    const m = new THREE.Mesh(geo, mat(c.getHex(), { flatShading: true }));
    m.position.set(Math.cos(a) * r, h * 0.30, Math.sin(a) * r);
    m.rotation.y = Math.random() * Math.PI;
    m.scale.set(1 + Math.random() * 0.45, 1, 0.65 + Math.random() * 0.6);
    m.userData.far = true;
    scene.add(m);
  }
}

// ─── 水面：顶点波动 + 滚动法线 + 菲涅尔反射 ───
let _wn = null;
function waterNormal(repeat) {
  if (!_wn) _wn = finish(waterNormalTexture(256), repeat, false);
  return _wn;
}
function makeWater(size, seg, color, animators) {
  const s = Q.waterSeg;
  const geo = new THREE.PlaneGeometry(size, size, s, s);
  geo.rotateX(-Math.PI / 2);
  const nrm = waterNormal(Math.max(6, Math.round(size / 42)));
  const mtl = new THREE.MeshStandardMaterial({
    color, roughness: 0.055, metalness: 0.86, transparent: true, opacity: 0.93,
    normalMap: nrm, envMapIntensity: 2.0,
  });
  mtl.normalScale.set(0.42, 0.42);
  const mesh = new THREE.Mesh(geo, mtl);
  mesh.userData.noShadow = true;
  mesh.receiveShadow = false;
  const pos = geo.attributes.position;
  const base = pos.array.slice();
  let acc = 0;
  animators.push((dt, t) => {
    nrm.offset.x = (t * 0.013) % 1;
    nrm.offset.y = (t * 0.0085) % 1;
    acc += dt;
    if (acc < 1 / 30) return;   // 顶点波动 30fps 更新即可，省 CPU
    acc = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3], z = base[i * 3 + 2];
      pos.array[i * 3 + 1] =
        Math.sin(x * 0.16 + t * 1.05) * 0.16 +
        Math.cos(z * 0.13 + t * 0.78) * 0.16 +
        Math.sin((x + z) * 0.07 + t * 0.5) * 0.1;
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  });
  return mesh;
}

// ─── 树（不规则树冠 + 弯曲树干 + 风摆）───
function makeTree(x, z, y, opt = {}) {
  const { trunkH = 2.4, crownR = 1.9, crownColor = 0x5a7a4a, trunkColor = 0x4a3826, animators = null } = opt;
  const g = new THREE.Group();
  const tg = new THREE.CylinderGeometry(0.15, 0.28, trunkH, 6, 3);
  jitter(tg, 0.1, (x * 13 + z * 7) | 0);
  const trunk = new THREE.Mesh(tg, mat(trunkColor, { flatShading: true }));
  trunk.position.y = trunkH / 2;

  const leafMat = mat(crownColor, { flatShading: true, roughness: 0.95 });
  const mkCrown = (r, ox, oy, oz, sd) => {
    const cg = new THREE.IcosahedronGeometry(r, 1);
    jitter(cg, 0.26, sd);
    const m = new THREE.Mesh(cg, leafMat);
    m.position.set(ox, oy, oz);
    m.scale.y = 0.86;
    return m;
  };
  const c1 = mkCrown(crownR, 0, trunkH + crownR * 0.5, 0, (x * 31 + z * 3) | 0);
  const c2 = mkCrown(crownR * 0.66, crownR * 0.52, trunkH + crownR * 1.0, crownR * 0.18, (x * 17 + z * 11 + 5) | 0);
  const c3 = mkCrown(crownR * 0.5, -crownR * 0.48, trunkH + crownR * 0.86, -crownR * 0.3, (x * 23 + z * 19 + 9) | 0);
  // 低垂枝：贴近地面的小叶团，遮住树干根部
  const c4 = mkCrown(crownR * 0.38, crownR * 0.2, trunkH * 0.55, crownR * 0.62, (x * 41 + z * 29 + 3) | 0);
  g.add(trunk, c1, c2, c3, c4);
  g.position.set(x, y, z);
  g.rotation.y = Math.random() * Math.PI * 2;
  const s = 0.8 + Math.random() * 0.5;
  g.scale.setScalar(s);
  const ph = Math.random() * Math.PI * 2;
  const amp = 0.012 + Math.random() * 0.014;
  const sway = (dt, t) => {
    g.rotation.z = Math.sin(t * 0.9 + ph) * amp;
    g.rotation.x = Math.cos(t * 0.7 + ph * 1.3) * amp * 0.7;
  };
  if (animators) animators.push(sway); else _swayers.push(sway);
  return g;
}
// 未显式传 animators 的树，统一在 buildScene 收尾时挂上风摆
const _swayers = [];

// ─── 草丛（InstancedMesh 交叉面片）───
let _grassGeo = null, _grassTex = null;
function makeGrassField(cx, cz, radius, count, groundH, animators, tint = 0xa8c070) {
  const n = Math.min(count, Q.grass);
  if (!n) return null;
  if (!_grassGeo) {
    _grassGeo = new THREE.PlaneGeometry(1, 1);
    _grassGeo.translate(0, 0.5, 0);
    _grassTex = finish(grassBladeTexture(64), 1, true);
  }
  const mtl = new THREE.MeshStandardMaterial({
    map: _grassTex, transparent: true, alphaTest: 0.42, side: THREE.DoubleSide,
    roughness: 0.96, metalness: 0, color: tint,
  });
  const inst = new THREE.InstancedMesh(_grassGeo, mtl, n * 2);
  const dummy = new THREE.Object3D();
  let k = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    const y = groundH ? groundH(x, z) : 0;
    const sc = 0.55 + Math.random() * 0.75;
    for (const rot of [Math.random() * Math.PI, Math.random() * Math.PI + Math.PI / 2]) {
      dummy.position.set(x, y - 0.05, z);
      dummy.rotation.set(0, rot, 0);
      dummy.scale.set(sc * (0.8 + Math.random() * 0.5), sc * (0.7 + Math.random() * 0.8), sc);
      dummy.updateMatrix();
      inst.setMatrixAt(k++, dummy.matrix);
    }
  }
  inst.count = k;
  inst.instanceMatrix.needsUpdate = true;
  inst.userData.noShadow = true;
  inst.castShadow = false;
  inst.receiveShadow = false;
  return inst;
}

// ─── 飘落花瓣粒子 ───
function makePetals(count, cx, cz, radius, color, animators, yTop = 12) {
  const pos = new Float32Array(count * 3);
  const meta = [];
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * radius;
    pos[i * 3] = cx + Math.cos(a) * r;
    pos[i * 3 + 1] = Math.random() * yTop;
    pos[i * 3 + 2] = cz + Math.sin(a) * r;
    meta.push({ v: 0.35 + Math.random() * 0.5, ph: Math.random() * Math.PI * 2 });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({
    color, size: 0.32, transparent: true, opacity: 0.9,
    depthWrite: false,
  });
  const pts = new THREE.Points(g, m);
  animators.push((dt, t) => {
    for (let i = 0; i < count; i++) {
      let y = pos[i * 3 + 1] - meta[i].v * dt;
      if (y < 0) y = yTop;
      pos[i * 3 + 1] = y;
      pos[i * 3] += Math.sin(t * 0.9 + meta[i].ph) * dt * 0.5;
    }
    g.attributes.position.needsUpdate = true;
  });
  return pts;
}

// ─── 飘动旗帜 ───
function makeFlag(color, animators, w = 3.2, h = 1.7) {
  const grp = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 6.4, 6), mat(0x3a3228));
  pole.position.y = 3.2;
  grp.add(pole);
  const geo = new THREE.PlaneGeometry(w, h, 10, 4);
  geo.translate(w / 2, 0, 0);
  const flag = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color, side: THREE.DoubleSide, roughness: 0.85, flatShading: false,
  }));
  flag.position.set(0.08, 5.4, 0);
  grp.add(flag);
  const pos = geo.attributes.position;
  const base = pos.array.slice();
  animators.push((dt, t) => {
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3], y = base[i * 3 + 1];
      const k = x / w;
      pos.array[i * 3 + 2] = Math.sin(x * 1.8 + t * 4.2) * 0.3 * k + Math.sin(y * 2.0 + t * 3.0) * 0.1 * k;
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  });
  return grp;
}

// ─── 灯笼 ───
function makeLantern(x, y, z, color = 0xd84a3a) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.34, 10, 8),
    mat(color, { emissive: color, emissiveIntensity: 0.9, flatShading: false })
  );
  body.scale.y = 0.85;
  const glow = makeGlowSprite(0xff8a5e, 2.2, 0.6);
  g.add(body, glow);
  g.position.set(x, y, z);
  return g;
}

// ─── 双坡屋顶民居（斑驳白墙 + 黛瓦 + 透窗灯火）───
let _roofTex = null, _winMat = null;
function tileRoofMat(color) {
  if (!_roofTex) _roofTex = finish(roofTexture(), 4, true);
  const key = 'roofM' + color;
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({
      color, map: _roofTex, roughness: 0.8, metalness: 0.06, flatShading: false,
    }));
  }
  return matCache.get(key);
}
// 窗户：夜里透出暖光，白天是暗玻璃
function windowMat() {
  if (!_winMat) {
    const dark = _theme ? (_theme.key === 'night' ? 1 : (_theme.key === 'dusk' ? 0.62 : (_theme.key === 'dawn' ? 0.35 : 0.04))) : 1;
    _winMat = new THREE.MeshStandardMaterial({
      color: 0x3a3226, emissive: 0xffb45e, emissiveIntensity: 2.6 * dark,
      roughness: 0.35, metalness: 0.1,
    });
  }
  return _winMat;
}
function makeHouse(w, h, d, wallColor, roofColor) {
  const g = new THREE.Group();
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    matT('wall', wallColor, { repeat: Math.max(2, Math.round(w / 3)), roughness: 0.9, flatShading: false })
  );
  wall.position.y = h / 2;
  g.add(wall);

  // 双坡屋顶 + 屋脊 + 出檐
  const roofR = Math.hypot(w, d) * 0.64;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(roofR, h * 0.55, 4), tileRoofMat(roofColor));
  roof.position.y = h + h * 0.26;
  roof.rotation.y = Math.PI / 4;
  roof.scale.set(1, 1, d / w);
  g.add(roof);
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(roofR * 1.02, 0.14, 0.16), mat(0x2a2a2e));
  ridge.position.y = h + h * 0.53;
  g.add(ridge);
  const eave = new THREE.Mesh(new THREE.BoxGeometry(w * 1.12, 0.12, d * 1.12), tileRoofMat(roofColor));
  eave.position.y = h + 0.04;
  g.add(eave);

  // 木门 + 门框
  const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(1.25, 2.05, 0.08), matT('wood', 0x4a3626, { repeat: 1, roughness: 0.85, flatShading: false }));
  doorFrame.position.set(0, 1.02, d / 2 + 0.02);
  g.add(doorFrame);
  const door = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 1.75), matT('wood', 0x2f2018, { repeat: 1, roughness: 0.8, flatShading: false }));
  door.position.set(0, 0.95, d / 2 + 0.07);
  g.add(door);

  // 窗（正面两扇 + 侧面各一）
  const winW = Math.min(0.78, w * 0.2), winH = winW * 1.1;
  const wm = windowMat();
  const addWin = (x, y, z, ry) => {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(winW, winH), wm);
    win.position.set(x, y, z); win.rotation.y = ry;
    g.add(win);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(winW * 1.18, winH * 1.18, 0.05), mat(0x33291f));
    bar.position.set(x, y, z - 0.02 * (ry ? 1 : 1));
    bar.rotation.y = ry;
    g.add(bar);
  };
  const wy = h * 0.58;
  addWin(-w * 0.26, wy, d / 2 + 0.03, 0);
  addWin(w * 0.26, wy, d / 2 + 0.03, 0);
  addWin(w / 2 + 0.03, wy, -d * 0.15, Math.PI / 2);
  addWin(-w / 2 - 0.03, wy, d * 0.15, -Math.PI / 2);
  return g;
}

// ─── 亭 ───
function makePavilion(color = 0x5a3a2a, roofColor = 0x3a3230) {
  const g = new THREE.Group();
  for (const [dx, dz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.6, 6), mat(color));
    p.position.set(dx, 1.3, dz);
    g.add(p);
  }
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.2, 0.3, 8), mat(0x8a8578));
  floor.position.y = 0.15;
  g.add(floor);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.9, 1.5, 6), mat(roofColor));
  roof.position.y = 3.3;
  g.add(roof);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.18, 6, 6), mat(0xc9a86a, { emissive: 0xc9a86a, emissiveIntensity: 0.4 }));
  tip.position.y = 4.15;
  g.add(tip);
  return g;
}

// ─── 石灯笼 ───
function makeStoneLantern() {
  const g = new THREE.Group();
  const m = mat(0x9a958a);
  const b1 = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 0.3, 6), m); b1.position.y = 0.15;
  const b2 = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 1.1, 6), m); b2.position.y = 0.85;
  const b3 = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.7), m); b3.position.y = 1.65;
  const fire = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 6),
    mat(0xffc06a, { emissive: 0xffa04a, emissiveIntensity: 1.4 }));
  fire.position.y = 1.65;
  const b4 = new THREE.Mesh(new THREE.ConeGeometry(0.62, 0.45, 6), m); b4.position.y = 2.1;
  g.add(b1, b2, b3, fire, b4, makeGlowSprite(0xffa04a, 1.8, 0.5));
  g.children[5].position.y = 1.65;
  return g;
}

// ═════════ 场景总装 ═════════
// sceneKey: 精游 spotId（yuantouzhu/meiyuan/sanguo/huishan）或类型（mountain/water/town/garden/coast/city/snow/desert/temple/park/ruin/island/forest/modern）
// seed: 景点名 hash，让类型模板有差异
export function buildScene(sceneKey, themeKey, renderer, seed = 0) {
  const theme = THEMES[themeKey];
  _theme = theme;
  _winMat = null;              // 主题变了，窗户亮度重算
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(theme.fog, theme.fogD);
  const animators = [];

  // 光照（含实时阴影）
  const hemi = new THREE.HemisphereLight(theme.hemiSky, theme.hemiGnd, theme.hemiI);
  scene.add(hemi);
  const amb = new THREE.AmbientLight(0xffffff, theme.ambI);
  scene.add(amb);
  const sun = new THREE.DirectionalLight(theme.sunColor, theme.sunI);
  sun.position.set(theme.sunDir[0] * 100, theme.sunDir[1] * 100 + 40, theme.sunDir[2] * 100);
  if (Q.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
    const c = sun.shadow.camera;
    c.left = -95; c.right = 95; c.top = 95; c.bottom = -95;
    c.near = 1; c.far = 420;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.035;
    sun.shadow.radius = 2.5;
  }
  scene.add(sun);
  scene.add(sun.target);
  // 反向补光：避免背光面死黑，模拟天空漫射
  const fill = new THREE.DirectionalLight(theme.hemiSky, theme.sunI * 0.22);
  fill.position.set(-theme.sunDir[0] * 60, 40, -theme.sunDir[2] * 60);
  scene.add(fill);

  // 天空 / 日月 / 星 / 云
  scene.add(makeSky(theme));
  // 环境贴图：PMREM 从天空生成，给水面/金属反射
  if (renderer) {
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      const envScene = new THREE.Scene();
      envScene.add(makeSky(theme));
      const envRT = pmrem.fromScene(envScene, 0, 0.1, 1000);
      scene.environment = envRT.texture;
      pmrem.dispose();
    } catch (e) { /* 老设备降级 */ }
  }
  scene.add(makeSunMoon(theme));
  scene.add(makeClouds(theme.clouds, theme, animators));
  if (theme.stars > 0) {
    const stars = makeStars(900);
    stars.material.opacity = theme.stars;
    scene.add(stars);
  }

  // 分发：精游 4 个专属 / 其余按类型模板
  const PRO = { yuantouzhu: 1, meiyuan: 1, sanguo: 1, huishan: 1 };
  let builder;
  if (PRO[sceneKey]) builder = { yuantouzhu, meiyuan, sanguo, huishan }[sceneKey];
  else builder = TYPE_BUILDERS[sceneKey] || TYPE_BUILDERS.mountain;
  const built = builder(scene, theme, animators, seed);

  // 树的风摆统一挂载
  for (const f of _swayers) animators.push(f);
  _swayers.length = 0;

  // 草丛（由各模板声明）
  if (built.grass && Q.grass) {
    const gcfg = built.grass;
    const gf = makeGrassField(
      gcfg.x || 0, gcfg.z || 0, gcfg.r || 50, gcfg.n || Q.grass,
      built.groundHeight, animators, gcfg.tint
    );
    if (gf) scene.add(gf);
  }

  // 阴影：让所有实体网格投影/接收阴影（天空、水面、粒子除外）
  if (Q.shadows) {
    scene.traverse(o => {
      if (!o.isMesh || o.userData.noShadow) return;
      o.castShadow = !o.userData.far && !o.userData.ground;
      o.receiveShadow = true;
    });
  }

  // 热点可视化：六边形光圈 + 上升光点
  for (const h of built.hotspots) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1.05, 6),
      new THREE.MeshBasicMaterial({ color: 0xd3b98a, transparent: true, opacity: 0.75, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(h.pos[0], (built.groundHeight ? built.groundHeight(h.pos[0], h.pos[2]) : 0) + 0.06, h.pos[2]);
    scene.add(ring);
    const glow = makeGlowSprite(0xd3b98a, 2.6, 0.45);
    glow.position.set(h.pos[0], ring.position.y + 1.2, h.pos[2]);
    scene.add(glow);
    const ph = Math.random() * Math.PI * 2;
    animators.push((dt, t) => {
      ring.rotation.z = t * 0.5 + ph;
      const k = 1 + Math.sin(t * 2 + ph) * 0.12;
      ring.scale.setScalar(k);
      glow.position.y = ring.position.y + 1.2 + Math.sin(t * 1.6 + ph) * 0.25;
    });
  }

  return {
    scene, theme,
    hotspots: built.hotspots,
    spawn: built.spawn,
    boundR: built.boundR,
    colliders: built.colliders || [],
    groundHeight: built.groundHeight || (() => 0),
    update(dt, t) { for (const a of animators) a(dt, t); },
  };
}

// ═════════ ① 鼋头渚 ═════════
function yuantouzhu(scene, theme, animators) {
  // 太湖
  const water = makeWater(560, 42, theme.water, animators);
  water.position.set(0, -0.5, -60);
  scene.add(water);

  // 半岛（草地 + 微起伏）
  const islGeo = new THREE.CylinderGeometry(58, 62, 1.6, 48, 3);
  const ip = islGeo.attributes.position;
  for (let i = 0; i < ip.count; i++) {
    const x = ip.getX(i), y = ip.getY(i), z = ip.getZ(i);
    if (y > 0.5) {
      const n = (fbm(x * 0.06 + 4, z * 0.06 + 2, 9, 3, 32) - 0.5) * 1.5;
      ip.setY(i, y + n);
    }
  }
  islGeo.computeVertexNormals();
  const island = new THREE.Mesh(islGeo, matT('grass', 0x5a7a4a, { repeat: 18, roughness: 0.96, flatShading: false }));
  island.position.set(0, -0.8, 14);
  island.userData.ground = true;
  scene.add(island);
  // 石滩圈
  const beach = new THREE.Mesh(new THREE.TorusGeometry(59.5, 1.4, 6, 44), matT('stone', 0x8a8578, { repeat: 20, roughness: 0.94, flatShading: false }));
  beach.rotation.x = Math.PI / 2;
  beach.position.set(0, -0.25, 14);
  scene.add(beach);

  // 远山：三山岛剪影（不规则轮廓）
  for (const [x, z, w, h] of [[-120, -260, 90, 26], [10, -290, 130, 34], [140, -250, 80, 22]]) {
    const g2 = new THREE.ConeGeometry(w, h, 6, 3);
    jitter(g2, 0.2, (x + z) | 0);
    const m = new THREE.Mesh(g2, mat(0x3a4a4e, { flatShading: true }));
    m.position.set(x, h * 0.28 - 1, z);
    m.userData.far = true;
    scene.add(m);
  }
  mountainRing(scene, 0x46545a, 7, 200, 320, 18, 44);

  // 樱花树（粉白）沿岛弧，避开正前方 a=π/2 ±0.18 通道，让玩家朝 -z 视野开阔
  const sakuraColors = [0xe8a8bc, 0xf0c0cc, 0xf5d5da, 0xe89ab4];
  const treeA = [];
  for (let i = 0; i < 14; i++) {
    const a = Math.PI * 0.12 + (i / 14) * Math.PI * 1.76;
    if (Math.abs(a - Math.PI / 2) < 0.22) continue; // 避开正前通道
    treeA.push(a);
  }
  for (const a of treeA) {
    const r = 26 + Math.random() * 12;
    const x = Math.cos(a) * r, z = 14 + Math.sin(a) * r * 0.85;
    scene.add(makeTree(x, z, 0, {
      crownColor: sakuraColors[Math.floor(Math.random() * sakuraColors.length)],
      trunkH: 2.6, crownR: 2.0, trunkColor: 0x4a3228,
    }));
  }
  // 花瓣雨
  scene.add(makePetals(240, 0, 4, 48, 0xf5c8d4, animators, 13));

  // 石灯塔（长春桥畔）
  const lantern = makeStoneLantern();
  lantern.position.set(-14, 0, -18);
  scene.add(lantern);

  // 长春桥：真正的拱桥（半圆环 + 桥面 + 栏杆）
  const bridgeMat = mat(0x9a958a);
  const archBridge = new THREE.Group();
  const archRing = new THREE.Mesh(
    new THREE.TorusGeometry(2.8, 0.45, 8, 16, Math.PI),
    bridgeMat
  );
  archRing.rotation.z = Math.PI;
  archRing.position.y = 0.2;
  archBridge.add(archRing);
  // 桥面（弧形台阶）
  for (let i = 0; i < 9; i++) {
    const a = (i / 8) * Math.PI;
    const step = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.22, 1.1), bridgeMat);
    step.position.set(0, Math.sin(a) * 2.6 + 0.3, (i - 4) * 1.1);
    archBridge.add(step);
  }
  // 桥栏杆
  for (let i = 0; i < 7; i++) {
    const a = ((i + 1) / 8) * Math.PI;
    for (const sx of [-1.5, 1.5]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.9, 5), bridgeMat);
      post.position.set(sx, Math.sin(a) * 2.6 + 0.8, (i - 3) * 1.1);
      archBridge.add(post);
    }
  }
  archBridge.position.set(20, 0, -24);
  archBridge.rotation.y = Math.PI / 2;
  scene.add(archBridge);

  // 鼋头石：岛尖标志性巨石（形如神鼋翘首）
  const turtleRock = new THREE.Group();
  const rockMat = matT('rock', 0x6a6a5e, { repeat: 3, roughness: 0.95, flatShading: true });
  const bg = new THREE.DodecahedronGeometry(2.8, 1); jitter(bg, 0.2, 61);
  const rockBody = new THREE.Mesh(bg, rockMat);
  rockBody.scale.set(1.4, 0.8, 1.0);
  rockBody.position.y = 1.2;
  const hg = new THREE.DodecahedronGeometry(1.4, 1); jitter(hg, 0.22, 67);
  const rockHead = new THREE.Mesh(hg, rockMat);
  rockHead.position.set(0, 2.6, -2.2);
  rockHead.scale.set(0.9, 0.7, 1.3);
  turtleRock.add(rockBody, rockHead);
  turtleRock.position.set(0, 0, -46);
  scene.add(turtleRock);

  // "包孕吴越"石刻
  const stele = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3.0, 0.5), matT('stone', 0x7a756a, { repeat: 1, roughness: 0.9, flatShading: false }));
  stele.position.set(6, 1.5, -38);
  stele.rotation.y = -0.2;
  scene.add(stele);

  // 石栏沿岛南岸
  for (let i = 0; i < 16; i++) {
    const a = Math.PI * 1.05 + (i / 16) * Math.PI * 0.9;
    const x = Math.cos(a) * 55, z = 14 + Math.sin(a) * 55;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.0, 5), matT('stone', 0x8a8578, { repeat: 1, roughness: 0.9 }));
    post.position.set(x, 0.5, z);
    scene.add(post);
  }

  // 湖面月光/日光碎金（光带 sprite 一排）
  for (let i = 0; i < 8; i++) {
    const s = makeGlowSprite(theme.moon ? 0xaec4e8 : 0xffe0a8, 10 + Math.random() * 14, 0.14);
    s.position.set(theme.sunDir[0] * 120 + (Math.random() - 0.5) * 40, 0.4, -70 - Math.random() * 90);
    scene.add(s);
  }

  return {
    spawn: { pos: [0, 0, 52], yaw: Math.PI },
    boundR: 56,
    grass: { x: 0, z: 14, r: 50, n: Q.grass, tint: 0x9ab86a },
    groundHeight: (x, z) => {
      const d = Math.hypot(x, z - 14);
      return d < 56 ? 0 : -0.4;
    },
    colliders: [
      { x: -14, z: -18, r: 0.9 },          // 石灯塔
      { x: 6, z: -38, w: 2.6, d: 1.0 },     // 包孕吴越石刻
      { x: 20, z: -24, w: 4.0, d: 10.0 },   // 长春桥（拱桥）
      { x: 0, z: -46, r: 3.2 },             // 鼋头石
    ],
    hotspots: [
      { pos: [0, 0, -38], name: '岛尖 · 包孕吴越', desc: '太湖就在眼前，烦心事也是——看着它，然后扔进去。' },
      { pos: [-14, 0, -19.5], name: '长春桥畔石灯塔', desc: '灯亮着，就总有一条路是通的。' },
      { pos: [10, 0, 8], name: '樱花林下', desc: '花瓣落得慢，刚好够想明白一件事。' },
      { pos: [21, 0, -21], name: '长春桥头', desc: '桥不长，走过去就是另一头了。' },
      { pos: [-30, 0, 22], name: '西岸听涛处', desc: '什么都不做，只听水。' },
    ],
  };
}

// ═════════ ② 梅园 ═════════
function meiyuan(scene, theme, animators) {
  const groundH = (x, z) => {
    let y = Math.sin(x * 0.05) * 1.2 + Math.cos(z * 0.045) * 1.4;
    y += (fbm(x * 0.04 + 2, z * 0.04 + 6, 5, 3, 32) - 0.5) * 2.2;  // 自然起伏
    y += Math.max(0, (-z - 10) * 0.05); // 向北渐高
    return y;
  };

  // 起伏地面（顶点色：草坡 → 高处裸土）
  const geo = new THREE.PlaneGeometry(220, 220, 56, 56);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const col = [];
  const cLo = new THREE.Color(0x46683a), cHi = new THREE.Color(0x6a6248);
  const tmp = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.array[i * 3], z = p.array[i * 3 + 2];
    const y = groundH(x, z);
    p.array[i * 3 + 1] = y;
    const k = Math.min(1, Math.max(0, (y + 0.6) / 3.4));
    const patch = fbm(x * 0.1, z * 0.1, 19, 3, 32);
    tmp.copy(cLo).lerp(cHi, k * (0.4 + patch * 0.7));
    const s = 0.9 + patch * 0.22;
    col.push(tmp.r * s, tmp.g * s, tmp.b * s);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const gMat = matT('grass', 0xffffff, { repeat: 30, roughness: 0.96, flatShading: false });
  gMat.vertexColors = true;
  const ground = new THREE.Mesh(geo, gMat);
  ground.userData.ground = true;
  scene.add(ground);

  mountainRing(scene, 0x3f4f42, 8, 150, 260, 20, 50);

  // 梅林：红、粉、白分区
  const zones = [
    { cx: -22, cz: -10, colors: [0xc94a5a, 0xd85a6a], n: 8 },
    { cx: 18, cz: -24, colors: [0xf0e8e2, 0xf5f0ea], n: 7 },
    { cx: 2, cz: 16, colors: [0xe89ab4, 0xf0b8c4], n: 8 },
  ];
  for (const z of zones) {
    for (let i = 0; i < z.n; i++) {
      const x = z.cx + (Math.random() - 0.5) * 22;
      const zz = z.cz + (Math.random() - 0.5) * 20;
      scene.add(makeTree(x, zz, groundH(x, zz), {
        crownColor: z.colors[i % z.colors.length],
        trunkH: 2.2, crownR: 1.7, trunkColor: 0x3f2e22,
      }));
    }
  }
  scene.add(makePetals(200, 0, 0, 55, 0xe8b0c0, animators, 12));

  // 荣氏梅园牌坊（入口标志）
  const paifang = new THREE.Group();
  const pfMat = mat(0x7a6a5a);
  // 四柱
  for (const px of [-3.2, -1.1, 1.1, 3.2]) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 5.2, 6), pfMat);
    col.position.set(px, 2.6, 0);
    paifang.add(col);
  }
  // 三道横梁
  for (const [y, w] of [[4.8, 7.4], [3.8, 5.0], [5.4, 7.8]]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(w, 0.35, 0.5), pfMat);
    beam.position.set(0, y, 0);
    paifang.add(beam);
  }
  // 顶部小檐
  const pfRoof = new THREE.Mesh(new THREE.BoxGeometry(8.2, 0.25, 1.2), mat(0x3a3230));
  pfRoof.position.set(0, 5.7, 0);
  paifang.add(pfRoof);
  const pfRidge = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 8.4, 6), mat(0x4a4038));
  pfRidge.rotation.z = Math.PI / 2;
  pfRidge.position.set(0, 5.9, 0);
  paifang.add(pfRidge);
  paifang.position.set(0, groundH(0, 32), 32);
  scene.add(paifang);

  // 石板小径：蜿蜒到坡上
  const pathMat = mat(0x9a958a, { flatShading: false });
  for (let i = 0; i < 26; i++) {
    const t = i / 25;
    const x = Math.sin(t * Math.PI * 2.2) * 9;
    const z = 34 - t * 72;
    const stone = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.14, 1.1), pathMat);
    stone.position.set(x, groundH(x, z) + 0.07, z);
    stone.rotation.y = Math.sin(t * Math.PI * 2.2) * 0.5;
    scene.add(stone);
  }

  // 诵豳堂亭（坡顶）
  const pav = makePavilion();
  const pavY = groundH(0, -40);
  pav.position.set(0, pavY, -40);
  scene.add(pav);

  // 念劬塔（远景高处）
  const tower = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const lv = new THREE.Mesh(new THREE.CylinderGeometry(1.6 - i * 0.4, 1.9 - i * 0.4, 2.2, 6), mat(0x7a6a5a));
    lv.position.y = 1.1 + i * 2.4;
    const rf = new THREE.Mesh(new THREE.ConeGeometry(2.2 - i * 0.45, 0.9, 6), mat(0x4a4038));
    rf.position.y = 2.4 + i * 2.4;
    tower.add(lv, rf);
  }
  const towerY = groundH(-34, -52);
  tower.position.set(-34, towerY, -52);
  scene.add(tower);

  // 洗心泉：小水面
  const spring = new THREE.Mesh(new THREE.CircleGeometry(3.2, 18),
    new THREE.MeshStandardMaterial({ color: theme.water, roughness: 0.15, metalness: 0.5, transparent: true, opacity: 0.9 }));
  spring.rotation.x = -Math.PI / 2;
  spring.position.set(24, groundH(24, 6) + 0.05, 6);
  scene.add(spring);

  // 石灯笼沿路
  for (const [x, z] of [[4, 20], [-6, 2], [7, -16], [-4, -30]]) {
    const l = makeStoneLantern();
    l.position.set(x, groundH(x, z), z);
    l.scale.setScalar(0.85);
    scene.add(l);
  }

  return {
    spawn: { pos: [0, 0, 34], yaw: Math.PI },
    boundR: 62,
    groundHeight: groundH,
    grass: { x: 0, z: -4, r: 54, n: Q.grass, tint: 0x9cb46a },
    colliders: [
      { x: 0, z: -40, r: 2.6 },        // 诵豳堂亭
      { x: -34, z: -52, r: 2.6 },      // 念劬塔
      { x: 24, z: 6, r: 3.6 },         // 洗心泉
      { x: 0, z: 32, w: 8.0, d: 1.2 }, // 梅园牌坊
    ],
    hotspots: [
      { pos: [0, 0, -40], name: '诵豳堂亭中', desc: '坐在亭子里，风从梅花那边来。' },
      { pos: [-22, 0, -10], name: '红梅林深处', desc: '被红色围住的时候，心是暖的。' },
      { pos: [18, 0, -24], name: '白梅坡', desc: '白得很安静，适合想一些很远的人。' },
      { pos: [24, 0, 6], name: '洗心泉边', desc: '泉水照得见人，照完就算洗过了。' },
      { pos: [-34, 0, -48], name: '念劬塔下', desc: '塔看了八十年人间，你的事它见多了。' },
    ],
  };
}

// ═════════ ③ 三国水浒城 ═════════
function sanguo(scene, theme, animators) {
  // 校场地面（夯土）
  const ground = new THREE.Mesh(new THREE.CylinderGeometry(90, 92, 1.2, 44), matT('dirt', 0x9a8a68, { repeat: 26, roughness: 0.97, flatShading: false }));
  ground.position.y = -0.6;
  ground.userData.ground = true;
  scene.add(ground);
  // 中央夯土广场（石板）
  const plaza = new THREE.Mesh(new THREE.CylinderGeometry(34, 34, 0.3, 40), matT('stone', 0xb09a72, { repeat: 12, roughness: 0.92, flatShading: false }));
  plaza.position.y = 0.15;
  plaza.userData.ground = true;
  scene.add(plaza);

  mountainRing(scene, 0x4a4038, 6, 200, 300, 16, 40);

  // 西侧太湖水寨
  const water = makeWater(300, 30, theme.water, animators);
  water.position.set(-160, -0.7, 0);
  scene.add(water);

  // 城墙（北）
  const wallMat = mat(0x6e5f4c);
  for (const seg of [[-32, -42, 40], [32, -42, 40]]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(seg[2], 8, 4), wallMat);
    w.position.set(seg[0], 4, seg[1]);
    scene.add(w);
    // 垛口
    for (let i = 0; i < seg[2] / 3; i++) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1, 0.6), wallMat);
      c.position.set(seg[0] - seg[2] / 2 + 1.5 + i * 3, 8.5, seg[1]);
      scene.add(c);
    }
  }
  // 城门楼
  const gate = new THREE.Group();
  const tower1 = new THREE.Mesh(new THREE.BoxGeometry(14, 6, 6), wallMat);
  tower1.position.y = 3;
  const roof1 = new THREE.Mesh(new THREE.ConeGeometry(11, 3.2, 4), mat(0x3a3230));
  roof1.position.y = 7.6; roof1.rotation.y = Math.PI / 4;
  const tower2 = new THREE.Mesh(new THREE.BoxGeometry(9, 4, 4.5), wallMat);
  tower2.position.y = 9.5;
  const roof2 = new THREE.Mesh(new THREE.ConeGeometry(7.5, 2.6, 4), mat(0x3a3230));
  roof2.position.y = 12.8; roof2.rotation.y = Math.PI / 4;
  gate.add(tower1, roof1, tower2, roof2);
  gate.position.set(0, 4, -42);
  scene.add(gate);
  // 门洞
  const arch = new THREE.Mesh(new THREE.BoxGeometry(6, 6.5, 4.4), mat(0x241c14));
  arch.position.set(0, 3.2, -42);
  scene.add(arch);

  // 阙楼
  for (const sx of [-1, 1]) {
    const q = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(6, 10, 6), wallMat);
    base.position.y = 5;
    const rf = new THREE.Mesh(new THREE.ConeGeometry(5.4, 2.6, 4), mat(0x3a3230));
    rf.position.y = 11.3; rf.rotation.y = Math.PI / 4;
    q.add(base, rf);
    q.position.set(sx * 30, 0, -40);
    scene.add(q);
  }

  // 旌旗两排
  const flagColors = [0xb03a2a, 0xb03a2a, 0xc9a86a, 0x8a2a20];
  for (let i = 0; i < 8; i++) {
    const f = makeFlag(flagColors[i % flagColors.length], animators);
    f.position.set((i % 2 === 0 ? -1 : 1) * 8, 0, 24 - Math.floor(i / 2) * 12);
    f.rotation.y = (i % 2 === 0 ? 0 : Math.PI) + (Math.random() - 0.5) * 0.3;
    scene.add(f);
  }

  // 点将台
  const platform = new THREE.Mesh(new THREE.CylinderGeometry(7, 8.5, 2.6, 8), mat(0x8a7a5c));
  platform.position.set(0, 1.3, -16);
  scene.add(platform);
  // 大鼓
  const drum = new THREE.Group();
  const drumBody = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 1.6, 12), mat(0xa03a2a));
  drumBody.rotation.x = Math.PI / 2;
  const skin = new THREE.Mesh(new THREE.CircleGeometry(1.25, 12), mat(0xe8d8b8));
  skin.position.z = 0.82;
  const stand = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.5, 1.2), mat(0x3a3228));
  stand.position.y = -1.4;
  drum.add(drumBody, skin, stand);
  drum.position.set(0, 3.6, -16);
  scene.add(drum);
  // 台边火把
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const torch = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 2.2, 5), mat(0x3a3228));
    pole.position.y = 1.1;
    const fire = makeGlowSprite(0xff9a4a, 2.4, 0.9);
    fire.position.y = 2.4;
    const ph = Math.random() * 6;
    animators.push((dt, t) => { fire.material.opacity = 0.65 + Math.sin(t * 9 + ph) * 0.25; fire.scale.setScalar(2.2 + Math.sin(t * 11 + ph) * 0.4); });
    torch.add(pole, fire);
    torch.position.set(Math.cos(a) * 7.6, 2.6, -16 + Math.sin(a) * 7.6);
    scene.add(torch);
  }

  // 水寨战船
  for (let i = 0; i < 2; i++) {
    const ship = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(14, 2.4, 4.5), mat(0x4a3826));
    hull.position.y = 0.8;
    const bow = new THREE.Mesh(new THREE.ConeGeometry(2.2, 4, 4), mat(0x4a3826));
    bow.rotation.z = -Math.PI / 2; bow.rotation.y = Math.PI / 4;
    bow.position.set(8.5, 1.2, 0);
    const mastM = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 9, 6), mat(0x3a3228));
    mastM.position.y = 5.5;
    const sail = new THREE.Mesh(new THREE.PlaneGeometry(5, 6), mat(0xd8cbb0, { side: THREE.DoubleSide, flatShading: false }));
    sail.position.set(0.2, 6, 0);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(3.5, 2, 3), mat(0x5a4632));
    cabin.position.set(-3.5, 2.8, 0);
    ship.add(hull, bow, mastM, sail, cabin);
    ship.position.set(-70 - i * 22, -0.4, -24 - i * 14);
    ship.rotation.y = 0.4 + i * 0.5;
    scene.add(ship);
    const ph2 = i * 2;
    animators.push((dt, t) => { ship.position.y = -0.4 + Math.sin(t * 0.8 + ph2) * 0.18; ship.rotation.z = Math.sin(t * 0.6 + ph2) * 0.02; });
  }

  // 酒旗挑子
  const winePole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 5.5, 5), mat(0x3a3228));
  winePole.position.set(16, 2.75, 8);
  scene.add(winePole);
  const wineFlag = makeFlag(0xd8cbb0, animators, 2.2, 1.2);
  wineFlag.position.set(16, 0, 8);
  scene.add(wineFlag);

  // 兵器架（校场两侧）：横杆 + 竖插长矛/戟
  for (const sx of [-18, 18]) {
    const rack = new THREE.Group();
    // 横杆支架
    const rackBar = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 5, 6), mat(0x4a3826));
    rackBar.rotation.z = Math.PI / 2;
    rackBar.position.y = 2.2;
    rack.add(rackBar);
    for (const lx of [-2.2, 2.2]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 2.4, 5), mat(0x4a3826));
      leg.position.set(lx, 1.2, 0);
      rack.add(leg);
    }
    // 长矛/戟 5 把
    for (let i = 0; i < 5; i++) {
      const spear = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 4.2, 5), mat(0x5a4a38));
      spear.position.set(-2 + i * 1, 2.6, 0);
      rack.add(spear);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.5, 4), mat(0x9a9a9a, { metalness: 0.6, roughness: 0.3 }));
      tip.position.set(-2 + i * 1, 4.9, 0);
      rack.add(tip);
    }
    rack.position.set(sx, 0, 16);
    scene.add(rack);
  }

  // "吴"字大纛旗（城门楼前，巨型令旗）
  const wuFlag = new THREE.Group();
  const wuPole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 12, 6), mat(0x3a2a1a));
  wuPole.position.y = 6;
  wuFlag.add(wuPole);
  const wuBanner = new THREE.Mesh(
    new THREE.PlaneGeometry(4.5, 6, 8, 10),
    new THREE.MeshStandardMaterial({ color: 0xb03a2a, side: THREE.DoubleSide, roughness: 0.85 })
  );
  wuBanner.position.set(2.4, 8.5, 0);
  wuFlag.add(wuBanner);
  // 旗帜飘动
  const wuPos = wuBanner.geometry.attributes.position;
  const wuBase = wuPos.array.slice();
  animators.push((dt, t) => {
    for (let i = 0; i < wuPos.count; i++) {
      const x = wuBase[i * 3], y = wuBase[i * 3 + 1];
      const k = (x + 2.25) / 4.5;
      wuPos.array[i * 3 + 2] = Math.sin(x * 1.2 + t * 3.5) * 0.4 * k + Math.sin(y * 1.5 + t * 2.8) * 0.15 * k;
    }
    wuPos.needsUpdate = true;
    wuBanner.geometry.computeVertexNormals();
  });
  wuFlag.position.set(0, 4, -34);
  scene.add(wuFlag);

  return {
    spawn: { pos: [0, 0, 30], yaw: Math.PI },
    boundR: 58,
    groundHeight: () => 0,
    colliders: [
      { x: -32, z: -42, w: 40, d: 5 },    // 西城墙
      { x: 32, z: -42, w: 40, d: 5 },     // 东城墙
      { x: 0, z: -42, w: 16, d: 7 },      // 城门楼
      { x: -30, z: -40, w: 7, d: 7 },     // 西阙楼
      { x: 30, z: -40, w: 7, d: 7 },      // 东阙楼
      { x: 0, z: -16, r: 8.5 },           // 点将台
    ],
    hotspots: [
      { pos: [0, 0, -10], name: '点将台下', desc: '站上来，把让你烦的人和事挨个过一遍堂。' },
      { pos: [0, 0, -38], name: '城门楼下', desc: '进了这道门，你就是自己故事里的主角。' },
      { pos: [-56, 0, -18], name: '水寨码头', desc: '战船都歇了，你也可以歇。' },
      { pos: [16, 0, 11], name: '酒旗挑子', desc: '店家，来一碗不醉人的，把话留下。' },
      { pos: [-20, 0, 20], name: '校场西', desc: '空旷的地方，喊一嗓子也没人管。' },
    ],
  };
}

// ═════════ ④ 惠山古镇 ═════════
function huishan(scene, theme, animators) {
  // 基底（湿润的青苔土地）
  const ground = new THREE.Mesh(new THREE.CylinderGeometry(95, 98, 1.2, 48), matT('dirt', 0x5a6252, { repeat: 28, roughness: 0.97, flatShading: false }));
  ground.position.y = -0.6;
  ground.userData.ground = true;
  scene.add(ground);

  // 主街石板路（错缝铺装）
  const streetMat = matT('stone', 0x8a8578, { repeat: 3, roughness: 0.92, flatShading: false });
  const street = new THREE.Mesh(new THREE.BoxGeometry(5, 0.12, 110), streetMat);
  street.position.set(0, 0.06, -10);
  street.userData.ground = true;
  scene.add(street);
  for (let i = 0; i < 40; i++) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(1.5 + Math.random() * 0.6, 0.13, 1.0 + Math.random() * 0.4), streetMat);
    slab.position.set((Math.random() - 0.5) * 3.4, 0.07, 42 - i * 2.6);
    slab.rotation.y = (Math.random() - 0.5) * 0.08;
    slab.userData.ground = true;
    scene.add(slab);
  }

  // 两侧民居
  const wallColors = [0xd8d2c2, 0xcfc8b8, 0xe0dacb];
  let zi = 38;
  while (zi > -56) {
    for (const side of [-1, 1]) {
      if (Math.random() < 0.15) continue;
      const w = 6 + Math.random() * 3, h = 3 + Math.random() * 1.6, d = 5 + Math.random() * 2;
      const house = makeHouse(w, h, d, wallColors[Math.floor(Math.random() * 3)], 0x3f3a36);
      const x = side * (5.5 + d / 2 + Math.random() * 1.5);
      house.position.set(x, 0, zi + (Math.random() - 0.5) * 2);
      house.rotation.y = side === -1 ? 0 : Math.PI;
      scene.add(house);
      // 门口灯笼（夜里更亮）
      if (Math.random() < 0.6) {
        scene.add(makeLantern(x - side * (d / 2 + 0.5), 2.4, zi + 1));
      }
    }
    zi -= 7 + Math.random() * 3;
  }

  // 龙头河 + 石桥（z = -18 横向河）
  const river = makeWater(90, 20, theme.water, animators);
  river.rotation.y = Math.PI / 2;
  river.scale.set(1, 1, 0.12);
  river.position.set(0, -0.35, -18);
  scene.add(river);
  // 拱石桥（台阶式）
  const bridgeMat = mat(0x9a958a, { flatShading: false });
  for (let i = 0; i < 7; i++) {
    const k = (i - 3) / 3;
    const step = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.26, 1.7), bridgeMat);
    step.position.set(0, 0.6 + (1 - k * k) * 1.1, -18 + k * 6);
    scene.add(step);
  }
  // 桥头望柱
  for (const [dx, dz] of [[-2, -24.6], [2, -24.6], [-2, -11.4], [2, -11.4]]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 1.2, 6), bridgeMat);
    post.position.set(dx, 1.2, dz);
    scene.add(post);
  }

  // 祠堂大门（街尽头）
  const hall = new THREE.Group();
  const hw = new THREE.Mesh(new THREE.BoxGeometry(12, 5, 7), mat(0x8a4438));
  hw.position.y = 2.5;
  const hr = new THREE.Mesh(new THREE.ConeGeometry(10.5, 3, 4), mat(0x2f2a28));
  hr.position.y = 6.4; hr.rotation.y = Math.PI / 4; hr.scale.z = 0.6;
  const hdoor = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 3), mat(0x241c14));
  hdoor.position.set(0, 1.5, 3.51);
  hall.add(hw, hr, hdoor);
  hall.position.set(0, 0, -62);
  scene.add(hall);
  scene.add(makeLantern(-3, 3.4, -58));
  scene.add(makeLantern(3, 3.4, -58));

  // 茶馆（街边突出）
  const tea = makeHouse(7, 3.6, 6, 0xb8a888, 0x3f3a36);
  tea.position.set(-8.5, 0, 10);
  scene.add(tea);
  const teaFlag = makeFlag(0xd8cbb0, animators, 1.8, 1.0);
  teaFlag.position.set(-5.8, 0, 14);
  scene.add(teaFlag);

  // 惠山古镇入口牌坊（街南口）
  const hsGate = new THREE.Group();
  const hsMat = mat(0x6a5a4a);
  for (const px of [-3.6, -1.2, 1.2, 3.6]) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 6, 6), hsMat);
    col.position.set(px, 3, 0);
    hsGate.add(col);
  }
  for (const [y, w] of [[5.6, 8.2], [4.6, 5.6], [6.2, 8.6]]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(w, 0.4, 0.6), hsMat);
    beam.position.set(0, y, 0);
    hsGate.add(beam);
  }
  // 坊顶（歇山式简化）
  const hsRoof = new THREE.Mesh(new THREE.BoxGeometry(9, 0.3, 1.6), mat(0x3a3230));
  hsRoof.position.set(0, 6.5, 0);
  hsGate.add(hsRoof);
  const hsRidge = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 9.2, 6), mat(0x4a4038));
  hsRidge.rotation.z = Math.PI / 2;
  hsRidge.position.set(0, 6.75, 0);
  hsGate.add(hsRidge);
  // 翘角
  for (const sx of [-1, 1]) {
    const eave = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.2, 4), mat(0x3a3230));
    eave.position.set(sx * 4.6, 6.8, 0);
    eave.rotation.z = sx * 0.6;
    hsGate.add(eave);
  }
  hsGate.position.set(0, 0, 40);
  scene.add(hsGate);

  // 泥人铺（惠山泥人是标志性特产）
  const clayShop = makeHouse(5.5, 3.2, 5, 0xc8b898, 0x3f3a36);
  clayShop.position.set(8.5, 0, 22);
  clayShop.rotation.y = Math.PI;
  scene.add(clayShop);
  // 泥人铺招牌旗
  const clayFlag = makeFlag(0xc94a3a, animators, 1.6, 0.9);
  clayFlag.position.set(6.2, 0, 24);
  scene.add(clayFlag);
  // 门口泥人摆件（两个彩色小球代表阿福阿喜）
  for (const [dx, color] of [[-0.6, 0xd84a3a], [0.6, 0x4a8a5a]]) {
    const figurine = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 8), mat(color, { emissive: color, emissiveIntensity: 0.3 }));
    figurine.position.set(8.5 + dx, 0.4, 24.6);
    figurine.scale.y = 1.3;
    scene.add(figurine);
  }

  // 惠山剪影（街尽头后）
  for (const [x, z, w, h] of [[-40, -140, 110, 42], [40, -150, 130, 52], [0, -180, 160, 60]]) {
    const m = new THREE.Mesh(new THREE.ConeGeometry(w, h, 6), mat(0x37473c));
    m.position.set(x, h * 0.3, z);
    scene.add(m);
  }
  mountainRing(scene, 0x3f5044, 5, 160, 260, 24, 46);

  // 寄畅园一角：假山 + 池水
  const rockMat = matT('rock', 0x6a6a62, { repeat: 2, roughness: 0.95, flatShading: true });
  for (let i = 0; i < 7; i++) {
    const rg = new THREE.DodecahedronGeometry(0.8 + Math.random() * 1.4, 1);
    jitter(rg, 0.32, i * 13 + 7);
    const r = new THREE.Mesh(rg, rockMat);
    const rr = 0.85 + Math.random() * 0.5;
    r.position.set(14 + Math.random() * 6, 0.5 + Math.random() * 1.8, -14 + Math.random() * 5);
    r.rotation.set(Math.random(), Math.random(), Math.random());
    r.scale.set(rr, rr * (1.1 + Math.random() * 0.6), rr);
    scene.add(r);
  }
  const pond = new THREE.Mesh(new THREE.CircleGeometry(4.5, 16),
    new THREE.MeshStandardMaterial({ color: theme.water, roughness: 0.15, metalness: 0.5, transparent: true, opacity: 0.9 }));
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(17, 0.04, -8);
  scene.add(pond);

  // 暖光浮尘
  scene.add(makePetals(120, 0, -10, 45, theme.moon ? 0xffc88a : 0xffe0b0, animators, 7));

  return {
    spawn: { pos: [0, 0, 42], yaw: Math.PI },
    boundR: 60,
    groundHeight: () => 0,
    colliders: [
      { x: 0, z: -62, w: 13, d: 8 },      // 祠堂
      { x: 0, z: -18, w: 5, d: 9 },       // 石桥
      { x: -8.5, z: 10, w: 7, d: 6 },     // 茶馆
      { x: 0, z: 40, w: 9, d: 1.4 },      // 入口牌坊
      { x: 8.5, z: 22, w: 6, d: 5.5 },    // 泥人铺
    ],
    hotspots: [
      { pos: [0, 0, -18], name: '龙头河石桥上', desc: '桥下的水慢慢流，你的事也慢慢来。' },
      { pos: [0, 0, -55], name: '祠堂门前', desc: '几百年的老房子看着你呢，站直了。' },
      { pos: [-6, 0, 12], name: '茶馆门口', desc: '来都来了，喝碗茶再走。' },
      { pos: [17, 0, -8], name: '寄畅园池畔', desc: '假山不言，池水不急，你也别慌。' },
      { pos: [2, 0, 30], name: '街南口', desc: '回头望一眼这条街，灯都为你留着。' },
    ],
  };
}

// ═════════ 类型化 3D 模板（按景点类型生成，seed 让不同景点有差异）═════════
// 哈希种子
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function rng(seed) { let s = seed || 1; return () => (s = (s * 9301 + 49297) % 233280) / 233280; }

// 公共：地面 + 远山环
function addGround(scene, color, r = 90, kind = 'grass') {
  const g = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r + 2, 1.2, 48),
    matT(kind, color, { repeat: Math.max(8, Math.round(r / 9)), roughness: 0.96, flatShading: false })
  );
  g.position.y = -0.6;
  g.userData.ground = true;
  scene.add(g);
  return g;
}

// ① 山岳模板（variant: mountain / forest / snow / desert）
function buildMountain(scene, theme, animators, seed, variant = 'mountain') {
  const rnd = rng(seed);
  const S = (seed % 97) / 97;
  const isSnow = variant === 'snow', isDesert = variant === 'desert', isForest = variant === 'forest';
  const groundH = (x, z) => {
    const d = Math.hypot(x, z);
    if (d > 74) return 0;
    const base = Math.max(0, (74 - d) * 0.05);
    // fbm 起伏：比纯正弦自然得多
    const n1 = fbm(x * 0.035 + S * 10, z * 0.035 + S * 7, 3, 4, 32) - 0.5;
    const n2 = fbm(x * 0.11, z * 0.11, 11, 3, 32) - 0.5;
    const ridge = isSnow ? 1.5 : (isDesert ? 0.45 : 1.0);
    return base + n1 * 7.5 * ridge + n2 * 1.5;
  };
  const geo = new THREE.PlaneGeometry(220, 220, 56, 56);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const col = [];
  const cGrass = new THREE.Color(isSnow ? 0xdfe8f2 : isDesert ? 0xc7a86a : isForest ? 0x35502c : 0x4a6b3a);
  const cRock = new THREE.Color(isSnow ? 0x9aa4ae : isDesert ? 0xa8865a : 0x6a6258);
  const cHigh = new THREE.Color(isSnow ? 0xffffff : isDesert ? 0xd8bd86 : 0x8a8578);
  const tmp = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.array[i * 3], z = p.array[i * 3 + 2];
    const y = groundH(x, z);
    p.array[i * 3 + 1] = y;
    // 顶点色：低处植被 → 高处裸岩 → 顶积雪/亮沙
    const patch = fbm(x * 0.09 + 3, z * 0.09 + 5, 17, 3, 32);
    const hk = Math.min(1, Math.max(0, (y - (isSnow ? 2.5 : 1.6)) / (isSnow ? 7 : 5.5)));
    const rockK = Math.min(1, hk * (0.45 + patch * 0.75));
    tmp.copy(cGrass).lerp(cRock, rockK);
    if (hk > 0.8) tmp.lerp(cHigh, (hk - 0.8) * 5 * (isSnow ? 1 : 0.5));
    const shade = 0.88 + patch * 0.24;
    col.push(tmp.r * shade, tmp.g * shade, tmp.b * shade);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const gMat = matT(isSnow ? 'snow' : isDesert ? 'sand' : 'grass', 0xffffff,
    { repeat: 26, roughness: 0.97, flatShading: false });
  gMat.vertexColors = true;
  const ground = new THREE.Mesh(geo, gMat);
  ground.userData.ground = true;
  scene.add(ground);

  mountainRing(scene, isSnow ? 0x5a6672 : isDesert ? 0x8a7250 : 0x3a4f3a, 9, 150, 270, 26, 60);

  // 主峰（不规则岩体）
  const peakGeo = new THREE.ConeGeometry(20, 36, 7, 4);
  jitter(peakGeo, 0.22, 31);
  const peak = new THREE.Mesh(peakGeo, matT('rock', isSnow ? 0xb8c2cc : 0x6a5f52,
    { repeat: 5, roughness: 0.95, flatShading: true }));
  peak.position.set(-30, 15 - 2, -92);
  peak.scale.set(1.1, 1, 0.85);
  scene.add(peak);
  // 次峰
  const pk2Geo = new THREE.ConeGeometry(13, 24, 6, 3);
  jitter(pk2Geo, 0.24, 47);
  const pk2 = new THREE.Mesh(pk2Geo, peak.material);
  pk2.position.set(48, 8, -104);
  pk2.scale.set(0.9, 1, 0.8);
  scene.add(pk2);

  // 树林 / 枯树
  const treeN = isDesert ? 6 : (isForest ? 34 : 22);
  for (let i = 0; i < treeN; i++) {
    const a = rnd() * Math.PI * 2, r = 16 + rnd() * 46;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = groundH(x, z);
    if (h > 7.5) continue;               // 高处不长树
    const crown = isSnow ? 0x2e4436 : isDesert ? 0x7a6a42
      : isForest ? 0x2f5228 + ((rnd() * 0x182010) | 0)
        : 0x40602e + ((rnd() * 0x202018) | 0);
    scene.add(makeTree(x, z, h, {
      crownColor: crown, trunkH: (isSnow ? 3.2 : 2.2) + rnd() * 1.2,
      crownR: (isSnow ? 1.3 : 1.6) + rnd() * 0.7,
      trunkColor: isDesert ? 0x5a4a30 : 0x40301f,
    }));
  }
  // 散石
  for (let i = 0; i < 14; i++) {
    const a = rnd() * Math.PI * 2, r = 12 + rnd() * 52;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const rg = new THREE.DodecahedronGeometry(0.4 + rnd() * 1.1, 0);
    jitter(rg, 0.3, i * 7 + 5);
    const rock = new THREE.Mesh(rg, matT('rock', isSnow ? 0xa8b2bc : 0x6e6a62,
      { repeat: 2, roughness: 0.95, flatShading: true }));
    rock.position.set(x, groundH(x, z) + 0.15, z);
    rock.rotation.set(rnd(), rnd(), rnd());
    scene.add(rock);
  }

  // 观景平台
  const plat = new THREE.Mesh(new THREE.CylinderGeometry(4, 4.5, 0.4, 10), matT('stone', 0x9a8a6a, { repeat: 3, roughness: 0.9 }));
  plat.position.set(0, 0.2 + (groundH(0, 20) || 0), 20);
  scene.add(plat);

  return {
    spawn: { pos: [0, 0, 24], yaw: Math.PI }, boundR: 62, groundHeight: groundH,
    grass: isDesert || isSnow ? null : { r: 52, n: Q.grass, tint: isForest ? 0x8fae5e : 0xa8c070 },
    colliders: [{ x: 0, z: 20, r: 4.2 }, { x: -30, z: -92, r: 12 }],
    hotspots: [
      { pos: [0, 0, 20], name: '观景台', desc: '站高一点，世界就小一点。' },
      { pos: [-15, 0, -10], name: '山腰栈道', desc: '风从山谷来，把心事带走。' },
      { pos: [20, 0, -20], name: '林间空地', desc: '树会听你说话，且不评价。' },
      { pos: [-25, 0, 15], name: '溪流边', desc: '水声盖过脑子里的噪音。' },
      { pos: [10, 0, -40], name: '远眺点', desc: '看远处，是想远一点的事。' },
    ],
  };
}

// ② 湖泊水景模板
function buildWater(scene, theme, animators, seed) {
  const rnd = rng(seed);
  const water = makeWater(560, 42, theme.water, animators);
  water.position.set(0, -0.5, -50);
  scene.add(water);
  const island = new THREE.Mesh(
    new THREE.CylinderGeometry(50, 54, 1.4, 40),
    matT('grass', 0x5a7a4a, { repeat: 14, roughness: 0.96, flatShading: false })
  );
  island.position.set(0, -0.7, 20);
  island.userData.ground = true;
  scene.add(island);
  mountainRing(scene, 0x4a5a5e, 8, 180, 280, 22, 52);
  for (let i = 0; i < 18; i++) {
    const a = rnd() * Math.PI * 2, r = 24 + rnd() * 22;
    scene.add(makeTree(Math.cos(a) * r, 20 + Math.sin(a) * r * 0.7, 0, {
      crownColor: 0x46682f + ((rnd() * 0x1a1a12) | 0), crownR: 1.7 + rnd() * 0.6,
    }));
  }
  // 岸石：让水陆交界不生硬
  for (let i = 0; i < 22; i++) {
    const a = rnd() * Math.PI * 2, r = 47 + rnd() * 5;
    const rg = new THREE.DodecahedronGeometry(0.5 + rnd() * 1.5, 0);
    jitter(rg, 0.32, i * 3 + 1);
    const rock = new THREE.Mesh(rg, matT('rock', 0x6e6a60, { repeat: 2, roughness: 0.95, flatShading: true }));
    rock.position.set(Math.cos(a) * r, -0.3 + rnd() * 0.4, 20 + Math.sin(a) * r);
    rock.rotation.set(rnd(), rnd(), rnd());
    scene.add(rock);
  }
  // 湖心亭
  const pav = makePavilion();
  pav.position.set(0, 0, -10);
  scene.add(pav);
  // 倒影光带
  for (let i = 0; i < 6; i++) {
    const s = makeGlowSprite(theme.moon ? 0xaec4e8 : 0xffe0a8, 12 + rnd() * 12, 0.13);
    s.position.set((rnd() - 0.5) * 80, 0.4, -60 - rnd() * 80);
    scene.add(s);
  }
  return {
    spawn: { pos: [0, 0, 44], yaw: Math.PI }, boundR: 48, groundHeight: () => 0,
    grass: { x: 0, z: 20, r: 44, n: Q.grass, tint: 0x9ab86a },
    colliders: [{ x: 0, z: -10, r: 2.8 }],
    hotspots: [
      { pos: [0, 0, -10], name: '湖心亭', desc: '四面环水，烦恼到不了这。' },
      { pos: [20, 0, 10], name: '东岸柳堤', desc: '柳枝往下垂，你也要学会低头。' },
      { pos: [-22, 0, 0], name: '西岸石矶', desc: '坐下来，扔个石子听听响。' },
      { pos: [0, 0, 30], name: '北岸码头', desc: '船不开了，正好发呆。' },
      { pos: [12, 0, -25], name: '南湾荷塘', desc: '荷花出淤泥，你也可以。' },
    ],
  };
}

// ③ 古镇模板
function buildTown(scene, theme, animators, seed) {
  const rnd = rng(seed);
  const colliders = [];
  addGround(scene, 0x5a6252, 80, 'dirt');
  // 石板街：一块块铺，带缝隙和起伏
  const stoneMat = matT('stone', 0x8a8578, { repeat: 3, roughness: 0.92, flatShading: false });
  for (let i = 0; i < 46; i++) {
    const zz = 44 - i * 2.2;
    const sw = 4.6 + rnd() * 0.5;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.1, 2.0), stoneMat);
    slab.position.set((rnd() - 0.5) * 0.25, 0.05 + (rnd() - 0.5) * 0.02, zz);
    slab.rotation.y = (rnd() - 0.5) * 0.05;
    slab.userData.ground = true;
    scene.add(slab);
  }
  const wallColors = [0xd8d2c2, 0xcfc8b8, 0xc0b8a8, 0xb8a888];
  let zi = 38;
  while (zi > -56) {
    for (const side of [-1, 1]) {
      if (rnd() < 0.15) continue;
      const w = 6 + rnd() * 3, h = 3 + rnd() * 1.6, d = 5 + rnd() * 2;
      const house = makeHouse(w, h, d, wallColors[Math.floor(rnd() * 4)], 0x3a3230);
      const hx = side * (5.5 + d / 2 + rnd());
      house.position.set(hx, 0, zi);
      house.rotation.y = side === -1 ? 0 : Math.PI;
      scene.add(house);
      colliders.push({ x: hx, z: zi, w: w + 0.6, d: d + 0.6 });
      if (rnd() < 0.6) scene.add(makeLantern(side * (5.5 + d / 2 + 0.5), 2.4, zi + 1));
    }
    zi -= 7 + rnd() * 3;
  }
  mountainRing(scene, 0x3f4f44, 6, 150, 260, 20, 44);
  scene.add(makePetals(120, 0, -8, 45, theme.moon ? 0xffc88a : 0xffe0b0, animators, 7));
  return {
    spawn: { pos: [0, 0, 42], yaw: Math.PI }, boundR: 56, groundHeight: () => 0,
    colliders,
    hotspots: [
      { pos: [0, 0, 10], name: '街口牌坊', desc: '进了这道门，时间就慢了。' },
      { pos: [-6, 0, 20], name: '老茶馆', desc: '一碗茶，能喝一下午。' },
      { pos: [6, 0, 0], name: '手工艺铺', desc: '看手艺人，心就静了。' },
      { pos: [0, 0, -20], name: '古桥', desc: '桥下流水，桥上的人换了几茬。' },
      { pos: [-5, 0, -40], name: '祠堂', desc: '几百年了，看着你来去。' },
    ],
  };
}

// ④ 园林模板
function buildGarden(scene, theme, animators, seed) {
  const rnd = rng(seed);
  addGround(scene, 0x4a5a3e, 70, 'grass');
  // 池水
  const pond = makeWater(120, 24, theme.water, animators);
  pond.scale.set(1, 1, 0.6);
  pond.position.set(0, -0.3, -10);
  scene.add(pond);
  // 假山（太湖石：不规则 + 皱漏瘦透的粗糙感）
  for (let i = 0; i < 9; i++) {
    const rg = new THREE.DodecahedronGeometry(0.8 + rnd() * 1.5, 1);
    jitter(rg, 0.34, i * 5 + 2);
    const r = new THREE.Mesh(rg, matT('rock', 0x6a6a62, { repeat: 2, roughness: 0.95, flatShading: true }));
    const rr = 0.8 + rnd() * 0.6;
    r.position.set((rnd() - 0.5) * 20, 0.4 + rnd() * 1.6, -20 + (rnd() - 0.5) * 10);
    r.rotation.set(rnd(), rnd(), rnd());
    r.scale.set(rr, rr * (1.1 + rnd() * 0.7), rr);
    scene.add(r);
  }
  // 亭台长廊
  const pav = makePavilion();
  pav.position.set(0, 0, 10);
  scene.add(pav);
  // 梅/竹
  for (let i = 0; i < 12; i++) {
    const a = rnd() * Math.PI * 2, r = 15 + rnd() * 20;
    scene.add(makeTree(Math.cos(a) * r, Math.sin(a) * r, 0, { crownColor: 0x6a8a5a + Math.floor(rnd() * 0x101010), trunkH: 2, crownR: 1.4 }));
  }
  // 曲桥
  const bridgeMat = mat(0x9a958a, { flatShading: false });
  for (let i = 0; i < 5; i++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.2, 1.4), bridgeMat);
    step.position.set(0, 0.4 + Math.sin((i / 4) * Math.PI) * 0.5, 0 - i * 2);
    scene.add(step);
  }
  return {
    spawn: { pos: [0, 0, 28], yaw: Math.PI }, boundR: 50, groundHeight: () => 0,
    colliders: [{ x: 0, z: 10, r: 2.8 }, { x: 10, z: -20, r: 2.5 }],
    hotspots: [
      { pos: [0, 0, 10], name: '主亭', desc: '坐亭中，看四季在池里倒影。' },
      { pos: [0, 0, -4], name: '曲桥', desc: '桥是弯的，路也是。' },
      { pos: [10, 0, -20], name: '假山', desc: '爬上去，换个角度看自己。' },
      { pos: [-12, 0, 5], name: '竹林', desc: '风过竹响，比白噪音管用。' },
      { pos: [8, 0, 18], name: '花窗', desc: '透过花窗看世界，世界也变温柔。' },
    ],
  };
}

// ⑤ 海岸模板
function buildCoast(scene, theme, animators, seed) {
  const rnd = rng(seed);
  const sea = makeWater(600, 42, theme.water, animators);
  sea.position.set(0, -0.5, -80);
  scene.add(sea);
  // 沙滩（湿沙 + 干沙渐变：靠水更暗）
  const beachGeo = new THREE.PlaneGeometry(300, 90, 24, 10);
  beachGeo.rotateX(-Math.PI / 2);
  const bp = beachGeo.attributes.position;
  const col = [];
  const cWet = new THREE.Color(0x9a8a68), cDry = new THREE.Color(0xe0d0a4);
  const tmp = new THREE.Color();
  for (let i = 0; i < bp.count; i++) {
    const z = bp.array[i * 3 + 2];
    // 靠海侧(z 小)为湿沙，并做出沙丘起伏
    const k = Math.min(1, Math.max(0, (z + 45) / 90));
    const dune = (fbm(bp.array[i * 3] * 0.06, z * 0.06, 7, 3, 32) - 0.5) * 1.1;
    bp.array[i * 3 + 1] = dune * (0.3 + k * 0.9);
    tmp.copy(cWet).lerp(cDry, k);
    const s = 0.9 + fbm(bp.array[i * 3] * 0.3, z * 0.3, 13, 2, 32) * 0.2;
    col.push(tmp.r * s, tmp.g * s, tmp.b * s);
  }
  beachGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  beachGeo.computeVertexNormals();
  const bMat = matT('sand', 0xffffff, { repeat: 30, roughness: 0.98, flatShading: false });
  bMat.vertexColors = true;
  const beach = new THREE.Mesh(beachGeo, bMat);
  beach.position.set(0, 0.05, 10);
  beach.userData.ground = true;
  scene.add(beach);

  // 海浪：几道白色浪线推向岸边
  for (let i = 0; i < 4; i++) {
    const sg = new THREE.PlaneGeometry(300, 2.2 + i * 0.5);
    sg.rotateX(-Math.PI / 2);
    const sm = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.3 - i * 0.055,
      depthWrite: false, fog: true,
    });
    const surf = new THREE.Mesh(sg, sm);
    surf.userData.noShadow = true;
    const z0 = -34 + i * 5.5;
    surf.position.set(0, 0.12, z0);
    scene.add(surf);
    const ph = i * 1.3;
    animators.push((dt, t) => {
      const k = (Math.sin(t * 0.55 + ph) * 0.5 + 0.5);
      surf.position.z = z0 + k * 7 - 2;
      sm.opacity = (0.16 + k * 0.26) * (1 - i * 0.18);
    });
  }

  // 礁石
  for (let i = 0; i < 12; i++) {
    const x = (rnd() - 0.5) * 150, zz = -30 + rnd() * 14;
    const rg = new THREE.DodecahedronGeometry(0.7 + rnd() * 2.2, 0);
    jitter(rg, 0.34, i * 11 + 3);
    const rock = new THREE.Mesh(rg, matT('rock', 0x5e5a52, { repeat: 2, roughness: 0.96, flatShading: true }));
    rock.position.set(x, 0.1 + rnd() * 0.5, zz);
    rock.rotation.set(rnd(), rnd(), rnd());
    rock.scale.y = 0.55 + rnd() * 0.5;
    scene.add(rock);
  }

  // 棕榈：弯曲树干 + 下垂叶片 + 风摆
  for (let i = 0; i < 9; i++) {
    const x = (rnd() - 0.5) * 90, z = 4 + rnd() * 32;
    const palm = new THREE.Group();
    const th = 4 + rnd() * 2.4;
    const tg = new THREE.CylinderGeometry(0.17, 0.3, th, 6, 4);
    jitter(tg, 0.06, i * 3 + 1);
    const trunk = new THREE.Mesh(tg, matT('wood', 0x6a4a2a, { repeat: 2, roughness: 0.9 }));
    trunk.position.y = th / 2;
    trunk.rotation.z = (rnd() - 0.5) * 0.34;
    palm.add(trunk);
    const leafMat = mat(0x3f7a3c, { flatShading: true, roughness: 0.9 });
    for (let j = 0; j < 7; j++) {
      const a = (j / 7) * Math.PI * 2 + rnd() * 0.3;
      const lg = new THREE.ConeGeometry(0.42, 3.2, 4, 2);
      jitter(lg, 0.1, j + i * 5);
      const leaf = new THREE.Mesh(lg, leafMat);
      leaf.position.set(Math.cos(a) * 1.25, th - 0.25, Math.sin(a) * 1.25);
      leaf.rotation.z = Math.PI / 2.35;
      leaf.rotation.y = a;
      leaf.scale.set(1, 1, 0.42);
      palm.add(leaf);
    }
    // 椰果
    for (let j = 0; j < 3; j++) {
      const nut = new THREE.Mesh(new THREE.SphereGeometry(0.17, 6, 5), mat(0x5a4228));
      const a = rnd() * Math.PI * 2;
      nut.position.set(Math.cos(a) * 0.35, th - 0.55, Math.sin(a) * 0.35);
      palm.add(nut);
    }
    palm.position.set(x, 0, z);
    scene.add(palm);
    const ph = Math.random() * 6.28;
    animators.push((dt, t) => {
      palm.rotation.z = Math.sin(t * 1.1 + ph) * 0.022;
    });
  }
  // 远岛
  for (let i = 0; i < 4; i++) {
    const ig = new THREE.ConeGeometry(20 + rnd() * 22, 8 + rnd() * 7, 6, 2);
    jitter(ig, 0.22, i * 17 + 9);
    const m = new THREE.Mesh(ig, mat(0x5a7a6a, { flatShading: true }));
    m.position.set((rnd() - 0.5) * 220, -0.5, -150 - rnd() * 90);
    m.userData.far = true;
    scene.add(m);
  }
  return {
    spawn: { pos: [0, 0, 36], yaw: Math.PI }, boundR: 58, groundHeight: () => 0,
    hotspots: [
      { pos: [0, 0, 10], name: '沙滩', desc: '把脚印留下，让浪带走。' },
      { pos: [20, 0, 5], name: '礁石', desc: '坐在礁石上，听海讲老故事。' },
      { pos: [-18, 0, 12], name: '棕榈林', desc: '假装在度假，真的在放空。' },
      { pos: [0, 0, -20], name: '亲水平台', desc: '浪花够得着你的脚。' },
      { pos: [30, 0, 20], name: '观海点', desc: '海没有边，心也可以没有。' },
    ],
  };
}

// ⑥ 都市模板
function buildCity(scene, theme, animators, seed) {
  const rnd = rng(seed);
  const colliders = [];
  addGround(scene, 0x3a3a42, 80, 'stone');
  // 街道：沥青 + 中央虚线 + 人行道
  const road = new THREE.Mesh(new THREE.BoxGeometry(13, 0.1, 104), matT('stone', 0x2a2a2e, { repeat: 10, roughness: 0.85, flatShading: false }));
  road.position.set(0, 0.05, -8);
  road.userData.ground = true;
  scene.add(road);
  for (let i = 0; i < 26; i++) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.02, 1.6), mat(0xd8d0b0, { flatShading: false }));
    dash.position.set(0, 0.11, 46 - i * 4);
    dash.userData.ground = true;
    scene.add(dash);
  }
  for (const sx of [-7.2, 7.2]) {
    const walk = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.14, 104), matT('stone', 0x6a6a66, { repeat: 20, roughness: 0.9, flatShading: false }));
    walk.position.set(sx, 0.08, -8);
    walk.userData.ground = true;
    scene.add(walk);
  }

  // 玻璃幕墙：一张窗格纹理，按世界尺寸铺 UV，夜里亮灯
  const bTex = finish(buildingTexture(1 + (seed % 5)), 1, true);
  const nightK = theme.moon ? 1 : (theme.key === 'dusk' ? 0.55 : (theme.key === 'dawn' ? 0.3 : 0.06));
  const UNIT = 3.2;   // 一格窗的世界尺寸
  const makeTower = (w, h, d, hue) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    const uv = geo.attributes.uv;
    const faceScale = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) {
      const ru = faceScale[f][0] / UNIT, rv = faceScale[f][1] / UNIT;
      for (let i = 0; i < 4; i++) {
        const idx = f * 4 + i;
        if (f === 2 || f === 3) uv.setXY(idx, 0.99, 0.99);  // 顶/底取暗色
        else uv.setXY(idx, uv.getX(idx) * ru, uv.getY(idx) * rv);
      }
    }
    uv.needsUpdate = true;
    const mtl = new THREE.MeshStandardMaterial({
      color: hue, map: bTex, emissive: 0xffcf9a, emissiveMap: bTex,
      emissiveIntensity: 1.9 * nightK, metalness: 0.42, roughness: 0.4,
    });
    return new THREE.Mesh(geo, mtl);
  };
  const hues = [0x5a6a7a, 0x6a7a8a, 0x4a5a6a, 0x707e88];
  let zi = 36;
  while (zi > -60) {
    for (const side of [-1, 1]) {
      const w = 5 + rnd() * 4.5, h = 10 + rnd() * 32, d = 5 + rnd() * 3;
      const b = makeTower(w, h, d, hues[Math.floor(rnd() * hues.length)]);
      const bx = side * (8.5 + w / 2 + rnd() * 2);
      b.position.set(bx, h / 2, zi);
      scene.add(b);
      colliders.push({ x: bx, z: zi, w: w + 0.6, d: d + 0.6 });
      // 楼顶航空障碍灯
      const tip = makeGlowSprite(0xff6a5a, 1.6, 0.75);
      tip.position.set(bx, h + 0.5, zi);
      scene.add(tip);
      animators.push((dt, t) => { tip.material.opacity = 0.25 + 0.55 * (Math.sin(t * 2.2 + bx) * 0.5 + 0.5); });
    }
    zi -= 8 + rnd() * 3;
  }

  // 路灯：灯杆 + 暖光晕
  for (let i = 0; i < 10; i++) {
    const zz = 40 - i * 9;
    for (const sx of [-7.6, 7.6]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 4.2, 6), mat(0x3a3a3e));
      pole.position.set(sx, 2.1, zz);
      scene.add(pole);
      const head = makeGlowSprite(0xffd9a0, 3.2, 0.85 * (0.35 + nightK * 0.9));
      head.position.set(sx, 4.3, zz);
      scene.add(head);
    }
  }
  // 行道树
  for (let i = 0; i < 8; i++) {
    const zz = 38 - i * 11;
    for (const sx of [-8.9, 8.9]) {
      scene.add(makeTree(sx + (rnd() - 0.5), zz, 0, { crownColor: 0x3f5a34, trunkH: 2.6, crownR: 1.5 }));
    }
  }
  mountainRing(scene, 0x4a4a5a, 5, 180, 280, 20, 40);
  return {
    spawn: { pos: [0, 0, 40], yaw: Math.PI }, boundR: 58, groundHeight: () => 0,
    colliders,
    hotspots: [
      { pos: [0, 0, 20], name: '广场', desc: '人流如水，你是其中一滴。' },
      { pos: [-10, 0, 10], name: '老街角', desc: '霓虹下，谁没点故事。' },
      { pos: [12, 0, 0], name: '天桥', desc: '站高看车流，像看自己的焦虑。' },
      { pos: [0, 0, -25], name: '十字路口', desc: '往哪走都行，反正都通。' },
      { pos: [-8, 0, -45], name: '夜市', desc: '烟火气最能抚凡人心。' },
    ],
  };
}

// 类型 → builder 映射
const TYPE_BUILDERS = {
  mountain: buildMountain,
  water: buildWater,
  town: buildTown,
  garden: buildGarden,
  coast: buildCoast,
  city: buildCity,
  // 别名映射（各自走不同地貌变体）
  snow:   (s, t, a, sd) => buildMountain(s, t, a, sd, 'snow'),
  forest: (s, t, a, sd) => buildMountain(s, t, a, sd, 'forest'),
  desert: (s, t, a, sd) => buildMountain(s, t, a, sd, 'desert'),
  island: buildCoast,
  temple: buildGarden, park: buildGarden, ruin: buildTown, modern: buildCity,
};

// 精游映射：city|spot → spotId（app.js 查）
export const PRO_SCENES = {
  '无锡|鼋头渚': 'yuantouzhu',
  '无锡|梅园': 'meiyuan',
  '无锡|三国水浒城': 'sanguo',
  '无锡|惠山古镇': 'huishan',
};

// 给 app.js 用的 seed 工具
export function spotSeed(name) { return hashStr(name); }
