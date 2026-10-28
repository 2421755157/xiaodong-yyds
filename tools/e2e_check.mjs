#!/usr/bin/env node
// ═══ 端到端冒烟测试（CDP 直连，无第三方依赖）═══
// 用 Edge/Chrome 的 --remote-debugging-port 驱动真实浏览器，
// 验证：首页渲染 / 搜索 / 点击景点详情 / 灯箱 / 路由 / 控制台报错
//
// 用法：
//   node tools/e2e_check.mjs [baseUrl] [cdpPort]
// 前置：已启动本地服务（node server.cjs）与带调试端口的浏览器：
//   msedge.exe --headless=new --remote-debugging-port=9222 --user-data-dir=<tmp> about:blank

const BASE = process.argv[2] || 'http://127.0.0.1:8765/';
const PORT = process.argv[3] || '9222';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getTarget() {
  // 显式新建一个 target，而不是复用列表里第一个 page。
  // 原因：浏览器实例里可能已有 edge:// 弹窗页、扩展页等，
  // 它们是 opaque origin（localStorage 抛 SecurityError），复用会直接崩。
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
      if (r.ok) {
        const t = await r.json();
        if (t.webSocketDebuggerUrl) return t;
      }
    } catch (e) { /* 还没起来 */ }
    await sleep(500);
  }
  // 退化：退回到挑一个可用的 page target
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl
        && !/^edge:\/\/|^chrome:\/\/|^about:/.test(t.url));
      if (page) return page;
    } catch (e) { /* 还没起来 */ }
    await sleep(500);
  }
  throw new Error('无法连接到浏览器调试端口 ' + PORT);
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = []; this.waiters = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        c.logs.push({ type: m.params.type, text: m.params.args.map(a => a.value ?? a.description ?? '').join(' ') });
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        c.logs.push({ type: 'exception', text: (d.exception && (d.exception.description || d.exception.value)) || d.text });
      } else if (m.method === 'Log.entryAdded') {
        const e = m.params.entry;
        c.logs.push({ type: e.level, text: e.text, url: e.url || '' });
      } else if (m.method === 'Fetch.requestPaused' && c.onFetch) {
        c.onFetch(m.params);
      } else if (m.method) {
        // 事件型消息：唤醒对应的事件等待者
        c.waiters = c.waiters.filter(w => {
          if (w.method !== m.method) return true;
          clearTimeout(w.timer);
          w.resolve(m.params);
          return false;
        });
      }
    };
    return c;
  }
  // 等待某个 CDP 事件（如 Page.loadEventFired）
  waitEvent(method, timeout = 20000) {
    return new Promise((resolve) => {
      const w = { method, resolve };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(x => x !== w);
        resolve(null);
      }, timeout);
      this.waiters.push(w);
    });
  }
  // 导航并等文档真正加载完成。
  // 必须在 eval 之前用：新建 target 初始是 about:blank（opaque origin），
  // 直接 eval 会抛 SecurityError（localStorage 无权限）。
  async navigate(url, timeout = 20000) {
    const loaded = this.waitEvent('Page.loadEventFired', timeout);
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(300);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('超时: ' + method)); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
    return r.result.value;
  }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail ? '  → ' + detail : ''));
}

