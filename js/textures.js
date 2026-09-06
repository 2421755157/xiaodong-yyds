// ═══ 程序化纹理库（纯 Canvas 生成，零外部资源）═══
// 目的：让场景摆脱"纯色塑料感"，用噪声/斑驳/法线贴图提升真实度。
import * as THREE from 'three';

const cache = new Map();
const memo = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};

// ─── 可平铺 value noise ───
function hash2(x, y, s) {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 362437);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967295;
}
const smooth = t => t * t * (3 - 2 * t);

function vnoise(x, y, s, period) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = smooth(x - xi), v = smooth(y - yi);
  const p = Math.max(1, period | 0);
  const x0 = ((xi % p) + p) % p, x1 = ((xi + 1) % p + p) % p;
  const y0 = ((yi % p) + p) % p, y1 = ((yi + 1) % p + p) % p;
  const a = hash2(x0, y0, s), b = hash2(x1, y0, s);
  const c = hash2(x0, y1, s), d = hash2(x1, y1, s);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function fbm(x, y, s, oct, period) {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    v += amp * vnoise(x * f, y * f, s + i * 101, period * f);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return v / norm;
}

function mkCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function finish(canvas, repeat, srgb) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ─── 漫反射色斑纹理 ───
// kind 决定噪声形态；base 是 [r,g,b] 0-1
function colorNoiseTex(key, base, o = {}) {
  return memo(key, () => {
    const size = o.size || 128;
    const c = mkCanvas(size), g = c.getContext('2d');
    const img = g.createImageData(size, size);
    const d = img.data;
    const scale = o.scale || 16;     // 噪声块大小（像素）
    const oct = o.oct || 4;
    const seed = o.seed || 3;
    const amp = o.amp != null ? o.amp : 0.45;
    const grain = o.grain != null ? o.grain : 0.06;
    const tint = o.tint || null;     // [r,g,b] 叠加色，按噪声混入
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const n = fbm(x / scale, y / scale, seed, oct, Math.max(2, (size / scale) | 0));
        let k = 1 - amp * 0.5 + n * amp;
        k += (hash2(x, y, 91) - 0.5) * grain;
        let r = base[0] * k, gg = base[1] * k, b = base[2] * k;
        if (tint) {
          const m = Math.pow(n, o.tintPow || 1.6) * (o.tintAmt != null ? o.tintAmt : 0.5);
          r = r * (1 - m) + tint[0] * m;
          gg = gg * (1 - m) + tint[1] * m;
          b = b * (1 - m) + tint[2] * m;
        }
        const i = (y * size + x) * 4;
        d[i] = Math.min(255, Math.max(0, r * 255)) | 0;
        d[i + 1] = Math.min(255, Math.max(0, gg * 255)) | 0;
        d[i + 2] = Math.min(255, Math.max(0, b * 255)) | 0;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  });
}

