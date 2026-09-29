import type { ContentScriptContext } from '#imports';
import {
  SELECTION_HIDE_DEBOUNCE_MS,
  SELECTION_HIDE_SCROLL_PX,
  SELECTION_MAX_LENGTH,
  SELECTION_MIN_LENGTH,
} from '@/utils/constants';

export interface SelectionTarget {
  text: string;
  rect: DOMRect;
  /** 松开鼠标时的视口坐标，翻译按钮贴在这里 */
  point: { x: number; y: number };
  /** 选区快照。点按钮时选区可能已经塌掉，靠它把译文插回页面 */
  range: Range;
}

export interface SelectionDetectorHooks {
  /** 划词功能开关（设置热更新） */
  isEnabled: () => boolean;
  /** 检测到有效选区 */
  onShow: (target: SelectionTarget) => void;
  /** 选区消失 / 点击外部 / Esc / 滚动 */
  onHide: () => void;
  /** 判断事件是否发生在翻译按钮内 */
  isInsidePopup: (event: Event) => boolean;
}

/**
 * 选区检测：mouseup 触发（用户显式动作，不需要防抖），
 * selectionchange（防抖）负责清理路径，避免拖选过程闪烁。
 */
export function initSelectionDetector(ctx: ContentScriptContext, hooks: SelectionDetectorHooks): void {
  let lastScrollY = window.scrollY;
  let hideDebounceTimer: number | undefined;
  let pointerOnButton = false;

  const findSelection = (point: { x: number; y: number }): SelectionTarget | null => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    if (isInEditable(selection.anchorNode)) return null;
    const text = selection.toString();
    if (!qualifies(text)) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { text, rect, range, point };
  };

  // 触发路径
  ctx.addEventListener(document, 'mouseup', (event) => {
    if (pointerOnButton) {
      window.setTimeout(() => {
        pointerOnButton = false;
      }, 0);
      return;
    }
    if (!hooks.isEnabled()) return;
    const mouse = event as MouseEvent;
    const found = findSelection({ x: mouse.clientX, y: mouse.clientY });
    if (found) hooks.onShow(found);
  });

  // 点击浮层外关闭（mousedown 先于 mouseup，避免"点击别处后浮层残留"）
  ctx.addEventListener(document, 'mousedown', (event) => {
    if (hooks.isInsidePopup(event)) {
      pointerOnButton = true;
      return;
    }
    pointerOnButton = false;
    hooks.onHide();
  });

  // 清理路径：选区塌陷（150ms 防抖）
  ctx.addEventListener(document, 'selectionchange', () => {
    window.clearTimeout(hideDebounceTimer);
    hideDebounceTimer = window.setTimeout(() => {
      if (pointerOnButton) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) hooks.onHide();
    }, SELECTION_HIDE_DEBOUNCE_MS);
  });

  // 滚动超过阈值隐藏（fixed 浮层不随选区移动）；capture 覆盖页面内滚动容器
  ctx.addEventListener(window, 'scroll', () => {
    const delta = Math.abs(window.scrollY - lastScrollY);
    lastScrollY = window.scrollY;
    if (delta > SELECTION_HIDE_SCROLL_PX) hooks.onHide();
  }, { passive: true, capture: true });

  // Esc 关闭
  ctx.addEventListener(window, 'keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') hooks.onHide();
  });
}

/** 选区是否值得翻译：长度达标且含至少一个字母 */
function qualifies(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < SELECTION_MIN_LENGTH) return false;
  if (trimmed.length > SELECTION_MAX_LENGTH) return false;
  return /[\p{L}]/u.test(trimmed);
}

/** 选区起点在输入框 / 可编辑区域内时不触发（用户正在编辑自己的文字） */
function isInEditable(node: Node | null): boolean {
  const el = node instanceof HTMLElement ? node : node?.parentElement;
  if (!el) return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return true;
  return el.isContentEditable;
}
