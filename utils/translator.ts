import { BATCH_TIMEOUT_MS, MAX_RETRIES } from './constants';
import { chatCompletion, isRetryable, LlmRequestError, toTranslateError } from './llm-client';
import type { Settings, TranslateError } from './types';

/**
 * 翻译一批文本（≤ MAX_ITEMS_PER_BATCH 条），返回与 items 等长的结果数组。
 * 单条解析失败为 null；整批失败（重试耗尽）抛 LlmRequestError。
 * 仅在 background 中调用。
 */
export async function translateBatch(
  items: string[],
  settings: Settings,
): Promise<(string | null)[]> {
  const messages = [
    { role: 'system' as const, content: buildSystemPrompt(settings.targetLang) },
    { role: 'user' as const, content: JSON.stringify(items) },
  ];

  let lastError: TranslateError = { code: 'UNKNOWN', message: '未知错误' };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS);
    try {
      const raw = await chatCompletion(settings.llm, messages, controller.signal);
      const parsed = parseArrayResponse(raw);
      if (parsed === null) {
        lastError = { code: 'PARSE', message: '返回内容无法解析为 JSON 数组' };
      } else if (parsed.length < items.length) {
        lastError = {
          code: 'PARSE',
          message: `返回条数不足（${parsed.length}/${items.length}）`,
        };
      } else {
        return alignResults(parsed.slice(0, items.length));
      }
    } catch (err) {
      lastError = toTranslateError(err);
      if (!isRetryable(err)) {
        throw err instanceof LlmRequestError ? err : new LlmRequestError(lastError.code, lastError.message);
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt < MAX_RETRIES) {
      await delay(backoffMs(attempt));
    }
  }
  throw new LlmRequestError(lastError.code, lastError.message);
}

/** 解析失败 / 网络 / 限流 / 超时重试：500ms、2s，带随机抖动 */
function backoffMs(attempt: number): number {
  return (500 * 4 ** attempt) + Math.floor(Math.random() * 250);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSystemPrompt(targetLang: string): string {
  return [
    `你是一个精确的机器翻译引擎。用户会发送一个 JSON 字符串数组，请把每个元素翻译成${targetLang}。`,
    '严格遵守：',
    '1. 只输出 JSON 数组本身，不要 markdown 代码块，不要任何解释或前后缀文字。',
    '2. 输出数组的长度和顺序必须与输入完全一致。',
    '3. 每个元素独立翻译，不要合并、拆分、增删内容。',
    '4. URL、邮箱、数字、代码片段、命令行、HTML 标签、变量名、专有名词保持原样不译。',
    '5. 保留元素内的换行符和空格。',
    `6. 若某元素已是${targetLang}或无实际语义，原样返回。`,
  ].join('\n');
}

/**
 * JSON 容错解析管线：
 * 1) 剥除 ```json 围栏 2) JSON.parse 3) 正则提取最外层 [...] 4) 按行拆分兜底
 */
function parseArrayResponse(raw: string): unknown[] | null {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return value;
  } catch {
    // 继续后续容错
  }

  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const value = JSON.parse(match[0]);
      if (Array.isArray(value)) return value;
    } catch {
      // 继续后续容错
    }
  }

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : null;
}

/** 非字符串或空字符串的条目置 null（降级显示"翻译失败"） */
function alignResults(parsed: unknown[]): (string | null)[] {
  return parsed.map((item) =>
    typeof item === 'string' && item.trim().length > 0 ? item : null,
  );
}
