// ═══ 数据层：所有数据只存在浏览器 localStorage ═══
const KEY = 'other-side-wuxi-v1';

const blank = () => ({
  user: null,          // { name, createdAt }
  visits: {},          // { spotId: count }
  footprints: [],      // [{ id, spot, place, pos:[x,y,z], mood:1-5, score:1-10, text, ts }]
  covers: {},          // { spotId: dataURL } 游览截图做封面
  fortunes: {},        // { 'YYYY-MM-DD': index }
  lastTheme: 'auto',
});

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

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(store.data)); } catch (e) { /* 存储满了就静默 */ }
}

export const store = {
  data: load(),

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
    save();
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

  setCover(spotId, dataUrl) {
    this.data.covers[spotId] = dataUrl;
    save();
  },
  getCover(spotId) {
    return this.data.covers[spotId] || null;
  },
  removeCover(spotId) {
    delete this.data.covers[spotId];
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
