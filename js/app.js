// ═══ 夜游神 · 主逻辑（全国版：省→市→景点）═══
import * as THREE from 'three';
import { store, titleFor } from './store.js';
import { PROVINCES, SPOT_TYPE, stats } from './china-data.js';
import { buildScene, resolveTheme, THEME_ORDER, themeLabel, PRO_SCENES, spotSeed, setQuality } from './scenes.js';
import { Roamer, isMobile } from './roam.js';
import { analyzeToday, drawMoodCard } from './mood.js';
import { FORTUNES, greetingFor, SPOT_MEMES, expandDesc, pickN } from './lexicon.js';
import { getSpotImages, getSpotCover } from './spot-images.js';
import { SPOT_DESC_DB } from './spot-desc-db.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const $ = s => document.querySelector(s);

// ═══ 景点真实简介（维基词条首段静态库）优先，手写 d 字段作为回退 ═══
function realDesc(spot) {
  return SPOT_DESC_DB[spot.n] || spot.d || '';
}
// 卡片摘要：取首句、限长，避免长段落撑破卡片
function shortDesc(spot, max = 44) {
  let t = (realDesc(spot) || '').replace(/\s+/g, '');
  const stop = t.indexOf('。');
  if (stop > 12 && stop < max) t = t.slice(0, stop + 1);
  else if (t.length > max) t = t.slice(0, max) + '…';
  return t;
}
const MOOD_EMOJI = ['', '😭', '😔', '😐', '🙂', '😄'];
const MOOD_COLOR = ['', 0x7a9ac9, 0x8fb8c9, 0xb8b8a8, 0xd3b98a, 0xf0c86a];

// 导航状态：{ level: 'prov'|'city'|'spot', prov?, city? }
let nav = { level: 'prov' };

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._tm);
  toast._tm = setTimeout(() => { t.hidden = true; }, ms);
}

// ═════════ 登录屏粒子 ═════════
function startGateParticles() {
  const cv = $('#gate-particles');
  const g = cv.getContext('2d');
  let W, H, pts = [];
  function resize() {
    W = cv.width = innerWidth; H = cv.height = innerHeight;
    pts = Array.from({ length: 110 }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.8 + 0.4,
      vy: -(Math.random() * 0.25 + 0.06),
      vx: (Math.random() - 0.5) * 0.12,
      a: Math.random() * 0.5 + 0.15, ph: Math.random() * Math.PI * 2,
    }));
  }
  resize(); addEventListener('resize', resize);
  let t = 0;
  (function loop() {
    if ($('#gate').hidden) return;
    requestAnimationFrame(loop); t += 0.016;
    g.clearRect(0, 0, W, H);
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#0b1216'); grd.addColorStop(0.6, '#0b100f'); grd.addColorStop(1, '#12100c');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    for (const p of pts) {
      p.y += p.vy; p.x += p.vx;
      if (p.y < -4) { p.y = H + 4; p.x = Math.random() * W; }
      const tw = p.a + Math.sin(t * 2 + p.ph) * 0.18;
      g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      g.fillStyle = 'rgba(211,185,138,' + Math.max(0.04, tw) + ')'; g.fill();
    }
  })();
}

function show(id) {
  for (const s of ['#gate', '#home', '#stage']) $(s).hidden = (s !== id);
}

// ═════════ 主页：三级导航 ═════════
function renderHome() {
  const user = store.data.user;
  $('#user-name').textContent = user.name;
  $('#user-title').textContent = titleFor(store.data.footprints.length);
  $('#hero-greet').textContent = greetingFor(new Date().getHours());
  const st = stats();
  $('#hero-line').innerHTML = '把白天的自己寄存在门口，<br>进来走一圈。<br><span style="font-size:14px;color:var(--ink-dim);letter-spacing:1px">已收录 ' + st.provinces + ' 省 · ' + st.cities + ' 市 · ' + st.spots + ' 处风景</span>';
  nav = { level: 'prov' };
  renderNav();
  renderTimeline();
}

