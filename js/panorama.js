// ═══ 真实全景查看器（Three.js）═══
// sphere：等距柱状 2:1 → 球面贴图，拖动 360° 环视 + 滚轮变焦
// wide  ：宽幅拼接     → 平面贴图，横向拖拽环视 + 滚轮变焦
// 纹理来自 Wikimedia（带 CORS 头），加载失败自动降级为平面图片。
import * as THREE from 'three';

let S = null;   // 当前全景会话状态
// 打开全景前焦点所在的元素，关闭时还回去。
// 全景浮层不是 .modal，dialog.js 的统一焦点层管不到它，这里得自己记账。
let returnFocus = null;
// 当前查看器的键盘动作（转视角 / 平移 / 缩放）。浮层只负责"这些键归我"，
// 具体怎么做由 WebGL、2D 降级各自填——这样贴图挂了降级时不会出现两套监听互相吞事件。
let keyHandler = null;
const PANO_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  '+', '=', '-', '_', 'Add', 'Subtract']);

function overlay() {
  let box = document.getElementById('pano-overlay');
  if (box) return box;
  box = document.createElement('div');
  box.id = 'pano-overlay';
  box.className = 'pano-overlay';
  box.hidden = true;
  // 对话框语义。缺了 role / aria-modal，读屏软件只会把它当成页面里多出来的一段 div，
  // 打开全景既不播报、也不会让人忽略背后那层内容；.pano-stage 可聚焦（tabindex=0），
  // 才算给键盘用户一个"画布"本身——只靠 document 级方向键的话，屏幕上没有任何焦点位置。
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.innerHTML =
    '<div class="pano-bar">' +
      '<span class="pano-title" id="pano-title"></span>' +
      '<span class="pano-tag"></span>' +
      '<button class="pano-close" aria-label="关闭全景">×</button>' +
    '</div>' +
    '<div class="pano-stage" tabindex="0" role="group" aria-label="全景画面"></div>' +
    '<div class="pano-hint" id="pano-hint">拖动或方向键环视 · 滚轮 / ＋－ 缩放 · ESC 关闭</div>';
  box.setAttribute('aria-labelledby', 'pano-title');
  box.setAttribute('aria-describedby', 'pano-hint');
  document.body.appendChild(box);
  box.querySelector('.pano-close').addEventListener('click', closePanorama);
  box.addEventListener('click', e => { if (e.target === box) closePanorama(); });

  // Tab 在浮层内循环：关闭按钮 ↔ 画面。
  // 不拦的话 Tab 会跑到背后被遮住的「进入 3D 漫游」等按钮上，用户看不见却按得到。
  box.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || box.hidden) return;
    const items = [...box.querySelectorAll('button:not([disabled]), [tabindex="0"]')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const inside = box.contains(document.activeElement);
    if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
  });

  // 浮层开着的时候，方向键/加减号一律归全景，不许漏到背后那层去。
  // 挂在 document 捕获阶段：详情页的「← → 翻上一处」注册得更早，同在冒泡阶段会先跑，
  // 结果是"转视角"和"换景点"同时发生（实测在全景里按两下方向键景点就被换走了）。
  document.addEventListener('keydown', e => {
    if (box.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePanorama();
      return;
    }
    if (!PANO_KEYS.has(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (keyHandler) keyHandler(e);
  }, true);
  return box;
}

// 底部提示随实际可用的操作走：降级成静态图时还写"滚轮缩放"就是骗人
function setHint(text) {
  const h = document.getElementById('pano-hint');
  if (h) h.textContent = text;
}

// ── 打开 ──
export function openPanorama(opts) {
  if (!opts || !opts.url) return;
  // 先记触发元素再关上一场：closePanorama 会把焦点还给它自己那次的触发元素，
  // 记晚了就会把「上一处景点」的按钮当成这次要还焦点的目标。
  const ae = document.activeElement;
  const trigger = ae && typeof ae.focus === 'function' ? ae : null;
  closePanorama();
  const box = overlay();
  const stage = box.querySelector('.pano-stage');
  stage.innerHTML = '';
  keyHandler = null;   // 上一场可能降级成了别的查看器，先清空
  box.querySelector('.pano-title').textContent = opts.title || '实景全景';
  box.querySelector('.pano-tag').textContent = opts.type === 'sphere' ? '360° 全景' : '宽幅全景';
  box.hidden = false;
  document.body.style.overflow = 'hidden';
  returnFocus = trigger;
  // 等这一帧的画布/降级图落位再落焦点。落空会让 aria-modal 变成一句空话：
  // 读屏软件宣布"对话开始"，焦点却还在背后的按钮上。
  requestAnimationFrame(() => {
    if (box.hidden) return;
    if (!box.contains(document.activeElement)) stage.focus({ preventScroll: true });
  });

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
      // 先摘掉 WebGL 那套键盘动作：相机和贴图马上要被丢弃，
      // 留着的话降级后的 2D 环视会被它顶掉（浮层只认一个 keyHandler）。
      keyHandler = null;
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
  // 缩放：滚轮与 ＋/－ 键共用一处，免得两套边界值慢慢跑偏
  const zoomBy = delta => {
    camera.fov = Math.max(30, Math.min(100, camera.fov + delta));
    camera.updateProjectionMatrix();
  };
  // 宽幅型的横向平移。范围与拖拽一致（半幅减去半屏可见宽），
  // 键盘步长按"可见宽度的 14%"算，缩到不同 fov 下手感一致。
  const panStep = dir => {
    const halfVis = Math.abs(camera.position.z) * Math.tan((camera.fov * Math.PI / 180) / 2) * camera.aspect;
    const halfPlane = 10 * (mesh.scale.x / 2);
    const lim = Math.max(0, halfPlane - halfVis);
    panX = Math.max(-lim, Math.min(lim, panX + dir * halfVis * 0.28));
    camera.position.x = panX;
    camera.lookAt(panX, 0, 0);
  };
  el.addEventListener('wheel', e => {
    e.preventDefault();
    zoomBy(e.deltaY > 0 ? 3 : -3);
  }, { passive: false });

  // 原实现只有左右两颗键，且宽幅型走的是 lookAt、根本不读 yaw ——
  // 62/88 处全景是宽幅，方向键对它们等于没反应；上下与缩放则完全没有。
  // 这里只描述"按了键怎么动"，按键的拦截与冒泡由浮层统一负责。
  keyHandler = e => {
    switch (e.key) {
      case 'ArrowLeft':
        if (sphere) { yaw += 0.12; camera.rotation.set(pitch, yaw, 0); } else panStep(-1);
        break;
      case 'ArrowRight':
        if (sphere) { yaw -= 0.12; camera.rotation.set(pitch, yaw, 0); } else panStep(1);
        break;
      case 'ArrowUp':
        if (sphere) { pitch = Math.min(1.45, pitch + 0.1); camera.rotation.set(pitch, yaw, 0); }
        else zoomBy(-3);
        break;
      case 'ArrowDown':
        if (sphere) { pitch = Math.max(-1.45, pitch - 0.1); camera.rotation.set(pitch, yaw, 0); }
        else zoomBy(3);
        break;
      case '+': case '=': case 'Add': zoomBy(-4); break;
      case '-': case '_': case 'Subtract': zoomBy(4); break;
      default: break;
    }
  };

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
  setHint('拖动或 ← → 环视 · ESC 关闭');
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
  // 键盘环视：只描述"按了键怎么动"，拦截在浮层那层统一做。
  // 之前这条降级路径只有拖拽，WebGL 不可用时键盘用户看到的就是一张不动的图。
  keyHandler = e => {
    if (!period) return;
    const step = Math.max(40, (stage.clientWidth || 800) * 0.14);
    if (e.key === 'ArrowLeft') off = ((off - step) % period + period) % period;
    else if (e.key === 'ArrowRight') off = ((off + step) % period + period) % period;
    else return;
    img.style.transform = 'translateX(' + (-off) + 'px)';
  };
  // 清理时移除 resize 监听（keyHandler 由 closePanorama 统一清空）
  const obs = new MutationObserver(() => {
    if (!document.body.contains(wrap)) { window.removeEventListener('resize', measure); obs.disconnect(); }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

// ── 降级：加载失败时显示平面照片 ──
function fallback(stage, url) {
  setHint('实景照片 · ESC 关闭');
  keyHandler = null;   // 静态照片没有可转的视角，方向键别假装能用
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
// 关掉后把焦点还回触发它的按钮：否则焦点会停在已被 hidden 的浮层里，
// 读屏用户按完 ESC 就"失联"，下一次 Tab 从文档开头重新数起。
export function closePanorama() {
  if (S) { S.close(); S = null; }
  const box = document.getElementById('pano-overlay');
  if (box) { box.hidden = true; box.querySelector('.pano-stage').innerHTML = ''; }
  document.body.style.overflow = '';
  keyHandler = null;
  const rt = returnFocus;
  returnFocus = null;
  if (rt && document.contains(rt)) rt.focus({ preventScroll: true });
}