(async () => {
  const target = await getTarget();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  // 百度静态图要求 Referer 在白名单内（线上是 2421755157.github.io），
  // 本地 localhost 必然被拒 → 注入生产域名的 Referer，才能真实验证静态图能否加载。
  //
  // ⚠ 必须用 Fetch 域按 URL 匹配拦截，不能用 Network.setExtraHTTPHeaders：
  //   setExtraHTTPHeaders 会给**所有**请求加上 Referer，
  //   包括本地 index.html 本身 → 导航直接失败成 chrome-error://。
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*api.map.baidu.com*', requestStage: 'Request' }],
  });
  cdp.onFetch = async (params) => {
    try {
      await cdp.send('Fetch.continueRequest', {
        requestId: params.requestId,
        headers: Object.entries({
          ...(params.request.headers || {}),
          Referer: 'https://2421755157.github.io/xiaodong-yyds/',
        }).map(([name, value]) => ({ name, value })),
      });
    } catch (e) { /* target 已关闭 */ }
  };
  // 预置登录态并清掉 hash 记忆，保证每次测试都从干净状态开始
  await cdp.navigate(BASE);
  await cdp.eval(`localStorage.setItem('other-side-wuxi-v1', JSON.stringify({
    user:{name:'测试员',createdAt:Date.now()}, visits:{}, footprints:[], covers:{},
    fortunes:{}, lastTheme:'auto'
  })); localStorage.removeItem('nr_last_nav'); location.hash='';`);
  await cdp.navigate(BASE);
  await sleep(4500);
  cdp.logs.length = 0;   // 清掉导航前的历史日志（Log.enable 会回放旧条目）

  // 0) 首屏加载策略守门
  // three.js gzip 就有 257KB，必须只在「进入 3D 漫游」时才下，否则看一张卡片也要等它。
  // 这里同时守住"静态依赖"和"下载时序"两个层面，防止以后又被顺手 import 回首屏。
  // 注意路径要用相对页面 URL 的 './js/app.js'：
  // 本地服务在根路径，线上在 /xiaodong-yyds/ 子路径。
  // 写死 '/js/app.js' 在线上会 404，而 404 返回的是 HTML ——
  // 正则一条都不匹配，断言反而"通过"（假阳性）。所以必须显式检查 r.ok。
  const staticDeps = await cdp.eval(`fetch('./js/app.js').then(r => {
    if (!r.ok) throw new Error('fetch app.js → HTTP ' + r.status);
    return r.text();
  }).then(t => {
    const bad = [];
    if (/from\\s+['"]three['"]/.test(t)) bad.push('three');
    if (/from\\s+['"]three\\/addons/.test(t)) bad.push('three/addons');
    if (/from\\s+['"]\\.\\/scenes\\.js['"]/.test(t)) bad.push('scenes.js');
    if (/from\\s+['"]\\.\\/roam\\.js['"]/.test(t)) bad.push('roam.js');
    if (/from\\s+['"]\\.\\/panorama\\.js['"]/.test(t)) bad.push('panorama.js');
    return bad.join(',');
  }).catch(e => 'ERROR:' + e.message)`);
  check('首屏不静态依赖 3D 运行时', staticDeps === '', staticDeps || '干净');

  const metaLoaded = await cdp.eval(
    "performance.getEntriesByType('resource').some(r => /scenes-meta\\.js/.test(r.name))");
  check('首屏引入轻量层 scenes-meta.js', metaLoaded === true, String(metaLoaded));

  const threeTiming = await cdp.eval(`(() => {
    const rs = performance.getEntriesByType('resource');
    const app = rs.find(r => /\\/js\\/app\\.js$/.test(r.name));
    const three = rs.find(r => /three\\.module\\.js/.test(r.name));
    if (!app) return 'no-app-entry';
    if (!three) return 'three-lazy';                       // 还没加载：更彻底的按需
    return three.startTime >= app.responseEnd ? 'after-app' : 'blocking';
  })()`);
  check('three 不阻塞首屏（app.js 之后才加载）',
    threeTiming === 'after-app' || threeTiming === 'three-lazy', threeTiming);

  // 景点图库同理：首屏只渲染省份网格（渐变封面），压根不需要 372KB 的景点照片
  const imgDbTiming = await cdp.eval(`(() => {
    const rs = performance.getEntriesByType('resource');
    const app = rs.find(r => /\\/js\\/app\\.js$/.test(r.name));
    const db = rs.find(r => /spot-images-db\\.js/.test(r.name));
    if (!db) return 'lazy';
    if (!app) return 'no-app-entry';
    return db.startTime >= app.responseEnd ? 'after-app' : 'blocking';
  })()`);
  check('景点图库不阻塞首屏（按需/预热加载）',
    imgDbTiming === 'after-app' || imgDbTiming === 'lazy', imgDbTiming);

  // 1) 首页渲染
  const cards = await cdp.eval("document.querySelectorAll('.spot-card').length");
  check('首页渲染景点卡片', cards > 0, cards + ' 张');

  // 2) 首页数据条
  const stats = await cdp.eval("document.querySelectorAll('#hero-stats .stat-cell').length");
  check('首页数据条渲染', stats >= 4, stats + ' 项');

  // 2a) 数字必须是构建期算好的真实值（改成 HOME_STATS 后不许再出现"加载中…"）
  const statText = await cdp.eval(
    "[...document.querySelectorAll('#hero-stats .stat-cell b')].map(b => b.textContent).join(' | ')");
  check('首页数据条为确定数字', statText.length > 0 && !/加载中/.test(statText),
    statText);

  // 2b) 省卡封面：必须铺上真实照片并真的解码出来。
  //     只断言"有 img 元素"不够——图片 404 时它照样在，只是空白。
  //     视口外的卡片是 loading=lazy，不会立刻解码，所以按"已解码张数"判定。
  await sleep(1200);
  // 先滑一屏把 loading=lazy 的卡片唤起来，再回到顶部，保证张数不是"只有首屏那几张"
  await cdp.eval("scrollTo(0, 900)");
  await sleep(1400);
  await cdp.eval("scrollTo(0, 0)");
  await sleep(600);
  const provCovRaw = await cdp.eval(`(async () => {
    const imgs = [...document.querySelectorAll('.spot-card .spot-cover img')];
    const local = imgs.filter(i => (i.getAttribute('src') || '').startsWith('img/cover/'));
    // 视口外的卡片是 loading=lazy，解码张数取决于窗口大小；
    // 所以再直接取几张图发请求，确认文件本身可取（不是 404）
    const probe = await Promise.all(local.slice(0, 3).map(u =>
      fetch(u.getAttribute('src')).then(r => r.status).catch(() => 0)));
    return JSON.stringify({
      total: imgs.length,
      decoded: imgs.filter(i => i.naturalWidth > 0).length,
      local: local.length,
      probe,
    });
  })()`);
  const provCov = JSON.parse(provCovRaw);
  const probeOk = provCov.probe.length > 0 && provCov.probe.every(s => s === 200);
  check('省卡封面是真实照片',
    provCov.total >= 30 && provCov.local >= 30 && provCov.decoded >= 4 && probeOk,
    `${provCov.decoded}/${provCov.total} 已解码，${provCov.local} 张本地图，请求状态 ${provCov.probe.join('/')}`);

  // 2c) 键盘可达性：卡片是 div，必须显式给 role/tabindex，否则 Tab 直接跳过整个网格
  const kbRaw = await cdp.eval(`(async () => {
    const c = document.querySelector('.spot-card');
    c.focus();
    const focused = document.activeElement === c;
    const role = c.getAttribute('role');
    const tab = c.tabIndex;
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 1000));
    const crumb = ((document.querySelector('#breadcrumb') || {}).textContent || '').trim();
    const back = document.querySelector('#breadcrumb a[data-go="prov"]');
    if (back) back.click();
    await new Promise(r => setTimeout(r, 900));
    return JSON.stringify({ focused, role, tab, crumb });
  })()`);
  const kb = JSON.parse(kbRaw);
  check('卡片可键盘操作（Enter 进入下一层）',
    kb.focused && kb.role === 'button' && kb.tab === 0 && kb.crumb.includes('›'),
    `focus=${kb.focused} role=${kb.role} tab=${kb.tab} 面包屑="${kb.crumb}"`);

  // 3) 省卡 → 城市列表（直辖市只有 1 个市属正常，故只断言 >0）
  await cdp.eval("document.querySelector('.spot-card').click()");
  await sleep(1200);
  const cityCards = await cdp.eval("document.querySelectorAll('.spot-card').length");
  check('点击省卡进入城市列表', cityCards > 0, cityCards + ' 张');
  const hash1 = await cdp.eval("location.hash");
  check('URL hash 同步', !!hash1 && hash1.startsWith('#/'), hash1);

  // 4) 城市卡 → 景点列表
  await cdp.eval("document.querySelector('.spot-card').click()");
  await sleep(1200);
  const spotCards = await cdp.eval("document.querySelectorAll('.spot-card').length");
  check('点击市卡进入景点列表', spotCards > 0, spotCards + ' 张');

  const imgDbLoaded = await cdp.eval(
    "performance.getEntriesByType('resource').some(r => /spot-images-db\\.js/.test(r.name))");
  check('进入景点层后图库已加载', imgDbLoaded === true, String(imgDbLoaded));

  // 图片必须真的解码出来（naturalWidth>0），而不只是 src 有值。
  // 这条是本轮的关键回归点：Wikimedia 域名在国内不可达时，
  // src 看着正常、图片却全是空白，只有 naturalWidth 能测出来。
  await sleep(2500);
  const imgReal = await cdp.eval(`(() => {
    const imgs = [...document.querySelectorAll('.spot-card img')].filter(i => i.src && !i.src.startsWith('data:'));
    const loaded = imgs.filter(i => i.naturalWidth > 0);
    return JSON.stringify({ total: imgs.length, loaded: loaded.length,
      host: imgs[0] ? new URL(imgs[0].src).host : '', sample: loaded[0] ? loaded[0].naturalWidth : 0 });
  })()`);
  const ir = JSON.parse(imgReal);
  check('景点封面图片真实解码', ir.total > 0 && ir.loaded > 0,
    `${ir.loaded}/${ir.total} 张 ${ir.sample}px @ ${ir.host}`);

  // 5) 景点卡 → 详情弹窗（用户反馈打不开的地方）
  await cdp.eval("document.querySelector('.spot-card').click()");
  await sleep(2500);
  const modalOpen = await cdp.eval("!document.getElementById('intro-modal').hidden");
  check('点击景点打开详情弹窗', modalOpen === true, 'hidden=' + (await cdp.eval("document.getElementById('intro-modal').hidden")));
  const desc = await cdp.eval("(document.getElementById('intro-desc')||{}).textContent || ''");
  check('详情有简介文本', desc.length > 8, desc.slice(0, 36) + '…');
  const galImgs = await cdp.eval("document.querySelectorAll('#intro-gallery figure img').length");
  check('图集渲染 3 格', galImgs === 3, galImgs + ' 格');
  const src = await cdp.eval("(document.querySelector('#intro-gallery img')||{}).src || ''");
  check('图集首图为真实图片', src.startsWith('http'), src.slice(0, 58));
  const related = await cdp.eval("document.querySelectorAll('#intro-related .rel-item').length");
  check('相关推荐渲染', related >= 1, related + ' 项');
  const srcLink = await cdp.eval("(document.querySelector('#intro-source a')||{}).href || ''");
  check('来源标注链接', srcLink.includes('zh.wikipedia.org'), srcLink ? '有' : '无（该景点无真实简介时隐藏）');

  // 5b) 历史沿革长介绍（分片按需加载）
  await sleep(1200);
  const histVisible = await cdp.eval("!document.getElementById('intro-history').hidden");
  const histText = await cdp.eval("(document.getElementById('hist-text')||{}).textContent || ''");
  check('历史沿革区块显示', histVisible === true, 'hidden=' + histVisible);
  check('历史沿革有内容', histText.length > 60, histText.length + ' 字：' + histText.slice(0, 30) + '…');
  const histTitle = await cdp.eval("(document.getElementById('hist-title')||{}).textContent || ''");
  check('区块标题正确', histTitle.includes('来历') || histTitle.includes('历史'), histTitle);
  const chunkReq = await cdp.eval("performance.getEntriesByType('resource').filter(r=>/long-db-\\d+\\.js/.test(r.name)).length");
  check('长介绍分片按需加载', chunkReq >= 1, '已加载 ' + chunkReq + ' 个分片');

  // 5b-2) 有真实长文时，模板化的「详细解说」应让位给真实史料
  // （expandDesc 的模板文案对所有景点都一样，会稀释真实内容）
  const detailTpl = await cdp.eval("(document.getElementById('intro-detail')||{}).dataset ? document.getElementById('intro-detail').dataset.tpl : 'x'");
  const detailText = await cdp.eval("(document.getElementById('intro-detail')||{}).textContent || ''");
  if (histVisible) {
    check('有真实长文时模板解说让位', detailTpl !== '1' || detailText.length === 0,
      'tpl=' + JSON.stringify(detailTpl) + ' len=' + detailText.length);
  } else {
    check('无长文时保留模板解说', detailTpl === '1' || detailText.length > 0,
      'tpl=' + JSON.stringify(detailTpl) + ' len=' + detailText.length);
  }

  // 5b-3) 懒加载库统一走 lazyDB：简介库加载后 get() 应可用
  // 用 BASE 拼绝对 URL：嵌套 import() 的基准是模块自身 URL，
  // 相对路径在本地与线上部署下解析结果不同
  const LAZY_BASE = BASE.replace(/\/$/, '') + '/js/';
  const lazyOk = await cdp.eval(
    `import(${JSON.stringify(LAZY_BASE + 'lazy-db.js')}).then(m=>{`
    + `const d=m.lazyDB(()=>import(${JSON.stringify(LAZY_BASE + 'spot-desc-db.js')}),x=>x.SPOT_DESC_DB);`
    + "return d.load().then(()=>d.ready() && typeof d.get('故宫')==='string');})");
  check('lazyDB 统一懒加载可用', lazyOk === true, String(lazyOk));

  // 5c) 实景全景（故宫等名景有全景资源）
  await sleep(1500);
  const panoBtn = await cdp.eval("!document.getElementById('intro-pano').hidden");
  check('全景按钮出现（有全景资源的景点）', panoBtn === true, 'hidden=' + panoBtn);
  if (panoBtn) {
    await cdp.eval("document.getElementById('intro-pano').click()");
    // 全景浮层是打开的瞬间才由 panorama.js 动态创建，且要现拉 three.js；
    // 线上（非 localhost）首次加载明显更慢，等 2.2s 会假失败
    await sleep(4500);
    const panoOpen = await cdp.eval(
      "(()=>{const b=document.getElementById('pano-overlay');return !!b && !b.hidden})()");
    check('全景查看器打开', panoOpen === true, 'open=' + panoOpen);
    const canvas = await cdp.eval("!!document.querySelector('#pano-overlay canvas')");
    check('全景 WebGL 画布渲染', canvas === true, 'canvas=' + canvas);
    await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
    await sleep(600);
    const panoClosed = await cdp.eval(
      "(()=>{const b=document.getElementById('pano-overlay');return !b || b.hidden})()");
    check('全景 ESC 关闭', panoClosed === true, 'hidden=' + panoClosed);
  }

  // 5d) 位置小地图（百度静态图）
  await sleep(1500);
  const mapVisible = await cdp.eval("!document.getElementById('intro-map').hidden");
  check('位置小地图显示', mapVisible === true, 'hidden=' + mapVisible);
  if (mapVisible) {
    const mapImg = await cdp.eval("(()=>{const i=document.getElementById('map-img');return i?(i.naturalWidth+'x'+i.naturalHeight):'none';})()");
    check('静态图已加载', mapImg !== 'none' && !/^0x/.test(mapImg), mapImg);
    // 视野档位切换：街区 → 全域（静态图接口没有图层参数，只能切 zoom）
    const before = await cdp.eval("(document.getElementById('map-img')||{}).src || ''");
    await cdp.eval("(()=>{document.getElementById('map-view-city').click();return 1})()");
    await sleep(2000);
    const after = await cdp.eval("(document.getElementById('map-img')||{}).src || ''");
    check('视野档位切换生效', after !== before && after.includes('zoom=11'), after.slice(-48));
    const mapImg2 = await cdp.eval("(()=>{const i=document.getElementById('map-img');return i?(i.naturalWidth+'x'+i.naturalHeight):'none';})()");
    check('全域图已加载', mapImg2 !== 'none' && !/^0x/.test(mapImg2), mapImg2);
    const mapHref = await cdp.eval("(document.getElementById('map-open')||{}).href || ''");
    check('百度地图跳转链接', mapHref.includes('api.map.baidu.com/marker'), mapHref ? '有' : '无');
  }

  // 5e) 实景街景按钮：服务未开通时必须隐藏，不能显示一个点了必炸的按钮
  const streetHidden = await cdp.eval("document.getElementById('intro-street').hidden");
  const caps = await cdp.eval("import('./js/config.js').then(m=>m.BAIDU_CAPS)");
  if (caps && caps.panorama === false) {
    check('街景按钮在服务禁用时隐藏', streetHidden === true, 'hidden=' + streetHidden);
  } else {
    check('街景按钮显示（服务已开通）', streetHidden === false, 'hidden=' + streetHidden);
  }

  // 6) 灯箱
  await cdp.eval("document.querySelector('#intro-gallery figure').click()");
  await sleep(700);
  const lb = await cdp.eval("!!document.getElementById('lightbox') && !document.getElementById('lightbox').hidden");
  check('图集灯箱打开', lb === true, 'lb=' + lb);
  await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
  await sleep(400);
  const lbClosed = await cdp.eval("!document.getElementById('lightbox') || document.getElementById('lightbox').hidden");
  check('灯箱 ESC 关闭', lbClosed === true, 'closed=' + lbClosed);

  // 7) 搜索
  await cdp.eval("document.getElementById('intro-x').click()");
  await sleep(300);
  await cdp.eval("const i=document.getElementById('search-input'); i.value='太湖'; i.dispatchEvent(new Event('input',{bubbles:true}))");
  // 搜索是防抖 + 异步查库，固定睡 900ms 会随机器负载偶发落空 → 改成轮询
  let sres = 0;
  for (let i = 0; i < 14; i++) {
    sres = await cdp.eval("document.querySelectorAll('#search-results .sr-item').length");
    if (sres > 0) break;
    await sleep(250);
  }
  check('搜索实时出结果', sres > 0, sres + ' 条');
  const chips = await cdp.eval("document.querySelectorAll('#search-results .sr-chip').length");
  check('搜索筛选条渲染', chips === 4, chips + ' 个筛选按钮');

  // 7a) 搜索要能命中「简介正文」而不只是名称
  // （原实现里简介库是懒加载的，库没就绪时 get() 恒为 undefined，
  //  搜正文会全部落空 —— 这条断言专门守住这个回归）
  const hitDesc = await cdp.eval(`(async()=>{
    const db = await import(${JSON.stringify(BASE.replace(/\/$/, '') + '/js/spot-desc-db.js')});
    const entries = Object.entries(db.SPOT_DESC_DB);
    // 找一个「名称不含、但简介含」的关键字
    for (const [name, v] of entries) {
      const txt = (Array.isArray(v) ? v[0] : v) || '';
      if (txt.length < 40) continue;
      const kw = txt.slice(6, 10);
      if (!kw || name.includes(kw)) continue;
      const i = document.getElementById('search-input');
      i.value = kw;
      i.dispatchEvent(new Event('input', {bubbles:true}));
      await new Promise(r => setTimeout(r, 700));
      const n = document.querySelectorAll('#search-results .sr-item').length;
      if (n > 0) return kw + ':' + n;
    }
    return 'none';
  })()`);
  check('搜索可命中简介正文', hitDesc !== 'none' && hitDesc.split(':')[1] > 0, String(hitDesc));

  // 7b) 进入 3D 漫游：场景画布 + 实景看板
  await cdp.eval("document.getElementById('intro-enter').click()");
  await sleep(3500);
  const canvas3d = await cdp.eval("(()=>{const c=document.getElementById('scene-canvas');return c? (c.width+'x'+c.height) : 'none';})()");
  check('3D 场景画布创建', canvas3d !== 'none' && !/^0x/.test(canvas3d), canvas3d);

  const threeNow = await cdp.eval(
    "performance.getEntriesByType('resource').some(r => /three\\.module\\.js/.test(r.name))");
  check('进入 3D 后 three 已按需加载', threeNow === true, String(threeNow));
  const gl = await cdp.eval("(()=>{try{const c=document.getElementById('scene-canvas');return !!(c && (c.getContext('webgl2')||c.getContext('webgl')));}catch(e){return false}})()");
  check('WebGL 上下文可用', gl === true, 'gl=' + gl);
  const errsInScene = cdp.logs.filter(l => /error|exception/i.test(l.type));
  check('3D 场景无报错', errsInScene.length === 0, errsInScene.length ? errsInScene.slice(0, 2).map(e => (e.text || '').slice(0, 80)).join(' | ') : '干净');

  // 8) 控制台报错
  const errs = cdp.logs.filter(l => /error|exception/i.test(l.type));
  check('无控制台错误', errs.length === 0, errs.length
    ? errs.slice(0, 3).map(e => (e.text || '').slice(0, 60) + ' @' + (e.url || '').slice(-60)).join(' | ')
    : '干净');

  console.log('\n通过 ' + results.filter(r => r.ok).length + '/' + results.length);
  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    console.log('失败项：' + failed.map(f => f.name).join('、'));
    process.exitCode = 1;
  }
  process.exit(0);
})().catch(e => { console.error('测试异常:', e.message); process.exit(2); });
