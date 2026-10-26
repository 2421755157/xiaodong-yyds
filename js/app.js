// ═══ 夜游神 · 主逻辑（全国版：省→市→景点）═══
//
// ⚠ 加载约束：本文件**不得**静态 import 'three' / scenes.js / roam.js / panorama.js。
// three 内核 gzip 就有 257KB，而 3D 只在用户点「进入 3D 漫游」时才需要；
// 一旦静态引入，用户只是"看一眼景点卡片"也得先把整个 3D 引擎下完。
// 首屏只引零依赖的 scenes-meta.js（纯数据）与 env.js（环境探测），
// 重活全部交给 three-loader.js 在真正需要时按需拉取。
import { store, titleFor } from './store.js';
import { PROVINCES, SPOT_TYPE, stats } from './china-data.js';
import { resolveTheme, THEME_ORDER, themeLabel, PRO_SCENES, spotSeed, setQuality } from './scenes-meta.js';
import { isMobile } from './env.js';
import { loadThreeRuntime, loadPanorama, warmUpThree } from './three-loader.js';
import { analyzeToday, drawMoodCard } from './mood.js';
import { FORTUNES, greetingFor, SPOT_MEMES, expandDesc, pickN } from './lexicon.js';
import { getSpotImages, getSpotCover, imageStats, ensureGallery, galleryReady, enrichSpotImages,
         loadSpotImages, spotImagesReady } from './spot-images.js';
import { streetViewFor, hasStreetView, POIID_DB } from './streetview.js';
import { staticMapUrl, hasStaticMap, MAP_VIEWS, mapViewByKey, baiduMapLink } from './staticmap.js';
import { lazyDB } from './lazy-db.js';
import { REGION_DESC_DB } from './region-desc-db.js';

const $ = s => document.querySelector(s);

// ─── 3D 运行时句柄 ───
// 由 loadThreeRuntime() 在首次进入漫游时注入。名字与原来的 import 绑定保持一致，
// 这样下面 30 多处 THREE.xxx / new Roamer() / buildScene() 的调用完全不用改。
let THREE = null, EffectComposer = null, RenderPass = null, UnrealBloomPass = null;
let buildScene = null, Roamer = null;

// ═══ 静态数据库（统一懒加载，见 lazy-db.js）═══
// 简介库 100KB / 坐标库 39KB / 全景库 26KB，都不阻塞首屏
const DESC_DB = lazyDB(() => import('./spot-desc-db.js'), m => m.SPOT_DESC_DB);
const COORD_DB = lazyDB(() => import('./coords-db.js'), m => m.COORD_DB);
const PANORAMA_DB = lazyDB(() => import('./panorama-db.js'), m => m.PANORAMA_DB);

let descDBRepainted = false;

// ═══ 景点真实简介（维基词条首段静态库）优先，手写 d 字段作为回退 ═══
function realDesc(spot) {
  return DESC_DB.get(spot.n) || spot.d || '';
}
// 卡片摘要：取首句、限长，避免长段落撑破卡片
function shortDesc(spot, max = 44) {
  let t = (realDesc(spot) || '').replace(/\s+/g, '');
  const stop = t.indexOf('。');
  if (stop > 12 && stop < max) t = t.slice(0, stop + 1);
  else if (t.length > max) t = t.slice(0, max) + '…';
  return t;
}

// 图片加载骨架屏：加载中显示微光，完成/失败后移除
function markLoading(img) {
  if (!img) return;
  img.classList.add('skel');
  const done = () => img.classList.remove('skel');
  img.addEventListener('load', done);
  img.addEventListener('error', done);
}

// ═══ 省市真实简介（维基词条静态库）═══
function provDesc(p) { return REGION_DESC_DB['p:' + p.n] || p.desc || ''; }
function cityDesc(p, c) { return REGION_DESC_DB['p:' + p.n + '|' + c.n] || c.desc || ''; }
// 横幅/卡片用的短版：取首句并限长
function tagline(t, max = 36) {
  t = (t || '').replace(/\s+/g, '');
  const stop = t.indexOf('。');
  if (stop > 10 && stop < max) return t.slice(0, stop + 1);
  return t.length > max ? t.slice(0, max) + '…' : t;
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
  renderHomeStats(st);
  nav = { level: 'prov' };
  renderNav();
  renderTimeline();
}

// ── 首页数据条：真实图片/简介数量（简介库懒加载后就绪后补齐）──
function renderHomeStats(st) {
  const box = $('#hero-stats');
  if (!box) return;
  const im = imageStats();
  const paint = (descCount, extraCount) => {
    box.innerHTML = [
      ['实景照片', im.total + ' 张'],
      ['景点专属图', im.c3 + ' 张'],
      ['多图景点', extraCount ? extraCount + ' 处' : '加载中…'],
      ['真实简介', descCount ? descCount + ' 条' : '加载中…'],
      ['覆盖省市', st.provinces + ' 省 / ' + st.cities + ' 市'],
    ].map(([k, v]) => '<div class="stat-cell"><b>' + v + '</b><span>' + k + '</span></div>').join('');
  };
  paint(0, 0);
  Promise.all([DESC_DB.load(), ensureGallery(), loadSpotImages()]).then(() => {
    const g = imageStats().galleryCount;
    paint(Object.keys(DESC_DB.data()).length, g);
  });
}

