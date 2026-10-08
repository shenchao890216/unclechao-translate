import { HOST_CLASS, SRC_ID_ATTR, TARGET_CLASS, TARGET_ID_ATTR } from '@/utils/constants';
import type { TextBlock, ViewMode } from '@/utils/types';

const PAGE_STYLE_ID = 'uct-page-style';
const PAGE_NOTICE_ID = 'uct-page-notice';

const PAGE_STYLE = `
  .uct-tl {
    display: block;
    font: inherit;
    color: #3b5bdb;
    border-left: 2px solid #91a7ff;
    padding-left: 0.5em;
    margin: 0.25em 0;
  }
  .uct-failed {
    font: inherit;
    display: block;
    color: #adb5bd;
    font-size: 0.85em;
    margin: 0.25em 0;
  }
  .uct-pending {
    display: block;
    font: inherit;
    font-size: 0.85em;
    color: #868e96;
    margin: 0.25em 0;
  }
  .uct-pending::before {
    content: '';
    display: inline-block;
    width: 0.45em;
    height: 0.45em;
    margin-right: 0.4em;
    border-radius: 50%;
    background: #748ffc;
    vertical-align: 0.05em;
    animation: uct-pulse 1s ease-in-out infinite;
  }
  @keyframes uct-pulse {
    50% { opacity: 0.25; }
  }
  .uct-mode-source [data-uct-target-id] { display: none !important; }
  .uct-mode-target [data-uct-src-id] { display: none !important; }
  @media (prefers-color-scheme: dark) {
    .uct-tl { color: #748ffc; border-left-color: #4c6ef5; }
    .uct-failed { color: #6b7280; }
    .uct-pending { color: #9ca3af; }
  }
`;

