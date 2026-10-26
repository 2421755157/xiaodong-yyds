// ═══ 心情鉴定引擎：情绪分析 + SBTI 抽象报告卡 ═══
import { LEX, DIM_NAMES, TYPE_TITLES, VERDICTS, YI_POOL, JI_POOL, LUCKY_POOL, pick, pickN } from './lexicon.js';

const T_WORDS = ['想通', '算了', '没事', '放下', '无所谓', '随它', '看开', '就这样', '也好', '释然', '接受'];
const J_WORDS = ['为什么', '如果', '怎么办', '纠结', '犹豫', '该不该', '要不要', '后悔', '假如', '矛盾', '想不通'];

function countHits(text, words) {
  let n = 0;
  for (const w of words) {
    let i = text.indexOf(w);
    while (i !== -1) { n++; i = text.indexOf(w, i + w.length); }
  }
  return n;
}

// ─── 分析今日足迹 → 鉴定结果 ───
export function analyzeToday(fps, userName) {
  const all = fps.map(f => f.text || '').join('。');
  const moodAvg = fps.reduce((s, f) => s + (f.mood || 3), 0) / fps.length;
  const scoreAvg = fps.reduce((s, f) => s + (f.score || 6), 0) / fps.length;
  const moodVar = fps.reduce((s, f) => s + Math.pow((f.mood || 3) - moodAvg, 2), 0) / fps.length;

  const hits = {
    happy: countHits(all, LEX.happy),
    sad: countHits(all, LEX.sad),
    angry: countHits(all, LEX.angry),
    calm: countHits(all, LEX.calm),
    miss: countHits(all, LEX.miss),
  };
  const excl = (all.match(/[!！?？~～]/g) || []).length;
  const len = all.length;
  const tHits = countHits(all, T_WORDS);
  const jHits = countHits(all, J_WORDS);

  // 维度一：E 外放 / I 内收
  const eScore = hits.happy * 2 + hits.angry * 1.5 + excl * 0.6 + Math.min(4, len / 40) + (moodAvg - 3) * 1.2;
  const iScore = hits.sad * 1.5 + hits.calm * 2 + hits.miss * 1.5 + (5 - moodAvg) * 0.8 + (fps.length >= 3 ? 1 : 0);
  const d1 = eScore >= iScore ? 'E' : 'I';

  // 维度二：F 佛系 / D 发癫
  const fScore = hits.calm * 2 + (moodVar < 0.8 ? 2 : 0) + tHits;
  const dScore = hits.angry * 2 + excl * 0.8 + (moodVar >= 1.5 ? 3 : 0) + jHits * 0.5;
  const d2 = fScore >= dScore ? 'F' : 'D';

  // 维度三：T 想通 / J 纠结
  const d3 = (tHits + (moodAvg >= 3.5 ? 1 : 0)) >= (jHits + (moodAvg < 2.5 ? 1 : 0)) ? 'T' : 'J';

  // 维度四：S 晴 / R 雨
  const d4 = (moodAvg + (scoreAvg - 6) * 0.15 + hits.happy * 0.2 - hits.sad * 0.2) >= 3.1 ? 'S' : 'R';

  const code = d1 + d2 + d3 + d4;
  const title = TYPE_TITLES[code];

  // 主情绪 → 判词
  const total = hits.happy + hits.sad + hits.angry + hits.calm + hits.miss;
  let main = 'mixed';
  if (total === 0 && len < 10) main = 'calm';
  else {
    const max = Math.max(hits.happy, hits.sad, hits.angry, hits.calm, hits.miss);
    const sumOthers = total - max;
    if (max > 0 && max >= sumOthers) {
      main = Object.keys(hits).find(k => hits[k] === max);
    }
  }
  const verdict = VERDICTS[main];

  // 数据条（0-100）
  const bars = [
    { label: '仙气值', val: clamp(hits.calm * 18 + (d2 === 'F' ? 35 : 5) + moodAvg * 6) },
    { label: '癫值', val: clamp(hits.angry * 20 + excl * 6 + (d2 === 'D' ? 30 : 0)) },
    { label: 'emo浓度', val: clamp(hits.sad * 18 + hits.miss * 12 + (d4 === 'R' ? 28 : 4)) },
    { label: '生命力', val: clamp(hits.happy * 18 + moodAvg * 12 + fps.length * 5) },
  ];

  // 种子：用日期+条数，保证同一天结果稳定
  const seed = new Date().getDate() * 31 + fps.length * 7 + Math.floor(moodAvg * 10) + code.charCodeAt(0);
  const yi = pickN(YI_POOL, 2, seed);
  const ji = pickN(JI_POOL, 2, seed + 3);
  const lucky = pick(LUCKY_POOL, seed + 9);

  return {
    code, title, verdict, bars, yi, ji, lucky,
    moodAvg, fpsCount: fps.length,
    dims: DIM_NAMES, main,
    serial: 'NO.' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(100 + (seed % 900)),
    userName,
  };
}

function clamp(v) { return Math.max(4, Math.min(99, Math.round(v))); }