// 面包屑 + 内容区
// 之所以是 async：景点列表要用真实封面，需等 372KB 的图库就绪。
// 省/市层用渐变封面，不等 —— 首屏关键路径上没有任何图库开销。
let navSeq = 0;          // 渲染令牌：async 渲染期间若用户又切了层级，让旧的那次作废
async function renderNav() {
  const seq = ++navSeq;
  const grid = $('#spot-grid');
  if (nav.level === 'spot' && !spotImagesReady()) {
    // 冷缓存下要等 372KB 图库。给一个延迟 300ms 才出现的弱提示：
    // 快的情况根本察觉不到，慢的时候用户至少知道在加载而不是卡死。
    const hint = setTimeout(() => { if (seq === navSeq) grid.style.opacity = '0.4'; }, 300);
    // 先不动已渲染的旧网格，等库到了再一次性替换，避免中间夹一屏占位图
    await loadSpotImages();
    clearTimeout(hint);
    // 等待期间用户可能已经点回上层 —— 这时本次渲染过期，交给新的那次处理
    if (seq !== navSeq) { grid.style.opacity = ''; return; }
    grid.style.opacity = '';
  }
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
        '<p>' + tagline(provDesc(p), 40) + '</p><div class="spot-meta"><span>下辖 <b>' + p.cities.length + '</b> 市</span>' +
        '<span class="spot-enter">进入 →</span></div></div>';
      card.addEventListener('click', () => { nav = { level: 'city', prov: p }; renderNav(); });
      grid.appendChild(card);
    }
  } else if (nav.level === 'city') {
    // 城市网格
    $('#hero-line').innerHTML = tagline(provDesc(nav.prov), 44) + '<br><span style="font-size:14px;color:var(--ink-dim)">' + nav.prov.n + ' · ' + nav.prov.cities.length + ' 市</span>';
    for (const c of nav.prov.cities) {
      const card = document.createElement('div');
      card.className = 'spot-card';
      const spotsN = c.spots.length;
      card.innerHTML =
        '<div class="spot-cover"><div style="position:absolute;inset:0;background:' + c.cover + '"></div>' +
        '<span class="cover-glyph">' + c.n.charAt(0) + '</span></div>' +
        '<div class="spot-body"><h4>' + c.n + '</h4><span class="tag">' + nav.prov.n + '</span>' +
        '<p>' + tagline(cityDesc(nav.prov, c), 40) + '</p><div class="spot-meta"><span><b>' + spotsN + '</b> 处风景</span>' +
        '<span class="spot-enter">查看 →</span></div></div>';
      card.addEventListener('click', () => { nav = { level: 'spot', prov: nav.prov, city: c }; renderNav(); });
      grid.appendChild(card);
    }
  } else {
    // 景点列表
    $('#hero-line').innerHTML = tagline(cityDesc(nav.prov, nav.city), 44) + '<br><span style="font-size:14px;color:var(--ink-dim)">' + nav.prov.n + ' ' + nav.city.n + ' · ' + nav.city.spots.length + ' 处风景</span>';
    for (const s of nav.city.spots) {
      const typeInfo = SPOT_TYPE[s.t] || SPOT_TYPE.park;
      const isPro = PRO_SCENES[nav.city.n + '|' + s.n];
      const card = document.createElement('div');
      card.className = 'spot-card';
      card.innerHTML =
        '<div class="spot-cover"><img alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-img="' + encodeURIComponent(s.n) + '"><span class="cover-glyph">' + s.n.charAt(0) + '</span></div>' +
        '<div class="spot-body"><h4>' + s.n + '</h4><span class="tag">' + typeInfo.label + (isPro ? ' · 精游' : '') + '</span>' +
        '<p>' + shortDesc(s) + '</p><div class="spot-meta"><span>' + nav.city.n + '</span>' +
        '<span class="spot-enter">详情 →</span></div></div>';
      const img = card.querySelector('img');
      markLoading(img);
      const custom = store.getCover(nav.prov.n + nav.city.n + s.n) || store.getCover(nav.city.n + s.n);
      const coverUrl = custom || getSpotCover(s.n, nav.prov.n);
      img.setAttribute('data-src', coverUrl);
      img.src = coverUrl;
      robustImg(img, () => { img.style.display = 'none'; });
      img.addEventListener('load', () => { img.style.display = 'block'; card.querySelector('.cover-glyph').style.display = 'none'; });
      card.addEventListener('click', () => openSpot(nav.prov, nav.city, s));
      grid.appendChild(card);
    }
  }
  syncHash();
  // 简介库异步就绪后，用真实简介重绘一次卡片（只重绘一次，避免循环）
  if (!DESC_DB.ready() && !descDBRepainted) {
    DESC_DB.load().then(() => {
      if (descDBRepainted) return;
      descDBRepainted = true;
      renderNav();
    });
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

// ═════════ 搜索（实时 + 类型/省市筛选 + 关键词高亮）═════════
let searchType = 'all';      // all | spot | city | prov
let searchProv = '';         // '' = 全国
let searchTimer = null;

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 关键词高亮（在已转义的文本上标记，避免注入）
function markHit(text, q) {
  const t = escHtml(text);
  if (!q) return t;
  const eq = escHtml(q);
  const i = t.toLowerCase().indexOf(eq.toLowerCase());
  if (i < 0) return t;
  return t.slice(0, i) + '<mark>' + t.slice(i, i + eq.length) + '</mark>' + t.slice(i + eq.length);
}

function doSearch() {
  const q = $('#search-input').value.trim();
  const box = $('#search-results');
  if (!q) { box.classList.remove('show'); box.innerHTML = ''; return; }
  // 简介库是异步懒加载的：库没就绪时 DESC_DB.get() 恒为 undefined，
  // 搜简介全文会全部落空（只剩名称命中）。这里先确保库就绪再搜。
  if (!DESC_DB.ready()) {
    DESC_DB.load().then(() => {
      // 加载期间用户可能已经改了关键词或清空输入，过期就不重绘
      if ($('#search-input').value.trim() === q) doSearch();
    });
    return;
  }
  const results = [];
  // 命中上限：超出后跳出整个三层循环（原来只 break 最内层，
  // 外层还会继续扫，白白遍历全省景点）
  const MAX_HITS = 60;
  outer:
  for (const p of PROVINCES) {
    if (searchProv && p.n !== searchProv) continue;
    const hitProv = (p.n.includes(q) || p.c.includes(q));
    if (hitProv && searchType !== 'spot' && searchType !== 'city') {
      results.push({ type: 'prov', prov: p, label: p.n + '（省）', sub: '省会 ' + p.cap + ' · ' + p.cities.length + ' 市' });
    }
    for (const c of p.cities) {
      const hitCity = c.n.includes(q);
      if (hitCity && (searchType === 'all' || searchType === 'city')) {
        results.push({ type: 'city', prov: p, city: c, label: c.n + '（市）', sub: p.n + ' · ' + c.spots.length + ' 处风景' });
      }
      if (searchType === 'city' || searchType === 'prov') continue;
      for (const s of c.spots) {
        const d = DESC_DB.get(s.n) || s.d || '';
        if (s.n.includes(q) || d.includes(q)) {
          results.push({ type: 'spot', prov: p, city: c, spot: s, label: s.n, sub: p.n + ' ' + c.n, tag: (SPOT_TYPE[s.t] || {}).label, hit: s.n.includes(q) ? s.n : d });
          if (results.length >= MAX_HITS) break outer;
        }
      }
    }
  }
  // 排序：名称直接命中的排最前，其次是简介命中的景点
  const rank = r => (r.type === 'spot' && r.label.includes(q) ? 0 : r.type === 'spot' ? 1 : r.type === 'city' ? 2 : 3);
  results.sort((a, b) => rank(a) - rank(b));
  const shown = results.slice(0, 40);

  // 筛选条
  const chips = [
    ['all', '全部'], ['spot', '景点'], ['city', '城市'], ['prov', '省份'],
  ].map(([k, t]) => '<button class="sr-chip' + (searchType === k ? ' on' : '') + '" data-type="' + k + '">' + t + '</button>').join('');
  const provSel = '<select class="sr-select" id="sr-prov"><option value="">全国</option>' +
    PROVINCES.map(p => '<option value="' + escHtml(p.n) + '"' + (searchProv === p.n ? ' selected' : '') + '>' + escHtml(p.n) + '</option>').join('') +
    '</select>';

  if (!results.length) {
    box.innerHTML = '<div class="sr-filters">' + chips + provSel + '</div>' +
      '<div class="sr-head">没找到「' + escHtml(q) + '」' + (searchProv ? '（限 ' + escHtml(searchProv) + '）' : '') +
      '，换个词试试（已搜 ' + stats().spots + ' 处风景）</div>';
    bindSearchFilters(box);
    box.classList.add('show');
    return;
  }
  box.innerHTML = '<div class="sr-filters">' + chips + provSel + '</div>' +
    '<div class="sr-head">找到 ' + results.length + ' 条结果' + (results.length > shown.length ? '（显示前 ' + shown.length + '）' : '') + '</div>';
  for (const r of shown) {
    const it = document.createElement('div');
    it.className = 'sr-item';
    it.innerHTML = '<b>' + markHit(r.label, q) + '</b><span>' + escHtml(r.sub) + (r.tag ? ' · ' + escHtml(r.tag) : '') + '</span>';
    it.addEventListener('click', () => {
      box.classList.remove('show');
      $('#search-input').value = '';
      if (r.type === 'prov') { nav = { level: 'city', prov: r.prov }; renderNav(); }
      else if (r.type === 'city') { nav = { level: 'spot', prov: r.prov, city: r.city }; renderNav(); }
      else { openSpot(r.prov, r.city, r.spot); }
    });
    box.appendChild(it);
  }
  bindSearchFilters(box);
  box.classList.add('show');
}

function bindSearchFilters(box) {
  box.querySelectorAll('.sr-chip').forEach(b => b.addEventListener('click', () => {
    searchType = b.dataset.type;
    doSearch();
  }));
  const sel = box.querySelector('#sr-prov');
  if (sel) sel.addEventListener('change', () => { searchProv = sel.value; doSearch(); });
}

// Wikipedia 真实景点图 + 百科摘要（CORS 友好，失败静默）
// 带超时：网络挂起会让详情页的「详细解说」一直空着
async function fetchWiki(name) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch('https://zh.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(name) + '?redirect=true',
      { signal: ctrl.signal });
    if (!r.ok) return {};
    const j = await r.json();
    const img = (j.originalimage && j.originalimage.source) || (j.thumbnail && j.thumbnail.source);
    return { img, extract: j.extract };
  } catch (e) {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

// ═══ 图集灯箱 ═══
let lbImgs = [], lbIdx = 0;
function paintLightbox() {
  const box = $('#lightbox');
  if (!box || !lbImgs.length) return;
  box.querySelector('.lb-img').src = lbImgs[lbIdx];
  box.querySelector('.lb-count').textContent = (lbIdx + 1) + ' / ' + lbImgs.length;
}
function stepLightbox(d) {
  if (!lbImgs.length) return;
  lbIdx = (lbIdx + d + lbImgs.length) % lbImgs.length;
  paintLightbox();
}
function closeLightbox() {
  const b = $('#lightbox');
  if (b) b.hidden = true;
  document.removeEventListener('keydown', onLbKey);
}
function onLbKey(e) {
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') stepLightbox(-1);
  else if (e.key === 'ArrowRight') stepLightbox(1);
}
function openLightbox(urls, idx) {
  lbImgs = (urls || []).filter(u => u && !u.startsWith('data:'));
  if (!lbImgs.length) return;
  lbIdx = Math.max(0, Math.min(idx || 0, lbImgs.length - 1));
  let box = $('#lightbox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'lightbox';
    box.className = 'lightbox';
    box.hidden = true;
    box.innerHTML =
      '<button class="lb-close" aria-label="关闭">×</button>' +
      '<button class="lb-nav lb-prev" aria-label="上一张">‹</button>' +
      '<img class="lb-img" alt="" referrerpolicy="no-referrer">' +
      '<button class="lb-nav lb-next" aria-label="下一张">›</button>' +
      '<div class="lb-count"></div>';
    document.body.appendChild(box);
    box.addEventListener('click', e => {
      if (e.target === box || e.target.classList.contains('lb-close')) closeLightbox();
      else if (e.target.classList.contains('lb-prev')) stepLightbox(-1);
      else if (e.target.classList.contains('lb-next')) stepLightbox(1);
    });
  }
  paintLightbox();
  box.hidden = false;
  document.addEventListener('keydown', onLbKey);
}

// ═══ 简介来源标注 + 展开收起 ═══
function renderSource(spot) {
  const el = $('#intro-source');
  if (!el) return;
  if (DESC_DB.get(spot.n)) {
    el.innerHTML = '资料来源：<a href="https://zh.wikipedia.org/wiki/' + encodeURIComponent(spot.n) +
      '" target="_blank" rel="noopener">中文维基百科 · ' + spot.n + ' 词条</a>';
    el.hidden = false;
  } else {
    el.innerHTML = '';
    el.hidden = true;
  }
}
function setupDescExpand() {
  const p = $('#intro-desc'), btn = $('#intro-more');
  if (!p || !btn) return;
  const long = (p.textContent || '').length > 76;
  p.classList.toggle('clamp', long);
  btn.hidden = !long;
  btn.textContent = '展开全文 ↓';
  btn.onclick = () => {
    const on = p.classList.toggle('clamp');
    btn.textContent = on ? '展开全文 ↓' : '收起 ↑';
  };
}

// ═══ 同城相关推荐 ═══
function renderRelated(prov, city, spot) {
  const box = $('#intro-related');
  if (!box) return;
  const others = city.spots.filter(s => s.n !== spot.n);
  if (!others.length) { box.hidden = true; box.innerHTML = ''; return; }
  // 同类型优先，其次有真实简介的优先
  const scored = others.map(s => ({ s, k: (s.t === spot.t ? 2 : 0) + (DESC_DB.get(s.n) ? 1 : 0) + spotSeed(s.n) % 2 }));
  scored.sort((a, b) => b.k - a.k);
  const picks = scored.slice(0, 6).map(x => x.s);
  box.hidden = false;
  box.innerHTML = '<div class="rel-title">同城别处 · <span>' + city.n + '</span></div><div class="rel-row"></div>';
  const row = box.querySelector('.rel-row');
  for (const s of picks) {
    const it = document.createElement('button');
    it.className = 'rel-item';
    it.innerHTML = '<img alt="" loading="lazy" referrerpolicy="no-referrer"><span>' + s.n + '</span>';
    const im = it.querySelector('img');
    markLoading(im);
    im.src = getSpotCover(s.n, prov.n, s.t);
    im.addEventListener('error', () => { im.style.visibility = 'hidden'; });
    it.addEventListener('click', () => { closeLightbox(); openSpot(prov, city, s); });
    row.appendChild(it);
  }
}

// ═══ 图片容错：三级换源 ═══
// 1) thumb.wikimedia.org 缩略图（默认）
// 2) upload.wikimedia.org 原图（**不同域名**，主域被卡时仍可加载）
// 3) commons Special:FilePath（最后兜底）
// 国内网络访问 Wikimedia 偶发超时/失败，换源后成功率明显提升
function imgFallbacks(u) {
  if (!u || u.startsWith('data:')) return [];
  const list = [];
  const m = /\/commons\/thumb\/([0-9a-f])\/([0-9a-f]{2})\/(.+)\/\d+px-.+$/.exec(u);
  if (m) {
    // 原图（upload 域，与 thumb 域不同）
    list.push('https://upload.wikimedia.org/wikipedia/commons/' + m[1] + '/' + m[2] + '/' + m[3]);
    // 文件路径接口
    const file = decodeURIComponent(m[3]);
    list.push('https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(file) + '?width=960');
  }
  return list;
}
function robustImg(img, onFail) {
  if (!img) return;
  const src = img.getAttribute('data-src') || img.src;
  const chain = imgFallbacks(src);
  let step = 0;
  img.addEventListener('error', () => {
    if (step < chain.length) { img.src = chain[step++]; return; }
    if (onFail) onFail();
  });
}

// ═══ 实景街景：坐标库（懒加载）+ 详情页按钮 ═══
async function renderStreetBtn(spot) {
  const btn = $('#intro-street');
  if (!btn) return;
  if (!hasStreetView()) { btn.hidden = true; return; }   // 没配密钥就不显示
  await COORD_DB.load();
  const c = COORD_DB.get(spot.n);
  // poiid 指向景点正门，比只传坐标准；没有 poiid 但有坐标也能取到附近街景
  await POIID_DB.load();
  const poi = POIID_DB.get(spot.n) || null;
  if (!c && !poi) { btn.hidden = true; return; }
  const sv = streetViewFor(c ? [c[0], c[1]] : null, poi ? { poiid: poi.uid } : {});
  if (!sv) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.textContent = sv.provider === 'baidu'
    ? (poi ? '🛣 实景街景 · 正门' : '🛣 实景街景')
    : '🛣 街景照片';
  btn.onclick = () => openPano({
    url: sv.url, type: sv.type,
    title: poi ? (spot.n + ' · ' + (poi.name || '正门')) : (spot.n + ' · 实景'),
  });
}

// ═══ 位置小地图：百度静态图接口 ═══
// 静态图接口没有图层参数（maptype 会被静默忽略），但缩放级别是真的能切，
// 而且对"景点在城里的方位"很有用：街区 → 城区 → 全域。
let mapViewKey = 'block';
function renderStaticMap(spot, coord) {
  const box = $('#intro-map');
  const img = $('#map-img');
  if (!box || !img) return;
  if (!hasStaticMap() || !coord) { box.hidden = true; return; }
  box.hidden = false;
  const paint = () => {
    const v = mapViewByKey(mapViewKey);
    const u = staticMapUrl(coord[0], coord[1], { zoom: v.zoom, width: v.w, height: v.h });
    if (!u) { box.hidden = true; return; }
    img.setAttribute('data-src', u);
    img.src = u;
    markLoading(img);
    robustImg(img, () => {
      // 静态图拿不到（配额/网络/Referer 未白名单）→ 整块隐藏，不留破图
      box.hidden = true;
    });
  };
  // 视野档位按钮
  MAP_VIEWS.forEach(v => {
    const b = $('#map-view-' + v.key);
    if (!b) return;
    b.onclick = () => {
      mapViewKey = v.key;
      MAP_VIEWS.forEach(o => {
        const ob = $('#map-view-' + o.key);
        if (ob) ob.classList.toggle('on', o.key === v.key);
      });
      paint();
    };
  });
  // 跳转百度地图可交互版
  const open = $('#map-open');
  if (open) {
    const link = baiduMapLink(coord[0], coord[1], spot.n);
    if (link) open.href = link; else open.hidden = true;
  }
  paint();
}

// ═══ 实景全景库（按需加载）+ 详情页按钮 ═══
async function renderPanoBtn(spot) {
  const btn = $('#intro-pano');
  if (!btn) return;
  await PANORAMA_DB.load();
  const p = PANORAMA_DB.get(spot.n);
  if (!p || !p.url) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.textContent = p.type === 'sphere' ? '🖐 360° 全景' : '🖐 宽幅全景';
  btn.onclick = () => openPano({ url: p.url, type: p.type, title: spot.n, w: p.w, h: p.h });
}

// 图库预热：首屏渲染完后在空闲时段偷偷下好，不阻塞任何东西
function warmUpSpotImages() {
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 1200));
  idle(() => { loadSpotImages().catch(() => {}); }, { timeout: 4000 });
}

