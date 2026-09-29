import { VIEWPORT_LOOKAHEAD_RATIO } from '@/utils/constants';

/**
 * 是否已经进入「视口及其上方」，再加一小段提前量。
 * 没有盒子的节点（尚未布局的 content-visibility）先不译，等滚到出现盒子后再译。
 */
export function isInTranslatedRange(el: Element): boolean {
  const top = layoutTop(el);
  if (top == null) return false;
  const ahead = window.innerHeight * VIEWPORT_LOOKAHEAD_RATIO;
  return top < window.scrollY + window.innerHeight + ahead;
}

function layoutTop(el: Element): number | null {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return rect.top + window.scrollY;
}
