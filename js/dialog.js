// ═══ 弹窗无障碍统一层 ═══
//
// 站点有 8 个 .modal，全都是 <div class="modal" hidden> 手动开关，
// 开关点散落在业务代码里。要补的东西每个都一样，所以不去改 8 处调用点，
// 而是在这里用 MutationObserver 盯住 hidden 属性的变化，统一补：
//
//   1) role="dialog" + aria-modal + aria-labelledby（读标题 h3）
//      —— 没有这些，读屏软件会把弹窗当成页面里的一段普通 div
//   2) 打开时把焦点移进弹窗
//      —— 否则焦点还停在背后的卡片上，Tab 一路在背景里走，弹窗内容根本够不到
//   3) 关闭时把焦点还给触发它的元素
//   4) Esc 关闭；Tab 在弹窗内循环，不跑到背景去
//      —— 灯箱 / 全景浮层可能叠在弹窗之上，它们有自己的 Esc 处理，这里让位
//
// 之所以用观察者而不是包装 open/close 函数：调用点太多且形态各异
// （有的直接 hidden=false，有的走 onclick），包一遍容易漏。

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)]
    .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement);
}

function visibleModals() {
  return [...document.querySelectorAll('.modal')].filter(m => !m.hidden);
}

// 叠在弹窗之上的浮层：它们自己处理 Esc，弹窗不要抢
function overlayAbove() {
  const lb = document.getElementById('lightbox');
  const pano = document.getElementById('pano-overlay');
  return (lb && !lb.hidden) || (pano && !pano.hidden);
}

function enhance(modal) {
  if (modal.dataset.dlgReady) return;
  modal.dataset.dlgReady = '1';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const title = modal.querySelector('h3, h4, [data-dialog-title]');
  if (title) {
    if (!title.id) title.id = (modal.id || 'dialog') + '-title';
    modal.setAttribute('aria-labelledby', title.id);
  } else if (modal.id) {
    modal.setAttribute('aria-label', modal.id);
  }

  let lastFocused = null;
  new MutationObserver(() => {
    if (!modal.hidden) {
      lastFocused = document.activeElement;
      // 等这一帧的渲染落定再聚焦：调用点常常是「先填内容、再 hidden=false」
      requestAnimationFrame(() => {
        if (modal.hidden) return;
        const items = focusables(modal);
        const preferred = items.find(el => el.classList.contains('intro-close')) || items[0] || modal;
        if (!modal.contains(document.activeElement)) preferred.focus();
        if (modal === document.activeElement && !modal.hasAttribute('tabindex')) {
          modal.setAttribute('tabindex', '-1');   // 没有可聚焦元素时，焦点至少有处可落
        }
      });
    } else {
      if (lastFocused && document.contains(lastFocused)) {
        lastFocused.focus({ preventScroll: true });
        lastFocused = null;
      }
      // 通知业务层（路由回写等）。只在关闭时发，开启时不发。
      document.dispatchEvent(new CustomEvent('dialog:close', { detail: { id: modal.id } }));
    }
  }).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
}

/**
 * 给页面上所有 .modal 补齐对话框语义与焦点管理。
 * 幂等：重复调用只会处理新增的弹窗。
 */
export function enhanceDialogs() {
  document.querySelectorAll('.modal').forEach(enhance);

  if (document.documentElement.dataset.dlgKeys) return;   // 键盘监听只挂一次
  document.documentElement.dataset.dlgKeys = '1';

  document.addEventListener('keydown', e => {
    const open = visibleModals();
    if (!open.length) return;
    const top = open[open.length - 1];

    if (e.key === 'Escape') {
      if (overlayAbove()) return;          // 让灯箱/全景先关自己
      e.stopPropagation();                 // 别顺手把搜索框也清了
      top.hidden = true;
      return;
    }

    if (e.key !== 'Tab') return;
    const items = focusables(top);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const inside = top.contains(document.activeElement);
    if (e.shiftKey && (!inside || document.activeElement === first)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
      e.preventDefault();
      first.focus();
    }
  }, true);
}
