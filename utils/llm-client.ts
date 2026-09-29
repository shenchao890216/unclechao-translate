import { normalizeBaseUrl } from './settings';
import type { LlmSettings, TranslateErrorCode, TranslateError } from './types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class LlmRequestError extends Error {
  readonly code: TranslateErrorCode;

  constructor(code: TranslateErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'LlmRequestError';
  }
}

export function toTranslateError(err: unknown): TranslateError {
  if (err instanceof LlmRequestError) {
    return { code: err.code, message: err.message };
  }
  return { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) };
}

/** AUTH 之外的错误（网络 / 429 / 5xx / 解析 / 超时）都值得重试 */
export function isRetryable(err: unknown): boolean {
  return !(err instanceof LlmRequestError && err.code === 'AUTH');
}

/**
 * 调用 OpenAI 兼容 /chat/completions，返回首条回复文本。
 * 必须在 background service worker 中调用（host_permissions 提供跨域能力）。
 */
export async function chatCompletion(
  llm: LlmSettings,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const url = `${normalizeBaseUrl(llm.baseUrl)}/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        temperature: 0.2,
        stream: false,
        messages,
      }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) {
      throw new LlmRequestError('TIMEOUT', '请求超时');
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new LlmRequestError('NETWORK', `网络请求失败：${reason}`);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new LlmRequestError('AUTH', 'API Key 无效或无权限');
    }
    if (response.status === 429) {
      throw new LlmRequestError('RATE_LIMIT', '请求过于频繁，请稍后重试');
    }
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      // 忽略错误体读取失败
    }
    throw new LlmRequestError('UNKNOWN', `服务返回 ${response.status}${detail ? `：${detail}` : ''}`);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new LlmRequestError('PARSE', '响应不是合法 JSON');
  }
  const content = (data as { choices?: { message?: { content?: unknown } }[] })
    ?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new LlmRequestError('PARSE', '响应缺少 choices[0].message.content');
  }
  return content;
}
