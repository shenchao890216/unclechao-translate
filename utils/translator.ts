import { BATCH_TIMEOUT_MS, MAX_RETRIES, RATE_LIMIT_RETRIES } from './constants';
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
  kind: 'page' | 'subtitle' = 'page',
): Promise<(string | null)[]> {
  const systemPrompt =
    kind === 'subtitle'
      ? buildSubtitleSystemPrompt(settings.targetLang)
      : buildSystemPrompt(settings.targetLang);
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: JSON.stringify(items) },
  ];

  let lastError: TranslateError = { code: 'UNKNOWN', message: '未知错误' };
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
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
    const retries = lastError.code === 'RATE_LIMIT' ? RATE_LIMIT_RETRIES : MAX_RETRIES;
    if (attempt < retries) {
      await delay(backoffMs(attempt, lastError));
    } else {
      break;
    }
  }
  throw new LlmRequestError(lastError.code, lastError.message);
}

/** 普通错误 500ms、2s。限流从 6 秒起翻倍，并尊重服务端 Retry-After */
function backoffMs(attempt: number, error: TranslateError): number {
  const base =
    error.code === 'RATE_LIMIT' ? 6_000 * 2 ** attempt : 500 * 4 ** attempt;
  const jitter = Math.floor(Math.random() * 400);
  return Math.max(base + jitter, error.retryAfterMs ?? 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 连续口播：条数不能并，但术语和人称要前后一致 */
function buildSubtitleSystemPrompt(targetLang: string): string {
  return [
    `你是视频字幕翻译。用户会发送按播放顺序排列的 JSON 字符串数组，请把每句口播翻译成${targetLang}。`,
    '严格遵守：',
    '1. 只输出 JSON 数组本身，不要 markdown 代码块，不要任何解释或前后缀文字。',
    '2. 输出数组的长度和顺序必须与输入完全一致。',
    '3. 每句单独对应一条译文，不要合并或拆分。前后句的术语、人称保持一致。',
    '4. 译文要像字幕：短、口语、能跟上语速。不要补充原文没有的解释。',
    '5. 人名和专有名词可保留原文或用通用译名，同一批内必须统一。',
    '6. 纯音乐、掌声等无对白标记（如 [Music]）原样返回。',
    `7. 若某句已是${targetLang}，原样返回。`,
  ].join('\n');
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
