import { DEFAULT_SETTINGS } from './constants';
import type { Settings } from './types';

const STORAGE_KEY = 'settings';

/** 读取设置并与默认值深合并（容忍字段缺失，向后兼容） */
export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return deepMerge(DEFAULT_SETTINGS, stored[STORAGE_KEY] ?? {}) as Settings;
}

/** 部分更新设置（读取-合并-写回），支持嵌套对象的局部 patch */
export async function saveSettings(patch: DeepPartial<Settings>): Promise<void> {
  const current = await loadSettings();
  await browser.storage.local.set({ [STORAGE_KEY]: deepMerge(current, patch) });
}

/** 监听设置变化，返回取消监听函数 */
export function onSettingsChanged(cb: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, Browser.storage.StorageChange>,
    area: string,
  ) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      cb(deepMerge(DEFAULT_SETTINGS, changes[STORAGE_KEY].newValue ?? {}) as Settings);
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/**
 * 归一化 baseUrl：去尾斜杠；最后一段不是 v1/v4 等版本段则补 /v1。
 * 覆盖 https://api.deepseek.com → .../v1、http://localhost:11434 → .../v1 等写法。
 * 幂等，llm-client 请求前也会调用一次。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  try {
    const u = new URL(trimmed);
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (segments.length === 0 || !last || !/^v\d+$/.test(last)) {
      return `${trimmed}/v1`;
    }
  } catch {
    // 非法 URL 原样返回，由请求阶段报 NETWORK 错
  }
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : (patch as T));
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    result[key] =
      isPlainObject(value) && isPlainObject(result[key])
        ? deepMerge(result[key], value)
        : value;
  }
  return result as T;
}
