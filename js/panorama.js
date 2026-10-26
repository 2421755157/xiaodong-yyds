// ═══ 真实全景查看器（Three.js）═══
// sphere：等距柱状 2:1 → 球面贴图，拖动 360° 环视 + 滚轮变焦
// wide  ：宽幅拼接     → 平面贴图，横向拖拽环视 + 滚轮变焦
// 纹理来自 Wikimedia（带 CORS 头），加载失败自动降级为平面图片。
import * as THREE from 'three';

let S = null;   // 当前全景会话状态

function overlay() {
  let box = document.getElementById('pano-overlay');
  if (box) return box;
  box = document.createElement('div');
  box.id = 'pano-overlay';
  box.className = 'pano-overlay';
  box.hidden = true;
  box.innerHTML =
    '<div class="pano-bar">' +
      '<span class="pano-title"></span>' +
      '<span class="pano-tag"></span>' +
      '<button class="pano-close" aria-label="关闭">×</button>' +
    '</div>' +
    '<div class="pano-stage"></div>' +
    '<div class="pano-hint">拖动环视 · 滚轮缩放 · ESC 关闭</div>';
  document.body.appendChild(box);
  box.querySelector('.pano-close').addEventListener('click', closePanorama);
  box.addEventListener('click', e => { if (e.target === box) closePanorama(); });
  return box;
}

// ── 打开 ──
export function openPanorama(opts) {
  if (!opts || !opts.url) return;
  closePanorama();
  const box = overlay();
  const stage = box.querySelector('.pano-stage');
  stage.innerHTML = '';
  box.querySelector('.pano-title').textContent = opts.title || '实景全景';
  box.querySelector('.pano-tag').textContent = opts.type === 'sphere' ? '360° 全景' : '宽幅全景';
  box.hidden = false;
  document.body.style.overflow = 'hidden';

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  } catch (e) {
    fallback(stage, opts.url);
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(stage.clientWidth || 800, stage.clientHeight || 600);
  renderer.domElement.className = 'pano-canvas';
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, (stage.clientWidth || 800) / (stage.clientHeight || 600), 0.1, 2000);

  const texLoader = new THREE.TextureLoader();
  texLoader.setCrossOrigin('anonymous');
  let mesh = null;
  const sphere = opts.type !== 'wide';
  let panX = 0, yaw = 0, pitch = 0;

  const tex = texLoader.load(
    opts.url,
    () => { /* 载入完成 */ },
    undefined,
    () => {
      // 跨域受限（无 CORS 头）→ 退回 2D 环视，仍可左右拖动看全景
      renderer.dispose();
      stage.innerHTML = '';
      if (sphere) openPano2D(stage, opts.url);
      else fallback(stage, opts.url);
    }
  );
  tex.colorSpace = THREE.SRGBColorSpace;

  if (sphere) {
    // 球面：贴图内翻，站在球心环视
    const geo = new THREE.SphereGeometry(100, 64, 40);
    geo.scale(-1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    camera.rotation.order = 'YXZ';
  } else {
    // 宽幅：平面，可横向拖拽
    const geo = new THREE.PlaneGeometry(20, 20);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
    mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    const asp = (opts.w && opts.h) ? opts.w / opts.h : 4;
    mesh.scale.set(asp, 1, 1);
    const dist = 12 / Math.tan((camera.fov * Math.PI / 180) / 2);
    camera.position.set(0, 0, dist);
    camera.lookAt(0, 0, 0);
  }

  // ── 交互 ──
  let dragging = false, lx = 0, ly = 0;
  const el = renderer.domElement;
  const down = e => { dragging = true; lx = e.clientX; ly = e.clientY; el.setPointerCapture && el.setPointerCapture(e.pointerId); };
  const move = e => {
    if (!dragging) return;
    const dx = e.clientX - lx, dy = e.clientY - ly;
    lx = e.clientX; ly = e.clientY;
    if (sphere) {
      yaw -= dx * 0.16;
      pitch = Math.max(-1.45, Math.min(1.45, pitch - dy * 0.16));
      camera.rotation.set(pitch, yaw, 0);
    } else {
      const halfVis = Math.abs(camera.position.z) * Math.tan((camera.fov * Math.PI / 180) / 2) * camera.aspect;
      const halfPlane = 10 * (mesh.scale.x / 2);
      panX = Math.max(-Math.max(0, halfPlane - halfVis), Math.min(Math.max(0, halfPlane - halfVis), panX - dx * halfVis * 2 / (el.clientWidth || 1)));
      camera.position.x = panX;
      camera.lookAt(panX, 0, 0);
    }
  };
  const up = () => { dragging = false; };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
  el.addEventListener('wheel', e => {
    e.preventDefault();
    const f = camera.fov + (e.deltaY > 0 ? 3 : -3);
    camera.fov = Math.max(30, Math.min(100, f));
    camera.updateProjectionMatrix();
  }, { passive: false });

  const onKey = e => {
    if (e.key === 'Escape') closePanorama();
    else if (e.key === 'ArrowLeft') { yaw += 0.25; camera.rotation.set(pitch, yaw, 0); }
    else if (e.key === 'ArrowRight') { yaw -= 0.25; camera.rotation.set(pitch, yaw, 0); }
  };
  document.addEventListener('keydown', onKey);

  const onResize = () => {
    const w = stage.clientWidth || 800, h = stage.clientHeight || 600;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);

  let raf = 0;
  const loop = () => { raf = requestAnimationFrame(loop); renderer.render(scene, camera); };
  loop();

  S = {
    close() {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('pointerleave', up);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      if (mesh) { mesh.geometry.dispose(); if (mesh.material.map) mesh.material.map.dispose(); mesh.material.dispose(); }
      renderer.dispose();
      stage.innerHTML = '';
    },
  };
}

