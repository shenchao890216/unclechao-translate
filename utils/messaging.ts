import type {
  ContentMessage,
  FetchYouTubeCaptionsRequest,
  FetchYouTubeCaptionsResponse,
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslateError,
  TranslateKind,
} from './types';

/**
 * 同一时间只允许一条翻译消息在途。
 * 视口和滚动会并行发起多批，后台若排队再回复，Chrome 会先关掉还在等的通道，
 * 整批目录项就都显示 “message channel closed”。
 */
let translateTail: Promise<unknown> = Promise.resolve();

/** content script → background：请求翻译一批文本（划词=单项数组，整页=N 项数组） */
export function requestTranslateBatch(
  items: string[],
  kind: TranslateKind = 'page',
): Promise<TranslateBatchResponse> {
  const run = translateTail.then(() => sendTranslateBatch(items, kind));
  translateTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 网页字幕地址是空的，改由 background 下载可用正文 */
export async function requestYouTubeCaptions(
  videoId: string,
  languageCode: string,
): Promise<FetchYouTubeCaptionsResponse> {
  let lastMessage = 'background 无响应';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const request: FetchYouTubeCaptionsRequest = {
        type: 'FETCH_YOUTUBE_CAPTIONS',
        videoId,
        languageCode,
      };
      const response = (await browser.runtime.sendMessage(request)) as
        | FetchYouTubeCaptionsResponse
        | undefined;
      if (!response) return { ok: false, error: 'background 无响应' };
      return response;
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
      if (attempt === 0 && isClosedChannel(lastMessage)) continue;
      return { ok: false, error: lastMessage };
    }
  }
  return { ok: false, error: lastMessage };
}

async function sendTranslateBatch(
  items: string[],
  kind: TranslateKind,
): Promise<TranslateBatchResponse> {
  let lastMessage = 'background 无响应';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const request: TranslateBatchRequest = { type: 'TRANSLATE_BATCH', items, kind };
      const response = (await browser.runtime.sendMessage(request)) as
        | TranslateBatchResponse
        | undefined;
      if (!response) return unknownError('background 无响应');
      return response;
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
      if (attempt === 0 && isClosedChannel(lastMessage)) continue;
      return unknownError(lastMessage);
    }
  }
  return unknownError(lastMessage);
}

/** 服务工作线程刚被唤醒，或上一条回复太慢时，Chrome 会丢弃这条异步通道 */
function isClosedChannel(message: string): boolean {
  return /message channel closed|asynchronous response by returning true|receiving end does not exist/i.test(
    message,
  );
}

/** 获取当前活动标签页。popup 打开时 currentWindow 有时不是网页所在窗口，故再试 lastFocusedWindow */
export async function getActiveTab(): Promise<Browser.tabs.Tab | undefined> {
  const [current] = await browser.tabs.query({ active: true, currentWindow: true });
  if (current?.id && current.url && !current.url.startsWith('chrome-extension://')) return current;
  const [focused] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return focused ?? current;
}

/** 整页翻译要进到正文 iframe；设置和字幕只作用于顶层页面 */
function reachesEveryFrame(message: ContentMessage): boolean {
  return message.type === 'TOGGLE_PAGE_TRANSLATE' || message.type === 'SET_VIEW_MODE';
}

/** 向指定标签页的 content script 发消息，失败（如 chrome:// 页无 content script）返回 false */
export async function sendMessageToTab(
  tabId: number,
  message: ContentMessage,
): Promise<boolean> {
  return sendMessageToFrame(tabId, message, 0);
}

async function sendMessageToFrame(
  tabId: number,
  message: ContentMessage,
  frameId: number,
): Promise<boolean> {
  try {
    await browser.tabs.sendMessage(tabId, message, { frameId });
    return true;
  } catch {
    return false;
  }
}

/** 向当前活动标签页发消息；页面里没有 content script 时补注入一次再重试 */
export async function sendToActiveTab(message: ContentMessage): Promise<boolean> {
  const tab = await getActiveTab();
  if (!tab?.id) return false;
  const frameIds = reachesEveryFrame(message) ? await listFrameIds(tab.id) : [0];
  return deliverToFrames(tab.id, message, frameIds);
}

async function deliverToFrames(
  tabId: number,
  message: ContentMessage,
  frameIds: number[],
): Promise<boolean> {
  const results = await Promise.all(frameIds.map((frameId) => sendMessageToFrame(tabId, message, frameId)));
  const missing = frameIds.filter((_, index) => !results[index]);
  if (missing.length === 0) return true;
  if (!(await injectContentScript(tabId, missing))) return results.some(Boolean);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const retried = await Promise.all(missing.map((frameId) => sendMessageToFrame(tabId, message, frameId)));
  return results.some(Boolean) || retried.some(Boolean);
}

async function listFrameIds(tabId: number): Promise<number[]> {
  try {
    const frames = await browser.webNavigation.getAllFrames({ tabId });
    const ids = (frames ?? []).map((frame) => frame.frameId);
    return ids.length > 0 ? ids : [0];
  } catch {
    return [0];
  }
}

/** 把 content script 注入到指定框架（已打开的页面在扩展重载后常常没有脚本） */
export async function injectContentScript(tabId: number, frameIds: number[] = [0]): Promise<boolean> {
  try {
    await browser.scripting.executeScript({
      target: { tabId, frameIds },
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
  if (
    type === 'TOGGLE_PAGE_TRANSLATE' ||
    type === 'TOGGLE_VIDEO_TRANSLATE' ||
    type === 'TOGGLE_SETTINGS'
  ) {
    return true;
  }
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
