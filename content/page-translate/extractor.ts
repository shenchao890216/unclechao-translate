import {
  BLOCK_MAX_LENGTH,
  BLOCK_MIN_LENGTH,
  BLOCK_TAGS,
  CJK_RATIO_THRESHOLD,
  CONDITIONAL_CODE_TAGS,
  SKIP_TAGS,
} from '@/utils/constants';
import type { TextBlock } from '@/utils/types';
import { isSelectionTranslatedText } from '@/content/selection/inline';
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

  /** 长度达标、含字母、像正文、非中文为主 */
  function qualifies(text: string): boolean {
    if (text.length < BLOCK_MIN_LENGTH) return false;
    if (!/[\p{L}]/u.test(text)) return false;
    if (isChromeText(text)) return false;
    return cjkRatio(text) <= CJK_RATIO_THRESHOLD;
  }
}

/** 划词已经译过的原文不再送进整页翻译 */
function acceptSourceText(node: Node): number {
  if (!(node instanceof Text) || !node.textContent?.trim()) return NodeFilter.FILTER_SKIP;
  if (isSelectionTranslatedText(node)) return NodeFilter.FILTER_REJECT;
  return NodeFilter.FILTER_ACCEPT;
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
  if (isSiteChrome(el)) return true;
  if (isSiteNav(el)) return true;
  if (isBreadcrumb(el)) return true;
  if (isCssHidden(el)) return true;
  return false;
}

/**
 * 账号、话题、阅读量、时间、语言切换和登录入口整段出现时不是正文。
 * 无空格的普通单词（如一句推文 "Hello"）仍翻译；带数字或下划线的标识才跳过。
 * 句子里的 Login / English 仍翻译，只有整段就是这些词才跳过。
 */
function isChromeText(text: string): boolean {
  if (isSocialTokenRun(text)) return true;
  if (isBareIdentifier(text)) return true;
  if (isMetric(text)) return true;
  if (isTimestamp(text)) return true;
  if (isUtilityRun(text)) return true;
  return false;
}

/** 语言切换和账号入口。长的放前面，避免 "sign" 吃掉 "sign in"。 */
const UTILITY_LABELS = [
  'bahasa indonesia',
  'bahasa melayu',
  'tiếng việt',
  '简体中文',
  '繁體中文',
  'português',
  'español',
  'français',
  'italiano',
  'nederlands',
  'українська',
  'русский',
  '日本語',
  '한국어',
  'العربية',
  'עברית',
  'हिन्दी',
  'ไทย',
  '中文',
  'select language',
  'change language',
  'choose language',
  'sign out',
  'sign in',
  'sign up',
  'log out',
  'log in',
  'languages',
  'language',
  'english',
  'deutsch',
  'polski',
  'svenska',
  'dansk',
  'suomi',
  'norsk',
  'čeština',
  'magyar',
  'română',
  'ελληνικά',
  'türkçe',
  'logout',
  'signup',
  'login',
  'register',
].sort((a, b) => b.length - a.length);

function isUtilityRun(text: string): boolean {
  let rest = text.replace(/[▾▼▸►›]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!rest) return false;
  let matched = 0;
  while (rest) {
    const label = UTILITY_LABELS.find((item) => rest === item || rest.startsWith(`${item} `));
    if (!label) return false;
    rest = rest.slice(label.length).trim();
    matched += 1;
    if (matched > 4) return false;
  }
  return true;
}

function isSocialTokenRun(text: string): boolean {
  const parts = text.split(/\s+/);
  return parts.every(
    (part) => /^@[\p{L}\p{N}_.]{1,50}$/u.test(part) || /^#[\p{L}\p{N}_]{1,80}$/u.test(part),
  );
}

function isBareIdentifier(text: string): boolean {
  if (text.length > 40 || /\s/u.test(text)) return false;
  return /^[\p{L}\p{N}_]+$/u.test(text) && /[\d_]/u.test(text);
}