// 面包屑 + 内容区
function renderNav() {
  // 面包屑
  const bc = $('#breadcrumb');
  const crumbs = ['<a data-go="prov">全国</a>'];
  if (nav.level !== 'prov') crumbs.push(' › <a data-go="prov">' + nav.prov.n + '</a>');
  if (nav.level === 'spot') crumbs.push(' › <a data-go="city">' + nav.city.n + '</a>');
  bc.innerHTML = crumbs.join('');
  bc.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
    const go = a.dataset.go;
    if (go === 'prov') nav = { level: 'prov' };
    else if (go === 'city') nav = { level: 'city', prov: nav.prov };
    renderNav();
  }));

  const grid = $('#spot-grid');
  grid.innerHTML = '';

  if (nav.level === 'prov') {
    // 省份网格
    for (const p of PROVINCES) {
      const card = document.createElement('div');
      card.className = 'spot-card';
      card.innerHTML =
        '<div class="spot-cover"><div style="position:absolute;inset:0;background:' + p.cover + '"></div>' +
        '<span class="cover-glyph">' + p.c + '</span></div>' +
        '<div class="spot-body"><h4>' + p.n + '</h4><span class="tag">省会 ' + p.cap + '</span>' +
        '<p>' + p.desc + '</p><div class="spot-meta"><span>下辖 <b>' + p.cities.length + '</b> 市</span>' +
        '<span class="spot-enter">进入 →</span></div></div>';
      card.addEventListener('click', () => { nav = { level: 'city', prov: p }; renderNav(); });
      grid.appendChild(card);
    }
  } else if (nav.level === 'city') {
    // 城市网格
    $('#hero-line').innerHTML = nav.prov.desc + '<br><span style="font-size:14px;color:var(--ink-dim)">' + nav.prov.n + ' · ' + nav.prov.cities.length + ' 市</span>';
    for (const c of nav.prov.cities) {
      const card = document.createElement('div');
      card.className = 'spot-card';
      const spotsN = c.spots.length;
      card.innerHTML =
        '<div class="spot-cover"><div style="position:absolute;inset:0;background:' + c.cover + '"></div>' +
        '<span class="cover-glyph">' + c.n.charAt(0) + '</span></div>' +
        '<div class="spot-body"><h4>' + c.n + '</h4><span class="tag">' + nav.prov.n + '</span>' +
        '<p>' + c.desc + '</p><div class="spot-meta"><span><b>' + spotsN + '</b> 处风景</span>' +
        '<span class="spot-enter">查看 →</span></div></div>';
      card.addEventListener('click', () => { nav = { level: 'spot', prov: nav.prov, city: c }; renderNav(); });
      grid.appendChild(card);
    }
  } else {
    // 景点列表
    $('#hero-line').innerHTML = nav.city.desc + '<br><span style="font-size:14px;color:var(--ink-dim)">' + nav.prov.n + ' ' + nav.city.n + ' · ' + nav.city.spots.length + ' 处风景</span>';
    for (const s of nav.city.spots) {
      const typeInfo = SPOT_TYPE[s.t] || SPOT_TYPE.park;
      const isPro = PRO_SCENES[nav.city.n + '|' + s.n];
      const card = document.createElement('div');
      card.className = 'spot-card';
      card.innerHTML =
        '<div class="spot-cover"><img alt="" data-img="' + encodeURIComponent(s.n) + '"><span class="cover-glyph">' + s.n.charAt(0) + '</span></div>' +
        '<div class="spot-body"><h4>' + s.n + '</h4><span class="tag">' + typeInfo.label + (isPro ? ' · 精游' : '') + '</span>' +
        '<p>' + shortDesc(s) + '</p><div class="spot-meta"><span>' + nav.city.n + '</span>' +
        '<span class="spot-enter">详情 →</span></div></div>';
      const img = card.querySelector('img');
      img.src = getSpotCover(s.n, nav.prov.n);
      img.addEventListener('error', () => { img.style.display = 'none'; });
      img.addEventListener('load', () => { img.style.display = 'block'; card.querySelector('.cover-glyph').style.display = 'none'; });
      card.addEventListener('click', () => openSpot(nav.prov, nav.city, s));
      grid.appendChild(card);
    }
  }
}

function renderTimeline() {
  const box = $('#timeline');
  const fps = store.data.footprints.slice().reverse();
  $('#fp-count').textContent = fps.length ? '共 ' + fps.length + ' 枚足迹' : '';
  if (!fps.length) {
    box.innerHTML = '<div class="tl-empty">还没有足迹。选个景点，进入 3D 漫游，按 E 留下第一枚。</div>';
    return;
  }
  box.innerHTML = '';
  for (const f of fps.slice(0, 30)) {
    const d = new Date(f.ts);
    const item = document.createElement('div');
    item.className = 'tl-item';
    const loc = [f.prov, f.city, f.spotName].filter(Boolean).join(' · ') || f.spot;
    item.innerHTML =
      '<div class="tl-when">' + (d.getMonth() + 1) + '月' + d.getDate() + '日<br>' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + '</div>' +
      '<div class="tl-main"><span class="tl-spot">' + (f.spotName || f.spot) + ' ' + MOOD_EMOJI[f.mood] + '</span>' +
      '<div class="tl-text"></div><div class="tl-place">' + loc + ' · ' + (f.place || '') + '</div></div>' +
      '<div class="tl-side"><span class="score">' + f.score + ' 分</span>' +
      '<button class="tl-del" title="抹去这枚足迹">×</button></div>';
    item.querySelector('.tl-text').textContent = f.text || '（什么也没写，就站了一会儿）';
    item.querySelector('.tl-del').addEventListener('click', () => {
      store.removeFootprint(f.id);
      renderTimeline();
      toast('足迹已抹去，就当没发生过');
    });
    box.appendChild(item);
  }
}

// ═════════ 搜索 ═════════
function doSearch() {
  const q = $('#search-input').value.trim();
  const box = $('#search-results');
  if (!q) { box.classList.remove('show'); return; }
  const results = [];
  for (const p of PROVINCES) {
    if (p.n.includes(q) || p.c.includes(q)) results.push({ type: 'prov', prov: p, label: p.n + '（省）', sub: '省会 ' + p.cap + ' · ' + p.cities.length + ' 市' });
    for (const c of p.cities) {
      if (c.n.includes(q)) results.push({ type: 'city', prov: p, city: c, label: c.n + '（市）', sub: p.n + ' · ' + c.spots.length + ' 处风景' });
      for (const s of c.spots) {
        if (s.n.includes(q) || (s.d && s.d.includes(q)) || (SPOT_DESC_DB[s.n] && SPOT_DESC_DB[s.n].includes(q))) {
          results.push({ type: 'spot', prov: p, city: c, spot: s, label: s.n, sub: p.n + ' ' + c.n, tag: (SPOT_TYPE[s.t] || {}).label });
          if (results.length > 50) break;
        }
      }
    }
  }
  if (!results.length) {
    box.innerHTML = '<div class="sr-head">没找到「' + q + '」，换个词试试（已搜 ' + stats().spots + ' 处风景）</div>';
    box.classList.add('show'); return;
  }
  box.innerHTML = '<div class="sr-head">找到 ' + results.length + ' 条结果' + (results.length > 30 ? '（显示前 30）' : '') + '</div>';
  for (const r of results.slice(0, 30)) {
    const it = document.createElement('div');
    it.className = 'sr-item';
    it.innerHTML = '<b>' + r.label + '</b><span>' + r.sub + (r.tag ? ' · ' + r.tag : '') + '</span>';
    it.addEventListener('click', () => {
      box.classList.remove('show');
      $('#search-input').value = '';
      if (r.type === 'prov') { nav = { level: 'city', prov: r.prov }; renderNav(); }
      else if (r.type === 'city') { nav = { level: 'spot', prov: r.prov, city: r.city }; renderNav(); }
      else { openSpot(r.prov, r.city, r.spot); }
    });
    box.appendChild(it);
  }
  box.classList.add('show');
}

