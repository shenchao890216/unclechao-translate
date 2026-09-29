import { injectPageStyles } from '@/content/page-translate/injector';

/** 在选区末尾插入「翻译中…」，返回占位节点，结果回来后原地替换 */
export function insertSelectionPending(range: Range): HTMLElement | null {
  if (!range.startContainer.isConnected) return null;
  injectPageStyles();
  const slot = document.createElement('span');
  slot.className = 'uct-pending';
  slot.dataset.uctSelection = '1';
  slot.setAttribute('translate', 'no');
  slot.textContent = '翻译中…';
  try {
    const at = range.cloneRange();
    at.collapse(false);
    at.insertNode(slot);
  } catch {
    return null;
  }
  return slot;
}

export function fillSelectionResult(slot: HTMLElement, text: string): void {
  slot.className = 'uct-tl';
  slot.textContent = text;
  slot.removeAttribute('title');
}

export function fillSelectionError(slot: HTMLElement, message: string): void {
  slot.className = 'uct-failed';
  slot.textContent = '翻译失败';
  slot.title = message;
}
