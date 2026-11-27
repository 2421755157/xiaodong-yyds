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
const ORIGIN = new URL(BASE).origin;

// 外域图片/接口加载失败 ≠ 站点出错。
// 图组是热链的 360 图床（p*.ssl.qhimgs1.com，按 /dr/720_720_/ 缩放）、小地图是
// 百度静态图接口，两者在部分网络（含本机）直接连不上，浏览器会往控制台写一条
// 「Failed to load resource: net::ERR_*」。那是被测环境的网络，不是页面脚本的错；
// 自有资源（同源）加载失败仍然必须让测试红。
function isExternalAssetFailure(l) {
  if (!/Failed to load resource/i.test(l.text || '')) return false;
  if (!l.url || !/^https?:/i.test(l.url)) return false;
  try { return new URL(l.url).origin !== ORIGIN; } catch { return false; }
}

// 浏览器扩展自己的日志也不属于站点。无头实例里装了扩展（或被宿主注入）时，
// 扩展重载/卸载会让它抛 "Extension context invalidated."，扩展包内字体取不到
// 又会在控制台写一条 ERR_FILE_NOT_FOUND（URL 是 chrome-extension://…）。
// 这些既不是页面脚本的错，站点也无从修复，却会让「无控制台错误」随扩展状态
// 随机变红。按来源剔除，并在结果里把剔除条数报出来，避免把真错误也藏掉 —
// 判据只看 chrome-extension:// 来源与那条固定的失效文案，不放宽 script error。
function isExtensionNoise(l) {
  const s = (l.url || '') + ' ' + (l.text || '');
  return /(?:chrome|edge|moz)-extension:\/\//i.test(s)
    || /Extension context invalidated/i.test(s);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 轮询等待条件成立。固定 sleep 会随机器负载偶发失败（搜索出结果、图片解码
// 都是"网络快就早、慢就晚"），断言应该等状态而不是猜时间。
async function waitFor(fn, timeout = 8000, step = 200) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  return last;
}

// 判断当前地址是不是导航目标（同文档 hash 跳转用）。
// 不能直接比字符串：浏览器会把 hash 里的中文重新百分号编码，大小写也可能不同。
function sameDocUrl(current, target) {
  try {
    const a = new URL(current), b = new URL(target);
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search
      && decodeURIComponent(a.hash) === decodeURIComponent(b.hash);
  } catch (e) {
    return false;
  }
}

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
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = []; this.waiters = []; this.mapResponses = []; this.net = []; }
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
      } else if (m.method === 'Network.requestWillBeSent') {
        // 记账真实发出的请求：有些断言要判"某个资源到底有没有被请求"，
        // performance.getEntriesByType('resource') 会随缓冲区/缓存状态丢条目，
        // 网络层才是事实（线上曾因此假红）。
        c.net.push(m.params.request.url);
      } else if (m.method === 'Network.responseReceived'
        && /api\.map\.baidu\.com/.test(m.params.response.url || '')) {
        // 静态图接口这次到底有没有回话。用来判定"降级"是环境拦住了，
        // 还是接口明明回了 200 却没把图显示出来（后者必须算失败）。
        c.mapResponses.push(m.params.response.status);
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
  //
  // ⚠ 不能只等 Page.loadEventFired。站内「切景点/切城市」走的都是 hash 跳转，
  // 属于**同文档导航**，load 事件永远不会再来（Page.navigate 对这类导航也不返回
  // loaderId）：以前每次都干等满 20s 超时才继续，整个套件为此多花约 4 分钟；
  // 更要命的是这段空窗里页面其实早已切换，断言却可能在切换瞬间读到**上一处
  // 景点**的 DOM——「分片失败后打开同片景点能自动重试」偶发假失败就是这么来的。
  // 现在按 loaderId 分流：换文档才等 load，纯 hash 跳转只等地址生效。
  async navigate(url, timeout = 20000) {
    const loaded = this.waitEvent('Page.loadEventFired', timeout);
    const nav = await this.send('Page.navigate', { url, transitionType: 'typed' });
    if (nav && nav.loaderId) {
      await loaded;
    } else {
      // 同文档：等到 location 真的变成目标地址（最多 3s，正常几十毫秒）
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) {
        try {
          const href = await this.eval('location.href');
          if (sameDocUrl(href, url)) break;
        } catch (e) { /* 导航中上下文可能被销毁，下一轮再试 */ }
        await sleep(50);
      }
    }
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
  // 真实按键。不能用 document.dispatchEvent(new KeyboardEvent(...)) 代替：
  // 事件目标是 document 本身时，捕获与冒泡监听按**注册顺序**执行，抢不到先手；
  // 而真实按键的目标是聚焦元素，捕获阶段才会先于详情页的冒泡监听。
  // 「全景里按方向键会不会顺手换掉景点」这类断言必须走这条路径才作数。
  async key(k, code, vk, modifiers = 0) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers,
    });
  }
}

const results = [];
let CDP_REF = null;              // 失败时顺手打出这一段里的页面异常，省得再写探针复现
let logCursor = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail ? '  → ' + detail : ''));
  if (!ok && CDP_REF) {
    const errs = CDP_REF.logs.slice(logCursor).filter(l => l.type === 'exception' || l.type === 'error');
    if (errs.length) {
      console.log('     [页面异常] ' + errs.slice(-3).map(e => e.text.slice(0, 160)).join(' | '));
    } else {
      console.log('     [页面无异常] 本轮日志共 ' + CDP_REF.logs.length + ' 条');
    }
  }
  logCursor = CDP_REF ? CDP_REF.logs.length : 0;
}