// ═══ 全景查看器（按需加载；统一入口便于集中处理失败）═══
function openPano(opts) {
  loadPanorama()
    .then(m => m.openPanorama(opts))
    .catch(() => toast('全景组件加载失败，请检查网络后重试', 3000));
}

// ═══ 历史沿革长介绍（分片按需加载）═══
// 8 个分片各 ~100KB，打开景点时只加载对应那片
const LONG_CHUNKS = 8;
const longChunkCache = new Map();
function longChunkIndex(name) {
  return (name && name.charCodeAt(0)) % LONG_CHUNKS;
}
function loadLongChunk(idx) {
  if (longChunkCache.has(idx)) return longChunkCache.get(idx);
  const p = import('./long-db-' + idx + '.js')
    .then(m => m['LONG_DESC_DB_' + idx] || {})
    .catch(() => ({}));
  longChunkCache.set(idx, p);
  return p;
}
async function renderHistory(spot) {
  const box = $('#intro-history');
  const txt = $('#hist-text');
  const more = $('#hist-more');
  const title = $('#hist-title');
  if (!box || !txt) return;
  const type = spot.t;
  title.textContent = (type === 'ruin' || type === 'temple' || type === 'modern')
    ? '来历 · 地标故事' : '历史沿革';
  const db = await loadLongChunk(longChunkIndex(spot.n));
  const body = db[spot.n];
  if (!body) { box.hidden = true; return; }
  box.hidden = false;
  txt.textContent = body;
  const long = body.length > 180;
  txt.classList.toggle('clamp', long);
  more.hidden = !long;
  more.textContent = '展开全文 ↓';
  more.onclick = () => {
    const on = txt.classList.toggle('clamp');
    more.textContent = on ? '展开全文 ↓' : '收起 ↑';
  };
  // 有真实历史长文时，把「详细解说」里的模板文案清掉 ——
  // 那段「这里四季景致各异…」对所有景点都一样，
  // 真实史料在前才显得有分量（也避免同一段话出现两遍）。
  const detail = $('#intro-detail');
  if (detail && detail.dataset.tpl === '1') {
    detail.textContent = '';
    detail.dataset.tpl = '';
  }
}