// Wikipedia 真实景点图 + 百科摘要（CORS 友好，失败静默）
async function fetchWiki(name) {
  try {
    const r = await fetch('https://zh.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(name) + '?redirect=true');
    if (!r.ok) return {};
    const j = await r.json();
    const img = (j.originalimage && j.originalimage.source) || (j.thumbnail && j.thumbnail.source);
    return { img, extract: j.extract };
  } catch (e) { return {}; }
}

// ═════════ 景点详情弹窗 ═════════
function openSpot(prov, city, spot) {
  const isPro = PRO_SCENES[city.n + '|' + spot.n];
  const typeInfo = SPOT_TYPE[spot.t] || SPOT_TYPE.park;
  const seed = spotSeed(spot.n);
  const cover = store.getCover(prov.n + city.n + spot.n) || store.getCover(city.n + spot.n);
  const coverEl = $('#intro-cover');
  if (cover) {
    coverEl.innerHTML = '<img src="' + cover + '" alt="' + spot.n + '">';
  } else {
    const real = getSpotCover(spot.n, prov.n, spot.t);
    if (real.startsWith('data:')) {
      // 终极降级：主题渐变占位
      coverEl.innerHTML = '<div style="position:absolute;inset:0;background:' + city.cover + '"></div><span class="cover-glyph">' + spot.n.charAt(0) + '</span>';
    } else {
      coverEl.innerHTML = '<img src="' + real + '" alt="' + spot.n + '">';
    }
  }
  const coverImg = coverEl.querySelector('img');
  if (coverImg) coverImg.addEventListener('error', () => {
    coverEl.innerHTML = '<div style="position:absolute;inset:0;background:' + city.cover + '"></div><span class="cover-glyph">' + spot.n.charAt(0) + '</span>';
  });
  $('#intro-name').textContent = spot.n;
  $('#intro-tag').textContent = prov.n + ' · ' + city.n + ' · ' + typeInfo.label + (isPro ? ' · 精游 3D' : '');
  $('#intro-desc').textContent = realDesc(spot);
  // 详细解说（程序化扩写 + 真实简介为底）
  $('#intro-detail').textContent = expandDesc(spot.n, spot.t, realDesc(spot));
  // 网友热梗评价
  const memes = SPOT_MEMES[spot.t] || SPOT_MEMES.park;
  const picked = pickN(memes, Math.min(3, memes.length), seed);
  $('#intro-memes').innerHTML = picked.map(m => '<div class="meme-item">「' + m + '」</div>').join('');
  // 图集 3 张：优先 Wikimedia 真实景点图（静态库），缺失/地区泛图则运行时精搜升级
  const gal = $('#intro-gallery');
  gal.innerHTML = '';
  const caps = ['一隅 · 此景', '二景 · 此处', '三瞥 · 此间'];
  const realImgs = getSpotImages(spot.n, prov.n, 3, spot.t);
  const galImgs = [];
  for (let i = 0; i < 3; i++) {
    const fig = document.createElement('figure');
    fig.innerHTML = '<img alt="' + caps[i] + '"><figcaption>' + caps[i] + '</figcaption>';
    gal.appendChild(fig);
    const img = fig.querySelector('img');
    img.src = realImgs[i];
    img.addEventListener('error', () => { fig.style.background = city.cover; img.style.display = 'none'; });
    galImgs.push(img);
  }
  // 异步补搜：拿到更精准的实景图后替换（含地区泛图升级）
  enrichSpotImages(spot.n, prov.n, spot.t, 3).then(urls => {
    urls.slice(0, 3).forEach((u, i) => { if (galImgs[i] && u && !u.startsWith('data:')) galImgs[i].src = u; });
  });
  // 异步拉取 Wikipedia 百科摘要（仅静态库缺失时补，避免重复请求）
  if (!SPOT_DESC_DB[spot.n]) {
    fetchWiki(spot.n).then(w => {
      if (w.extract) {
        $('#intro-detail').textContent = w.extract + '\n\n' + expandDesc(spot.n, spot.t, spot.d);
      }
    });
  }
  // meta
  $('#intro-meta').innerHTML = [
    ['所在', prov.n + ' ' + city.n],
    ['类型', typeInfo.label],
    ['3D 漫游', isPro ? '专属精游场景' : '类型化通用场景'],
    ['心绪贴士', '适合放空、记录、释放'],
  ].map(([k, v]) => '<div><b>' + k + '</b>' + v + '</div>').join('');
  // 视频
  $('#intro-video').href = 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(prov.n + city.n + spot.n);
  $('#intro-modal').hidden = false;
  $('#intro-enter').onclick = () => {
    $('#intro-modal').hidden = true;
    enterSpot(prov, city, spot);
  };
}

// ═════════ 3D 场景运行时 ═════════
let renderer = null, camera = null, roamer = null;
let built = null, clock = null, activeSpot = null, activeCtx = null;
let running = false;
let fpMarkers = [];
let raycaster = new THREE.Raycaster();
let coverShotAt = 0;
let composer = null, bloomPass = null;

function ensureRenderer() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ canvas: $('#scene-canvas'), antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // 实时阴影 + 按设备选画质档位
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  setQuality(isMobile ? 'mid' : 'high');
  camera = new THREE.PerspectiveCamera(68, 1, 0.1, 900);
  roamer = new Roamer(camera, $('#scene-canvas'));
  roamer.onLockChange = locked => {
    $('#lock-mask').hidden = locked || (isMobile && roamer.touchRunning);
    $('#crosshair').style.display = (locked || (isMobile && roamer.touchRunning)) ? 'block' : 'none';
    if (!locked && !(isMobile && roamer.touchRunning)) { $('#hotspot-tip').hidden = true; $('#fp-tip').hidden = true; }
    // 移动端显示/隐藏触摸控制
    if (isMobile) $('#touch-controls').hidden = !(locked || roamer.touchRunning);
  };
  composer = new EffectComposer(renderer);
  bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.5, 0.82);
  composer.addPass(new RenderPass(new THREE.Scene(), camera));
  composer.addPass(bloomPass);
  addEventListener('resize', resizeStage);
  resizeStage();
}