// ─── 凹凸（灰度高度场）───
function bumpTex(key, o = {}) {
  return memo('bump:' + key, () => {
    const size = o.size || 128;
    const c = mkCanvas(size), g = c.getContext('2d');
    const img = g.createImageData(size, size);
    const d = img.data;
    const scale = o.scale || 12, oct = o.oct || 4, seed = o.seed || 11;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let n = fbm(x / scale, y / scale, seed, oct, Math.max(2, (size / scale) | 0));
        if (o.crack) {
          // 裂纹：噪声脊线
          const e = Math.abs(n - 0.5);
          n = n * 0.72 + Math.pow(1 - e * 2, 6) * 0.28;
        }
        const v = Math.min(255, Math.max(0, n * 255)) | 0;
        const i = (y * size + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  });
}

// ─── 对外：各类地表纹理 ───
const hexToRGB = h => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

export function groundTexture(kind, seed = 3) {
  const cfg = {
    grass: { base: [0.19, 0.32, 0.16], tint: [0.34, 0.44, 0.18], amp: 0.55, scale: 10, tintAmt: 0.55 },
    dirt:  { base: [0.34, 0.27, 0.19], tint: [0.46, 0.38, 0.27], amp: 0.5, scale: 13, tintAmt: 0.5 },
    rock:  { base: [0.36, 0.35, 0.33], tint: [0.52, 0.51, 0.48], amp: 0.5, scale: 9, tintAmt: 0.45 },
    sand:  { base: [0.70, 0.62, 0.45], tint: [0.80, 0.72, 0.55], amp: 0.35, scale: 14, tintAmt: 0.5 },
    snow:  { base: [0.82, 0.86, 0.92], tint: [0.98, 0.99, 1.0], amp: 0.28, scale: 16, tintAmt: 0.6 },
    stone: { base: [0.44, 0.43, 0.40], tint: [0.58, 0.57, 0.53], amp: 0.45, scale: 8, tintAmt: 0.4 },
    wood:  { base: [0.30, 0.21, 0.14], tint: [0.42, 0.30, 0.19], amp: 0.4, scale: 22, tintAmt: 0.5 },
    wall:  { base: [0.76, 0.74, 0.68], tint: [0.62, 0.60, 0.54], amp: 0.3, scale: 18, tintAmt: 0.4 },
    roof:  { base: [0.16, 0.16, 0.17], tint: [0.28, 0.28, 0.30], amp: 0.35, scale: 8, tintAmt: 0.4 },
  }[kind] || { base: [0.3, 0.3, 0.3] };
  return colorNoiseTex(kind + ':' + seed, cfg.base, Object.assign({ seed }, cfg));
}

// 木纹：横向条带
export function woodTexture(seed = 5) {
  return memo('wood:' + seed, () => {
    const size = 128, c = mkCanvas(size), g = c.getContext('2d');
    const img = g.createImageData(size, size), d = img.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const warp = fbm(x / 26, y / 6, seed, 3, 8) * 5;
        const rings = Math.sin((y + warp) * 0.55) * 0.5 + 0.5;
        const n = fbm(x / 6, y / 6, seed + 9, 3, 16);
        const k = 0.55 + rings * 0.3 + n * 0.2;
        const i = (y * size + x) * 4;
        d[i] = Math.min(255, 0.34 * k * 255) | 0;
        d[i + 1] = Math.min(255, 0.23 * k * 255) | 0;
        d[i + 2] = Math.min(255, 0.15 * k * 255) | 0;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  });
}

// 瓦片：横向排列的半圆柱亮暗
export function roofTexture(seed = 7) {
  return memo('roof:' + seed, () => {
    const size = 128, c = mkCanvas(size), g = c.getContext('2d');
    const img = g.createImageData(size, size), d = img.data;
    const cols = 10, cw = size / cols;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const cx = (x % cw) / cw;
        const arc = Math.sin(cx * Math.PI);          // 瓦当弧面
        const row = Math.floor(y / 16) % 2 ? 0.5 : 0; // 错缝
        const n = fbm(x / 7, y / 7, seed, 3, 16);
        const k = (0.32 + arc * 0.55 + n * 0.18) * (row ? 0.88 : 1);
        const i = (y * size + x) * 4;
        d[i] = Math.min(255, k * 78) | 0;
        d[i + 1] = Math.min(255, k * 80) | 0;
        d[i + 2] = Math.min(255, k * 88) | 0;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  });
}

// 白墙：斑驳
export function wallTexture(seed = 13) {
  return memo('wall:' + seed, () => {
    const size = 128, c = mkCanvas(size), g = c.getContext('2d');
    const img = g.createImageData(size, size), d = img.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const n = fbm(x / 20, y / 20, seed, 4, 8);
        const stain = Math.pow(fbm(x / 7, y / 30, seed + 5, 3, 16), 2) * 0.35;
        const grain = (hash2(x, y, 3) - 0.5) * 0.05;
        const k = 0.78 + n * 0.24 - stain + grain;
        const i = (y * size + x) * 4;
        d[i] = Math.min(255, k * 235) | 0;
        d[i + 1] = Math.min(255, k * 230) | 0;
        d[i + 2] = Math.min(255, k * 214) | 0;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  });
}

// ─── 楼宇立面：窗格 + 随机亮灯（同时用作 map 与 emissiveMap）───
export function buildingTexture(seed = 1) {
  return memo('bldg:' + seed, () => {
    const size = 128, c = mkCanvas(size), g = c.getContext('2d');
    // 底色：玻璃幕墙
    g.fillStyle = '#1b222c';
    g.fillRect(0, 0, size, size);
    const cols = 8, rows = 10, cw = size / cols, ch = size / rows;
    const pad = 1.6;
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const lit = hash2(col * 3 + seed, r * 5 + seed * 2, 41) > 0.42;
        const warm = hash2(col * 7 + 3, r * 11 + 5, 43);
        if (lit) {
          const l = 0.55 + hash2(col, r, 47) * 0.45;
          const cr = 255 * l, cg = (200 + warm * 45) * l, cb = (130 + warm * 60) * l;
          g.fillStyle = 'rgb(' + (cr | 0) + ',' + (cg | 0) + ',' + (cb | 0) + ')';
        } else {
          const l = 0.16 + hash2(col + 9, r + 4, 51) * 0.16;
          g.fillStyle = 'rgb(' + (46 * l * 3 | 0) + ',' + (58 * l * 3 | 0) + ',' + (74 * l * 3 | 0) + ')';
        }
        g.fillRect(col * cw + pad, r * ch + pad, cw - pad * 2, ch - pad * 2);
      }
    }
    // 楼层分隔线
    g.strokeStyle = 'rgba(10,12,16,0.85)';
    g.lineWidth = 1;
    for (let r = 0; r <= rows; r++) {
      g.beginPath(); g.moveTo(0, r * ch); g.lineTo(size, r * ch); g.stroke();
    }
    return c;
  });
}

