import {
  BLOCK_MAX_LENGTH,
  BLOCK_MIN_LENGTH,
  BLOCK_TAGS,
  CJK_RATIO_THRESHOLD,
  CONDITIONAL_CODE_TAGS,
  SKIP_TAGS,
} from '@/utils/constants';
import type { TextBlock } from '@/utils/types';
import { hasTranslationSlot } from './injector';

/** 超过该长度的块直接截断（防超出模型上下文） */
const HARD_MAX_LENGTH = BLOCK_MAX_LENGTH * 3;

/**
 * 文本块提取：块级递归下降 + 叶子内 TreeWalker。
 * - 容器块（含块级子元素）：聚合"直接文本"为一个块，再逐个下探子块
 * - 叶子块：收集子树内全部文本节点（含行内元素内的）
 * 行内 <code> 不剪枝（剪掉会造成句子空洞），靠 prompt 规则保护；
 * 仅当其被 CSS 渲染为块级时才剪枝（<pre><code> 场景由 PRE 剪枝覆盖）。
 */
export function extractBlocks(root: Element, startId: number): TextBlock[] {
  const blocks: TextBlock[] = [];
  let nextId = startId;

  const visit = (el: Element): void => {
    if (shouldPrune(el)) return;
    if (isBlockElement(el)) {
      visitBlockElement(el);
    } else {
      for (const child of el.children) visit(child);
    }
  };

  const visitBlockElement = (el: Element): void => {
    const childBlocks = Array.from(el.children).filter(
      (child) => !shouldPrune(child) && isBlockElement(child),
    );
    if (childBlocks.length > 0) {
      pushIfQualified(el, collectDirectText(el, new Set(childBlocks)));
      for (const child of childBlocks) visitBlockElement(child);
    } else {
      pushIfQualified(el, collectLeafText(el));
    }
  };

  const pushIfQualified = (host: Element, text: string): void => {
    if (!(host instanceof HTMLElement)) return;
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, HARD_MAX_LENGTH);
    if (!qualifies(clean)) return;
    blocks.push({
      id: nextId++,
      host,
      sourceText: clean,
      state: 'pending',
    });
  };

  visit(root);
  return blocks;

  /** 长度达标、含字母、非中文为主 */
  function qualifies(text: string): boolean {
    if (text.length < BLOCK_MIN_LENGTH) return false;
    if (!/[\p{L}]/u.test(text)) return false;
    return cjkRatio(text) <= CJK_RATIO_THRESHOLD;
  }
}

function cjkRatio(text: string): number {
  const cjk = text.match(/[一-鿿㐀-䶿]/g)?.length ?? 0;
  return text.length === 0 ? 0 : cjk / text.length;
}

/** 命中则跳过整棵子树 */
function shouldPrune(el: Element): boolean {
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) return true;
  if (CONDITIONAL_CODE_TAGS.has(tag) && !isInlineRendered(el)) return true;
  if (el.getAttribute('translate') === 'no') return true;
  const classAttr = el.getAttribute('class');
  if (classAttr && classAttr.split(/\s+/).includes('notranslate')) return true;
  if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el instanceof HTMLElement && (el.dataset.uctTargetId !== undefined || el.dataset.uctSelection !== undefined)) {
    return true; // 译文节点，防止译中译
  }
  // 只在译文还在时跳过。滚动 / hydration 常把译文节点摘掉但留下宿主，
  // 若仅凭 data-uct-src-id 剪枝，这段文字会一直缺译文。
  if (hasTranslationSlot(el)) return true;
  if (isCssHidden(el)) return true;
  return false;
}

/**
 * 只剪掉真正不渲染的子树。
 * `checkVisibility()` 对 `display: contents` 恒为 false（元素自己没有盒子），
 * 但子节点是可见的。若据此整树剪枝，Tailwind `contents` 一类包裹层下的正文会被全部丢掉，
 * 整页翻译表现为点了没反应。
 * 屏幕外、尚未布局的 `content-visibility: auto` 后代同样没有盒子，全文翻译仍要收录。
 */
function isCssHidden(el: Element): boolean {
  if (typeof el.checkVisibility === 'function' && el.checkVisibility()) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.contentVisibility === 'hidden') return true;
  if (hasHiddenAncestor(el)) return true;
  return false;
}

function hasHiddenAncestor(el: Element): boolean {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node.hasAttribute('hidden')) return true;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.contentVisibility === 'hidden') return true;
  }
  return false;
}

function isInlineRendered(el: Element): boolean {
  const display = window.getComputedStyle(el).display;
  return display.startsWith('inline');
}

/** 块级判定：标签白名单优先，computed display 兜底 */
function isBlockElement(el: Element): boolean {
  if (BLOCK_TAGS.has(el.tagName)) return true;
  const display = window.getComputedStyle(el).display;
  return /^(block|list-item|table-cell|table-caption|flow-root|flex|grid)/.test(display);
}

/** 叶子块：收集子树全部文本节点（跳过剪枝子树与空白节点） */
function collectLeafText(el: Element): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ALL, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (shouldPrune(node as Element)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_SKIP;
    },
  });
  let current = walker.nextNode();
  while (current) {
    parts.push(current.textContent ?? '');
    current = walker.nextNode();
  }
  return parts.join(' ');
}

/** 容器块：聚合"直接文本"（本层文本节点 + 不在子块子树内的文本） */
function collectDirectText(el: Element, excluded: Set<Element>): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ALL, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (shouldPrune(element) || excluded.has(element)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_SKIP;
    },
  });
  let current = walker.nextNode();
  while (current) {
    parts.push(current.textContent ?? '');
    current = walker.nextNode();
  }
  return parts.join(' ');
}