function resizeStage() {
  if (!renderer) return;
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  if (composer) composer.setSize(innerWidth, innerHeight);
}

function enterSpot(prov, city, spot) {
  ensureRenderer();
  activeSpot = { name: spot.n, tag: SPOT_TYPE[spot.t]?.label || '' };
  activeCtx = { prov: prov.n, city: city.n, spotName: spot.n };
  store.visitSpot(prov.n + '|' + city.n + '|' + spot.n);

  const themeKey = resolveTheme(store.getTheme());
  const sceneKey = PRO_SCENES[city.n + '|' + spot.n] || (SPOT_TYPE[spot.t] || SPOT_TYPE.park).scene;
  const seed = spotSeed(spot.n);
  built = buildScene(sceneKey, themeKey, renderer, seed);
  roamer.boundR = built.boundR;
  roamer.groundHeight = built.groundHeight;
  roamer.colliders = built.colliders || [];
  roamer.spawnAt(built.spawn.pos, built.spawn.yaw);
  roamer.enabled = true;

  composer.passes = [];
  composer.addPass(new RenderPass(built.scene, camera));
  const bs = { dawn: 0.5, day: 0.35, dusk: 0.75, night: 0.95 }[themeKey] || 0.55;
  bloomPass.strength = bs;
  composer.addPass(bloomPass);

  $('#hud-spot-name').textContent = activeSpot.name;
  $('#hud-spot-tag').textContent = prov.n + ' · ' + city.n + ' · ' + themeLabel(themeKey);
  $('#lock-title').textContent = '点击画面，进入' + activeSpot.name;

  fpMarkers = [];
  for (const f of store.footprintsOf(prov.n + '|' + city.n + '|' + spot.n)) addFpMarker(f);

  show('#stage');
  $('#lock-mask').hidden = false;
  if (isMobile) { roamer.touchRunning = false; $('#touch-controls').hidden = true; }
  clock = new THREE.Clock();
  running = true;
  coverShotAt = performance.now() + 2600;
  loop();
  // 免责提示
  setTimeout(() => toast('场景由程序实时生成，仅供娱乐参考，不代表实景', 3500), 800);
}

function leaveSpot() {
  running = false;
  roamer.enabled = false;
  roamer.touchRunning = false;
  roamer.unlock();
  if (isMobile) $('#touch-controls').hidden = true;
  if (built) {
    built.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    built = null;
  }
  fpMarkers = [];
  closeNote();
  $('#spot-detail-modal') && ($('#spot-detail-modal').hidden = true);
  renderHome();
  show('#home');
}

function loop() {
  if (!running || !built) return;
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  roamer.update(dt);
  built.update(dt, t);
  checkHotspot();
  checkFpAim();
  composer.render();
  if (coverShotAt && performance.now() > coverShotAt) { coverShotAt = 0; shootCover(); }
}

function shootCover() {
  try {
    const src = $('#scene-canvas');
    const c = document.createElement('canvas');
    c.width = 400; c.height = 240;
    c.getContext('2d').drawImage(src, 0, 0, src.width, src.height, 0, 0, 400, 240);
    const key = activeCtx.prov + activeCtx.city + activeCtx.spotName;
    store.setCover(key, c.toDataURL('image/jpeg', 0.62));
  } catch (e) { /* 忽略 */ }
}

let nearHotspot = null;
function checkHotspot() {
  if (!roamer.locked && !(isMobile && roamer.touchRunning)) return;
  const p = camera.position;
  nearHotspot = null;
  let best = 5.0;
  for (const h of built.hotspots) {
    const d = Math.hypot(p.x - h.pos[0], p.z - h.pos[2]);
    if (d < best) { best = d; nearHotspot = h; }
  }
  const tip = $('#hotspot-tip');
  if (nearHotspot) {
    tip.innerHTML = '<b>' + nearHotspot.name + '</b><span>' + nearHotspot.desc + ' — 按 E 留足迹 · 按 G 看解说</span>';
    tip.hidden = false;
  } else tip.hidden = true;
}