/** 向页面注入整页翻译样式（幂等），关闭翻译时移除 */
export function injectPageStyles(): void {
  if (document.getElementById(PAGE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PAGE_STYLE_ID;
  style.textContent = PAGE_STYLE;
  document.head.append(style);
}

export function removePageStyles(): void {
  document.getElementById(PAGE_STYLE_ID)?.remove();
}

const PENDING_CLASS = 'uct-pending';

/** 请求已发出、译文还没回来时，在原块下显示「翻译中…」 */
export function showTranslatingPlaceholder(block: TextBlock): void {
  if (!block.host.isConnected || slotOf(block.host)) return;
  const placeholder = document.createElement('span');
  placeholder.className = PENDING_CLASS;
  placeholder.dataset.uctTargetId = String(block.id);
  placeholder.setAttribute('translate', 'no');
  placeholder.textContent = '翻译中…';
  placeSlot(block.host, placeholder);
  markHost(block);
}

/** 在原块下方插入译文（td/th 作为单元格末尾子元素，避免破坏表格结构） */
export function injectTranslation(block: TextBlock, text: string): void {
  const target = document.createElement('span');
  target.className = TARGET_CLASS;
  target.dataset.uctTargetId = String(block.id);
  target.textContent = text; // 只用 textContent，杜绝 LLM 输出注入
  placeSlot(block.host, target);
  markHost(block);
}

/** 灰色失败占位，悬停显示错误信息 */
export function injectFailurePlaceholder(block: TextBlock, reason: string): void {
  const placeholder = document.createElement('span');
  placeholder.className = 'uct-failed';
  placeholder.dataset.uctTargetId = String(block.id);
  placeholder.setAttribute('translate', 'no');
  placeholder.textContent = formatFailureLabel(reason);
  placeholder.title = reason;
  placeSlot(block.host, placeholder);
  markHost(block);
}

function placeSlot(host: Element, node: HTMLElement): void {
  const existing = slotOf(host);
  if (existing) {
    existing.replaceWith(node);
    return;
  }
  if (host.tagName === 'TD' || host.tagName === 'TH') {
    host.append(node);
  } else {
    host.insertAdjacentElement('afterend', node);
  }
}

function slotOf(host: Element): HTMLElement | null {
  if (host.tagName === 'TD' || host.tagName === 'TH') {
    const found = host.querySelector(':scope > [data-uct-target-id]');
    return found instanceof HTMLElement ? found : null;
  }
  const next = host.nextElementSibling;
  if (!(next instanceof HTMLElement) || next.dataset.uctTargetId === undefined) return null;
  return next;
}

/** 划词占住这段时，撤掉整页的「翻译中…」，避免同一段挂两份译文 */
export function removePendingPageSlot(host: Element): void {
  const slot = slotOf(host);
  if (!slot || !slot.classList.contains(PENDING_CLASS)) return;
  slot.remove();
  unmarkHost(host);
}

/** 划词已经给出译文时，撤掉整页译文，只留划词那一份 */
export function removePageSlot(host: Element): void {
  const slot = slotOf(host);
  if (!slot) return;
  slot.remove();
  unmarkHost(host);
}

function unmarkHost(host: Element): void {
  if (slotOf(host)) return;
  delete (host as HTMLElement).dataset.uctSrcId;
  host.classList.remove(HOST_CLASS);
}

function markHost(block: TextBlock): void {
  block.host.dataset.uctSrcId = String(block.id);
  block.host.classList.add(HOST_CLASS);
}

/** 宿主旁边是否已经有译文或失败占位（不含「翻译中」） */
export function hasRenderedTranslation(el: Element): boolean {
  const slot = slotOf(el);
  return !!slot && !slot.classList.contains(PENDING_CLASS);
}

/** 译文、失败或「翻译中」占位都算已占用，避免同一段被再次提取 */
export function hasTranslationSlot(el: Element): boolean {
  return slotOf(el) !== null;
}

/** 页面上给出状态。persistent 为真时不自动消失（翻译进行中） */
export function showPageNotice(message: string, persistent = false): void {
  document.getElementById(PAGE_NOTICE_ID)?.remove();
  const el = document.createElement('div');
  el.id = PAGE_NOTICE_ID;
  el.setAttribute('translate', 'no');
  el.textContent = message;
  el.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'left:16px',
    'bottom:16px',
    'max-width:320px',
    'padding:10px 12px',
    'border-radius:8px',
    'background:#1f2328',
    'color:#fff',
    'font:13px/1.5 system-ui,-apple-system,sans-serif',
    'box-shadow:0 8px 24px rgba(0,0,0,.2)',
  ].join(';');
  document.documentElement.append(el);
  if (!persistent) {
    window.setTimeout(() => el.remove(), 4500);
  }
}

/** 页面上能直接看到的失败说明，完整原因仍放在 title 里 */
export function formatFailureLabel(message: string): string {
  const clean = message.replace(/\s+/g, ' ').trim();
  if (!clean || clean === '翻译失败') return '翻译失败';
  const short = clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
  return `翻译失败：${short}`;
}

export function hidePageNotice(): void {
  document.getElementById(PAGE_NOTICE_ID)?.remove();
}

/** 清理页面上所有译文与宿主标记（关闭整页翻译） */
export function clearTranslations(): void {
  document.getElementById(PAGE_NOTICE_ID)?.remove();
  for (const el of document.querySelectorAll(`[${TARGET_ID_ATTR}]`)) {
    el.remove();
  }
  for (const el of document.querySelectorAll(`[${SRC_ID_ATTR}]`)) {
    el.removeAttribute(SRC_ID_ATTR);
    el.classList.remove(HOST_CLASS);
  }
  removePageStyles();
}

/** 三视图切换：documentElement 上切类，纯 CSS 生效 */
export function applyViewMode(mode: ViewMode): void {
  const root = document.documentElement;
  root.classList.remove('uct-mode-dual', 'uct-mode-source', 'uct-mode-target');
  root.classList.add(`uct-mode-${mode}`);
}