// ═══ 自选封面：本地图片压缩后存 localStorage，覆盖 Wikimedia 默认图 ═══
function coverKey(prov, city, spot) {
  return prov.n + city.n + spot.n;
}
function compressImage(file, maxSide = 1400, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('读取失败'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('解码失败'));
      img.onload = () => {
        let w = img.width, h = img.height;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.round(w * scale); h = Math.round(h * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        try { resolve(cv.toDataURL('image/jpeg', quality)); }
        catch (e) { reject(e); }
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
function bindCoverPicker(prov, city, spot) {
  const input = $('#cover-input');
  const btn = $('#intro-pick');
  const reset = $('#intro-reset-cover');
  if (!input || !btn) return;
  const key = coverKey(prov, city, spot);
  const hasCustom = !!store.getCover(key);
  if (reset) reset.hidden = !hasCustom;
  // 已有自定义封面：给一句说明，让用户知道这不是站点原图
  const hint = $('#cover-note');
  if (hint) {
    hint.innerHTML = hasCustom
      ? '当前封面为你自选的本机图片，仅保存在你的浏览器里。'
      : '找不到合适的图？可上传本机照片作为封面（仅存本地，不上传服务器）。';
    hint.className = 'cover-hint';
  }
  btn.onclick = () => input.click();
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) { toast('请选择图片文件'); input.value = ''; return; }
    try {
      const dataUrl = await compressImage(f);
      store.setCover(key, dataUrl);
      const el = $('#intro-cover');
      el.innerHTML = '<img src="' + dataUrl + '" alt="' + spot.n + '">';
      const ci = el.querySelector('img');
      if (ci) { markLoading(ci); ci.addEventListener('error', () => { el.innerHTML = ''; }); }
      if (reset) reset.hidden = false;
      const hint2 = $('#cover-note');
      if (hint2) hint2.innerHTML = '当前封面为你自选的本机图片，仅保存在你的浏览器里。';
      toast('封面已换成你自选的照片');
      renderNav();                       // 同步刷新卡片封面
    } catch (e) {
      toast('图片处理失败，换张小一点的试试');
    }
    input.value = '';
  };
  if (reset) reset.onclick = () => {
    store.removeCover(key);
    openSpot(prov, city, spot);        // 重开以恢复默认封面
    toast('已恢复站点默认封面');
  };
}

// ═════════ 景点详情弹窗 ═════════
async function openSpot(prov, city, spot) {
  // 只等简介库（详情页要立刻显示真实简介）；
  // 图集库 282KB 放后台加载 —— 之前 await 它会让整个弹窗卡住
  // 近 1 秒（用户点景点的第一眼延迟）。
  await DESC_DB.load();
  ensureGallery();
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
      coverEl.innerHTML = '<img src="' + real + '" alt="' + spot.n + '" referrerpolicy="no-referrer">';
    }
  }
  const coverImg = coverEl.querySelector('img');
  if (coverImg) {
    markLoading(coverImg);
    robustImg(coverImg, () => {
      coverEl.innerHTML = '<div style="position:absolute;inset:0;background:' + city.cover + '"></div><span class="cover-glyph">' + spot.n.charAt(0) + '</span>';
    });
  }
  $('#intro-name').textContent = spot.n;
  $('#intro-tag').textContent = prov.n + ' · ' + city.n + ' · ' + typeInfo.label + (isPro ? ' · 精游 3D' : '');
  const desc = realDesc(spot);
  $('#intro-desc').textContent = desc;
  renderSource(spot);
  bindCoverPicker(prov, city, spot);
  renderPanoBtn(spot);
  renderStreetBtn(spot);
  // 位置小地图（静态图接口，与街景共用坐标）
  COORD_DB.load().then(() => {
    const cc = COORD_DB.get(spot.n);
    renderStaticMap(spot, cc ? [cc[0], cc[1]] : null);
  });
  setupDescExpand();
  // 详细解说（程序化扩写 + 真实简介为底）
  // 标记 tpl=1：若稍后拿到真实历史长文，会把这段模板文案清掉
  const detailEl = $('#intro-detail');
  detailEl.textContent = expandDesc(spot.n, spot.t, desc);
  detailEl.dataset.tpl = '1';
  // 历史沿革长介绍（异步补上，先显示短简介不阻塞）
  renderHistory(spot);
  // 网友热梗评价
  const memes = SPOT_MEMES[spot.t] || SPOT_MEMES.park;
  const picked = pickN(memes, Math.min(3, memes.length), seed);
  $('#intro-memes').innerHTML = picked.map(m => '<div class="meme-item">「' + m + '」</div>').join('');
  // 图集 3 张：优先 Wikimedia 真实景点图（静态库），缺失/地区泛图则运行时精搜升级
  const gal = $('#intro-gallery');
  const caps = ['一隅 · 此景', '二景 · 此处', '三瞥 · 此间'];
  const galImgs = [];
  // 画图集：把某张图放到第 i 格（复用已有 <img> 节点，只换 src，不重建 DOM）
  const paintSlot = (i, url) => {
    const img = galImgs[i];
    if (!img || !url) return;
    const fig = img.parentElement;
    fig.className = url.startsWith('data:') ? 'no-zoom' : '';
    img.style.display = '';
    img.setAttribute('data-src', url);
    img.src = url;
  };
  const buildGallery = () => {
    gal.innerHTML = '';
    galImgs.length = 0;
    const realImgs = getSpotImages(spot.n, prov.n, 3, spot.t);
    for (let i = 0; i < 3; i++) {
      const fig = document.createElement('figure');
      if (!realImgs[i] || realImgs[i].startsWith('data:')) fig.className = 'no-zoom';
      fig.innerHTML = '<img alt="' + caps[i] + '" loading="lazy" decoding="async" referrerpolicy="no-referrer"><figcaption>' + caps[i] + '</figcaption>';
      gal.appendChild(fig);
      const img = fig.querySelector('img');
      markLoading(img);
      img.setAttribute('data-src', realImgs[i]);
      img.src = realImgs[i];
      robustImg(img, () => { fig.style.background = city.cover; img.style.display = 'none'; });
      galImgs.push(img);
    }
  };
  buildGallery();
  // 图集库是异步加载的：加载完成后用补充图刷新（原先 await 整个库，
  // 弹窗要卡近 1 秒；改成先出主图、库就绪后再补图集）
  if (!galleryReady()) {
    ensureGallery().then(() => {
      if (!$('#intro-gallery') || !$('#intro-gallery').contains(galImgs[0])) return;  // 已关闭详情
      buildGallery();
    });
  }
  // 点击图集进入灯箱大图（支持左右键切换、ESC 关闭）；占位图不可点
  galImgs.forEach(img => {
    const fig = img.parentElement;
    fig.addEventListener('click', () => {
      if (!img.src || img.src.startsWith('data:')) return;
      openLightbox(galImgs.filter(x => x.src && !x.src.startsWith('data:')).map(x => x.src),
                   galImgs.filter(x => x.src && !x.src.startsWith('data:')).indexOf(img));
    });
  });
  // 异步补搜：拿到更精准的实景图后替换（含地区泛图升级）
  enrichSpotImages(spot.n, prov.n, spot.t, 3).then(urls => {
    urls.slice(0, 3).forEach((u, i) => { if (galImgs[i] && u && !u.startsWith('data:')) paintSlot(i, u); });
  });
  // 异步拉取 Wikipedia 百科摘要（仅静态库缺失时补，避免重复请求）
  if (!DESC_DB.get(spot.n)) {
    fetchWiki(spot.n).then(w => {
      if (w.extract) {
        const el = $('#intro-detail');
        el.textContent = w.extract + '\n\n' + expandDesc(spot.n, spot.t, spot.d);
        el.dataset.tpl = '';   // 含真实摘要，不再当作纯模板文案
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
  // 同城相关推荐
  renderRelated(prov, city, spot);
  // 视频
  $('#intro-video').href = 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(prov.n + city.n + spot.n);
  $('#intro-modal').hidden = false;
  $('#intro-enter').onclick = () => {
    $('#intro-modal').hidden = true;
    enterSpot(prov, city, spot);
  };
}

// ═══ 实景看板：把景点真实照片立进 3D 场景，走到跟前就看到真实样貌 ═══
let heroBillboard = null;
function addHeroBillboard(scene, url, spawn) {
  if (!url || url.startsWith('data:')) return null;
  try {
    const tex = new THREE.TextureLoader().load(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, side: THREE.DoubleSide, fog: false, toneMapped: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 3.6), mat);
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(5.7, 3.9),
      new THREE.MeshBasicMaterial({ color: 0x0e1513, fog: false, toneMapped: false })
    );
    back.position.z = -0.03;
    mesh.add(back);
    // 金色边框
    const edge = new THREE.Mesh(
      new THREE.RingGeometry(0, 0, 4),
      new THREE.MeshBasicMaterial({ color: 0xd3b98a, fog: false, toneMapped: false })
    );
    edge.visible = false;
    mesh.add(edge);
    const sp = spawn || [0, 0, 0];
    mesh.position.set(sp[0] + 4.5, 2.3, sp[2] + 2.5);
    mesh.rotation.y = -0.5;
    mesh.renderOrder = 5;
    scene.add(mesh);
    return mesh;
  } catch (e) { return null; }
}

// ═════════ 3D 场景运行时 ═════════
let renderer = null, camera = null, roamer = null;
let built = null, clock = null, activeSpot = null, activeCtx = null;
let running = false;
let fpMarkers = [];
// 需要 THREE 存在才能构造 → 改为在 ensureRenderer 里随运行时一起创建
let raycaster = null;
let coverShotAt = 0;
let composer = null, bloomPass = null;

// 3D 运行时加载态：并发去重（连点两次不会初始化两遍），失败后清空以便重试
// 3D 运行时加载态：并发去重（连点两次不会初始化两遍），失败后清空以便重试
let rendererPromise = null;

// 真正干活的初始化：注入 3D 运行时 → 建渲染器 / 相机 / 后期处理链。
// 单独拆出来是因为 ensureRenderer 还要负责去重与重试，两件事混在一起会很难读。
async function bootRenderer() {
  if (!THREE) {
    const rt = await loadThreeRuntime();
    THREE = rt.THREE;
    EffectComposer = rt.EffectComposer;
    RenderPass = rt.RenderPass;
    UnrealBloomPass = rt.UnrealBloomPass;
    buildScene = rt.buildScene;
    Roamer = rt.Roamer;
    raycaster = new THREE.Raycaster();
  }
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

/**
 * 确保 3D 渲染器就绪。
 * - 并发安全：连点两次不会初始化两遍
 * - 失败可重试：three 走 CDN，网络抖动后再次点击能重新加载
 */
function ensureRenderer() {
  if (renderer) return Promise.resolve();
  if (!rendererPromise) {
    rendererPromise = bootRenderer().catch(err => {
      rendererPromise = null;
      throw err;
    });
  }
  return rendererPromise;
}

function resizeStage() {
  if (!renderer) return;
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  if (composer) composer.setSize(innerWidth, innerHeight);
}

async function enterSpot(prov, city, spot) {
  try {
    await ensureRenderer();
  } catch (e) {
    // three 走 CDN，断网/被拦时不能白屏，得告诉用户发生了什么
    toast('3D 引擎加载失败，请检查网络后重试', 3200);
    return;
  }
  activeSpot = { name: spot.n, tag: SPOT_TYPE[spot.t]?.label || '' };
  activeCtx = { prov: prov.n, city: city.n, spotName: spot.n };
  store.visitSpot(prov.n + '|' + city.n + '|' + spot.n);

  const themeKey = resolveTheme(store.getTheme());
  const sceneKey = PRO_SCENES[city.n + '|' + spot.n] || (SPOT_TYPE[spot.t] || SPOT_TYPE.park).scene;
  const seed = spotSeed(spot.n);
  built = buildScene(sceneKey, themeKey, renderer, seed);
  // 真实照片看板：让程序化场景里也带着该景点的真实样貌
  heroBillboard = addHeroBillboard(built.scene, getSpotCover(spot.n, prov.n, spot.t), built.spawn.pos);
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
  if (heroBillboard) heroBillboard.quaternion.copy(camera.quaternion);
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
async function openSpotDetail() {
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

  // 真实历史来历（来自维基正文长介绍）
  const histBox = $('#detail-history');
  const histText = $('#detail-history-text');
  if (histBox && histText) {
    histBox.hidden = true;
    try {
      const db = await loadLongChunk(longChunkIndex(activeSpot.name));
      const real = db[activeSpot.name];
      if (real) {
        histText.textContent = real;
        histBox.hidden = false;
      }
    } catch (e) { /* 无长介绍则不显示 */ }
  }
  // 场景内也能直接看实景全景
  const pbtn = $('#detail-pano');
  if (pbtn) {
    pbtn.hidden = true;
    PANORAMA_DB.load().then(() => {
      const p = PANORAMA_DB.get(activeSpot.name);
      if (p && p.url) {
        pbtn.hidden = false;
        pbtn.textContent = p.type === 'sphere' ? '🖐 360° 全景' : '🖐 宽幅全景';
        pbtn.onclick = () => openPano({ url: p.url, type: p.type, title: activeSpot.name, w: p.w, h: p.h });
      }
    });
  }
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
    item.opts.forEach(opt => {
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
  // 实时搜索：输入即搜（防抖 220ms），回车立即搜
  const si = $('#search-input');
  si.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(), 220);
  });
  si.addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(searchTimer); doSearch(); }
    else if (e.key === 'Escape') { si.value = ''; doSearch(); si.blur(); }
  });
  // 快捷键：/ 聚焦搜索框，Esc 关闭结果面板
  document.addEventListener('keydown', e => {
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea';
    if (e.key === '/' && !typing) { e.preventDefault(); si.focus(); si.select(); }
    else if (e.key === 'Escape' && $('#search-results').classList.contains('show')) {
      $('#search-results').classList.remove('show');
    }
  });

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
  if (heroBillboard) {
    built && built.scene && built.scene.remove(heroBillboard);
    heroBillboard.geometry && heroBillboard.geometry.dispose();
    heroBillboard = null;
  }
  roamer.enabled = false;
  if (built) { built.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); }); built = null; }
  fpMarkers = [];
}