function addFpMarker(f) {
  const color = MOOD_COLOR[f.mood] || 0xd3b98a;
  const grp = new THREE.Group();
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.3, 3.2, 6, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false })
  );
  beam.position.y = 1.6;
  const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 1),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.6 }));
  orb.position.y = 3.4;
  grp.add(beam, orb);
  const gy = built.groundHeight(f.pos[0], f.pos[2]);
  grp.position.set(f.pos[0], gy, f.pos[2]);
  built.scene.add(grp);
  fpMarkers.push({ hit: beam, grp, data: f });
  beam.userData.fp = f;
}

function checkFpAim() {
  const tip = $('#fp-tip');
  if ((!roamer.locked && !(isMobile && roamer.touchRunning)) || !fpMarkers.length) { tip.hidden = true; return; }
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  raycaster.far = 26;
  const hits = raycaster.intersectObjects(fpMarkers.map(m => m.hit), false);
  if (hits.length) {
    const f = hits[0].object.userData.fp;
    const d = new Date(f.ts);
    tip.innerHTML = '';
    const b = document.createElement('div');
    b.textContent = MOOD_EMOJI[f.mood] + ' ' + (f.text ? (f.text.length > 42 ? f.text.slice(0, 42) + '…' : f.text) : '（什么也没写）');
    const em = document.createElement('em');
    em.textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + f.score + '分 · ' + (f.place || '');
    tip.appendChild(b); tip.appendChild(em);
    tip.hidden = false;
  } else tip.hidden = true;
}

// 场景内标志地点图文解说（按 G）
function openSpotDetail() {
  if (!nearHotspot) return;
  roamer.unlock();
  $('#detail-title').textContent = nearHotspot.name + ' · ' + activeSpot.name;
  $('#detail-desc').textContent = nearHotspot.desc;
  // 通用解说扩写
  const extra = '这是「' + activeSpot.name + '」里一处值得停下来的地方。' + nearHotspot.desc +
    '走近它，感受当下——风、光、声音，和你自己。在这里按 E 可以留下一枚专属足迹。';
  $('#detail-long').textContent = extra;
  $('#detail-img').src = getSpotCover(activeSpot.name, activeCtx.prov);
  $('#detail-img').onerror = () => { $('#detail-img').style.display = 'none'; };
  $('#detail-img').style.display = 'block';
  $('#spot-detail-modal').hidden = false;
}

// ═════════ 记录弹窗 ═════════
let noteMood = 4, noteScore = 8;
function openNote() {
  if (!roamer.locked) return;
  roamer.unlock();
  const place = nearHotspot ? nearHotspot.name : '某处';
  $('#note-title').textContent = '此刻 · ' + activeSpot.name + ' · ' + place;
  $('#note-text').value = '';
  setNoteMood(4); setNoteScore(8);
  $('#note-modal').hidden = false;
  setTimeout(() => $('#note-text').focus(), 60);
}
function closeNote() { $('#note-modal').hidden = true; }
function setNoteMood(v) {
  noteMood = v;
  document.querySelectorAll('#note-moods button').forEach(b => b.classList.toggle('on', +b.dataset.mood === v));
}
function setNoteScore(v) {
  noteScore = v;
  $('#note-score-num').textContent = v;
  document.querySelectorAll('#note-stars button').forEach(b => b.classList.toggle('on', +b.dataset.v <= v));
}
function submitNote() {
  const p = camera.position;
  const spotKey = activeCtx.prov + '|' + activeCtx.city + '|' + activeCtx.spotName;
  const f = store.addFootprint({
    spot: spotKey,
    prov: activeCtx.prov, city: activeCtx.city, spotName: activeCtx.spotName,
    place: nearHotspot ? nearHotspot.name : '某处',
    pos: [p.x, p.y - 1.65, p.z],
    mood: noteMood, score: noteScore,
    text: $('#note-text').value.trim(),
  });
  addFpMarker(f);
  closeNote();
  toast('足迹已留下 · ' + titleFor(store.data.footprints.length));
  $('#scene-canvas').requestPointerLock?.();
}

// ═════════ 心情鉴定 ═════════
function openMood() {
  const fps = store.todayFootprints();
  if (!fps.length) { openQuiz(); return; }
  roamer?.unlock?.();
  const r = analyzeToday(fps, store.data.user?.name);
  drawMoodCard($('#mood-canvas'), r);
  $('#mood-modal').hidden = false;
}