// ─── 绘制 1080x1350 鉴定卡 ───
export function drawMoodCard(canvas, r) {
  const W = 1080, H = 1350;
  const g = canvas.getContext('2d');
  const SERIF = '"Noto Serif SC","Songti SC","SimSun",serif';

  // 底
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#14201b');
  bg.addColorStop(0.55, '#0e1512');
  bg.addColorStop(1, '#151210');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  // 噪点
  for (let i = 0; i < 2400; i++) {
    g.fillStyle = 'rgba(232,226,212,' + (Math.random() * 0.05) + ')';
    g.fillRect(Math.random() * W, Math.random() * H, 1.2, 1.2);
  }

  // 四角微光
  const gl = g.createRadialGradient(W * 0.85, H * 0.08, 0, W * 0.85, H * 0.08, 420);
  gl.addColorStop(0, 'rgba(211,185,138,.14)'); gl.addColorStop(1, 'transparent');
  g.fillStyle = gl; g.fillRect(0, 0, W, H);
  const gl2 = g.createRadialGradient(W * 0.1, H * 0.95, 0, W * 0.1, H * 0.95, 420);
  gl2.addColorStop(0, 'rgba(143,184,168,.10)'); gl2.addColorStop(1, 'transparent');
  g.fillStyle = gl2; g.fillRect(0, 0, W, H);

  // 双线金框
  g.strokeStyle = 'rgba(211,185,138,.85)'; g.lineWidth = 3;
  g.strokeRect(36, 36, W - 72, H - 72);
  g.strokeStyle = 'rgba(211,185,138,.3)'; g.lineWidth = 1;
  g.strokeRect(50, 50, W - 100, H - 100);

  const cx = W / 2;
  let y = 132;

  // 局名
  g.textAlign = 'center';
  g.fillStyle = '#9a958a';
  g.font = '26px ' + SERIF;
  g.fillText('夜 游 神 · 精 神 状 态 鉴 定 局', cx, y);
  y += 40;
  g.fillStyle = '#5d594f';
  g.font = '20px ' + SERIF;
  g.fillText(r.serial + '  ·  ' + new Date().toLocaleDateString('zh-CN'), cx, y);

  // 分割线
  y += 44;
  g.strokeStyle = 'rgba(211,185,138,.4)';
  g.beginPath(); g.moveTo(180, y); g.lineTo(W - 180, y); g.stroke();
  y += 80;

  // 四字母代码
  g.fillStyle = '#e8d3a2';
  g.font = '700 148px Georgia, ' + SERIF;
  g.fillText(r.code.split('').join(' '), cx, y + 60);
  y += 130;
  // 字母释义
  g.fillStyle = '#9a958a';
  g.font = '22px ' + SERIF;
  const parts = r.code.split('').map(c => r.dims[c]);
  g.fillText(parts.join('  ·  '), cx, y);
  y += 72;

  // 称号
  g.fillStyle = '#f0ead8';
  g.font = '700 62px ' + SERIF;
  g.fillText('「' + r.title + '」', cx, y);
  y += 58;

  // 判词（自动换行）
  g.fillStyle = '#b8b2a4';
  g.font = '26px ' + SERIF;
  y = wrapText(g, r.verdict, cx, y, W - 320, 40);
  y += 46;

  // 数据条
  const barX = 190, barW = W - 380, barH = 14;
  for (const b of r.bars) {
    g.textAlign = 'left';
    g.fillStyle = '#9a958a';
    g.font = '23px ' + SERIF;
    g.fillText(b.label, barX, y + 6);
    g.textAlign = 'right';
    g.fillStyle = '#d3b98a';
    g.fillText(b.val + '%', barX + barW, y + 6);
    y += 18;
    g.fillStyle = 'rgba(232,226,212,.1)';
    roundRect(g, barX, y, barW, barH, 7); g.fill();
    const grad = g.createLinearGradient(barX, 0, barX + barW, 0);
    grad.addColorStop(0, '#8fb8a8'); grad.addColorStop(1, '#d3b98a');
    g.fillStyle = grad;
    roundRect(g, barX, y, barW * b.val / 100, barH, 7); g.fill();
    y += 42;
  }
  y += 22;
  g.textAlign = 'center';

  // 宜忌
  g.strokeStyle = 'rgba(211,185,138,.4)';
  g.beginPath(); g.moveTo(180, y); g.lineTo(W - 180, y); g.stroke();
  y += 52;
  g.font = '26px ' + SERIF;
  g.fillStyle = '#8fb8a8';
  g.fillText('宜　' + r.yi.join('　·　'), cx, y);
  y += 46;
  g.fillStyle = '#c98a7a';
  g.fillText('忌　' + r.ji.join('　·　'), cx, y);
  y += 46;
  g.fillStyle = '#d3b98a';
  g.font = '24px ' + SERIF;
  g.fillText('今日幸运物：' + r.lucky, cx, y);

  // 底部
  g.fillStyle = '#5d594f';
  g.font = '19px ' + SERIF;
  g.fillText('本报告不具备任何科学依据，但对得起你的心情', cx, H - 96);
  g.fillStyle = '#4a463e';
  g.font = '17px ' + SERIF;
  g.fillText('—— ' + (r.userName || '无名氏') + ' · 留下 ' + r.fpsCount + ' 枚足迹后鉴定 ——', cx, H - 64);

  return canvas;
}

function wrapText(g, text, cx, y, maxW, lh) {
  let line = '';
  for (const ch of text) {
    if (g.measureText(line + ch).width > maxW) {
      g.fillText(line, cx, y);
      line = ch; y += lh;
    } else line += ch;
  }
  if (line) { g.fillText(line, cx, y); y += lh; }
  return y;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
