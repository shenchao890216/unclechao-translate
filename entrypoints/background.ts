import { sendToActiveTab } from '@/utils/messaging';
import { loadSettings } from '@/utils/settings';
import { translateBatch } from '@/utils/translator';
import { LlmRequestError } from '@/utils/llm-client';
import type { TranslateBatchRequest } from '@/utils/types';

export default defineBackground(() => {
  // content script 的翻译请求：每批一次短事务，SW 按需唤醒
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isTranslateBatchRequest(msg)) return;
    handleTranslateBatch(msg.items)
      .then((results) => sendResponse({ ok: true, results }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error:
            err instanceof LlmRequestError
              ? { code: err.code, message: err.message }
              : { code: 'UNKNOWN', message: String(err) },
        }),
      );
    return true; // 保持通道开放，等待异步 sendResponse
  });

  // Alt+T：转发给活动标签页的 content script（chrome:// 页无 content script，静默失败）
  browser.commands.onCommand.addListener((command) => {
    if (command === 'toggle-page-translate') {
      void sendToActiveTab({ type: 'TOGGLE_PAGE_TRANSLATE' });
    }
  });
});

function isTranslateBatchRequest(msg: unknown): msg is TranslateBatchRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'TRANSLATE_BATCH' &&
    Array.isArray((msg as { items?: unknown }).items)
  );
}

/** 智谱免费模型限流严，批与批之间留空档。小米等付费接口不插入这段等待。 */
const FREE_TIER_GAP_MS = 2_000;
let requestChain: Promise<void> = Promise.resolve();
let notBefore = 0;

function requestGapMs(baseUrl: string): number {
  return /open\.bigmodel\.cn/i.test(baseUrl) ? FREE_TIER_GAP_MS : 0;
}

function enqueue<T>(gapMs: number, task: () => Promise<T>): Promise<T> {
  const job = requestChain.then(async () => {
    const wait = notBefore - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await task();
    } finally {
      if (gapMs > 0) notBefore = Math.max(notBefore, Date.now() + gapMs);
    }
  });
  requestChain = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

async function handleTranslateBatch(items: string[]) {
  const settings = await loadSettings();
  if (!settings.llm.apiKey || !settings.llm.model) {
    throw new LlmRequestError('AUTH', '请先在设置页配置 API Key 和模型');
  }
  return enqueue(requestGapMs(settings.llm.baseUrl), () =>
    keepWorkerAlive(() => translateBatch(items, settings)),
  );
}

/** 外部 fetch 不算扩展 API，服务工作线程可能在回复前被挂起，通道随之关闭 */
function keepWorkerAlive<T>(task: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    void browser.runtime.getPlatformInfo();
  }, 15_000);
  return task().finally(() => clearInterval(timer));
}