// ═════════ 心情问卷（无足迹时替代方案） ═════════
const QUIZ_POOL = [
  { q: '现在的你，更接近哪种状态？', opts: [
    { text: '充满电了，想搞点事', mood: 5, keywords: '开心 快乐 爽 棒' },
    { text: '还行，平平淡淡才是真', mood: 3, keywords: '平静 安静 放松 自在' },
    { text: '有点累，想躺平', mood: 2, keywords: '累 疲惫 丧 低落' },
    { text: '碎掉了，别碰我', mood: 1, keywords: '难过 崩溃 想哭 撑不住' },
  ]},
  { q: '如果现在给你一天假，你会？', opts: [
    { text: '冲出去浪！', mood: 5, keywords: '开心 快乐 惊喜 浪漫' },
    { text: '找个安静的地方待着', mood: 3, keywords: '安静 平静 放空 慢慢' },
    { text: '睡到自然醒，谁也别找我', mood: 2, keywords: '累 疲惫 孤独 空虚' },
    { text: '大概也提不起劲', mood: 1, keywords: '难过 丧 失落 撑不住' },
  ]},
  { q: '最近脑子里循环播放的是？', opts: [
    { text: '哈哈哈今天也好开心', mood: 5, keywords: '哈哈 开心 高兴 嘻嘻' },
    { text: '一些不确定的事，纠结', mood: 2, keywords: '为什么 如果 怎么办 纠结 犹豫 后悔' },
    { text: '算了，想通了，无所谓', mood: 4, keywords: '想通 算了 没事 放下 释然 接受' },
    { text: '气死我了！！', mood: 2, keywords: '气 烦死 讨厌 怒 离谱 无语 爆炸' },
  ]},
  { q: '此刻窗外的天气，像你的心情吗？', opts: [
    { text: '像，晴空万里', mood: 5, keywords: '开心 美好 幸福 阳光' },
    { text: '像，阴沉沉的', mood: 2, keywords: '难过 郁闷 低落 空虚' },
    { text: '不像，我内心比天气复杂', mood: 3, keywords: '纠结 矛盾 想不通 犹豫' },
    { text: '没注意窗外，沉浸在自己的世界', mood: 3, keywords: '安静 发呆 放空 平静' },
  ]},
  { q: '用一道菜形容今天的自己？', opts: [
    { text: '火锅——热辣滚烫，活力满满', mood: 5, keywords: '开心 爽 快乐 棒' },
    { text: '白粥——平平淡淡，没啥味道', mood: 3, keywords: '平静 安静 放松 无所谓' },
    { text: '苦瓜——苦，但得咽下去', mood: 2, keywords: '累 烦 焦虑 压力 熬' },
    { text: '碎掉的饼干——拼不回去了', mood: 1, keywords: '难过 心碎 崩溃 想哭' },
  ]},
  { q: '如果情绪有重量，你现在背着多少？', opts: [
    { text: '轻飘飘的，快飞起来了', mood: 5, keywords: '开心 快乐 幸福 美好 惊喜' },
    { text: '正常负重，还撑得住', mood: 3, keywords: '平静 放松 自在 还好' },
    { text: '有点沉，步子慢了', mood: 2, keywords: '累 疲惫 压力 焦虑 丧' },
    { text: '快被压垮了', mood: 1, keywords: '崩溃 撑不住 难过 想哭 空虚' },
  ]},
  { q: '此刻最想对世界说一句？', opts: [
    { text: '今天也是元气满满的一天！', mood: 5, keywords: '开心 快乐 哈哈 棒 感动' },
    { text: '别来烦我，我想静静', mood: 2, keywords: '烦 安静 平静 放空 独处' },
    { text: '算了，都这样了', mood: 3, keywords: '算了 想通 放下 无所谓 释然' },
    { text: '为什么偏偏是我', mood: 1, keywords: '为什么 难过 委屈 不公 想哭' },
  ]},
  { q: '今晚睡前你会？', opts: [
    { text: '带着笑意入睡', mood: 5, keywords: '开心 幸福 满足 快乐 温柔' },
    { text: '刷会儿手机就睡了', mood: 3, keywords: '平静 放松 安静 无所谓' },
    { text: '翻来覆去想事情', mood: 2, keywords: '纠结 犹豫 后悔 如果 怎么办 想不通' },
    { text: '可能又睡不着了', mood: 1, keywords: '焦虑 难过 累 撑不住 空虚 孤独' },
  ]},
];

let quizAnswers = [];

function openQuiz() {
  roamer?.unlock?.();
  quizAnswers = [];
  // 随机抽 4 题
  const shuffled = [...QUIZ_POOL].sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, 4);
  const body = $('#quiz-body');
  body.innerHTML = '';
  picked.forEach((item, qi) => {
    const div = document.createElement('div');
    div.className = 'quiz-item';
    div.innerHTML = '<p class="quiz-q">' + (qi + 1) + '. ' + item.q + '</p><div class="quiz-opts"></div>';
    const optsDiv = div.querySelector('.quiz-opts');
    item.opts.forEach((opt, oi) => {
      const btn = document.createElement('button');
      btn.className = 'quiz-opt';
      btn.textContent = opt.text;
      btn.addEventListener('click', () => {
        optsDiv.querySelectorAll('.quiz-opt').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        quizAnswers[qi] = opt;
        checkQuizReady(picked.length);
      });
      optsDiv.appendChild(btn);
    });
    body.appendChild(div);
  });
  $('#quiz-submit').disabled = true;
  $('#quiz-modal').hidden = false;
}

function checkQuizReady(total) {
  const answered = quizAnswers.filter(Boolean).length;
  $('#quiz-submit').disabled = answered < total;
}

function submitQuiz() {
  // 将问卷答案转换为虚拟足迹数据，喂给 analyzeToday
  const fakeFps = quizAnswers.filter(Boolean).map((opt, i) => ({
    mood: opt.mood,
    score: opt.mood * 2,
    text: opt.keywords,
    ts: Date.now() - i * 60000,
  }));
  $('#quiz-modal').hidden = true;
  const r = analyzeToday(fakeFps, store.data.user?.name);
  drawMoodCard($('#mood-canvas'), r);
  $('#mood-modal').hidden = false;
}

// ═════════ 每日一签 ═════════
const FORTUNE_LEVELS = ['上上签 · 万事可期', '上签 · 好事将近', '中签 · 稳中向好', '上签 · 否极泰来'];
const FORTUNE_YI = ['宜发呆', '宜散步', '宜吃好的', '宜早睡', '宜放空', '宜见想见的人', '宜不解释', '宜绕路走'];
const FORTUNE_JI = ['忌内耗', '忌复盘', '忌已读不回', '忌自我审判', '忌翻旧账', '忌硬撑', '忌解释', '忌卷'];