// ═══ 路由：hash 同步 + 记忆上次位置 ═══
// #/江苏      → 江苏省内城市列表
// #/江苏/无锡  → 无锡景点列表
function syncHash() {
  let h = '#/';
  if (nav.level === 'city' && nav.prov) h = '#/' + nav.prov.n;
  else if (nav.level === 'spot' && nav.prov && nav.city) h = '#/' + nav.prov.n + '/' + nav.city.n;
  if (location.hash !== h) history.replaceState(null, '', h);
  try {
    localStorage.setItem('nr_last_nav', JSON.stringify({
      level: nav.level, p: nav.prov && nav.prov.n, c: nav.city && nav.city.n,
    }));
  } catch (e) { /* 隐私模式忽略 */ }
}
function applyLocation() {
  // 1) hash 优先（分享链接可直达）
  const parts = (location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts.length) {
    const p = PROVINCES.find(x => x.n === parts[0]);
    if (p) {
      if (parts.length === 1) { nav = { level: 'city', prov: p }; return true; }
      const c = p.cities.find(x => x.n === parts[1]);
      nav = c ? { level: 'spot', prov: p, city: c } : { level: 'city', prov: p };
      return true;
    }
  }
  // 2) 退回上次浏览位置
  try {
    const last = JSON.parse(localStorage.getItem('nr_last_nav') || 'null');
    if (last && last.p) {
      const p = PROVINCES.find(x => x.n === last.p);
      if (p) {
        const c = last.c ? p.cities.find(x => x.n === last.c) : null;
        nav = c ? { level: 'spot', prov: p, city: c } : { level: 'city', prov: p };
        return true;
      }
    }
  } catch (e) { /* 忽略 */ }
  return false;
}
window.addEventListener('hashchange', () => { if (applyLocation()) renderNav(); });

bind();
applyLocation();
renderNav();
if (store.data.user) { renderHome(); show('#home'); }
else { show('#gate'); startGateParticles(); }

// 首屏已经出来了，这时再空闲预热：
//  · 景点图库（372KB）—— 用户点进景点列表时通常已就绪，不用干等
//  · 3D 运行时（three 内核 257KB）—— 点「进入 3D 漫游」时不用干等
// 两者都不占用首屏关键路径。
warmUpSpotImages();
warmUpThree();