// ─── 水面法线贴图（可平铺，多层正弦叠加）───
export function waterNormalTexture(size = 256) {
  return memo('waterN:' + size, () => {
    const c = mkCanvas(size), g = c.getContext('2d');
    const img = g.createImageData(size, size), d = img.data;
    const H = (x, y) => {
      const u = x / size * Math.PI * 2, v = y / size * Math.PI * 2;
      let h = 0;
      h += Math.sin(u * 3 + Math.cos(v * 2) * 1.3) * 0.5;
      h += Math.sin(v * 4 - Math.cos(u * 3) * 1.1) * 0.32;
      h += Math.sin((u + v) * 5) * 0.18;
      h += Math.sin((u - v) * 8 + 1.7) * 0.09;
      return h;
    };
    const e = 1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const hx = H(x + e, y) - H(x - e, y);
        const hy = H(x, y + e) - H(x, y - e);
        const nx = -hx * 1.6, ny = -hy * 1.6, nz = 1;
        const len = Math.hypot(nx, ny, nz);
        const i = (y * size + x) * 4;
        d[i] = ((nx / len) * 0.5 + 0.5) * 255 | 0;
        d[i + 1] = ((ny / len) * 0.5 + 0.5) * 255 | 0;
        d[i + 2] = ((nz / len) * 0.5 + 0.5) * 255 | 0;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  });
}