function openFortune() {
  const key = new Date().toISOString().slice(0, 10);
  let idx = store.getFortune(key);
  if (idx === undefined) { idx = Math.floor(Math.random() * FORTUNES.length); store.setFortune(key, idx); }
  const [main, sub] = FORTUNES[idx];
  // 签文编号（日期+序号，增加收藏感）
  const serial = '第 ' + String(idx + 1).padStart(2, '0') + ' 签 · ' + key.replace(/-/g, '.');
  // 签文等级（基于 idx 确定性分配，同一天不变）
  const level = FORTUNE_LEVELS[idx % FORTUNE_LEVELS.length];
  // 宜忌
  const yi = FORTUNE_YI[idx % FORTUNE_YI.length];
  const ji = FORTUNE_JI[(idx + 3) % FORTUNE_JI.length];
  $('#fortune-serial').textContent = serial;
  $('#fortune-level').textContent = level;
  $('#fortune-text').textContent = main;
  $('#fortune-sub').textContent = sub;
  $('#fortune-yiji').textContent = yi + '  /  ' + ji;
  $('#fortune-modal').hidden = false;
}

// ═════════ 事件绑定 ═════════
function bind() {
  $('#intro-x').addEventListener('click', () => { $('#intro-modal').hidden = true; });
  $('#intro-modal').addEventListener('click', e => { if (e.target.id === 'intro-modal') $('#intro-modal').hidden = true; });

  // 搜索
  $('#search-btn').addEventListener('click', doSearch);
  $('#search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  const tryEnter = () => {
    const name = $('#gate-name').value.trim() || '无名氏';
    store.setUser(name);
    renderHome();
    show('#home');
    toast('欢迎，' + name + '。夜游神已上线，山河等你。');
  };
  $('#gate-enter').addEventListener('click', tryEnter);
  $('#gate-name').addEventListener('keydown', e => { if (e.key === 'Enter') tryEnter(); });

  $('#btn-logout').addEventListener('click', () => {
    store.clearUser();
    $('#gate-name').value = '';
    show('#gate');
    startGateParticles();
  });
  $('#btn-fortune').addEventListener('click', openFortune);
  $('#btn-mood-home').addEventListener('click', openMood);
  $('#btn-shredder').addEventListener('click', () => {
    $('#shred-text').value = '';
    $('#shredder-modal').hidden = false;
    $('#shredder-modal .modal-card').classList.remove('shredding');
    const cnt = store.data.shredCount || 0;
    $('#shred-count').textContent = cnt > 0 ? '你已亲手粉碎 ' + cnt + ' 段烦恼，它们再也回不来了。' : '第一次来？写点什么，然后让它消失。';
  });
  $('#shred-close').addEventListener('click', () => { $('#shredder-modal').hidden = true; });
  $('#shred-go').addEventListener('click', () => {
    const txt = $('#shred-text').value.trim();
    if (!txt) { toast('先写点什么再粉'); return; }
    const card = $('#shredder-modal .modal-card');
    card.classList.add('shredding');
    setTimeout(() => {
      $('#shredder-modal').hidden = true;
      card.classList.remove('shredding');
      $('#shred-text').value = '';
      // 累计粉碎计数
      store.data.shredCount = (store.data.shredCount || 0) + 1;
      try { localStorage.setItem('other-side-wuxi-v1', JSON.stringify(store.data)); } catch(e) {}
      const blessings = [
        '已粉碎 · 尘归尘，土归土，烦恼归山河',
        '已粉碎 · 碎碎平安，岁岁平安',
        '已粉碎 · 风会替你把它们吹散',
        '已粉碎 · 今晚的月亮不记得这些',
        '已粉碎 · 明天又是新的一天，谁还认识它',
      ];
      toast(blessings[Math.floor(Math.random() * blessings.length)]);
    }, 1150);
  });
  $('#fortune-close').addEventListener('click', () => { $('#fortune-modal').hidden = true; });
  $('#quiz-close').addEventListener('click', () => { $('#quiz-modal').hidden = true; });
  $('#quiz-submit').addEventListener('click', submitQuiz);

  $('#lock-mask').addEventListener('click', () => {
    if (isMobile) {
      roamer.touchRunning = true;
      roamer.onLockChange(true);
      $('#touch-controls').hidden = false;
    } else {
      roamer.lock();
    }
  });
  $('#btn-back').addEventListener('click', leaveSpot);
  $('#btn-theme').addEventListener('click', () => {
    const cur = resolveTheme(store.getTheme());
    const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
    store.setTheme(next);
    if (activeCtx) {
      const ctx = activeCtx;
      leaveSpotSilent();
      // 重新进入同一景点
      const prov = PROVINCES.find(p => p.n === ctx.prov);
      const city = prov.cities.find(c => c.n === ctx.city);
      const spot = city.spots.find(s => s.n === ctx.spotName);
      enterSpot(prov, city, spot);
      toast('时辰切换 · ' + themeLabel(next));
    }
  });
  $('#btn-mood-scene').addEventListener('click', openMood);

  document.addEventListener('keydown', e => {
    if ($('#stage').hidden || !running) return;
    if (!$('#note-modal').hidden) return;
    const active = roamer.locked || (isMobile && roamer.touchRunning);
    if (e.code === 'KeyE' && active) openNote();
    if (e.code === 'KeyG' && active) openSpotDetail();
    if (e.code === 'KeyF' && active) { roamer.unlock(); openMood(); }
  });

  document.querySelectorAll('#note-moods button').forEach(b =>
    b.addEventListener('click', () => setNoteMood(+b.dataset.mood)));
  const stars = $('#note-stars');
  for (let i = 1; i <= 10; i++) {
    const b = document.createElement('button');
    b.dataset.v = i; b.textContent = '★';
    b.addEventListener('click', () => setNoteScore(i));
    stars.appendChild(b);
  }
  setNoteScore(8);
  $('#note-cancel').addEventListener('click', () => { closeNote(); $('#scene-canvas').requestPointerLock?.(); });
  $('#note-submit').addEventListener('click', submitNote);

  $('#mood-close').addEventListener('click', () => { $('#mood-modal').hidden = true; });
  $('#mood-download').addEventListener('click', () => {
    const a = document.createElement('a');
    a.download = '精神状态鉴定_' + new Date().toISOString().slice(0, 10) + '.png';
    a.href = $('#mood-canvas').toDataURL('image/png');
    a.click();
    toast('卡片已下载，拿去朋友圈抽象吧');
  });

  // ═════════ 移动端触摸控制 ═════════
  if (isMobile) document.body.classList.add('is-mobile');
  initTouchControls();

  // ═════════ 个人主页 ═════════
  $('#btn-profile').addEventListener('click', openProfile);
  $('#profile-close').addEventListener('click', () => { $('#profile-modal').hidden = true; });
  $('#profile-save').addEventListener('click', saveProfile);
  document.querySelectorAll('.pmood').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.pmood').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    });
  });
}

