import type { ContentScriptContext } from '#imports';
import { OBSERVER_DEBOUNCE_MS } from '@/utils/constants';

export interface PageObserverHooks {
  /** 整页翻译是否处于开启状态 */
  isActive: () => boolean;
  /** 增量翻译新增子树 */
  onAddedNodes: (nodes: Element[]) => void;
  /** 路由切换 / 大面积 DOM 替换：清空状态全量重提取 */
  onRouteSwitch: () => void;
}

/**
 * SPA 增量监测：
 * - 滚动、懒加载、目录高亮都会改 DOM，一律按新增子树增量翻译，不清整页
 * - 自家注入节点（译文、提示、浮层）不回调自己，避免死循环
 * - 300ms 去抖；父子同时出现时只保留祖先
 * - 只有路径或查询串变化才整页重译。hash 变化多半是滚动定位，不重译
 */
export function initPageObserver(ctx: ContentScriptContext, hooks: PageObserverHooks): void {
  let timer: number | undefined;
  const pending = new Set<Element>();

  const observer = new MutationObserver((mutations) => {
    if (!hooks.isActive()) return;
    let added = 0;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (isOwnNode(node)) continue;
        added++;
        pending.add(node);
      }
    }
    if (added === 0) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const nodes = topLevelNodes(pending);
      pending.clear();
      if (nodes.length > 0) hooks.onAddedNodes(nodes);
    }, OBSERVER_DEBOUNCE_MS);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // 路由变化兜底（纯路由切换、DOM 大部分复用的场景）
  ctx.addEventListener(window, 'wxt:locationchange', (event) => {
    if (!hooks.isActive()) return;
    if (isHashOnlyChange(event)) return;
    hooks.onRouteSwitch();
  });
}

function topLevelNodes(nodes: Set<Element>): Element[] {
  return Array.from(nodes).filter(
    (node) => ![...nodes].some((other) => other !== node && other.contains(node)),
  );
}

function isHashOnlyChange(event: Event): boolean {
  const change = event as Partial<{ newUrl: URL; oldUrl: URL }>;
  const next = change.newUrl;
  const prev = change.oldUrl;
  if (!next || !prev) return false;
  return next.origin === prev.origin && next.pathname === prev.pathname && next.search === prev.search;
}

function isOwnNode(node: HTMLElement): boolean {
  if (node.id === 'uct-page-notice' || node.id === 'uct-page-style') return true;
  if (node.tagName === 'UCT-SELECTION-POPUP') return true;
  if (node.dataset.uctTargetId !== undefined || node.dataset.uctSelection !== undefined) return true;
  return !!node.closest('[data-uct-target-id], [data-uct-selection]');
}