function isMetric(text: string): boolean {
  return /^(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s*[kmb])?(?:\s+(?:views?|reposts?|repl(?:y|ies)|likes?|quotes?|bookmarks?|shares?))?$/i.test(
    text,
  );
}

const MONTH = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
const SHORT_DATE = new RegExp(
  `^(?:(?:${MONTH})[a-z]*\\.?\\s+\\d{1,2}|\\d{1,2}\\s+(?:${MONTH})[a-z]*\\.?)(?:,?\\s+\\d{4})?$`,
  'i',
);

function isTimestamp(text: string): boolean {
  if (/^\d{1,3}\s*[smhdw]$/i.test(text)) return true;
  if (/^\d+\s+(?:sec|second|min|minute|hr|hour|day|week|month|year)s?\s+ago$/i.test(text)) return true;
  return SHORT_DATE.test(text);
}

/** X / Twitter 上显示名、转发来源、阅读量和互动数字。class 会变，只用稳定属性。 */
const X_CHROME_SELECTOR = [
  '[data-testid="User-Name"]',
  '[data-testid="socialContext"]',
  'a[href*="/analytics"]',
  '[data-testid="app-text-transition-container"]',
].join(',');

function isSiteChrome(el: Element): boolean {
  const host = location.hostname.replace(/^www\./, '');
  if (host !== 'x.com' && host !== 'twitter.com' && !host.endsWith('.twitter.com')) return false;
  return el.matches(X_CHROME_SELECTOR);
}

/**
 * 站点顶栏：Home / Posts / About 这种导航，以及旁边的站名。
 * 文章内部的 header、目录不在这里跳过。
 */
function isSiteNav(el: Element): boolean {
  if (el.closest('article, main, [role="main"]')) return false;
  if (el.tagName === 'NAV' || el.getAttribute('role') === 'navigation') return true;
  if (el.tagName === 'HEADER' || el.getAttribute('role') === 'banner') return isShortLinkBar(el);
  return false;
}

/** 顶栏里几乎只有短链接，没有标题或正文 */
function isShortLinkBar(el: Element): boolean {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 160) return false;
  const links = [...el.querySelectorAll('a')].filter((link) => (link.textContent ?? '').trim());
  if (links.length < 2) return false;
  return links.every((link) => {
    const label = (link.textContent ?? '').replace(/\s+/g, ' ').trim();
    return label.length <= 32 && !/[.!?。！？]/.test(label);
  });
}

/** 面包屑路径。正文标题还会单独出现，这里只跳过这条中导航。 */
function isBreadcrumb(el: Element): boolean {
  const hint = [
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('class') ?? '',
    el.id ?? '',
    el.getAttribute('data-testid') ?? '',
    el.getAttribute('itemtype') ?? '',
  ].join(' ');
  if (/breadcrumb/i.test(hint)) return true;
  return looksLikeBreadcrumb(el);
}

function looksLikeBreadcrumb(el: Element): boolean {
  const children = [...el.children];
  if (children.length < 2 || children.length > 12) return false;
  const hasSeparator = [...el.childNodes].some((node) => {
    if (node instanceof Element) return isBreadcrumbSeparator(node);
    return node.nodeType === Node.TEXT_NODE && /[>›»]| \/\s/.test(node.textContent ?? '');
  });
  if (!hasSeparator) return false;
  const items = children.filter((child) => !isBreadcrumbSeparator(child) && (child.textContent ?? '').trim());
  if (items.length < 2 || items.length > 6) return false;
  if (items.some((item) => (item.textContent ?? '').replace(/\s+/g, ' ').trim().length > 90)) return false;
  const linked = items.filter((item) => item.matches('a') || item.querySelector('a')).length;
  return linked >= items.length - 1;
}

function isBreadcrumbSeparator(el: Element): boolean {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (/^[>›»/|·•–—-]$/.test(text)) return true;
  return !text && (el.tagName === 'SVG' || !!el.querySelector('svg'));
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
      if (node.nodeType === Node.TEXT_NODE) return acceptSourceText(node);
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
      if (node.nodeType === Node.TEXT_NODE) return acceptSourceText(node);
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