// ─── 叶片/草丛 alpha 贴图（一簇草）───
export function grassBladeTexture(size = 64) {
  return memo('blade:' + size, () => {
    const c = mkCanvas(size), g = c.getContext('2d');
    g.clearRect(0, 0, size, size);
    const n = 9;
    for (let i = 0; i < n; i++) {
      const x0 = 6 + (i / (n - 1)) * (size - 12) + (hash2(i, 3, 1) - 0.5) * 5;
      const lean = (hash2(i, 7, 2) - 0.5) * 16;
      const h = size * (0.5 + hash2(i, 11, 3) * 0.45);
      const w = 2 + hash2(i, 13, 4) * 2.2;
      const grd = g.createLinearGradient(x0, size, x0 + lean, size - h);
      const lum = 0.35 + hash2(i, 17, 5) * 0.35;
      grd.addColorStop(0, 'rgba(' + (28 * lum * 2 | 0) + ',' + (58 * lum * 2 | 0) + ',' + (26 * lum * 2 | 0) + ',0.95)');
      grd.addColorStop(0.7, 'rgba(' + (48 * lum * 2 | 0) + ',' + (92 * lum * 2 | 0) + ',' + (40 * lum * 2 | 0) + ',0.95)');
      grd.addColorStop(1, 'rgba(' + (86 * lum * 2 | 0) + ',' + (128 * lum * 2 | 0) + ',' + (62 * lum * 2 | 0) + ',0.75)');
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(x0 - w / 2, size);
      g.quadraticCurveTo(x0 - w / 2 + lean * 0.4, size - h * 0.6, x0 + lean, size - h);
      g.quadraticCurveTo(x0 + w / 2 + lean * 0.4, size - h * 0.6, x0 + w / 2, size);
      g.closePath();
      g.fill();
    }
    return c;
  });
}

// ─── 树冠 alpha 贴图（团状叶簇，让树不那么"球"）───
export function leafClumpTexture(size = 128) {
  return memo('leaf:' + size, () => {
    const c = mkCanvas(size), g = c.getContext('2d');
    g.clearRect(0, 0, size, size);
    for (let i = 0; i < 26; i++) {
      const a = hash2(i, 1, 21) * Math.PI * 2;
      const r = Math.pow(hash2(i, 2, 22), 0.6) * size * 0.36;
      const x = size / 2 + Math.cos(a) * r;
      const y = size / 2 + Math.sin(a) * r * 0.85;
      const rad = size * (0.09 + hash2(i, 3, 23) * 0.11);
      const lum = 0.62 + hash2(i, 4, 24) * 0.38;
      const grd = g.createRadialGradient(x - rad * 0.3, y - rad * 0.3, 0, x, y, rad);
      grd.addColorStop(0, 'rgba(' + (150 * lum | 0) + ',' + (190 * lum | 0) + ',' + (110 * lum | 0) + ',1)');
      grd.addColorStop(0.65, 'rgba(' + (92 * lum | 0) + ',' + (126 * lum | 0) + ',' + (66 * lum | 0) + ',0.98)');
      grd.addColorStop(1, 'rgba(40,64,32,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }
    return c;
  });
}

// ─── 统一取纹理对象（带 repeat）───
export function tex(kind, repeat = 4, seed = 3) {
  return memo('T:' + kind + ':' + repeat + ':' + seed, () => finish(groundTexture(kind, seed), repeat, true));
}
export function bump(kind, repeat = 4, scale = 0.35) {
  return memo('B:' + kind + ':' + repeat + ':' + scale, () => {
    const t = finish(bumpTex(kind, { crack: kind === 'rock' || kind === 'stone' }), repeat, false);
    return t;
  });
}
export function repeatTex(canvas, repeat, srgb = true) {
  return finish(canvas, repeat, srgb);
}

// ─── 材质工厂：带纹理的标准材质 ───
export function surfaceMat(kind, color, opt = {}) {
  const repeat = opt.repeat || 6;
  const m = new THREE.MeshStandardMaterial({
    color,
    map: tex(kind, repeat, opt.seed || 3),
    bumpMap: opt.noBump ? null : bump(kind, repeat),
    bumpScale: opt.bumpScale != null ? opt.bumpScale : 0.35,
    roughness: opt.roughness != null ? opt.roughness : 0.92,
    metalness: opt.metalness != null ? opt.metalness : 0.0,
    flatShading: !!opt.flatShading,
    side: opt.side || THREE.FrontSide,
    transparent: !!opt.transparent,
    opacity: opt.opacity != null ? opt.opacity : 1,
  });
  return m;
}

export { fbm, vnoise, hash2, hexToRGB, finish };
