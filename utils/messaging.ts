import type {
  ContentMessage,
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslateError,
} from './types';

/** content script → background：请求翻译一批文本（划词=单项数组，整页=N 项数组） */
export async function requestTranslateBatch(
  items: string[],
): Promise<TranslateBatchResponse> {
  const request: TranslateBatchRequest = { type: 'TRANSLATE_BATCH', items };
  try {
    const response = (await browser.runtime.sendMessage(request)) as
      | TranslateBatchResponse
      | undefined;
    if (!response) {
      return unknownError('background 无响应');
    }
    return response;
  } catch (err) {
    return unknownError(err instanceof Error ? err.message : String(err));
  }
}

/** 获取当前活动标签页。popup 打开时 currentWindow 有时不是网页所在窗口，故再试 lastFocusedWindow */
export async function getActiveTab(): Promise<Browser.tabs.Tab | undefined> {
  const [current] = await browser.tabs.query({ active: true, currentWindow: true });
  if (current?.id && current.url && !current.url.startsWith('chrome-extension://')) return current;
  const [focused] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return focused ?? current;
}

/** 向指定标签页的 content script 发消息，失败（如 chrome:// 页无 content script）返回 false */
export async function sendMessageToTab(
  tabId: number,
  message: ContentMessage,
): Promise<boolean> {
  try {
    await browser.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    return false;
  }
}

/** 向当前活动标签页发消息；页面里没有 content script 时补注入一次再重试 */
export async function sendToActiveTab(message: ContentMessage): Promise<boolean> {
  const tab = await getActiveTab();
  if (!tab?.id) return false;
  if (await sendMessageToTab(tab.id, message)) return true;
  if (!(await injectContentScript(tab.id))) return false;
  if (await sendMessageToTab(tab.id, message)) return true;
  // 脚本是异步启动的，监听器刚注册时再补一次
  await new Promise((resolve) => setTimeout(resolve, 150));
  return sendMessageToTab(tab.id, message);
}

/** 把 content script 注入到指定标签页（已打开的页面在扩展重载后常常没有脚本） */
export async function injectContentScript(tabId: number): Promise<boolean> {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/content.js'],
    });
    return true;
  } catch {
    return false;
  }
}

/** 判断是否为 background → content 的指令消息 */
export function isContentMessage(msg: unknown): msg is ContentMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const type = (msg as { type?: unknown }).type;
  if (type === 'TOGGLE_PAGE_TRANSLATE') return true;
  if (
    type === 'SET_VIEW_MODE' &&
    ['dual', 'source', 'target'].includes((msg as { mode?: unknown }).mode as string)
  ) {
    return true;
  }
  return false;
}

function unknownError(message: string): TranslateBatchResponse {
  const error: TranslateError = { code: 'UNKNOWN', message };
  return { ok: false, error };
}
