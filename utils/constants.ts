import type { Settings } from './types';

// ---------- 默认设置 ----------

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  llm: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-4.7-flash',
  },
  targetLang: '中文',
  selection: { enabled: true },
  page: { enabled: true, viewMode: 'dual' },
};

// ---------- 划词翻译阈值 ----------

export const SELECTION_MIN_LENGTH = 2;
export const SELECTION_MAX_LENGTH = 5000;
/** 清理路径（selectionchange）防抖 */
export const SELECTION_HIDE_DEBOUNCE_MS = 150;
/** 页面滚动超过该距离即隐藏浮层 */
export const SELECTION_HIDE_SCROLL_PX = 40;

// ---------- 整页翻译：文本块提取 ----------

export const BLOCK_MIN_LENGTH = 2;
export const BLOCK_MAX_LENGTH = 2000;
/** CJK 字符占比超过该值的块视为中文内容，跳过 */
export const CJK_RATIO_THRESHOLD = 0.5;

/** 整树剪枝的标签：命中则跳过整个子树 */
export const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'PRE',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'BUTTON',
  'SVG',
  'MATH',
  'IFRAME',
  'TEMPLATE',
]);

/**
 * 行内代码标签不参与整树剪枝（剪掉会造成聚合句子空洞），
 * 但若它们被 CSS 渲染为块级（如 <pre><code> 场景由 PRE 剪枝覆盖，
 * 或显式 display:block），仍按块级代码跳过。
 */
export const CONDITIONAL_CODE_TAGS = new Set(['CODE', 'KBD', 'SAMP']);

/** 块级标签白名单：判定优先走这里，computed display 兜底 */
export const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'UL',
  'OL',
  'DL',
  'BLOCKQUOTE',
  'DD',
  'DT',
  'TD',
  'TH',
  'FIGURE',
  'FIGCAPTION',
  'CAPTION',
  'SECTION',
  'ARTICLE',
  'ASIDE',
  'MAIN',
  'HEADER',
  'FOOTER',
  'NAV',
  'DETAILS',
  'SUMMARY',
  'LABEL',
  'FIELDSET',
  'LEGEND',
  'ADDRESS',
]);

// ---------- 整页翻译：批量与并发 ----------

export const MAX_ITEMS_PER_BATCH = 20;
export const MAX_CHARS_PER_BATCH = 3000;
export const MAX_CONCURRENCY = 3;
export const BATCH_TIMEOUT_MS = 30_000;
export const MAX_RETRIES = 2;

// ---------- SPA 增量监测 ----------

export const OBSERVER_DEBOUNCE_MS = 300;
/** 滚动补译的去抖 */
export const SCROLL_TRANSLATE_DEBOUNCE_MS = 200;
/**
 * 视口下沿再往下提前翻译的距离，按视口高度的比例。
 * 这样滚到下一段时请求已经发出，而不是整页一次翻完。
 */
export const VIEWPORT_LOOKAHEAD_RATIO = 0.5;

// ---------- 注入标记（data-uct-*） ----------

export const SRC_ID_ATTR = 'data-uct-src-id';
export const TARGET_ID_ATTR = 'data-uct-target-id';
export const HOST_CLASS = 'uct-host';
export const TARGET_CLASS = 'uct-tl';