(async () => {
  const target = await getTarget();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  CDP_REF = cdp;
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  // 把自己置为前台页面。浏览器实例里可能有多个 target（本次新建的、初始的
  // about:blank、上次跑剩下的），非前台 target 的 rAF 会被节流到约 2 次/秒，
  // 而"星空还在不在流动"这类断言正是量 450ms 内画布有没有变化 —— 一旦被节流，
  // 画布纹丝不动，就会误报"恢复正常动效后星空没动"（还会把前一条"静止"顺带假通过）。
  await cdp.send('Page.bringToFront');
  await cdp.send('Network.enable');
  // 关掉缓存。对线上站点跑时必须这样，否则 GitHub Pages 的 max-age=600
  // 会让浏览器用上一次的旧模块，测出来一堆"回归"，其实只是缓存。
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  // 百度静态图要求 Referer 在白名单内（线上是 2421755157.github.io），
  // 本地 localhost 必然被拒 → 注入生产域名的 Referer，才能真实验证静态图能否加载。
  //
  // ⚠ 必须用 Fetch 域按 URL 匹配拦截，不能用 Network.setExtraHTTPHeaders：
  //   setExtraHTTPHeaders 会给**所有**请求加上 Referer，
  //   包括本地 index.html 本身 → 导航直接失败成 chrome-error://。
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*api.map.baidu.com*', requestStage: 'Request' },
      // 长介绍分片也要过一道：默认全放行，只在「分片失败可恢复」那条用例里
      // 掐断一次 long-db-N.js，模拟弱网下一次请求被中断。
      { urlPattern: '*long-db-*', requestStage: 'Request' },
      // 简介分片同理：只在「搜索不等整库」那条用例里把请求扣住不放，
      // 用来证明名称命中不依赖这 570KB。
      { urlPattern: '*spot-desc-shard-*', requestStage: 'Request' },
    ],
  });
  let longBlockIdx = null;   // 要掐断的分片号（掐一次后自动清空）
  let longBlockHits = 0;
  const longReqCount = Object.create(null);   // 分片号 → 实际发出的请求次数
  let mapBlockOnce = false;  // 掐断一次静态图请求，验证"接口被拦"时的降级
  let mapBlockHits = 0;
  let mapReqSeen = 0;        // 底图请求次数（含被掐断的），用来验证"不重复发"与"重试真发"
  // 简介分片：descHold 期间只记账不 continue（请求被扣在 Fetch 拦截里），
  // 用来验证"首条搜索结果不等整库"。descReqSeen 统计真正发出的请求数。
  let descHold = false;
  let descReqSeen = 0;
  const descHeld = [];
  cdp.onFetch = async (params) => {
    try {
      const url = params.request.url || '';
      if (/api\.map\.baidu\.com/.test(url)) mapReqSeen++;
      if (/spot-desc-shard-\d+\.js/.test(url)) {
        descReqSeen++;
        if (descHold) { descHeld.push(params.requestId); return; }
        await cdp.send('Fetch.continueRequest', { requestId: params.requestId });
        return;
      }
      const lm = url.match(/long-db-(\d+)\.js/);
      if (lm) {
        const idx = Number(lm[1]);
        longReqCount[idx] = (longReqCount[idx] || 0) + 1;
        if (longBlockIdx !== null && idx === longBlockIdx) {
          longBlockIdx = null;   // 只掐这一次，后面要能恢复
          longBlockHits++;
          await cdp.send('Fetch.failRequest', {
            requestId: params.requestId, errorReason: 'ConnectionReset',
          });
          return;
        }
        await cdp.send('Fetch.continueRequest', { requestId: params.requestId });
        return;
      }
      if (/api\.map\.baidu\.com/.test(url) && mapBlockOnce) {
        mapBlockOnce = false;   // 只掐一次：验证降级后还要能恢复
        mapBlockHits++;
        await cdp.send('Fetch.failRequest', {
          requestId: params.requestId,
          errorReason: 'ConnectionReset',
        });
        return;
      }
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
    const three = rs.find(r => /three\\.module(?:\\.min)?\\.js/.test(r.name));
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

  // 地址栏层级（#/省 = 1，#/省/市 = 2）。用它判断"真的进到下一层了"，
  // 比 sleep 固定毫秒可靠 —— 线上首屏要等图库，固定等待会偶发失败。
  const hashDepth = () => cdp.eval(
    "decodeURIComponent(location.hash).replace(/^#\\/?/,'').split('/').filter(Boolean).length");
  const waitDepth = n => waitFor(async () => (await hashDepth()) >= n, 12000);

  // 3) 省卡 → 城市列表（直辖市只有 1 个市属正常，故只断言 >0）
  await cdp.eval("document.querySelector('.spot-card').click()");
  await waitDepth(1);
  const cityCards = await cdp.eval("document.querySelectorAll('.spot-card').length");
  check('点击省卡进入城市列表', cityCards > 0, cityCards + ' 张');
  const hash1 = await cdp.eval("location.hash");
  check('URL hash 同步', !!hash1 && hash1.startsWith('#/'), hash1);

  // 3a) 城市卡的文案来自省市简介库，仍然用不上 590KB 的景点简介库。
  //     它以前在进站那一刻就被拉下来，到货后把同样的省卡原样重绘一遍。
  const descDbAtCity = await cdp.eval(
    "performance.getEntriesByType('resource').some(r => /spot-desc-(db|shard-\\d+)\\.js/.test(r.name))");
  check('城市层不拉景点简介（分片也不拉）', descDbAtCity === false, '已拉=' + descDbAtCity);

  // 4) 城市卡 → 景点列表
  await cdp.eval("document.querySelector('.spot-card').click()");
  await waitDepth(2);
  const spotCards = await cdp.eval("document.querySelectorAll('.spot-card').length");
  check('点击市卡进入景点列表', spotCards > 0, spotCards + ' 张');

  // 4a) 到了景点层才该拉简介，而且只拉「当前这一省」那一片（约 82KB），
  //     不是整库 656KB。整库只有搜索的正文匹配才用得上。
  //     卡片摘要判据用长度：手写兜底简介全部 ≤29 字（1891 处里只有 1 处到 30 字），
  //     词条首段截到 44 字，所以 ≥30 字基本只可能来自库里。
  const descShape = `(() => {
    const rs = performance.getEntriesByType('resource').map(r => r.name);
    return JSON.stringify({
      shards: rs.filter(u => /spot-desc-shard-\\d+\\.js/.test(u)).length,
      full: rs.some(u => /spot-desc-db\\.js/.test(u)),
    });
  })()`;
  const descAtSpotRaw = await waitFor(async () => {
    const o = JSON.parse(await cdp.eval(descShape));
    if (!o.shards) return null;
    const r = await cdp.eval(`(() => {
      const ds = [...document.querySelectorAll('#spot-grid .spot-card p')].map(p => p.textContent.trim());
      return JSON.stringify({ n: ds.length, ge30: ds.filter(d => d.length >= 30).length,
        first: ds[0] || '' });
    })()`);
    const d = JSON.parse(r);
    return d.n > 0 && d.ge30 >= Math.ceil(d.n * 0.6) ? r : null;
  }, 15000);
  const dsp = descAtSpotRaw ? JSON.parse(descAtSpotRaw) : { n: 0, ge30: 0, first: '' };
  check('景点层才拉简介，卡片摘要换成词条原文',
    !!descAtSpotRaw && dsp.ge30 >= Math.ceil(dsp.n * 0.6),
    `${dsp.ge30}/${dsp.n} 条为词条原文，首条：${dsp.first.slice(0, 20)}`);

  const shardNow = JSON.parse(await cdp.eval(descShape));
  check('景点层只拉当前省那一片简介（不下整库）',
    shardNow.shards === 1 && shardNow.full === false,
    `分片请求 ${shardNow.shards} 个，整库已拉=${shardNow.full}`);

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
  //    先聚焦卡片再点，模拟键盘用户，顺便记录"打开者"，供后面验证焦点归还
  const opener = await cdp.eval(`(() => {
    const c = document.querySelector('.spot-card');
    c.focus();
    return c.querySelector('h4').textContent;
  })()`);
  // 从这一刻起的网络请求单独记一段，下面判"图组只拉本省那片"用网络层而不是
  // performance 条目：后者受资源时序缓冲区与缓存状态影响，线上偶发读不到某条，
  // 会让断言假红（同一份代码本地全绿、线上连红两次）。
  const netMarkAtSpot = cdp.net.length;
  await cdp.eval("document.querySelector('.spot-card').click()");
  // 等弹窗真的打开（要等简介库 250KB 就绪），别用固定 sleep
  await waitFor(async () => (await cdp.eval("!document.getElementById('intro-modal').hidden")) === true, 15000);
  const modalOpen = await cdp.eval("!document.getElementById('intro-modal').hidden");
  check('点击景点打开详情弹窗', modalOpen === true, 'hidden=' + (await cdp.eval("document.getElementById('intro-modal').hidden")));

  // 5b) 详情页的简介来自「该省那一片」，不该为了一个景点把 656KB 整库拖下来
  //     （这一句 await 就压在用户点下去到弹窗出现之间）
  const detailShape = await cdp.eval(`(() => {
    const rs = performance.getEntriesByType('resource').map(r => r.name);
    return JSON.stringify({
      len: (document.getElementById('intro-desc').textContent || '').trim().length,
      shards: rs.filter(u => /spot-desc-shard-\\d+\\.js/.test(u)).length,
      full: rs.some(u => /spot-desc-db\\.js/.test(u)),
    });
  })()`);
  const dshape = JSON.parse(detailShape);
  check('详情页简介来自本省分片（没为一条简介下整库）',
    dshape.len > 20 && dshape.full === false && dshape.shards === 1,
    `简介 ${dshape.len} 字，分片 ${dshape.shards} 个，整库已拉=${dshape.full}`);

  // 5a) 对话框语义 + 焦点进入
  //     没有这些，读屏软件把弹窗当普通 div，Tab 也还在背后的卡片上走
  const dlgRaw = await cdp.eval(`(() => {
    const m = document.getElementById('intro-modal');
    const a = document.activeElement;
    return JSON.stringify({
      role: m.getAttribute('role'),
      ariaModal: m.getAttribute('aria-modal'),
      labelled: m.getAttribute('aria-labelledby'),
      named: !!(m.getAttribute('aria-labelledby') || m.getAttribute('aria-label')),
      inside: m.contains(a),
      focus: a ? (a.id || a.className || a.tagName) : '',
    });
  })()`);
  const dlg = JSON.parse(dlgRaw);
  check('详情弹窗是标准对话框且焦点已进入',
    dlg.role === 'dialog' && dlg.ariaModal === 'true' && dlg.named && dlg.inside,
    `role=${dlg.role} aria-modal=${dlg.ariaModal} labelled=${dlg.labelled} 焦点=${dlg.focus}`);
  const desc = await cdp.eval("(document.getElementById('intro-desc')||{}).textContent || ''");
  check('详情有简介文本', desc.length > 8, desc.slice(0, 36) + '…');
  const galImgs = await cdp.eval("document.querySelectorAll('#intro-gallery figure img').length");
  check('图集渲染 3 格', galImgs === 3, galImgs + ' 格');
  const src = await cdp.eval("(document.querySelector('#intro-gallery img')||{}).src || ''");
  check('图集首图为真实图片', src.startsWith('http'), src.slice(0, 58));
  // 图组以前混着 wikimedia（国内打不开）和 1.2MB 原图，现在必须全是
  // 可缩放地址或同源本地图
  const galRaw = await cdp.eval(`(() => {
    const imgs = [...document.querySelectorAll('#intro-gallery figure img')];
    return JSON.stringify(imgs.map(i => i.getAttribute('src') || ''));
  })()`);
  const galUrls = JSON.parse(galRaw);
  // data: 是占位图，属于合法兜底（景点图不足 3 张时），不算违规
  const badSrc = galUrls.filter(u => u && !u.startsWith('data:') && !u.startsWith('img/') && !u.includes('/dr/'));
  check('图组地址均已缩放/同源', badSrc.length === 0,
    badSrc.length ? badSrc[0].slice(0, 56) : galUrls.length + ' 张合规');
  const decoded = await waitFor(async () => {
    const n = await cdp.eval(
      "[...document.querySelectorAll('#intro-gallery figure img')].filter(i=>i.naturalWidth>0).length");
    return n >= 2 ? n : 0;
  }, 12000);
  check('图组图片真实解码', decoded >= 2, decoded + '/3 张已解码');

  // 5c) 图组只拉「本省」那一片。
  //     以前整库 292KB（1873 处景点的图组）一次性懒加载 —— 为了图集第 2/3 格
  //     那两张 720px 缩略图，先把全国的图组拖下来。
  //     现在一省一片（tools/shard_gallery.py）：单片 1~16KB。
  //     同时守住「整库不能再被拉一次」—— 有人把 import 改回去，这里立刻红。
  //
  //     判据取「点开这处景点之后真实发出的请求」（CDP 网络层）。
  //     原实现读 performance.getEntriesByType('resource')：那个缓冲区会随条目数
  //     与缓存状态丢记录，线上跑两次都读不到 gallery-shard-N.js（本地全绿），
  //     是判据不稳，不是真下了整库——已用网络层交叉验证过。
  const netSinceSpot = cdp.net.slice(netMarkAtSpot)
    .filter(u => /gallery-shard-\d+\.js/.test(u) || /spot-gallery-db\.js/.test(u));
  const netShards = netSinceSpot.filter(u => /gallery-shard-\d+\.js/.test(u)).map(u => u.split('/').pop());
  const netFull = netSinceSpot.some(u => /spot-gallery-db\.js/.test(u));
  const galShardRaw = await cdp.eval(`(async () => {
    const m = await import('./js/gallery-shard-map.js');
    const prov = decodeURIComponent(location.hash).replace(/^#\\/?/, '').split('/')[0];
    return JSON.stringify({ prov, want: m.GALLERY_SHARD_OF[prov] });
  })()`);
  const gs = JSON.parse(galShardRaw);
  check('图组只拉本省那一片（没为 3 张缩略图下整库）',
    netFull === false && netShards.length === 1 && netShards[0] === 'gallery-shard-' + gs.want + '.js',
    `${gs.prov} → 片${gs.want}，请求 ${netShards.join('、') || '无'}，整库已拉=${netFull}`);

  // 上一处 / 下一处：详情页里直接翻同城景点
  const beforeName = await cdp.eval("document.getElementById('intro-name').textContent");
  const stepVisible = await cdp.eval("!document.getElementById('intro-next').hidden");
  check('详情页有上一处/下一处', stepVisible === true, 'visible=' + stepVisible);
  await cdp.eval("document.getElementById('intro-next').click()");
  const afterName = await waitFor(async () => {
    const n = await cdp.eval("document.getElementById('intro-name').textContent");
    return n && n !== beforeName ? n : 0;
  }, 6000);
  check('点击下一处切换到同城另一景点', !!afterName,
    beforeName + ' → ' + (afterName || '(未变)'));
  await cdp.eval("document.getElementById('intro-prev').click()");
  const backName = await waitFor(async () => {
    const n = await cdp.eval("document.getElementById('intro-name').textContent");
    return n === beforeName ? n : 0;
  }, 6000);
  check('点上一处能回到原景点', backName === beforeName, backName || '(未回)');
  const related = await cdp.eval("document.querySelectorAll('#intro-related .rel-item').length");
  check('相关推荐渲染', related >= 1, related + ' 项');
  const srcLink = await cdp.eval("(document.querySelector('#intro-source a')||{}).href || ''");
  check('来源标注链接', srcLink.includes('baike.baidu.com'), srcLink ? '有' : '无（该景点无真实简介时隐藏）');

  // 5b) 历史沿革长介绍（按省分片，按需加载）
  await sleep(1200);
  const histVisible = await cdp.eval("!document.getElementById('intro-history').hidden");
  const histText = await cdp.eval("(document.getElementById('hist-text')||{}).textContent || ''");
  check('历史沿革区块显示', histVisible === true, 'hidden=' + histVisible);
  check('历史沿革有内容', histText.length > 60, histText.length + ' 字：' + histText.slice(0, 30) + '…');
  const histTitle = await cdp.eval("(document.getElementById('hist-title')||{}).textContent || ''");
  check('区块标题正确', histTitle.includes('来历') || histTitle.includes('历史'), histTitle);
  // 5b-1) 历史沿革只拉「本省」那一片（一省一片，最大 138KB / gzip 约 63KB）。
  //       以前按景点名首字分 8 片：单片 213~411KB，为了看一处景点 900 字的来历，
  //       先把八分之一全国的长文拖下来（打开大理洱海实测 336KB）。
  //       片号来自 js/long-shard-map.js，这里顺带验证「映射表能加载且指得对」——
  //       表错一位，那一省的历史沿革会请求成功但一条都没有。
  const longShape = await cdp.eval(`(async () => {
    const rs = performance.getEntriesByType('resource').map(r => r.name)
      .filter(u => /long-db-\\d+\\.js/.test(u));
    const m = await import('./js/long-shard-map.js');
    const prov = decodeURIComponent(location.hash).replace(/^#\\/?/, '').split('/')[0];
    return JSON.stringify({ req: rs.map(u => u.split('/').pop()), prov,
      want: m.LONG_SHARD_OF[prov], n: rs.length });
  })()`);
  const ls = JSON.parse(longShape);
  check('历史沿革只拉本省那一片',
    ls.n === 1 && ls.req[0] === 'long-db-' + ls.want + '.js',
    `${ls.prov} → 片${ls.want}，实际请求 ${ls.req.join('、') || '无'}`);

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
    const spotBefore = await cdp.eval("document.getElementById('intro-name').textContent");
    // 用键盘打开：先聚焦按钮再回车，等同于键盘用户的操作路径
    await cdp.eval("(()=>{const b=document.getElementById('intro-pano');b.focus();b.click();})()");
    // 全景浮层是打开的瞬间才由 panorama.js 动态创建，且要现拉 three.js；
    // 线上（非 localhost）首次加载明显更慢，等 2.2s 会假失败
    await sleep(4500);
    const panoOpen = await cdp.eval(
      "(()=>{const b=document.getElementById('pano-overlay');return !!b && !b.hidden})()");
    check('全景查看器打开', panoOpen === true, 'open=' + panoOpen);
    const canvas = await cdp.eval("!!document.querySelector('#pano-overlay canvas')");
    check('全景 WebGL 画布渲染', canvas === true, 'canvas=' + canvas);

    // 对话框语义 + 焦点落位。
    // 以前浮层是个裸 div：读屏不播报"打开了什么"，焦点还留在背后被遮住的按钮上，
    // Tab 一路在景点弹窗里走，屏幕上却只看到一张全景图。
    const pa = JSON.parse(await cdp.eval(`(() => {
      const o = document.getElementById('pano-overlay');
      const t = document.getElementById('pano-title');
      const a = document.activeElement;
      return JSON.stringify({
        role: o.getAttribute('role'), modal: o.getAttribute('aria-modal'),
        title: (t && t.textContent) || '', inPano: o.contains(a),
        active: a.className || a.id || a.tagName,
      });
    })()`));
    check('全景浮层是对话框，焦点落在画面里',
      pa.role === 'dialog' && pa.modal === 'true' && pa.title.length > 0 && pa.inPano === true,
      `role=${pa.role} modal=${pa.modal} 标题=${pa.title} 焦点=${pa.active}`);

    // Tab 不许跑到背后那层
    const trail = [];
    for (let i = 0; i < 3; i++) {
      await cdp.key('Tab', 'Tab', 9);
      await sleep(120);
      trail.push(await cdp.eval(`(() => {
        const o = document.getElementById('pano-overlay');
        const a = document.activeElement;
        return (o.contains(a) ? '内:' : '外:') + (a.className || a.id || a.tagName);
      })()`));
    }
    check('Tab 在全景浮层内循环，不落到背后的按钮', trail.every(x => x.startsWith('内:')), trail.join(' → '));

    // 方向键只转视角，不该顺带把背后景点翻走
    // （原先 direction 事件从浮层冒泡到详情页的「← → 翻上一处」，按两下就换景点）
    await cdp.key('ArrowLeft', 'ArrowLeft', 37);
    await sleep(150);
    await cdp.key('ArrowRight', 'ArrowRight', 39);
    await sleep(250);
    const afterArrows = await cdp.eval(`(() => {
      const o = document.getElementById('pano-overlay');
      return JSON.stringify({
        name: document.getElementById('intro-name').textContent,
        open: !!o && !o.hidden,
      });
    })()`);
    const aa = JSON.parse(afterArrows);
    check('全景里按方向键不会顺带换掉背后的景点',
      aa.name === spotBefore && aa.open === true,
      `${spotBefore} → ${aa.name}，全景仍开=${aa.open}`);

    await cdp.key('Escape', 'Escape', 27);
    await sleep(600);
    const panoClosed = await cdp.eval(
      "(()=>{const b=document.getElementById('pano-overlay');return !b || b.hidden})()");
    check('全景 ESC 关闭', panoClosed === true, 'hidden=' + panoClosed);
    const backFocus = await cdp.eval(
      "(()=>{const a=document.activeElement;return a.id||a.className||a.tagName})()");
    check('关掉全景后焦点回到「全景」按钮', backFocus === 'intro-pano', '焦点=' + backFocus);
  }

  // 5d) 位置小地图（百度静态图）
  //     底图是第三方接口：AK 带 Referer 白名单、国内网络还可能直接拦。
  //     接口挂住时 <img> 既不触发 load 也不触发 error（2026-11-18 实测：请求发出后
  //     一直没有响应），所以这里断言的是「不空转」——要么真图解码出来，要么
  //     明确降级并保住不依赖静态图的「在百度地图打开」。留一块空白框 + 点不动的
  //     档位按钮算失败。接口回话却没显示图同样算失败（用 mapResponses 判定）。
  const readMap = async () => JSON.parse(await cdp.eval(`(() => {
    const box = document.getElementById('intro-map');
    const frame = document.getElementById('map-frame');
    const fail = document.getElementById('map-fail');
    const img = document.getElementById('map-img');
    const btns = [...document.querySelectorAll('#intro-map button')]
      .filter(b => /^map-view-/.test(b.id));
    return JSON.stringify({
      hidden: !box || box.hidden,
      frameHidden: !frame || frame.hidden,
      failShown: !!fail && !fail.hidden,
      failText: (fail || {}).textContent || '',
      nat: img ? (img.naturalWidth + 'x' + img.naturalHeight) : 'none',
      src: img ? img.src : '',
      liveBtns: btns.filter(b => !b.hidden).length,
      link: (document.getElementById('map-open') || {}).href || '',
    });
  })()`));
  const mapDecoded = s => !!s && /^[1-9]\d*x[1-9]/.test(s.nat);
  // 等"图解码出来"或"降级说明出现"；两者都没等到才是空转（超时 6s + 余量）
  const mapState = await waitFor(async () => {
    const s = await readMap();
    return (!s.hidden && (mapDecoded(s) || s.failShown)) ? s : 0;
  }, 14000);
  check('位置小地图不空转（真图或明确降级）', !!mapState,
    !mapState ? '区块一直挂在空白框上'
      : mapDecoded(mapState) ? '已解码 ' + mapState.nat
        : '已降级：' + mapState.failText.slice(0, 22));
  // 接口这次回了 200，就必须真把图画出来 —— 防止用"降级"掩盖加载逻辑坏了
  const mapApiHit = cdp.mapResponses.includes(200);
  check('底图接口回话时必须显示真图', !mapApiHit || mapDecoded(mapState),
    mapApiHit ? '接口 200，图 ' + (mapState ? mapState.nat : 'none') : '接口未回话（环境拦截）');
  check('位置区块始终给出可用地图出口',
    !!mapState && /api\.map\.baidu\.com\/marker/.test(mapState.link),
    mapState ? (mapState.link ? '有' : '无') : '—');
  if (mapDecoded(mapState)) {
    // 视野档位切换：街区 → 全域（静态图接口没有图层参数，只能切 zoom）
    const before = mapState.src;
    await cdp.eval("(()=>{document.getElementById('map-view-city').click();return 1})()");
    await sleep(2500);
    const after = await cdp.eval("(document.getElementById('map-img')||{}).src || ''");
    check('视野档位切换生效', after !== before && after.includes('zoom=11'), after.slice(-48));
    const mapImg2 = await cdp.eval("(()=>{const i=document.getElementById('map-img');return i?(i.naturalWidth+'x'+i.naturalHeight):'none';})()");
    check('全域图已加载', mapImg2 !== 'none' && !/^0x/.test(mapImg2), mapImg2);
    const mapHref = await cdp.eval("(document.getElementById('map-open')||{}).href || ''");
    check('百度地图跳转链接', mapHref.includes('api.map.baidu.com/marker'), mapHref ? '有' : '无');
  } else if (mapState) {
    // 降级态：图框和档位按钮必须收起（点了没反应的按钮比没有更糟）
    check('降级时收起图框与视野按钮',
      mapState.frameHidden === true && mapState.liveBtns === 0,
      '图框隐藏=' + mapState.frameHidden + ' 残留按钮=' + mapState.liveBtns);
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
  //    先用键盘打开：图集格子必须是可聚焦按钮，否则 Tab 永远到不了
  const figA11y = await cdp.eval(`(() => {
    const f = document.querySelector('#intro-gallery figure:not(.no-zoom)');
    return f ? (f.getAttribute('role') + '|' + f.getAttribute('tabindex')) : 'none';
  })()`);
  check('图集格子可键盘聚焦', figA11y === 'button|0', String(figA11y));
  await cdp.eval(`(() => {
    const f = document.querySelector('#intro-gallery figure:not(.no-zoom)');
    f.focus();
    f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(700);
  const lb = await cdp.eval("!!document.getElementById('lightbox') && !document.getElementById('lightbox').hidden");
  check('图集灯箱打开', lb === true, 'lb=' + lb);
  const lbDlg = await cdp.eval(`(() => {
    const b = document.getElementById('lightbox');
    return b ? [b.getAttribute('role'), b.getAttribute('aria-modal'),
                b.contains(document.activeElement)].join('|') : 'none';
  })()`);
  check('灯箱是对话框且焦点已移入', lbDlg === 'dialog|true|true', String(lbDlg));
  // 手机上不能只有左右按钮：横向滑动也要能切图
  const beforeSwipe = await cdp.eval("document.querySelector('#lightbox .lb-count').textContent");
  await cdp.eval(`(() => {
    const b = document.getElementById('lightbox');
    const fire = (type, x) => b.dispatchEvent(new PointerEvent(type, {
      pointerType: 'touch', clientX: x, clientY: 300, bubbles: true }));
    fire('pointerdown', 320); fire('pointerup', 140);
  })()`);
  await sleep(300);
  const afterSwipe = await cdp.eval("document.querySelector('#lightbox .lb-count').textContent");
  check('灯箱可左右滑动切图', beforeSwipe !== afterSwipe, beforeSwipe + ' → ' + afterSwipe);
  await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
  await sleep(400);
  const lbClosed = await cdp.eval("!document.getElementById('lightbox') || document.getElementById('lightbox').hidden");
  check('灯箱 ESC 关闭', lbClosed === true, 'closed=' + lbClosed);
  const focusBack = await cdp.eval(
    "(document.activeElement && document.activeElement.closest('#intro-gallery')) ? 'gallery' : 'body'");
  check('灯箱关闭后焦点回到图集', focusBack === 'gallery', String(focusBack));

  // 6b) Esc 关闭详情 + 焦点归还给刚才那张卡片
  await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await sleep(500);
  const escRaw = await cdp.eval(`(() => {
    const m = document.getElementById('intro-modal');
    const a = document.activeElement;
    return JSON.stringify({
      closed: m.hidden,
      backTo: a ? (a.querySelector && a.querySelector('h4') ? a.querySelector('h4').textContent : '') : '',
    });
  })()`);
  const esc = JSON.parse(escRaw);
  check('Esc 关闭详情且焦点归还原卡片',
    esc.closed === true && esc.backTo === opener,
    `closed=${esc.closed} 焦点回到="${esc.backTo}" 期望="${opener}"`);

  // 7) 搜索
  //
  // 7-0) 首条结果不能等整库简介。
  //      名称/城市/省份都在本地 china-data 里（进站就绪），只有"正文提到"
  //      的命中要 8 片简介（约 570KB）。以前的实现把「有没有结果」压在整库
  //      到货上：第一次搜索必须先下完 570KB 才渲染，1Mbps 实测首条结果 5.8s。
  //      这里把分片请求扣在 Fetch 拦截里不放行，首条结果照样得出来；
  //      顺带证明「出结果时整库请求一个都没发」。
  descHold = true;
  descHeld.length = 0;
  const descBefore = descReqSeen;
  const sFirst = await cdp.eval(`(async()=>{
    const box = document.getElementById('search-results');
    box.innerHTML = '';
    const i = document.getElementById('search-input');
    const t0 = performance.now();
    i.value = '西湖';
    i.dispatchEvent(new Event('input', { bubbles:true }));
    for (let k = 0; k < 80; k++) {
      const it = document.querySelector('#search-results .sr-item');
      if (it) return JSON.stringify({ ms: Math.round(performance.now() - t0),
        label: it.querySelector('b').textContent, n: document.querySelectorAll('#search-results .sr-item').length,
        head: document.querySelector('.sr-head').textContent });
      await new Promise(r => setTimeout(r, 25));
    }
    return JSON.stringify({ ms: -1, label: '', n: 0, head: '' });
  })()`);
  const sf = JSON.parse(sFirst);
  const descReqBeforeFirst = descReqSeen - descBefore;
  check('首条搜索结果不等整库简介（分片被扣住时照样出名称命中）',
    sf.n > 0 && sf.label.includes('西湖') && sf.ms < 1500,
    `${sf.ms}ms 首条="${sf.label}" 共 ${sf.n} 条`);
  check('出首条结果时一个简介分片请求都没发', descReqBeforeFirst === 0,
    `请求数 ${descReqBeforeFirst}，被扣住 ${descHeld.length} 个`);

  // 7-0b) 面板静置后补入正文命中：条数变多，且"加载中"提示消失
  descHold = false;
  for (const rid of descHeld) await cdp.send('Fetch.continueRequest', { requestId: rid }).catch(() => {});
  let settled = null;
  for (let k = 0; k < 40; k++) {
    const st = await cdp.eval(`(() => { const h = document.querySelector('.sr-head');
      return JSON.stringify({ n: document.querySelectorAll('.sr-item').length,
        head: h ? h.textContent : '', loading: h ? /加载中/.test(h.textContent) : false }); })()`);
    settled = JSON.parse(st);
    if (!settled.loading) break;
    await sleep(250);
  }
  check('静置后补入正文命中，条数变多且提示收掉',
    settled && !settled.loading && settled.n > sf.n,
    `首版 ${sf.n} 条 → 补版 ${settled ? settled.n : '?'} 条，head="${settled ? settled.head.slice(0, 18) : ''}"`);

  await cdp.eval("const i=document.getElementById('search-input'); i.value='太湖'; i.dispatchEvent(new Event('input',{bubbles:true}))");
  // 搜索是防抖 + 异步查库，固定睡 900ms 会随机器负载偶发落空 → 改成轮询。
  // 首版结果用的是本地数据，正常几百毫秒内就到；上限留 6 秒给慢机器。
  let sres = 0;
  for (let i = 0; i < 24; i++) {
    sres = await cdp.eval("document.querySelectorAll('#search-results .sr-item').length");
    if (sres > 0) break;
    await sleep(250);
  }
  check('搜索实时出结果', sres > 0, sres + ' 条');
  const chips = await cdp.eval("document.querySelectorAll('#search-results .sr-chip').length");
  check('搜索筛选条渲染', chips === 4, chips + ' 个筛选按钮');

  // 7a-1) 搜索结果必须键盘可达
  //       结果项原来是纯 <div>：敲完关键词，键盘用户就断在这儿了，
  //       不开鼠标一条也打不开（站点的主要导航路径之一）。
  const srKeys = await cdp.eval(`(()=>{
    const it = document.querySelector('#search-results .sr-item');
    if (!it) return JSON.stringify({ n: 0 });
    return JSON.stringify({
      n: document.querySelectorAll('#search-results .sr-item').length,
      tabindex: it.getAttribute('tabindex'), role: it.getAttribute('role'),
      label: it.getAttribute('aria-label') || '',
    });
  })()`);
  const srk = JSON.parse(srKeys);
  check('搜索结果项可键盘聚焦且是按钮语义',
    srk.n > 0 && srk.tabindex === '0' && srk.role === 'button' && srk.label.length > 3,
    `tabindex=${srk.tabindex} role=${srk.role} name=${srk.label.slice(0, 24)}`);

  // 7a-2) 输入框按 ↓ 落进结果列表，列表内 ↑↓ 移动，顶部 ↑ 退回输入框
  const srNav = await cdp.eval(`(()=>{
    const kd = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const i = document.getElementById('search-input');
    i.focus();
    kd(i, 'ArrowDown');
    const first = document.activeElement.classList.contains('sr-item') ? document.activeElement.dataset.idx : 'none';
    kd(document.activeElement, 'ArrowDown');
    const second = document.activeElement.dataset.idx;
    kd(document.activeElement, 'ArrowUp');
    kd(document.activeElement, 'ArrowUp');
    const back = document.activeElement.id || document.activeElement.className;
    return JSON.stringify({ first, second, back });
  })()`);
  const srn = JSON.parse(srNav);
  check('搜索框 ↓ 进入结果、结果内 ↑↓ 移动、顶部 ↑ 退回输入框',
    srn.first === '0' && srn.second === '1' && srn.back === 'search-input',
    `first=${srn.first} second=${srn.second} back=${srn.back}`);

  // 7a-3) 条数靠常驻 live region 播报
  //       面板本身每次搜索都整块重建，aria-live 挂在被替换掉的节点上不会播报；
  //       挂在整块面板上又会把几十条结果当成一段话念完。
  const srLive = await cdp.eval(`(()=>{
    const st = document.getElementById('search-status');
    const box = document.getElementById('search-results');
    return JSON.stringify({ text: st ? st.textContent : '', role: st && st.getAttribute('role'),
      live: st && st.getAttribute('aria-live'), boxLive: box.getAttribute('aria-live') });
  })()`);
  const srl = JSON.parse(srLive);
  check('搜索条数由常驻 live region 播报',
    srl.role === 'status' && srl.live === 'polite' && /条结果/.test(srl.text) && srl.boxLive == null,
    `status="${srl.text.slice(0, 22)}" 面板 aria-live=${srl.boxLive}`);

  // 7a-4) 换筛选后焦点不能掉回 <body>（整块重建会把焦点一起删掉）
  const srChip = await cdp.eval(`(()=>{
    const b = document.querySelector('.sr-chip[data-type="spot"]');
    b.focus(); b.click();
    const a = document.activeElement;
    // 整块重建后旧节点已脱离文档，pressed 必须从新节点上读
    const nb = document.querySelector('.sr-chip[data-type="spot"]');
    const ok = a.classList.contains('sr-chip') && a.dataset.type === 'spot' && nb.getAttribute('aria-pressed') === 'true';
    document.querySelector('.sr-chip[data-type="all"]').click();
    return JSON.stringify({ ok, where: a.className + '/' + (a.dataset.type || ''), pressed: nb.getAttribute('aria-pressed') });
  })()`);
  const srcChip = JSON.parse(srChip);
  check('切换筛选后焦点仍在该按钮上且状态可读',
    srcChip.ok === true, `焦点=${srcChip.where} aria-pressed=${srcChip.pressed}`);

  // 7a-5) 泛名关键词：名称命中不能被前面省份的正文命中挤掉。
  //       原实现"收到 60 条就整轮退出"，而遍历顺序是省→市，搜「岛」时
  //       上海/河北/辽宁的正文命中就把配额吃满，山东的刘公岛、长岛、养马岛
  //       连前 40 条都进不去——用户搜名字却搜不到，属于"漏"不是"排得靠后"。
  const srQuota = await cdp.eval(`(async()=>{
    const i = document.getElementById('search-input');
    // 搜索是防抖的：不清掉上一轮的结果，"有 sr-item"会被旧结果直接满足，
    // 读到的还是太湖那几条。清空后面板重建才说明这一轮跑完了。
    document.getElementById('search-results').innerHTML = '';
    i.value = '岛';
    i.dispatchEvent(new Event('input', {bubbles:true}));
    for (let k = 0; k < 24; k++) {
      if (document.querySelectorAll('#search-results .sr-item').length) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const labels = [...document.querySelectorAll('#search-results .sr-item b')].map(e => e.textContent);
    const want = ['刘公岛', '长岛', '养马岛'].filter(n => labels.includes(n));
    return JSON.stringify({ n: labels.length, want, head: labels.slice(0, 3) });
  })()`);
  const srq = JSON.parse(srQuota);
  check('泛名搜索不丢名称命中（搜「岛」能看到山东那几处）',
    srq.want.length === 3, `前 ${srq.n} 条命中 ${srq.want.length}/3（${srq.want.join('、') || '无'}），首三条=${srq.head.join('、')}`);

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

  // 7a2) 拼音搜索：手边没中文输入法/不确定字怎么写时的入口
  const pyCases = [['gugong', '故宫'], ['bdlg', '布达拉宫']];
  for (const [kw, want] of pyCases) {
    const got = await cdp.eval(`(async () => {
      const i = document.getElementById('search-input');
      // 先清空，避免读到上一条查询残留的结果
      i.value = '';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
      i.value = ${JSON.stringify(kw)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      for (let n = 0; n < 30; n++) {
        await new Promise(r => setTimeout(r, 200));
        const items = [...document.querySelectorAll('#search-results .sr-item b')].map(e => e.textContent);
        if (items.some(t => t.indexOf(${JSON.stringify(want)}) >= 0)) return items.slice(0, 3).join('|');
      }
      return 'none';
    })()`);
    check(`拼音搜索「${kw}」`, String(got).includes(want), String(got).slice(0, 40));
  }
  await cdp.eval("(()=>{const i=document.getElementById('search-input'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true}));})()");

  // 7b) 进入 3D 漫游：场景画布 + 实景看板
  //     记下进场前的日志位置：这条断言只该量「3D 这一段」，之前图集/小地图
  //     的外域图片加载失败也留在 logs 里，按全量过滤会把它算成 3D 的错。
  const sceneLogStart = cdp.logs.length;
  await cdp.eval("document.getElementById('intro-enter').click()");
  await sleep(3500);
  const canvas3d = await cdp.eval("(()=>{const c=document.getElementById('scene-canvas');return c? (c.width+'x'+c.height) : 'none';})()");
  check('3D 场景画布创建', canvas3d !== 'none' && !/^0x/.test(canvas3d), canvas3d);

  const threeNow = await cdp.eval(
    "performance.getEntriesByType('resource').some(r => /three\\.module(?:\\.min)?\\.js/.test(r.name))");
  check('进入 3D 后 three 已按需加载', threeNow === true, String(threeNow));

  // 7b-1b) 3D 引擎必须由本站自己发出去，不能依赖第三方 CDN
  //      以前 importmap 指向 cdn.jsdelivr.net：国内网络下这条链路经常整段超时
  //      （实测三次探活两次 25s 超时），3D 漫游和全景直接加载失败，连 GitHub
  //      Pages 上的线上站也一样。这条断言同时守住"没被改回外域"和"同源可取"。
  const threeOrigin = JSON.parse(await cdp.eval(`(() => {
    const rs = performance.getEntriesByType('resource');
    const t = rs.find(r => /three\\.module(?:\\.min)?\\.js/.test(r.name));
    const cdn = rs.filter(r => /(jsdelivr|unpkg|cdnjs|staticfile)/.test(r.name))
                  .map(r => r.name.split('/')[2]);
    return JSON.stringify({ name: t ? t.name : '', cdn: [...new Set(cdn)] });
  })()`));
  const sameOrigin = threeOrigin.name.startsWith(BASE.replace(/\/$/, '') + '/js/vendor/three/');
  check('3D 引擎同源加载，不依赖第三方 CDN',
    sameOrigin && threeOrigin.cdn.length === 0,
    `three=${threeOrigin.name.replace(BASE, '/') || '未加载'}，CDN=${threeOrigin.cdn.join(',') || '无'}`);
  const gl = await cdp.eval("(()=>{try{const c=document.getElementById('scene-canvas');return !!(c && (c.getContext('webgl2')||c.getContext('webgl')));}catch(e){return false}})()");
  check('WebGL 上下文可用', gl === true, 'gl=' + gl);
  const errsInScene = cdp.logs.slice(sceneLogStart)
    .filter(l => /error|exception/i.test(l.type) && !isExternalAssetFailure(l) && !isExtensionNoise(l));
  check('3D 场景无报错', errsInScene.length === 0, errsInScene.length ? errsInScene.slice(0, 2).map(e => (e.text || '').slice(0, 80)).join(' | ') : '干净');

  // 7b-2) GPU 资源不累积
  //      实景看板（主图贴图 + 3 个材质）和 PMREM 用的临时天空球都是每次重建现做的，
  //      不在场景材质缓存里，漏 dispose 就是每切一次时辰净增（约 3MB 贴图 / 一个球几何体）。
  //      旧版本 leaveSpotSilent 只 dispose 了几何体，这里就是那个漏点的回归测试。
  //
  //      取样口径被三次偶发失败修正过，别改回去：
  //      ① 先等计数稳定再取基线，别猜时间；
  //      ② 走完一整圈回到同一时辰再比 —— 不同时辰布景本来就不同（夜有星、昼有云），
  //         跨时辰比既会冤枉人，也漏得掉「每次重建 +1」这种小泄漏；
  //      ③ 比之前先空跑一圈预热。云、草地、屋瓦、光晕这些贴图是首次用到时才建、
  //         之后常驻模块级缓存（这是有意为之，不算泄漏）。第一次走到白天就会多出
  //         一张云贴图，若拿预热前的数当基线，回程看着就像"涨了一张"（20→21 的假失败）。
  const settleMem = async () => {
    let prev = await cdp.eval("window.__nsMem ? window.__nsMem() : null");
    for (let i = 0; i < 15; i++) {
      await sleep(400);
      const now = await cdp.eval("window.__nsMem ? window.__nsMem() : null");
      if (!now || !prev) return null;
      if (now.textures === prev.textures && now.geometries === prev.geometries) return now;
      prev = now;
    }
    return prev;
  };
  const themeOrder = await cdp.eval("import('./js/scenes-meta.js').then(m => m.THEME_ORDER)");
  const cycleOrder = Array.isArray(themeOrder) && themeOrder.length ? themeOrder.length : 4;
  let tagCur = await cdp.eval("document.getElementById('hud-spot-tag').textContent");
  // 切一次时辰并等 HUD 标签真的换掉（重建是异步的，不猜时间）
  const clickTheme = async () => {
    await cdp.eval("document.getElementById('btn-theme').click()");
    const moved = await waitFor(async () => {
      const t = await cdp.eval("document.getElementById('hud-spot-tag').textContent");
      return t && t !== tagCur ? t : false;
    }, 6000);
    if (moved) tagCur = moved;
    return !!moved;
  };

  for (let i = 0; i < cycleOrder; i++) await clickTheme();   // 预热：把常驻缓存贴图都点出来
  const mem0 = await settleMem();
  const tag0 = tagCur;
  let rebuilt = 0;
  for (let i = 0; i < cycleOrder; i++) if (await clickTheme()) rebuilt++;
  const mem1 = await settleMem();
  check('切换时辰后场景已重建', rebuilt === cycleOrder, `${tag0} → ${tagCur}，重建 ${rebuilt}/${cycleOrder} 次`);
  check('切换一圈回到同一时辰', tagCur === tag0, `${tag0} vs ${tagCur}`);
  check('切换时辰不累积 GPU 贴图',
    !!(mem0 && mem1) && mem1.textures === mem0.textures,
    `贴图 ${mem0 && mem0.textures} → ${mem1 && mem1.textures}`);
  // 几何体数会随布景随机量小幅浮动（古城类模板按概率增减民居），允许 ±2；
  // 真实泄漏是每次重建 +1，一圈 +4，照样拦得住。
  const geoDelta = (mem0 && mem1) ? mem1.geometries - mem0.geometries : NaN;
  check('切换时辰不累积几何体', Math.abs(geoDelta) <= 2,
    `几何体 ${mem0 && mem0.geometries} → ${mem1 && mem1.geometries}（Δ${geoDelta}）`);

  // 7c) 场景截图不能顶掉真实封面
  //     老版本在进入 3D 2.6s 后会把 canvas 截成 400×240 JPEG 存成景点封面，
  //     于是「故宫」的封面变成一片程序生成的通用地形。等过那个时间点再看存储。
  await sleep(3200);
  const autoCover = await cdp.eval(`(() => {
    const d = JSON.parse(localStorage.getItem('other-side-wuxi-v1') || '{}');
    const c = d.covers || {};
    const bad = Object.keys(c).filter(k => String(c[k]).startsWith('data:'));
    return JSON.stringify({ total: Object.keys(c).length, bad: bad.length });
  })()`);
  const ac = JSON.parse(autoCover);
  check('进入 3D 后不会用场景截图覆盖真实封面', ac.bad === 0,
    `封面${ac.total}个，截图覆盖${ac.bad}个`);
  await cdp.eval("document.getElementById('btn-back').click()");
  await waitFor(async () => (await cdp.eval("document.getElementById('stage').hidden")) === true, 6000);
  const mem2 = await cdp.eval("window.__nsMem ? window.__nsMem() : null");
  check('离开 3D 后看板贴图已释放', !!(mem1 && mem2) && mem2.textures < mem1.textures,
    `贴图 ${mem1 && mem1.textures} → ${mem2 && mem2.textures}`);

  // 8) 控制台报错
  //    分三类看：脚本异常与自有资源加载失败一律红；外域图床/接口（360 图床、
  //    百度静态图）连不上只作为"环境网络"计数打出来 —— 它们本来就不在站点
  //    控制范围内，混在一起会让这条闸在弱网环境里天天假红，真错误反而被淹没。
  //    浏览器扩展的报错同理单独计数，不能算到站点头上。
  const allErrs = cdp.logs.filter(l => /error|exception/i.test(l.type));
  const extErrs = allErrs.filter(isExternalAssetFailure);
  const extNoise = allErrs.filter(l => !isExternalAssetFailure(l) && isExtensionNoise(l));
  const errs = allErrs.filter(l => !isExternalAssetFailure(l) && !isExtensionNoise(l));
  const aside = [
    extErrs.length ? `${extErrs.length} 条外域资源不可达` : '',
    extNoise.length ? `${extNoise.length} 条浏览器扩展噪声` : '',
  ].filter(Boolean).join('、');
  check('无控制台错误（外域资源与扩展噪声不计）', errs.length === 0, errs.length
    ? errs.slice(0, 3).map(e => (e.text || '').slice(0, 60) + ' @' + (e.url || '').slice(-60)).join(' | ')
    : '干净' + (aside ? `（另有 ${aside}）` : ''));

  // 9) 分享链接直达：地址里带景点名，重开页面就该打开这一处
  //    （放在最后，因为这一步会重新加载整个页面）
  await cdp.navigate(BASE.replace(/\/$/, '') + '#/' + encodeURIComponent('江苏') + '/'
    + encodeURIComponent('苏州') + '/' + encodeURIComponent('拙政园'));
  await sleep(2800);
  const deepRaw = await cdp.eval(`(() => {
    const m = document.getElementById('intro-modal');
    const t = (document.getElementById('intro-name') || {}).textContent || '';
    return JSON.stringify({
      open: !!m && !m.hidden,
      title: t.trim(),
      hash: location.hash,
    });
  })()`);
  const deep = JSON.parse(deepRaw);
  check('分享链接直达景点', deep.open && deep.title.indexOf('拙政园') >= 0,
    `open=${deep.open} 标题="${deep.title}" hash=${deep.hash}`);

  // 9b) 直达链接的封面必须是真照片
  //     首次进站时图片库（118KB，懒加载）还没就绪，封面会落到 canvas 占位图
  //     （src 是 data:image/jpeg;base64）。这条专门守"分享给别人打开看到渐变"。
  const deepCover = await waitFor(async () => {
    const r = await cdp.eval(`(() => {
      const i = document.querySelector('#intro-cover img');
      if (!i) return '';
      return i.src.startsWith('data:') ? '' : i.naturalWidth > 0 ? i.src : '';
    })()`);
    return r || 0;
  }, 10000);
  check('直达链接封面是真实照片', !!deepCover && !String(deepCover).startsWith('data:'),
    deepCover ? String(deepCover).slice(-52) : '仍是占位图');

  // 9c) 没来过的访客点开分享链接
  //     最常见的分享场景：对方是全新访客（没有昵称）。原来会先撞上
  //     "怎么称呼你"的欢迎页，看不到分享的那处景点。
  await cdp.eval("localStorage.clear()");
  await cdp.navigate(BASE.replace(/\/$/, '') + '#/' + encodeURIComponent('江苏') + '/'
    + encodeURIComponent('苏州') + '/' + encodeURIComponent('拙政园'));
  const guest = await waitFor(async () => {
    const r = await cdp.eval(`(() => {
      const m = document.getElementById('intro-modal');
      if (!m || m.hidden) return '';
      const gate = document.getElementById('gate');
      return JSON.stringify({
        name: (document.getElementById('intro-name') || {}).textContent || '',
        gate: gate ? !gate.hidden : false,
        user: (JSON.parse(localStorage.getItem('other-side-wuxi-v1') || '{}').user || ''),
      });
    })()`);
    return r || 0;
  }, 15000);
  const g = guest ? JSON.parse(guest) : {};
  check('新访客点分享链接直接看到景点', g.name === '拙政园' && g.gate === false,
    `景点="${g.name || ''}" 欢迎页=${g.gate} 称呼="${g.user || ''}"`);

  // 9d) 同名景点简介不串城
  //     简介库原先只按景点名做键，惠州西湖直接复用了杭州西湖那段话
  //     （"位于浙江省杭州旧城西侧"），清远丹霞山显示的是韶关的。
  // minLen：没有维基词条的景点，详情里只剩一句手写文案（「海上仙山。」5 字）。
  // 原先写死 6 字，会把「弹窗已打开但只有手写文案」误判成没打开，断言因此假失败。
  const openSpotByHash = async (prov, city, name, minLen = 6) => {
    await cdp.navigate(BASE.replace(/\/$/, '') + '#/' + encodeURIComponent(prov) + '/'
      + encodeURIComponent(city) + '/' + encodeURIComponent(name));
    const raw = await waitFor(async () => {
      const j = await cdp.eval(`(() => {
        const m = document.getElementById('intro-modal');
        if (!m || m.hidden) return '';
        // 必须确认弹窗里是**这一处**：切景点是同文档 hash 跳转，详情页会先保留
        // 上一处的 DOM 再异步换成新的，只判"弹窗开着且有文案"会把上一处的名字
        // 和简介当成目标景点的结果（同片重试那条断言就是这样偶发假失败的）。
        if ((document.getElementById('intro-name') || {}).textContent !== ${JSON.stringify(name)}) return '';
        const d = (document.getElementById('intro-desc') || {}).textContent || '';
        if (d.length < ${minLen}) return '';
        const cv = document.querySelector('#intro-cover img');
        return JSON.stringify({
          name: (document.getElementById('intro-name') || {}).textContent || '',
          desc: d,
          cover: (cv && cv.getAttribute('src')) || '',
        });
      })()`);
      return j || 0;
    }, 15000);
    return raw ? JSON.parse(raw) : { name: '', desc: '', cover: '' };
  };
  const hz = await openSpotByHash('广东', '惠州', '西湖');
  check('同名景点简介不串城（惠州西湖）',
    hz.name === '西湖' && hz.desc.indexOf('惠州') >= 0 && hz.desc.indexOf('杭州') < 0,
    hz.desc.slice(0, 34) || '(无简介)');

  // 9e) 重名景点的坐标也不能串城
  //     坐标库原先和简介库一样只按景点名做键，惠州西湖拿到的是杭州那条
  //     （120.14,30.24），小地图一点开就把人放到杭州西湖边上。
  //     现在按「省|市|名」分键，判不出归属的宁可不显示。
  const mapLocationOf = async () => {
    const raw = await cdp.eval(`(() => {
      const box = document.getElementById('intro-map');
      const img = document.getElementById('map-img');
      const src = (img && (img.getAttribute('data-src') || img.src)) || '';
      let loc = null;
      try { loc = new URL(src).searchParams.get('location'); } catch (e) { loc = null; }
      const xy = loc ? loc.split(',').map(Number) : null;
      return JSON.stringify({ hidden: !box || box.hidden, loc: xy && xy.length === 2 ? xy : null });
    })()`);
    return JSON.parse(raw);
  };
  await sleep(1200);
  const hzMap = await mapLocationOf();
  const hzNear = hzMap.loc && Math.abs(hzMap.loc[0] - 114.41) < 1.5
    && Math.abs(hzMap.loc[1] - 23.11) < 1.5;
  check('惠州西湖的小地图不指向杭州',
    hzMap.hidden || !!hzNear,
    hzMap.hidden ? '未显示（该处无本地坐标）' : 'location=' + String(hzMap.loc));

  const hzHome = await openSpotByHash('浙江', '杭州', '西湖');
  await sleep(1500);
  // 先等上一处的底图落定（解码完成或已明确降级），再往下注入「掐断」。
  // 固定 sleep 靠不住：本地底图有时几百毫秒就解码完，有时要等满 6s 超时；
  // 上一处请求还悬着时注入，掐断会落到它身上，故宫那条反而"正常出图"，
  // 紧接着的「不再重复请求」也会跟着误判（实测就是这样连挂三条）。
  await waitFor(async () => {
    const s = await readMap();
    return (!s.hidden && (mapDecoded(s) || s.failShown)) ? s : 0;
  }, 14000);
  const hzHomeMap = await mapLocationOf();
  const hzHomeNear = hzHomeMap.loc && Math.abs(hzHomeMap.loc[0] - 120.15) < 0.6
    && Math.abs(hzHomeMap.loc[1] - 30.25) < 0.6;
  check('杭州西湖的小地图落在杭州',
    hzHome.name === '西湖' && !!hzHomeNear,
    hzHomeMap.hidden ? '小地图未显示' : 'location=' + String(hzHomeMap.loc));

  // 9e-2) 底图接口被拦时必须降级，不能留一块空白框 + 点不动的档位按钮
  //       用 Fetch 掐断一次静态图请求（模拟国内网络拦 api.map.baidu.com 或
  //       AK 白名单对不上新域名）。降级后「在百度地图打开」必须还在 ——
  //       那条链接不走静态图接口，是这种情况下唯一还有用的出口。
  //       这条在任何网络环境下都可复现，不依赖接口到底通不通。
  // 只改 hash，不整页导航，让路由自己开详情。
  const bjHash = '#/' + encodeURIComponent('北京') + '/'
    + encodeURIComponent('北京') + '/' + encodeURIComponent('故宫');
  await cdp.eval(`location.hash = ${JSON.stringify(bjHash)}`);
  await waitFor(async () => (await cdp.eval(
    "(document.getElementById('intro-name')||{}).textContent || ''")) === '故宫', 8000);
  // 故宫的底图在本会话更早的时候已经显示过（3D/全景段），同一地址会直接走
  // 浏览器的图像解码缓存、**根本不发请求**，"掐断"就无从谈起（实测 hits=0，
  // 图 1024x768 直接出来，后面三条跟着全挂）。所以先等这一处的默认底图落定
  // （解码或已降级），再切一个当前没用着的视野档，换出必然要重新下载的地址，
  // 掐断才落得到实处。
  // 两个动作不能叠在一起：切档请求若落进上一次 paint 的收尾里，掐断虽然命中，
  // 这一处的降级回调却不触发（实测 5 条连锁失败）。
  await waitFor(async () => {
    const s = await readMap();
    return (!s.hidden && (mapDecoded(s) || s.failShown)) ? s : 0;
  }, 14000);
  const settledBeforeBlock = await readMap();
  if (!settledBeforeBlock.failShown) {
    mapBlockOnce = true;
    await cdp.eval(`(() => {
      const btn = ['block', 'area', 'city']
        .map(k => document.getElementById('map-view-' + k))
        .find(b => b && !b.classList.contains('on'));
      if (btn) btn.click();
      return 1;
    })()`);
  }
  let blocked = await waitFor(async () => {
    const s = await readMap();
    return (!s.hidden && s.failShown) ? s : 0;
  }, 12000);
  // 若前面的失败记忆还在（5 分钟内），区块会直接降级、请求根本没发出去，
  // 那样"被掐断"这条路径就没被真正验证。点一次重试，让请求真的发出去再掐断。
  // ⚠ 重试这一次也必须重新置位 mapBlockOnce：接口本身就不通的环境里，
  //   上面「切视野档」分支根本不会执行（进段时已降级），开关一直是 false，
  //   重试发出的请求没人拦 → mapBlockHits 恒为 0，断言就按 hits===1 判红。
  //   按下重试后要等这一请求真的被掐断，再重读降级态；否则读到的是点击前的旧状态。
  if (mapBlockHits === 0) {
    mapBlockOnce = true;
    await cdp.eval("(()=>{const b=document.getElementById('map-retry'); if(b && !b.hidden) b.click(); return 1})()");
    await waitFor(async () => mapBlockHits > 0, 12000);
    blocked = await waitFor(async () => {
      const s = await readMap();
      return (!s.hidden && s.failShown) ? s : 0;
    }, 12000);
  }
  check('底图被掐断时明确降级（不留空白框）',
    !!blocked && blocked.frameHidden === true && blocked.liveBtns === 0 && mapBlockHits === 1,
    !blocked ? '等不到降级说明（区块仍空转）：底图请求 ' + mapReqSeen
      + ' 次、掐断 ' + mapBlockHits + ' 次'
      : '图框隐藏=' + blocked.frameHidden + ' 残留按钮=' + blocked.liveBtns
        + ' 掐断=' + mapBlockHits + ' 次');
  check('降级后仍留有可用的地图出口',
    !!blocked && /api\.map\.baidu\.com\/marker/.test(blocked.link),
    blocked ? (blocked.link ? '有' : '无') : '—');

  // 9e-3) 接口不可用的结论要在本会话里复用：AK 白名单对不上是全局性的，
  //       如果每换一处景点都重新等 6 秒超时，连着看几处就是一片空白骨架屏。
  //       降级后再开一处有坐标的景点，必须秒降级、且不再白发一次请求。
  const reqBeforeSecond = mapReqSeen;
  const t0 = Date.now();
  const hzHash2 = '#/' + encodeURIComponent('浙江') + '/'
    + encodeURIComponent('杭州') + '/' + encodeURIComponent('西湖');
  await cdp.eval(`location.hash = ${JSON.stringify(hzHash2)}`);
  await waitFor(async () => (await cdp.eval(
    "(document.getElementById('intro-name')||{}).textContent || ''")) === '西湖', 8000);
  const blocked2 = await waitFor(async () => {
    const s = await readMap();
    return (!s.hidden && s.failShown) ? s : 0;
  }, 9000);
  const waitMs = Date.now() - t0;
  check('已知接口不可用时立即降级（不再每处空等 6 秒）',
    !!blocked2 && waitMs < 4500, '耗时 ' + waitMs + 'ms（超时阈值 6000ms）');
  check('降级态不再重复发注定失败的底图请求',
    mapReqSeen === reqBeforeSecond, '新增请求 ' + (mapReqSeen - reqBeforeSecond) + ' 次');

  // 9e-4) 降级稿必须有「重新加载底图」：网络恢复（或换了域名/白名单修好）后
  //       不用刷新整页。点一下要真重载，成功则把图框和档位按钮一起恢复。
  //
  // ⚠ 别把"重载"等同于"发网络请求"：同一个 URL 之前已经成功解码过时，浏览器
  //   直接拿解码缓存铺图（Network.setCacheDisabled 只关 HTTP 缓存，管不到文档内
  //   的图像解码缓存），此时不会出现 Fetch.requestPaused，请求计数是 0；
  //   而接口不可达的环境里图片缓存不下来，重试必然发请求并再次失败。
  //   两种网络状态下都成立的口径是：要么有新请求，要么图真的解码出来了 —— 且
  //   (a) 解码后的自然尺寸必须不同于点击前（降级态是 0x0），否则等于没重载；
  //   (b) 铺出来的必须是**这一处**景点的小地图，不能留上一处的旧图。
  const retryShown = await cdp.eval(
    "(()=>{const b=document.getElementById('map-retry');return !!b && !b.hidden;})()");
  const beforeRetry = await readMap();
  const reqBeforeRetry = mapReqSeen;
  await cdp.eval("(()=>{const b=document.getElementById('map-retry'); if(b) b.click(); return 1})()");
  const retried = await waitFor(async () => {
    const s = await readMap();
    return (mapDecoded(s) || s.failShown) ? s : 0;
  }, 12000);
  const retryReq = mapReqSeen - reqBeforeRetry;
  const retryDecoded = !!retried && mapDecoded(retried) && retried.nat !== beforeRetry.nat;
  // 杭州西湖坐标 120.141667,30.245833（与上面 9e 的 hzHomeNear 同一处）
  const retrySameSpot = retryDecoded ? retried.src.indexOf('120.141667') >= 0 : true;
  check('降级态有「重新加载底图」且点击后确实重载',
    retryShown === true && (retryReq > 0 || (retryDecoded && retrySameSpot)),
    '按钮可见=' + retryShown + ' 网络请求=' + retryReq + ' 次'
      + (retryDecoded ? '，解码恢复 ' + beforeRetry.nat + '→' + retried.nat
        + (retrySameSpot ? '（本景点）' : '（坐标不是本景点！）') : ''));
  check('重试成功则图框与档位按钮恢复',
    !!retried && (!mapDecoded(retried) || (retried.frameHidden === false && retried.liveBtns > 0)),
    retried ? (mapDecoded(retried) ? '已恢复 ' + retried.nat : '接口仍不通，保持降级')
      : '重试后一直空转');

  // 9f) 重名景点的封面不能串城
  //     图片库和简介库一样，长期只按景点名做键：惠州西湖的封面其实是杭州西湖，
  //     武汉东湖拿到的是绍兴东湖的石壁。现在按「省|市|名」分城存，
  //     没抓到本地照的那一处显示主题占位图（data:），也不借外地照片。
  const hzCover = (hzHome.cover || '').split('/').pop();
  const hzLocalCover = (hz.cover || '').split('/').pop();
  check('同名景点封面不串城（两处西湖不同图）',
    !!hzLocalCover && !!hzCover && hzLocalCover !== hzCover
      && hz.cover.indexOf('img/baike/') >= 0 && hzHome.cover.indexOf('img/baike/') >= 0,
    `惠州=${hzLocalCover || hz.cover.slice(0, 18)} 杭州=${hzCover || hzHome.cover.slice(0, 18)}`);

  // 分城键没抓到本地照时，只能回落占位图，不能借同名的外地照片
  const tl = await openSpotByHash('安徽', '铜陵', '凤凰山', 2);
  check('没本地照时分城景点回落到占位图',
    tl.name === '凤凰山' && (tl.cover === '' || tl.cover.indexOf('data:') === 0),
    '封面=' + (tl.cover ? tl.cover.slice(0, 30) : '(空)'));

  // 呼和浩特那座寺院本名「大召寺」（无量寺），「大昭寺」是拉萨的。
  // 以前列表里写成大昭寺，与拉萨同名，抓回来只能是拉萨的正文，所以一直只显示手写的一句话。
  // 11-13 改名重抓后它有了自己的词条，但仍不能带上拉萨的任何字眼。
  const hh = await openSpotByHash('内蒙古', '呼和浩特', '大召寺');
  check('呼和浩特的寺院用大召寺的词条，不套拉萨大昭寺',
    hh.name === '大召寺' && hh.desc.indexOf('呼和浩特') >= 0
      && hh.desc.indexOf('拉萨') < 0 && hh.desc.indexOf('八廓街') < 0,
    hh.desc.slice(0, 34) || '(无简介)');

  // 9g) 景点不能挂错城市
  //     同一处景观被顺手抄到相邻的旅游集散城市时，列表页完全看不出来（卡片只显示名字），
  //     点进详情才发现正文写着「位于石嘴山市平罗县」。11-13 逐条核过这五处：
  //     清远丹霞山（韶关）、银川沙湖（石嘴山）、三亚呀诺达（保亭）、
  //     伊犁赛里木湖（博州）、齐齐哈尔嫩江湾（白城）。
  //     这里同时守两头：错的那座城市不再列出，对的那座必须还在。
  const citySpotNames = async (prov, city) => {
    await cdp.navigate(BASE.replace(/\/$/, '') + '#/' + encodeURIComponent(prov) + '/'
      + encodeURIComponent(city));
    const raw = await waitFor(async () => {
      const j = await cdp.eval(`(() => {
        const hs = [...document.querySelectorAll('#spot-grid .spot-card .spot-body h4')];
        if (!hs.length) return '';
        return JSON.stringify(hs.map(h => h.textContent.trim()));
      })()`);
      return j || 0;
    }, 15000);
    return raw ? JSON.parse(raw) : [];
  };
  const qy = await citySpotNames('广东', '清远');
  check('挂错城市的景点已挪走（清远不再有丹霞山）',
    qy.length > 0 && qy.indexOf('丹霞山') < 0 && qy.indexOf('飞来峡') >= 0,
    '清远：' + (qy.join('、') || '(空)'));
  const sg = await citySpotNames('广东', '韶关');
  check('丹霞山仍在韶关', sg.indexOf('丹霞山') >= 0, '韶关：' + (sg.join('、') || '(空)'));
  const yc = await citySpotNames('宁夏', '银川');
  check('沙湖不再挂在银川（换成银川自己的湿地公园）',
    yc.indexOf('沙湖') < 0 && yc.indexOf('鸣翠湖') >= 0, '银川：' + (yc.join('、') || '(空)'));
  const szs = await citySpotNames('宁夏', '石嘴山');
  check('沙湖仍在石嘴山', szs.indexOf('沙湖') >= 0, '石嘴山：' + (szs.join('、') || '(空)'));

  // 泛名景点：维基词条标题与景点名一模一样，正文讲的却是别处的同一名字
  // （长岛→纽约长岛、铁塔→济宁崇觉寺铁塔）。这类错位标题层面看不出来，
  // 只有把首段挂上去才知道，所以在这一层守一道。
  // 这两处正确的结局是「没有维基词条」→ 回退手写一句话（长岛只有 5 字），
  // 所以 minLen 传 2，让断言能读到弹窗，而不是超时后误判成打不开。
  const cd = await openSpotByHash('山东', '烟台', '长岛', 2);
  check('泛名景点不套外地词条（烟台长岛）',
    cd.name === '长岛' && cd.desc.indexOf('纽约') < 0 && cd.desc.indexOf('美国') < 0,
    cd.desc.slice(0, 34) || '(弹窗未打开)');

  const kf = await openSpotByHash('河南', '开封', '铁塔', 2);
  check('泛名景点不套外地词条（开封铁塔）',
    kf.name === '铁塔' && kf.desc.indexOf('济宁') < 0 && kf.desc.indexOf('崇觉寺') < 0,
    kf.desc.slice(0, 34) || '(弹窗未打开)');

  // 详情主图的像素供给：卡片/封面在 2x 屏上渲染 316 CSS px，要 632 设备像素。
  // 开封铁塔原来挂的是图搜缩略图 400×266（放大 1.6 倍，糊），2026-11-24 起
  // 按百科原图重制成 800 宽。这条守「真到了浏览器也够大」，不只是数据层面数字好看。
  // 注意封面在 #intro-cover 里（不是 3D 场景那个 #detail-img），且图库懒加载，
  // 直达详情时先占位、库就绪后回填 —— 要等，不能立刻读。
  const kfImg = await waitFor(async () => {
    const v = await cdp.eval("(()=>{const i=document.querySelector('#intro-cover img');" +
      "return i&&i.complete&&i.naturalWidth>0?{w:i.naturalWidth,h:i.naturalHeight,dt:i.src.slice(0,5)}:0;})()");
    return v && v.w > 0 ? v : 0;
  }, 8000);
  check('详情主图不是被放大的小图（开封铁塔 ≥700px 宽）',
    !!kfImg && kfImg.w >= 700 && kfImg.h >= 400,
    kfImg ? kfImg.w + 'x' + kfImg.h : '(主图一直没解码出来)');

  // 人工拉黑（data/desc_block.json）的两处：词条标题对得上、正文却完全是另一样东西，
  // 自动校验只能判「地域」，这两条只能靠黑名单守。西塘是宁波的西塘河、
  // 安阳岳飞庙拿到的是开封朱仙镇的庙，都属同省异市，跨省规则拦不住。
  const xt = await openSpotByHash('浙江', '嘉兴', '西塘', 2);
  check('同名异物不套别人的词条（嘉兴西塘）',
    xt.name === '西塘' && xt.desc.indexOf('宁波') < 0 && xt.desc.indexOf('西塘河') < 0,
    xt.desc.slice(0, 34) || '(弹窗未打开)');

  const yf = await openSpotByHash('河南', '安阳', '岳飞庙', 2);
  check('同名异物不套别人的词条（安阳岳飞庙）',
    yf.name === '岳飞庙' && yf.desc.indexOf('开封') < 0 && yf.desc.indexOf('朱仙镇') < 0,
    yf.desc.slice(0, 34) || '(弹窗未打开)');

  // 9f) 详情页「历史沿革」整段不能讲别的城市
  //     短简介有地域闸门，长介绍原先没有：抓回来只要不是消歧义页就入库，
  //     于是嘉兴南湖的历史沿革是唐山南湖公园的采煤沉陷区修复史、
  //     青岛金沙滩的是山西朔州金沙滩镇的镇史、梧州中山公园的是北京中山公园。
  //     整段正文全在讲别处，比没有正文糟得多，而且不报错不 404。
  const longTextOf = async (prov, city, name) => {
    await openSpotByHash(prov, city, name, 2);
    for (let i = 0; i < 12; i++) {
      const t = await cdp.eval(`(() => {
        const box = document.getElementById('intro-history');
        if (!box || box.hidden) return '';
        return (document.getElementById('hist-text') || {}).textContent || '';
      })()`);
      if (t) return t;
      await sleep(250);
    }
    return '';
  };
  const jt = await longTextOf('浙江', '嘉兴', '南湖');
  check('历史沿革不串城（嘉兴南湖不写唐山）',
    jt.indexOf('唐山') < 0 && jt.indexOf('开滦') < 0,
    jt ? jt.slice(0, 34) : '(无长介绍，符合预期)');

  const js2 = await longTextOf('山东', '青岛', '金沙滩');
  check('历史沿革不串城（青岛金沙滩不写朔州）',
    js2.indexOf('朔州') < 0 && js2.indexOf('怀仁') < 0,
    js2 ? js2.slice(0, 34) : '(无长介绍，符合预期)');

  // 9f-2) 同名异地清单页：整段是「万佛山 (东安)…万佛山 (凤冈)…」这种各地同名
  //      景点的罗列，正文里没有「可以指」，老的消歧义闸门抓不到。页面上表现为
  //      遂宁灵泉寺的历史沿革是鄂州/汕头/柳州五座寺庙的清单。
  //      另有两条是短简介对、长介绍配到了同名的另一处（潮州牌坊街 → 济宁），
  //      记在 data/long_block.json，只挡长介绍。
  const pfj = await longTextOf('广东', '潮州', '牌坊街');
  check('历史沿革不串城（潮州牌坊街不写济宁礼拜堂）',
    pfj.indexOf('济宁') < 0 && pfj.indexOf('礼拜堂') < 0,
    pfj ? pfj.slice(0, 34) : '(无长介绍，符合预期)');

  const dcs = await longTextOf('黑龙江', '齐齐哈尔', '大乘寺');
  check('历史沿革不串城（齐齐哈尔大乘寺不写邯郸）',
    dcs.indexOf('邯郸') < 0,
    dcs ? dcs.slice(0, 34) : '(无长介绍，符合预期)');

  const lqs = await longTextOf('四川', '遂宁', '灵泉寺');
  check('历史沿革不再是同名景点清单（遂宁灵泉寺不写鄂州/汕头）',
    lqs.indexOf('鄂州') < 0 && lqs.indexOf('汕头') < 0 && lqs.indexOf('柳州市') < 0,
    lqs ? lqs.slice(0, 34) : '(无长介绍，符合预期)');

  // 反向守一条：正常的景点不能因为清洗被连带清空
  const zzy = await longTextOf('江苏', '苏州', '拙政园');
  check('正常景点的历史沿革还在（拙政园）',
    zzy.length > 40 && zzy.indexOf('园林') >= 0,
    zzy.slice(0, 30) || '(被清空了)');

  // 9g) 重名景点的历史沿革各归各城（长介绍库改成「省|市|名」之后）
  //     库里以前按裸名做键，46 组重名景点共用一条正文：惠州西湖整段是杭州的、
  //     长春南湖公园是唐山采煤沉陷区的、马鞍山太白楼是济宁的。
  //     分片是异步加载的，"读到空"既可能是真没有、也可能是还没到货，
  //     所以读到一个状态后要再确认一次稳定，别把"还没加载"当成"确实没有"。
  const longStateOf = async (prov, city, name) => {
    await openSpotByHash(prov, city, name, 2);
    let prev = null;
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) {
      const st = await cdp.eval(`(() => {
        const nm = (document.getElementById('intro-name') || {}).textContent || '';
        const box = document.getElementById('intro-history');
        const open = !!box && !box.hidden;
        return { nm: nm, open: open,
                 txt: open ? ((document.getElementById('hist-text') || {}).textContent || '') : '' };
      })()`);
      if (st.nm === name) {
        if (prev && prev.open === st.open && prev.txt === st.txt && Date.now() - t0 > 900) return st;
        prev = st;
      }
      await sleep(250);
    }
    return prev || { open: false, txt: '' };
  };
  const hzxh = await longStateOf('广东', '惠州', '西湖');
  check('历史沿革不串城（惠州西湖不写杭州）',
    !hzxh.txt.includes('杭州') && !hzxh.txt.includes('苏堤'),
    hzxh.txt ? hzxh.txt.slice(0, 30) : '(未显示历史沿革，符合预期)');
  const hzxh2 = await longStateOf('浙江', '杭州', '西湖');
  check('同名景点里对上的那处历史沿革还在（杭州西湖）',
    hzxh2.txt.length > 40 && hzxh2.txt.includes('杭州'),
    hzxh2.txt.slice(0, 30) || '(被清空了)');

  // 9h) 分片没下下来，不能把整片景点永久判死
  //     长介绍库按**省**分片（一省一片），打开景点时才 import 本省那片。以前失败
  //     分支会把**空对象**缓存进 longChunkCache：弱网下只要有一次分片请求被中断，
  //     这一片（原先是 1/8 全国，现在是整省）的景点在本次会话里就再也看不到
  //     历史沿革，只有刷新才恢复（本套件"杭州西湖的历史沿革被清空了"偶发失败
  //     就是这么来的）。现在失败不入缓存，这次先当没有正文，下次打开同省景点会重试。
  await cdp.navigate(BASE);
  await sleep(3000);
  longBlockHits = 0;
  // 片号当场从映射表取：一省一片之后「第 8 片」已经没有意义，
  // 而写死一个片号会在分片规则再变时静默失效（掐的是空片，断言照样绿）。
  const zjChunk = await cdp.eval(
    "import('./js/long-shard-map.js').then(m => m.LONG_SHARD_OF['浙江'])");
  longReqCount[zjChunk] = 0;              // 只数这一小段里浙江那片的请求
  longBlockIdx = zjChunk;
  await openSpotByHash('浙江', '杭州', '西湖');
  await sleep(1500);
  const blockedHist = await cdp.eval(`(() => {
    const box = document.getElementById('intro-history');
    return !!box && !box.hidden;
  })()`);
  check('分片加载失败时历史沿革只是不显示（页面不报错）',
    longBlockHits === 1 && blockedHist === false,
    '注入失败 ' + longBlockHits + ' 次，历史沿革块可见=' + blockedHist);

  const retry = await openSpotByHash('浙江', '杭州', '灵隐寺', 2);
  // 三件事一起判，缺一条都不算恢复：
  //   ① 弹窗里确实是灵隐寺（不是上一处残留的 DOM）
  //   ② 历史沿革真的出来了
  //   ③ 浙江那片**又发了一次请求**——否则可能只是浏览器把失败结果留在了
  //      模块图里，正文来自别处（这条同时守住"失败不入缓存"的语义）
  const recovered = await waitFor(async () => {
    const raw = await cdp.eval(`(() => {
      const t = (document.getElementById('hist-text') || {}).textContent || '';
      const n = (document.getElementById('intro-name') || {}).textContent || '';
      return JSON.stringify({ n, len: t.length, t: t.slice(0, 26) });
    })()`);
    const o = JSON.parse(raw);
    return (o.n === '灵隐寺' && o.len > 40) ? o : 0;
  }, 12000);
  check('分片失败后打开同省景点能自动重试（不用刷新）',
    !!recovered && (longReqCount[zjChunk] || 0) >= 2,
    (recovered ? recovered.t : '(仍然为空，分片被永久判死了)')
      + ' / 当前景点=' + (recovered ? recovered.n : retry.name || '(空)')
      + ' / 浙江片请求 ' + (longReqCount[zjChunk] || 0) + ' 次');

  // 10) 欢迎页（首次访客）不做主页才用得上的下载
  //     原先是无条件 renderNav()：新访客还停在「怎么称呼你」那一屏，
  //     后台已经把简介库 615KB + 景点图库 118KB + three 内核 326KB + 省卡封面图
  //     全拉完了，合计约 1.3MB —— 这一屏一个像素都用不到。
  //     现在这些一律等真正进站后再下，这里守住"停在欢迎页时一个都不许有"。
  await cdp.eval('localStorage.clear()');
  await cdp.navigate(BASE);
  await sleep(3500);
  const gateRaw = await cdp.eval(`(() => {
    const rs = performance.getEntriesByType('resource');
    const has = re => rs.some(r => re.test(r.name));
    const heavy = [];
    if (has(/spot-desc-db\\.js/) || has(/spot-desc-shard-\\d+\\.js/)) heavy.push('简介库');
    if (has(/spot-images-db\\.js/)) heavy.push('景点图库');
    if (has(/three\\.module(?:\\.min)?\\.js/)) heavy.push('three');
    if (has(/\\/js\\/scenes\\.js/)) heavy.push('scenes.js');
    if (has(/img\\/cover\\//)) heavy.push('省卡封面图');
    const kb = Math.round(rs.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024);
    return JSON.stringify({
      gate: !document.getElementById('gate').hidden,
      home: !document.getElementById('home').hidden,
      cards: document.querySelectorAll('.spot-card').length,
      heavy: heavy.join('+'),
      kb,
    });
  })()`);
  const gate = JSON.parse(gateRaw);
  check('欢迎页不下载主页资源（简介库/图库/three/封面）',
    gate.gate && !gate.home && gate.cards === 0 && gate.heavy === '',
    `停在欢迎页 ${gate.kb}KB，多下载：${gate.heavy || '无'}`);

  // 10b) 进站后主页必须照常可用：卡片、真实简介都要回来（别为了省流量把功能省掉）
  await cdp.eval(`document.getElementById('gate-name').value = '测试员';
    document.getElementById('gate-enter').click();`);
  const gateCards = await waitFor(async () => {
    const n = await cdp.eval("document.querySelectorAll('.spot-card').length");
    return n > 0 ? n : 0;
  }, 15000);
  // 省卡文案来自省市简介库，不需要景点简介库；等一秒确认它没有偷偷跟过来
  // （以前这里会主动 load()，590KB 白拉一趟还重绘一次）
  await sleep(1500);
  const provDescDb = await cdp.eval(
    "performance.getEntriesByType('resource').some(r => /spot-desc-db\\.js/.test(r.name))");
  const firstDesc = await cdp.eval(
    "((document.querySelector('#spot-grid .spot-card p') || {}).textContent || '').trim()");
  check('欢迎页进站后主页照常渲染（卡片+真实简介）',
    gateCards > 0 && firstDesc.length > 10,
    gateCards + ' 张卡片，首卡简介 ' + firstDesc.length + ' 字：' + firstDesc.slice(0, 18));
  check('省份网格不拉景点简介库（590KB 空转）',
    provDescDb === false, '已拉=' + provDescDb);

  // 11) 说明性文字对比度
  //     三级灰 --ink-faint 是给「还没有足迹」这类说明文字用的，13px 属于小字，
  //     必须 ≥4.5:1。以前用的 #5d594f 在页面底只有 2.75:1、卡片底 2.54:1，
  //     低视力用户基本看不清。这里直接量浏览器算出来的颜色，防止以后再被调暗。
  const contrast = await cdp.eval(`(() => {
    const parse = s => { const m = s.match(/[\\d.]+/g); return m ? m.map(Number) : null; };
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const lum = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    // 背景要逐层合成：.panel 的 --card 是 rgba(20,28,25,.72)，
    // 只取最近的纯色会一路退到页面底色，算出来的对比度虚高。
    const effBg = el => {
      const stack = [];
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const p = parse(getComputedStyle(n).backgroundColor);
        if (!p) continue;
        const a = p.length > 3 ? p[3] : 1;
        if (a <= 0) continue;
        stack.push([p[0], p[1], p[2], a]);
        if (a >= 0.999) break;
      }
      let c = [11, 16, 15];
      for (let i = stack.length - 1; i >= 0; i--) {
        const [r, g, b, a] = stack[i];
        c = [r * a + c[0] * (1 - a), g * a + c[1] * (1 - a), b * a + c[2] * (1 - a)];
      }
      return c;
    };
    const out = [];
    for (const sel of ['.tl-empty', '.panel-note', '.spot-meta', '.brand-text i']) {
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        const fg = parse(cs.color); if (!fg) continue;
        const L1 = lum(fg), L2 = lum(effBg(el));
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        out.push({ sel, ratio: +ratio.toFixed(2), color: cs.color });
      }
    }
    return out;
  })()`);
  const worst = contrast.length
    ? contrast.reduce((a, b) => (b.ratio < a.ratio ? b : a))
    : { sel: '未找到待测元素', ratio: 0, color: '' };
  check('说明性文字对比度够 AA 4.5:1',
    contrast.length > 0 && worst.ratio >= 4.5,
    '最低 ' + worst.sel + ' ' + worst.ratio + ':1（' + worst.color + '），共测 ' + contrast.length + ' 处');

  // 11b) 单选控件的名字与状态
  //      足迹弹窗里的 5 个心情表情、10 颗星、档案里的 5 个心情、问卷的每道题，
  //      原来都只有 emoji /「★」当名字，选中态只靠 .on 换颜色。读屏用户听到的是
  //      「星 按钮」×10，既不知道这是打分也不知道自己打了几分，10 颗星还要按 10 次 Tab。
  //      这一组断言守住：组有名字、每项有名字、状态写在 aria-checked 上、Tab 位只有一个。
  //
  //      足迹弹窗正常要先进 3D 并拿到指针锁才打得开，无头浏览器拿不到指针锁；
  //      这里只把弹窗显示出来（不改任何业务状态），验的是控件本身的语义与键盘行为。
  await cdp.eval("document.getElementById('note-modal').hidden = false");
  await sleep(400);
  const rg = JSON.parse(await cdp.eval(`(() => {
    const stars = document.getElementById('note-stars');
    const sb = [...stars.querySelectorAll('button')];
    const moods = document.getElementById('note-moods');
    const mb = [...moods.querySelectorAll('button')];
    return JSON.stringify({
      starRole: stars.getAttribute('role'), starLabel: stars.getAttribute('aria-label') || '',
      starRoles: [...new Set(sb.map(b => b.getAttribute('role')))].join(','),
      starNames: sb.map(b => b.getAttribute('aria-label')),
      starChecked: sb.filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.getAttribute('aria-label')),
      starTab: sb.filter(b => b.tabIndex === 0).length,
      moodRole: moods.getAttribute('role'), moodLabel: moods.getAttribute('aria-label') || '',
      moodNames: mb.map(b => b.getAttribute('aria-label')),
      moodChecked: mb.filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.getAttribute('aria-label')),
    });
  })()`));
  check('打分是单选组：10 项各带分值，只有当前分被选中',
    rg.starRole === 'radiogroup' && rg.starLabel.length > 0 && rg.starRoles === 'radio'
      && rg.starNames.length === 10 && rg.starNames[0] === '1 分' && rg.starNames[9] === '10 分'
      && rg.starChecked.length === 1 && rg.starChecked[0] === '8 分' && rg.starTab === 1,
    `${rg.starNames.length} 项，选中 ${rg.starChecked.join('/') || '无'}，Tab 位 ${rg.starTab}`);
  check('心情按钮不再只有 emoji 当名字，选中态写在 aria-checked',
    rg.moodRole === 'radiogroup' && rg.moodLabel.length > 0 && rg.moodNames.length === 5
      && rg.moodNames.every(n => n && !/^[\u{1F300}-\u{1FAFF}]$/u.test(n))
      && rg.moodChecked.length === 1 && rg.moodChecked[0] === '还可以',
    `组名「${rg.moodLabel}」，名字 ${rg.moodNames.join('/')}，选中 ${rg.moodChecked.join('/') || '无'}`);

  // 方向键要真的能改分：焦点跟着走，视觉（.on）、语义（aria-checked）、数字三者一致。
  // 每次 event 派发到 document.activeElement —— 真键盘就是这样，焦点移了事件才落在新星上。
  const kbScore = JSON.parse(await cdp.eval(`(() => {
    const sb = [...document.querySelectorAll('#note-stars button')];
    const before = sb.find(b => b.getAttribute('aria-checked') === 'true');
    before.focus();
    const fire = k => document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    fire('ArrowRight'); fire('ArrowRight');
    const up = document.getElementById('note-score-num').textContent;
    const upChecked = sb.filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.dataset.v).join(',');
    const upFocused = document.activeElement.dataset ? document.activeElement.dataset.v : '';
    fire('Home');
    const home = document.getElementById('note-score-num').textContent;
    fire('End');
    const end = document.getElementById('note-score-num').textContent;
    const lit = sb.filter(b => b.classList.contains('on')).length;
    return JSON.stringify({ up, upChecked, upFocused, home, end, lit, tab: sb.filter(b => b.tabIndex === 0).length });
  })()`));
  check('方向键能改分，焦点/语义/视觉三者同步',
    kbScore.up === '10' && kbScore.upChecked === '10' && kbScore.upFocused === '10'
      && kbScore.home === '1' && kbScore.end === '10' && kbScore.lit === 10 && kbScore.tab === 1,
    `→→ 后 ${kbScore.up} 分（aria=${kbScore.upChecked}，焦点=${kbScore.upFocused}），`
      + `Home=${kbScore.home} End=${kbScore.end}，点亮 ${kbScore.lit} 颗，Tab 位 ${kbScore.tab}`);
  await cdp.eval("document.getElementById('note-modal').hidden = true");

  // 11c) 档案弹窗：三个输入框的可见 label 必须真的关联（原来 <label> 没写 for，
  //      读屏只念 placeholder，一填字名字就没了）；心情组同样要有名字与状态。
  const prof = JSON.parse(await cdp.eval(`(() => {
    document.getElementById('profile-modal').hidden = false;
    const f = id => { const i = document.getElementById(id);
      return { n: i.labels ? i.labels.length : 0, t: i.labels && i.labels[0] ? i.labels[0].textContent.trim() : '' }; };
    const moods = document.getElementById('profile-moods');
    const mb = [...moods.querySelectorAll('button')];
    const r = {
      name: f('profile-name'), bio: f('profile-bio'), city: f('profile-city'),
      moodRole: moods.getAttribute('role'), moodLabel: moods.getAttribute('aria-label') || '',
      moodNames: mb.map(b => b.getAttribute('aria-label')),
      xLabel: document.getElementById('intro-x').getAttribute('aria-label') || '',
      detailClose: (document.querySelector('#spot-detail-modal .intro-close') || {}).ariaLabel || '',
      gateLabel: document.getElementById('gate-name').getAttribute('aria-label') || '',
      noteLabel: document.getElementById('note-text').getAttribute('aria-label') || '',
      shredLabel: document.getElementById('shred-text').getAttribute('aria-label') || '',
    };
    document.getElementById('profile-modal').hidden = true;
    return JSON.stringify(r);
  })()`));
  check('档案三个输入框的可见 label 已关联',
    prof.name.t === '称呼' && prof.bio.t === '一句话签名' && prof.city.t === '最想去的城市'
      && prof.name.n === 1 && prof.bio.n === 1 && prof.city.n === 1,
    `${prof.name.t}/${prof.bio.t}/${prof.city.t}`);
  check('档案心情组有名有状态', prof.moodRole === 'radiogroup' && prof.moodLabel.length > 0
    && prof.moodNames.length === 5 && prof.moodNames.every(Boolean),
    `组名「${prof.moodLabel}」：${prof.moodNames.join('/')}`);
  check('关闭按钮与纯 placeholder 输入框都有可读名字',
    prof.xLabel.length > 0 && prof.detailClose.length > 0
      && prof.gateLabel.length > 0 && prof.noteLabel.length > 0 && prof.shredLabel.length > 0,
    `×按=${prof.xLabel}/${prof.detailClose}，输入框=${prof.gateLabel}/${prof.noteLabel}/${prof.shredLabel}`);

  // 11d) 问卷：每道题是一组单选，组名用题干（否则读屏连念四个选项，听不出在答哪一问）
  await cdp.eval("document.getElementById('btn-mood-home').click()");
  const quiz = await waitFor(async () => {
    const r = await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#quiz-body .quiz-item')];
      if (!items.length) return null;
      const first = items[0].querySelector('.quiz-opts');
      const opt = first.querySelector('button');
      opt.click();
      const checked = [...first.querySelectorAll('button')].filter(b => b.getAttribute('aria-checked') === 'true');
      return JSON.stringify({
        n: items.length,
        roles: [...new Set(items.map(i => i.querySelector('.quiz-opts').getAttribute('role')))].join(','),
        labelsOk: items.every(i => (i.querySelector('.quiz-opts').getAttribute('aria-label') || '').indexOf('题') >= 0),
        checked: checked.length,
        checkedName: checked[0] ? checked[0].textContent : '',
        optName: opt.getAttribute('aria-label') || opt.textContent,
      });
    })()`);
    return r ? JSON.parse(r) : null;
  }, 4000);
  check('问卷每题是一个单选组，组名用题干，选项可选可读',
    !!quiz && quiz.n === 4 && quiz.roles === 'radiogroup' && quiz.labelsOk
      && quiz.checked === 1 && quiz.checkedName === quiz.optName,
    quiz ? `${quiz.n} 题，组角色 ${quiz.roles}，选中「${quiz.checkedName}」` : '没打开问卷');
  await cdp.eval("document.getElementById('quiz-close').click()");
  await sleep(300);

  // 11e) 心情鉴定卡：整份报告是画在 canvas 上的，必须有等价文字
  //      之前这张卡对读屏是隐形的 —— 弹窗名字取的是英文 id「mood-modal」，
  //      canvas 没有角色/名字/描述，焦点直接落在「收好」上：听完只知道
  //      "有张图"，类型码、判词、四项指标、宜忌、编号一个字都拿不到。
  //      这里走问卷这条路（当天没有足迹时的真实入口），并且与上一段故意选
  //      相反的选项 —— 卡面内容变了，文字版也得跟着变，写死文案过不了。
  await cdp.eval("document.getElementById('btn-mood-home').click()");
  await waitFor(async () => cdp.eval(
    "document.querySelectorAll('#quiz-body .quiz-opt').length >= 16"), 4000);
  await cdp.eval(`[...document.querySelectorAll('#quiz-body .quiz-item')]
    .forEach(it => { const b = it.querySelectorAll('.quiz-opts button'); b[b.length - 1].click(); })`);
  await waitFor(async () => cdp.eval(
    "document.getElementById('quiz-submit').disabled === false"), 4000);
  await cdp.eval("document.getElementById('quiz-submit').click()");
  const mood = await waitFor(async () => {
    const r = await cdp.eval(`(() => {
      const m = document.getElementById('mood-modal');
      if (m.hidden !== false) return null;
      const cv = document.getElementById('mood-canvas');
      const lb = m.getAttribute('aria-labelledby');
      const t = lb ? document.getElementById(lb) : null;
      const alt = document.getElementById('mood-alt');
      return JSON.stringify({
        label: m.getAttribute('aria-label') || '',
        title: t ? t.textContent.trim() : '',
        role: cv.getAttribute('role') || '',
        name: cv.getAttribute('aria-label') || '',
        desc: alt ? alt.textContent : '',
        active: document.activeElement ? document.activeElement.id : '',
        today: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
      });
    })()`);
    return r ? JSON.parse(r) : null;
  }, 5000);
  check('心情鉴定弹窗的名字是人话，不再读成英文 id',
    !!mood && mood.label === '' && /^今日心情鉴定 · \S/.test(mood.title),
    mood ? `名字「${mood.title}」，aria-label=${mood.label || '（未用）'}` : '弹窗没打开');

  // 焦点是弹窗层在下一帧才移过去的（dialog.js 等渲染落定才聚焦），不能同帧读
  const moodFocus = await waitFor(async () => {
    const a = await cdp.eval("document.activeElement ? document.activeElement.id : ''");
    return a === 'mood-canvas' ? a : null;
  }, 2500);
  check('鉴定卡以图像角色暴露、有可读名，且开弹窗时焦点落在卡上',
    !!mood && mood.role === 'img' && mood.name.length > 0 && moodFocus === 'mood-canvas',
    mood ? `role=${mood.role}，名字「${mood.name}」，焦点=${moodFocus || mood.active}`
      : '弹窗没打开');

  const moodDesc = mood ? mood.desc : '';
  const moodMiss = [];
  const need = (cond, what) => { if (!cond) moodMiss.push(what); };
  need(/^精神状态鉴定卡：[EI][FD][TJ][SR]「[^」]+」/.test(moodDesc), '类型码/称号');
  need(moodDesc.includes('字母含义：'), '字母释义');
  need(moodDesc.includes('判词：'), '判词');
  need(['仙气值', '癫值', 'emo浓度', '生命力'].every(k => moodDesc.includes(k + ' ')), '四项指标');
  need(/四项指标：(?:[^，]+ \d+%，){3}[^，]+ \d+%。/.test(moodDesc), '四项百分比');
  need(moodDesc.includes('宜') && moodDesc.includes('；忌'), '宜忌');
  need(moodDesc.includes('今日幸运物：'), '幸运物');
  need(moodDesc.includes('NO.' + (mood ? mood.today : '') + '-'), '当天编号');
  need(/留下 \d+ 枚足迹后鉴定/.test(moodDesc), '足迹数');
  need(!/undefined|NaN/.test(moodDesc), '无空字段');
  check('鉴定卡的文字版与卡面逐项对应（不是写死的一句话）',
    !!mood && moodDesc.length > 60 && moodMiss.length === 0,
    mood ? `缺项 ${moodMiss.join('、') || '无'}｜${moodDesc.slice(0, 52)}…` : '弹窗没打开');
  await cdp.eval("document.getElementById('mood-close').click()");
  await sleep(250);

  // 12) 减少动效：欢迎页星空必须冻结，但不能冻结成一片空白
  //     入场星空是整站面积最大的持续动效（整屏 110 个点在漂）。之前 CSS 层
  //     已经把卡片入场/悬停/骨架屏全停了，唯独这块 canvas 自己跑 rAF，漏在外面。
  //     判定用「每行相对行首的像素偏离量」：纯渐变横平竖直，偏离量为 0；
  //     有星点就有几万，能同时守住「停了」和「没画瞎」。
  //
  //     前提是页面真的在前台：后台 target 的 rAF 被节流到约 2 次/秒，画布 450ms
  //     不带变一下，会让"静止"假通过、"恢复流动"假失败。先把它量出来当守门断言。
  await cdp.send('Page.bringToFront');
  const rafTicks = await cdp.eval(`new Promise(r => {
    let n = 0; const t0 = performance.now();
    (function f() { n++; performance.now() - t0 < 300 ? requestAnimationFrame(f) : r(n); })();
  })`);
  check('动效测试跑在前台页面（rAF 未被节流）', rafTicks >= 10,
    '300ms 内 ' + rafTicks + ' 帧，visibility=' + await cdp.eval('document.visibilityState'));

  const STAR = `(() => {
    const c = document.querySelector('#gate-particles');
    const gate = document.querySelector('#gate');
    const vis = !!gate && !gate.hidden;
    if (!c || !c.width) return { dev: -1, vis };
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dev = 0;
    for (let y = 0; y < c.height; y += 4) {
      const off = y * c.width * 4;
      const base = d[off] + d[off + 1] + d[off + 2];
      for (let x = 0; x < c.width; x += 2) {
        const v = d[off + x * 4] + d[off + x * 4 + 1] + d[off + x * 4 + 2];
        const diff = v - base;
        dev += diff < 0 ? -diff : diff;
      }
    }
    return { dev, vis };
  })()`;
  const REDUCE = [{ name: 'prefers-reduced-motion', value: 'reduce' }];

  // 这一段量的必须是「新访客第一次进门」那张欢迎页。同文档 hash 导航不会重跑
  // 启动逻辑（returning/deep 都是旧文档算的），欢迎屏只是被旧文档又显示了一次，
  // 粒子循环却不会重启 —— 那样量到的是一张停住的旧画布，跟本站动效无关。
  // 记下 timeOrigin 就能分辨这次导航到底有没有换文档。
  const originBefore = await cdp.eval('performance.timeOrigin');
  await cdp.send('Emulation.setEmulatedMedia', { features: REDUCE });
  await cdp.eval('localStorage.clear()');
  await cdp.navigate(BASE);
  const docReloaded = originBefore !== await cdp.eval('performance.timeOrigin');
  // 冻结时的现场：媒体偏好到底是不是 reduce、门禁屏可见性、画布是否还在文档里、
  // 页面 rAF 还有没有在跑。缺了这几项，日志里只剩一个"没动"，根本分不清
  // 是产品冻住了，还是测试自己把页面搞到后台了。
  const starDiag = async () => {
    const d = await cdp.eval(`new Promise(resolve => {
      const c = document.querySelector('#gate-particles');
      const g = document.getElementById('gate');
      const t0 = performance.now(); let n = 0;
      (function f() { n++; performance.now() - t0 < 400 ? requestAnimationFrame(f)
        : resolve({ anim: matchMedia('(prefers-reduced-motion: reduce)').matches,
            gateHidden: g.hidden, connected: c.isConnected, w: c.width, h: c.height,
            frames: n, rv: document.visibilityState }); })();
    })`);
    return `诊断: 本次导航重载=${docReloaded} 媒体reduce=${d.anim} 门禁隐藏=${d.gateHidden}`
      + ` 画布在文档内=${d.connected} ${d.w}×${d.h} 400ms帧数=${d.frames} 可见性=${d.rv}`;
  };
  // 等欢迎页真的画出来，而不是赌一个固定毫秒数
  await waitFor(() => cdp.eval(
    "!document.getElementById('gate').hidden && document.querySelector('#gate-particles').width > 0"
  ), 8000);
  await sleep(600);
  const r1 = await cdp.eval(STAR); await sleep(450); const r2 = await cdp.eval(STAR);
  check('减少动效下欢迎页星空静止', r1.vis && r1.dev === r2.dev && r1.dev >= 0,
    !r1.vis ? '门禁屏没显示，量的不是欢迎页'
      : (r1.dev === r2.dev ? '两帧偏离量同为 ' + r1.dev : '仍在变化 ' + r1.dev + ' → ' + r2.dev));
  check('减少动效下星空没有画成空白', r1.vis && r1.dev > 5000,
    '偏离量 ' + r1.dev + '（纯渐变应为 0）');

  // 13) 开关中途切换要立刻生效，不能要求刷新（系统里现改现看是常态）
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  await sleep(700);
  const n1 = await cdp.eval(STAR);
  // 等它动起来，而不是赌固定 450ms：机器慢、掉帧时 450ms 可能一帧都没画，
  // 真冻结又永远不会变，所以轮询既不会误报也不会放过。
  const n2 = await waitFor(async () => {
    const s = await cdp.eval(STAR);
    return s.dev !== n1.dev ? s : null;
  }, 2500) || await cdp.eval(STAR);
  const stalled = n1.dev === n2.dev;
  check('恢复正常动效后星空继续流动', n1.vis && !stalled,
    '偏离量 ' + n1.dev + ' → ' + n2.dev + (n1.vis ? '' : '（门禁屏没显示）')
    + (stalled ? '；' + await starDiag() : ''));
  await cdp.send('Emulation.setEmulatedMedia', { features: REDUCE });
  await sleep(700);
  const q1 = await cdp.eval(STAR); await sleep(450); const q2 = await cdp.eval(STAR);
  check('运行中切到减少动效立即冻结', q1.vis && q1.dev === q2.dev,
    q1.dev === q2.dev ? '已停于 ' + q1.dev : '仍在变化 ' + q1.dev + ' → ' + q2.dev);
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });

  // 14) 浏览器后退：三层导航必须逐层退回去，而不是一按就离开站点。
  //     以前每层跳转都走 replaceState，历史里只有进站那一条 —— 手机上误触一次
  //     后退整站就没了，回来还得从首页重新点。这里守住「下钻写历史 + 后退按层退」。
  await cdp.eval(`localStorage.setItem('other-side-wuxi-v1', JSON.stringify({
    user:{name:'测试员',createdAt:Date.now()}, visits:{}, footprints:[], covers:{},
    fortunes:{}, lastTheme:'auto'
  })); localStorage.removeItem('nr_last_nav');`);
  await cdp.navigate(BASE);
  await sleep(4000);
  const introOpen = () => cdp.eval(
    "(() => { const m = document.getElementById('intro-modal'); return !!m && !m.hidden; })()");
  const h0 = await cdp.eval('history.length');
  await cdp.eval("document.querySelectorAll('#spot-grid .spot-card')[0].click()");
  await waitDepth(1);
  const h1 = await cdp.eval('history.length');
  await cdp.eval("document.querySelectorAll('#spot-grid .spot-card')[0].click()");
  await waitDepth(2);
  const h2 = await cdp.eval('history.length');
  await cdp.eval("document.querySelectorAll('#spot-grid .spot-card')[0].click()");
  const opened = await waitFor(async () => (await introOpen()) === true, 10000);
  const h3 = await cdp.eval('history.length');
  check('逐层下钻会写入历史（后退有层级可退）',
    opened === true && h1 > h0 && h2 > h1 && h3 > h2,
    `详情已开=${opened}，历史 ${h0} → ${h1} → ${h2} → ${h3}`);

  // 14b) 后退一次 = 关掉详情，退回本市景点列表（不离开站点、列表不重绘成空）
  await cdp.eval('history.back()');
  const backOne = await waitFor(async () => {
    const raw = await cdp.eval(`(() => {
      const m = document.getElementById('intro-modal');
      const parts = decodeURIComponent(location.hash).replace(/^#\\/?/, '').split('/').filter(Boolean);
      return JSON.stringify({
        closed: !!m && m.hidden,
        parts: parts.length,
        cards: document.querySelectorAll('#spot-grid .spot-card').length,
      });
    })()`);
    const o = JSON.parse(raw);
    return o.closed && o.parts === 2 && o.cards > 0 ? raw : 0;
  }, 10000);
  const bo = backOne ? JSON.parse(backOne) : {};
  check('后退一次退回景点列表（详情关闭，不离开站点）',
    bo.closed === true && bo.parts === 2 && bo.cards > 0,
    `关闭=${bo.closed} 层级=${bo.parts} 卡片=${bo.cards}`);

  // 14b2) 前进键也要能回到刚才那处详情。
  //      只做后退会把历史做成单向的：后退一次后再也回不到刚才看的景点。
  //      这条同时守住「popstate 与 hashchange 去重」没把前进事件误吞。
  await cdp.eval('history.forward()');
  const fwd = await waitFor(async () => {
    const raw = await cdp.eval(`(() => {
      const m = document.getElementById('intro-modal');
      return JSON.stringify({
        open: !!m && !m.hidden,
        parts: decodeURIComponent(location.hash).replace(/^#\\/?/, '').split('/').filter(Boolean).length,
      });
    })()`);
    const o = JSON.parse(raw);
    return o.open && o.parts === 3 ? raw : 0;
  }, 10000);
  const fo = fwd ? JSON.parse(fwd) : {};
  check('前进键回到刚才那处详情', fo.open === true && fo.parts === 3,
    `打开=${fo.open} 层级=${fo.parts}`);
  // 收回列表，后面的用例继续从列表层往下走
  await cdp.eval("document.getElementById('intro-x').click()");
  await waitFor(async () => (await introOpen()) === false, 8000);
  await sleep(400);

  // 14c) 关详情要连历史一起退：否则每看一处都留一条已关闭的地址，
  //      之后得按两次后退才退得出一层。（history.length 后退时不会变小，
  //      所以要靠下面「再后退一层是否直接到城市列表」来验证真的退了。）
  await cdp.eval("document.querySelectorAll('#spot-grid .spot-card')[1].click()");
  await waitFor(async () => (await introOpen()) === true, 10000);
  await cdp.eval("document.getElementById('intro-x').click()");
  await waitFor(async () => (await introOpen()) === false, 8000);
  await sleep(600);
  const closedState = await cdp.eval(`JSON.stringify({
    modal: !document.getElementById('intro-modal').hidden,
    parts: decodeURIComponent(location.hash).replace(/^#\\/?/, '').split('/').filter(Boolean).length,
  })`);
  const cs = JSON.parse(closedState);
  check('关详情后地址收回城市层', cs.modal === false && cs.parts === 2,
    `弹窗=${cs.modal} 层级=${cs.parts}`);

  // 14d) 再后退一层 = 回到省级城市列表
  await cdp.eval('history.back()');
  const backTwo = await waitFor(async () => {
    const raw = await cdp.eval(`(() => {
      const parts = decodeURIComponent(location.hash).replace(/^#\\/?/, '').split('/').filter(Boolean);
      return JSON.stringify({ parts: parts.length, cards: document.querySelectorAll('#spot-grid .spot-card').length });
    })()`);
    const o = JSON.parse(raw);
    return o.parts === 1 && o.cards > 0 ? raw : 0;
  }, 10000);
  const bt = backTwo ? JSON.parse(backTwo) : {};
  check('再后退一层回到城市列表', bt.parts === 1 && bt.cards > 0,
    `层级=${bt.parts} 卡片=${bt.cards}`);

  // 14e) 分享链接直达（不是站内点进来的）：关详情不能在历史里凭空压一层。
  //      若是压进去的，手机上「后退」只会把弹窗关了又弹回来，像退不出去。
  //      判据不用 history.length —— 后退过一次之后再导航会把前进记录截断，
  //      长度不可比；这里直接看「关掉后按一次后退，应当离开这个直达地址」。
  //      带 query 是为了强制整页加载，别退化成同文档 hash 跳转。
  await cdp.navigate(BASE + '?direct=1#/' + encodeURIComponent('江苏') + '/'
    + encodeURIComponent('苏州') + '/' + encodeURIComponent('拙政园'));
  await sleep(3000);
  const deepOpened = await waitFor(async () => (await introOpen()) === true, 15000);
  await cdp.eval("document.getElementById('intro-x').click()");
  const deepClosed = await waitFor(async () => (await introOpen()) === false, 8000);
  await sleep(600);
  const deepBefore = JSON.parse(await cdp.eval(`JSON.stringify({
    marker: !!(history.state && history.state.spot),
    parts: decodeURIComponent(location.hash).replace(/^#\\/?/, '').split('/').filter(Boolean).length,
  })`));
  await cdp.eval('history.back()');
  await sleep(2200);
  const deepAfter = JSON.parse(await cdp.eval(`JSON.stringify({
    stillDirect: location.search.includes('direct=1'),
  })`));
  check('直达链接关详情后一次后退即离开该页',
    deepOpened === true && deepClosed === true && deepBefore.marker === false
      && deepBefore.parts === 2 && deepAfter.stillDirect === false,
    `标记=${deepBefore.marker} 层级=${deepBefore.parts} 后退后仍在直达页=${deepAfter.stillDirect}`);

  // 14f/g/h) 省/市两级链接的「落地」。
  //      以前只有三段式景点链接有落地逻辑：收到「#/广东/清远」的人（以及在市层按
  //      刷新、从收藏夹进来的老用户）会停在省份网格，地址还被改写成 #/。
  //      带 query 强制整页加载，走的正是刷新/收藏/分享的真实路径。
  const enc = encodeURIComponent;
  await cdp.navigate(BASE + '?jump=1#/' + enc('广东') + '/' + enc('清远'));
  await sleep(3000);
  const jumpCity = JSON.parse(await cdp.eval(`JSON.stringify({
    hash: decodeURIComponent(location.hash),
    cards: document.querySelectorAll('#spot-grid .spot-card').length,
    first: (document.querySelector('#spot-grid .spot-body h4') || {}).textContent || '',
  })`));
  check('市层级链接/刷新落在该市（#/广东/清远）',
    jumpCity.hash === '#/广东/清远' && jumpCity.cards === 5 && jumpCity.first === '英西峰林',
    `地址=${jumpCity.hash} 卡片=${jumpCity.cards} 首项=${jumpCity.first}`);

  await cdp.navigate(BASE + '?jump=2#/' + enc('广东'));
  await sleep(2800);
  const jumpProv = JSON.parse(await cdp.eval(`JSON.stringify({
    hash: decodeURIComponent(location.hash),
    cards: document.querySelectorAll('#spot-grid .spot-card').length,
  })`));
  check('省层级链接/刷新落在该省城市列表（#/广东）',
    jumpProv.hash === '#/广东' && jumpProv.cards === 21,
    `地址=${jumpProv.hash} 卡片=${jumpProv.cards}`);

  // 14h) 没进过站的访客带两级链接：过欢迎页后仍落在该市（走 tryEnter 那条路）
  await cdp.eval("localStorage.removeItem('other-side-wuxi-v1')");
  await cdp.navigate(BASE + '?jump=3#/' + enc('广东') + '/' + enc('清远'));
  await sleep(2500);
  const gateShown = await cdp.eval("!document.getElementById('gate').hidden");
  await cdp.eval(`document.getElementById('gate-name').value = '新客';
    document.getElementById('gate-enter').click();`);
  await sleep(2800);
  const afterGate = JSON.parse(await cdp.eval(`JSON.stringify({
    hash: decodeURIComponent(location.hash),
    cards: document.querySelectorAll('#spot-grid .spot-card').length,
    first: (document.querySelector('#spot-grid .spot-body h4') || {}).textContent || '',
  })`));
  check('新访客带省市链接，过欢迎页后仍落在该市',
    gateShown === true && afterGate.hash === '#/广东/清远'
      && afterGate.cards === 5 && afterGate.first === '英西峰林',
    `欢迎页=${gateShown} 地址=${afterGate.hash} 卡片=${afterGate.cards} 首项=${afterGate.first}`);

  // 15) 图集凑不满时的占位文案
  //     9 处景点只有主图、136 处只有主图 + 1 张图组，第三格永远是占位图。
  //     占位图里以前焊死「实景图加载中…」——图库早就到货了，那几个格子再也不会变，
  //     等于让用户一直等一张不会来的图。同时占位格不可点，名称也不该像按钮。
  await cdp.navigate(BASE + '?gal=1#/' + enc('吉林') + '/' + enc('通化') + '/' + enc('三角龙湾'));
  await waitFor(() => cdp.eval("!!document.querySelector('#intro-gallery figure')"), 12000);
  const phInfo = await waitFor(async () => {
    const s = await cdp.eval(`(() => {
      const figs = [...document.querySelectorAll('#intro-gallery figure')];
      if (figs.length !== 3) return null;
      const last = figs[2];
      const src = (last.querySelector('img') || {}).getAttribute('src') || '';
      if (!src.startsWith('data:')) return null;   // 图集库还没到货 / 该景点其实有 3 张
      const svg = decodeURIComponent(src.slice(src.indexOf(',') + 1));
      return JSON.stringify({
        hint: svg.includes('暂无更多实景'),
        loading: svg.includes('加载中'),
        zoom: last.classList.contains('no-zoom'),
        tab: last.getAttribute('tabindex'),
        aria: last.getAttribute('aria-label') || '',
      });
    })()`);
    return s ? JSON.parse(s) : null;
  }, 15000);
  check('图集凑不满时不再谎称"加载中"',
    !!phInfo && phInfo.hint && !phInfo.loading,
    phInfo ? '占位提示=暂无更多实景，仍含加载中=' + phInfo.loading : '第三格没等到占位图');
  check('占位格不可点、名称不冒充按钮',
    !!phInfo && phInfo.zoom && phInfo.tab === null && phInfo.aria.startsWith('暂无更多实景图'),
    phInfo ? 'no-zoom=' + phInfo.zoom + ' tabindex=' + phInfo.tab + ' aria=' + phInfo.aria : '');

  console.log('\n通过 ' + results.filter(r => r.ok).length + '/' + results.length);
  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    console.log('失败项：' + failed.map(f => f.name).join('、'));
    process.exitCode = 1;
  }
  process.exit(0);
})().catch(e => { console.error('测试异常:', e.message); process.exit(2); });