// ── 降级方案：等距柱状图的 2D 环视（无需 WebGL / CORS）──
// 原理：图宽是视口的两倍，横向拖动半个图宽 = 转过 180°，循环拖动即 360° 环视
function openPano2D(stage, url) {
  const wrap = document.createElement('div');
  wrap.className = 'pano2d';
  const img = document.createElement('img');
  img.className = 'pano2d-img';
  img.alt = '实景全景';
  // 图加载不出来（服务未开通 / 无数据 / 配额耗尽）→ 提示而非空白拖拽区
  img.addEventListener('error', () => { wrap.remove(); showPanoError(stage); }, { once: true });
  img.src = url;
  wrap.appendChild(img);
  stage.appendChild(wrap);
  let off = 0, dragging = false, lx = 0, period = 0;
  const measure = () => {
    const W = stage.clientWidth || 800;
    img.style.width = (W * 2) + 'px';
    img.style.height = 'auto';
    period = W;          // 半个图宽 = 180°
    off = ((off % period) + period) % period;
    img.style.transform = 'translateX(' + (-off) + 'px)';
  };
  const onDown = e => { dragging = true; lx = e.clientX; };
  const onMove = e => {
    if (!dragging) return;
    const dx = e.clientX - lx;
    lx = e.clientX;
    off = ((off - dx) % period + period) % period;
    img.style.transform = 'translateX(' + (-off) + 'px)';
  };
  const onUp = () => { dragging = false; };
  wrap.addEventListener('pointerdown', onDown);
  wrap.addEventListener('pointermove', onMove);
  wrap.addEventListener('pointerup', onUp);
  wrap.addEventListener('pointercancel', onUp);
  wrap.addEventListener('pointerleave', onUp);
  img.addEventListener('load', measure);
  window.addEventListener('resize', measure);
  setTimeout(measure, 60);
  // 清理时移除 resize 监听
  const obs = new MutationObserver(() => {
    if (!document.body.contains(wrap)) { window.removeEventListener('resize', measure); obs.disconnect(); }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

// ── 降级：加载失败时显示平面照片 ──
function fallback(stage, url) {
  const img = document.createElement('img');
  img.className = 'pano-fallback';
  img.alt = '实景照片';
  // 接口失败时返回的是 JSON 错误体而非图片 → 走 onerror 显示提示，而不是破图
  img.onerror = () => { img.remove(); showPanoError(stage); };
  img.src = url;
  stage.appendChild(img);
}

// ── 没有实景数据时的明确提示 ──
// 触发场景：接口服务未开通（240）、该坐标无全景数据（404）、配额耗尽（402）
function showPanoError(stage) {
  const box = document.createElement('div');
  box.className = 'pano-error';
  box.innerHTML = '<div class="pano-error-title">该景点暂无可用实景数据</div>'
    + '<div class="pano-error-sub">可能是该位置没有覆盖街景，或地图服务配额已用尽</div>';
  stage.appendChild(box);
}

// ── 关闭 ──
export function closePanorama() {
  if (S) { S.close(); S = null; }
  const box = document.getElementById('pano-overlay');
  if (box) { box.hidden = true; box.querySelector('.pano-stage').innerHTML = ''; }
  document.body.style.overflow = '';
}

export function panoramaOpen() { return !!S; }
