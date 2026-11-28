// ═══ 数据层：所有数据只存在浏览器 localStorage ═══
const KEY = 'other-side-wuxi-v1';

const blank = () => ({
  user: null,          // { name, createdAt }
  visits: {},          // { spotId: count }
  footprints: [],      // [{ id, spot, place, pos:[x,y,z], mood:1-5, score:1-10, text, ts }]
  covers: {},          // { spotId: dataURL } 用户自选 / 场景兜底封面
  coverOrder: [],      // 封面写入顺序（存储写满时从最旧的开始淘汰）
  fortunes: {},        // { 'YYYY-MM-DD': index }
  lastTheme: 'auto',
});

// 封面键序：老存档没有 coverOrder，用 covers 的键序补齐，
// 否则淘汰逻辑对着空数组干瞪眼，明明有封面却一张也腾不出来。
function orderCovers(covers, order) {
  const kept = (Array.isArray(order) ? order : []).filter(k => Object.prototype.hasOwnProperty.call(covers, k));
  for (const k of Object.keys(covers)) if (!kept.includes(k)) kept.push(k);
  return kept;
}

// 校验并修正从 localStorage 读出的结构。
// 必要原因：Object.assign 只做浅拷贝，存档里若 visits/covers 是 null
//（老版本残留或被外部改坏），后续 this.data.visits[spotId] 会直接抛 TypeError。
function sanitize(raw) {
  const d = blank();
  if (!raw || typeof raw !== 'object') return d;
  if (raw.user && typeof raw.user === 'object') d.user = raw.user;
  if (raw.visits && typeof raw.visits === 'object' && !Array.isArray(raw.visits)) d.visits = raw.visits;
  if (raw.covers && typeof raw.covers === 'object' && !Array.isArray(raw.covers)) d.covers = raw.covers;
  if (raw.fortunes && typeof raw.fortunes === 'object' && !Array.isArray(raw.fortunes)) d.fortunes = raw.fortunes;
  if (Array.isArray(raw.footprints)) d.footprints = raw.footprints;
  if (typeof raw.lastTheme === 'string') d.lastTheme = raw.lastTheme;
  d.coverOrder = orderCovers(d.covers, raw.coverOrder);
  return d;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    return sanitize(JSON.parse(raw));
  } catch (e) {
    // 存档损坏（JSON 解析失败）→ 退回空档案，不让整站挂掉
    return blank();
  }
}

// ─── 落盘与配额 ───
// localStorage 只有 5MB，而自定义封面是 dataURL（一张手机照片编码出来几百 KB）。
// 老实现遇到 QuotaExceededError 直接吞掉：封面、足迹、收藏全写不进去，
// 界面上还照常说"已保存"——用户重开页面发现足迹没了，却以为是站点没记住。
//
// 现在的取舍：封面是装饰品（丢了回到站点默认图），足迹/收藏是用户资产。
// 配额不够时先把最旧的封面扔出去腾地方，扔完还写不下才认输，并把结果交回调用方，
// 由界面如实告诉用户，而不是继续撒谎。
function writeRaw() {
  try {
    localStorage.setItem(KEY, JSON.stringify(store.data));
    return true;
  } catch (e) {
    return false;
  }
}

// 扔掉最旧的一张封面（跳过 keep，别把刚写的那张自己淘汰了）
function dropOldestCover(keep) {
  const d = store.data;
  const order = orderCovers(d.covers, d.coverOrder);
  for (const k of order) {
    if (k === keep) continue;
    delete d.covers[k];
    d.coverOrder = order.filter(x => x !== k);
    return k;
  }
  return null;
}

// 返回 { ok, evicted }：evicted = 本次为了写进去牺牲掉的封面张数
function persist(keep) {
  if (writeRaw()) return { ok: true, evicted: 0 };
  let evicted = 0;
  while (evicted < 500) {
    if (!dropOldestCover(keep)) break;
    evicted++;
    if (writeRaw()) return { ok: true, evicted };
  }
  return { ok: false, evicted: 0 };
}

function save() {
  return persist().ok;
}

export const store = {
  data: load(),
  lastSaveOk: true,    // 最近一次写足迹是否真的落盘（false 时界面不能报"已保存"）

  setUser(name) {
    this.data.user = { name, createdAt: Date.now() };
    save();
  },
  clearUser() {
    this.data.user = null;
    save();
  },

  visitSpot(spotId) {
    this.data.visits[spotId] = (this.data.visits[spotId] || 0) + 1;
    save();
  },
  visitCount(spotId) {
    return this.data.visits[spotId] || 0;
  },

  addFootprint(fp) {
    fp.id = 'fp' + Date.now().toString(36) + Math.floor(Math.random() * 999);
    fp.ts = Date.now();
    this.data.footprints.push(fp);
    // 这一步没落盘就不能说"足迹已留下"。存储被别的东西占满时如实返回，
    // 由调用方决定提示什么（见 app.js submitNote）。
    this.lastSaveOk = save();
    return fp;
  },
  removeFootprint(id) {
    this.data.footprints = this.data.footprints.filter(f => f.id !== id);
    save();
  },
  footprintsOf(spotId) {
    return this.data.footprints.filter(f => f.spot === spotId);
  },
  todayFootprints() {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return this.data.footprints.filter(f => f.ts >= d.getTime());
  },

  // 返回 { ok, evicted }。opts.evict === false 时绝不为了存这张去扔别人的封面
  //（3D 场景截图做兜底封面走这条，不能拿用户的照片给它腾地方）。
  setCover(spotId, dataUrl, opts) {
    const keepOnly = !!(opts && opts.evict === false);
    // 快照：失败时内存要完整回到写入前，不能留下"内存里有、磁盘上没有"的封面，
    // 也不能把 persist 为腾地方已经删掉的封面留在删除态（磁盘上其实还在）。
    const prevCovers = Object.assign({}, this.data.covers);
    const prevOrder = (this.data.coverOrder || []).slice();
    this.data.covers[spotId] = dataUrl;
    this.data.coverOrder = orderCovers(this.data.covers, this.data.coverOrder)
      .filter(k => k !== spotId).concat(spotId);
    const r = keepOnly ? { ok: writeRaw(), evicted: 0 } : persist(spotId);
    if (!r.ok) {
      this.data.covers = prevCovers;
      this.data.coverOrder = prevOrder;
      return { ok: false, evicted: 0 };
    }
    return r;
  },
  getCover(spotId) {
    return this.data.covers[spotId] || null;
  },
  removeCover(spotId) {
    delete this.data.covers[spotId];
    this.data.coverOrder = (this.data.coverOrder || []).filter(k => k !== spotId);
    save();
  },

  setFortune(dateStr, idx) {
    this.data.fortunes[dateStr] = idx;
    save();
  },
  getFortune(dateStr) {
    return this.data.fortunes[dateStr];
  },

  setTheme(t) { this.data.lastTheme = t; save(); },
  getTheme() { return this.data.lastTheme || 'auto'; },
};

// ═══ 成就称号：按足迹总数解锁 ═══
export const TITLES = [
  { need: 0,  title: '初次踏入夜色' },
  { need: 3,  title: '开始有了秘密基地' },
  { need: 6,  title: '山河间的常客' },
  { need: 10, title: '四景巡游者' },
  { need: 16, title: '夜行地缚灵' },
  { need: 25, title: '夜游神的常住人口' },
];

export function titleFor(count) {
  let t = TITLES[0].title;
  for (const it of TITLES) if (count >= it.need) t = it.title;
  return t;
}
