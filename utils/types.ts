/** 三种整页视图：双语对照 / 仅原文 / 仅译文 */
export type ViewMode = 'dual' | 'source' | 'target';

export interface LlmSettings {
  /** OpenAI 兼容端点，如 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 按服务商记住的 Key。切换服务时换上，不冲掉另一家已经填过的 */
  keys?: Record<string, string>;
  /** 按服务商记住的模型，切回来时还停在上次选的那个 */
  modelByProvider?: Record<string, string>;
}

export interface Settings {
  version: number;
  llm: LlmSettings;
  /** 目标语言显示名，直接拼入 system prompt，如「中文」 */
  targetLang: string;
  selection: { enabled: boolean };
  page: { enabled: boolean; viewMode: ViewMode };
}

// ---------- 消息协议 ----------

export type TranslateErrorCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'NETWORK'
  | 'PARSE'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface TranslateError {
  code: TranslateErrorCode;
  message: string;
  /** 服务端 Retry-After，毫秒。仅限流时可能有 */
  retryAfterMs?: number;
}

/** content → background：划词（单项数组）与整页（N 项数组）统一走此协议 */
export interface TranslateBatchRequest {
  type: 'TRANSLATE_BATCH';
  items: string[];
}

/** results 与 items 等长对齐，null 表示该条失败（降级显示） */
export type TranslateBatchResponse =
  | { ok: true; results: (string | null)[] }
  | { ok: false; error: TranslateError };

/** background → content：来自快捷键 / popup */
export type ContentMessage =
  | { type: 'TOGGLE_PAGE_TRANSLATE' }
  | { type: 'TOGGLE_SETTINGS' }
  | { type: 'SET_VIEW_MODE'; mode: ViewMode };

// ---------- 整页翻译 ----------

/** 一个可翻译文本块 */
export interface TextBlock {
  id: number;
  /** 译文注入位置的参照元素（原块宿主） */
  host: HTMLElement;
  sourceText: string;
  state: 'pending' | 'translating' | 'done' | 'failed';
  translatedText?: string;
}