// ═════════ 触摸控制初始化 ═════════
function initTouchControls() {
  const base = $('#joystick-base');
  const knob = $('#joystick-knob');
  const lookZone = $('#touch-look-zone');
  if (!base || !lookZone) return;

  let joyId = null, joyCX = 0, joyCY = 0;
  const maxR = 38;

  base.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.changedTouches[0];
    joyId = t.identifier;
    const rect = base.getBoundingClientRect();
    joyCX = rect.left + rect.width / 2;
    joyCY = rect.top + rect.height / 2;
  }, { passive: false });

  document.addEventListener('touchmove', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) {
        let dx = t.clientX - joyCX, dy = t.clientY - joyCY;
        const dist = Math.hypot(dx, dy);
        if (dist > maxR) { dx *= maxR / dist; dy *= maxR / dist; }
        knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        roamer.touchMove.x = dx / maxR;
        roamer.touchMove.y = dy / maxR;
      }
    }
  }, { passive: false });

  document.addEventListener('touchend', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) {
        joyId = null;
        knob.style.transform = 'translate(0,0)';
        roamer.touchMove.x = 0;
        roamer.touchMove.y = 0;
      }
    }
  });

  // 右侧滑动环视
  let lookId = null, lookLX = 0, lookLY = 0;
  lookZone.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.changedTouches[0];
    lookId = t.identifier;
    lookLX = t.clientX; lookLY = t.clientY;
  }, { passive: false });

  lookZone.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === lookId) {
        roamer.touchLook.x += (t.clientX - lookLX) * 1.2;
        roamer.touchLook.y += (t.clientY - lookLY) * 1.2;
        lookLX = t.clientX; lookLY = t.clientY;
      }
    }
  }, { passive: false });

  lookZone.addEventListener('touchend', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === lookId) lookId = null;
    }
  });

  // 触摸按钮
  $('#touch-fp')?.addEventListener('click', () => { if (roamer.touchRunning) openNote(); });
  $('#touch-info')?.addEventListener('click', () => { if (roamer.touchRunning) openSpotDetail(); });
}

// ═════════ 个人主页逻辑 ═════════
function openProfile() {
  const p = store.data.profile || {};
  $('#profile-name').value = store.data.user?.name || '';
  $('#profile-bio').value = p.bio || '';
  $('#profile-city').value = p.city || '';
  $('#profile-avatar').textContent = (store.data.user?.name || '游')[0];
  // 心情选中
  document.querySelectorAll('.pmood').forEach(b => {
    b.classList.toggle('on', b.dataset.m === p.mood);
  });
  // 统计
  const fpCount = store.data.footprints.length;
  const spotCount = Object.keys(store.data.visits).length;
  const shredCount = store.data.shredCount || 0;
  $('#profile-stats').innerHTML =
    '足迹留言：<b>' + fpCount + '</b> 条<br>' +
    '到访景点：<b>' + spotCount + '</b> 个<br>' +
    '粉碎烦恼：<b>' + shredCount + '</b> 段<br>' +
    '当前称号：<b>' + titleFor(fpCount) + '</b>';
  $('#profile-modal').hidden = false;
}

function saveProfile() {
  const name = $('#profile-name').value.trim() || '无名氏';
  const moodBtn = document.querySelector('.pmood.on');
  store.data.profile = {
    bio: $('#profile-bio').value.trim(),
    city: $('#profile-city').value.trim(),
    mood: moodBtn ? moodBtn.dataset.m : '',
  };
  if (store.data.user) store.data.user.name = name;
  try { localStorage.setItem('other-side-wuxi-v1', JSON.stringify(store.data)); } catch(e) {}
  $('#user-name').textContent = name;
  $('#profile-modal').hidden = true;
  toast('档案已保存，继续夜游吧');
}

function leaveSpotSilent() {
  running = false;
  roamer.enabled = false;
  if (built) { built.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); }); built = null; }
  fpMarkers = [];
}

bind();
if (store.data.user) { renderHome(); show('#home'); }
else { show('#gate'); startGateParticles(); }
