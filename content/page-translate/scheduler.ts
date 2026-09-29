import { MAX_CHARS_PER_BATCH, MAX_CONCURRENCY, MAX_ITEMS_PER_BATCH, BLOCK_MAX_LENGTH } from '@/utils/constants';
import { requestTranslateBatch } from '@/utils/messaging';
import {
  hasRenderedTranslation,
  injectFailurePlaceholder,
  injectTranslation,
  showTranslatingPlaceholder,
} from './injector';
import type { TextBlock } from '@/utils/types';

/**
 * 分块翻译：切成批（≤20 条 / ≤3000 字符，超长块独立成批），
 * 同一轮只发一批；background 里还有全局排队，智谱免费接口批与批之间另留空档。
 * isCancelled 为真时不再发送后续批（响应到达的结果仍会渲染）。
 */
export async function scheduleTranslation(
  blocks: TextBlock[],
  isCancelled: () => boolean,
  onTranslated?: (sourceText: string, translated: string) => void,
  onFailed?: (sourceText: string) => void,
): Promise<void> {
  const batches = makeBatches(blocks);
  let index = 0;

  const workerCount = Math.min(MAX_CONCURRENCY, batches.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < batches.length) {
        if (isCancelled()) return;
        const batch = batches[index++];
        if (!batch) return;
        await translateOneBatch(batch, isCancelled, onTranslated, onFailed);
      }
    }),
  );
}

async function translateOneBatch(
  batch: TextBlock[],
  isCancelled: () => boolean,
  onTranslated?: (sourceText: string, translated: string) => void,
  onFailed?: (sourceText: string) => void,
): Promise<void> {
  for (const block of batch) {
    block.state = 'translating';
    showTranslatingPlaceholder(block);
  }
  const response = await requestTranslateBatch(batch.map((block) => block.sourceText));

  // 请求在途期间用户已关闭/重启翻译：丢弃结果，避免注入到已清理的页面
  if (isCancelled()) return;

  if (response.ok) {
    batch.forEach((block, i) => {
      const result = response.results[i];
      if (result) {
        block.state = 'done';
        block.translatedText = result;
        onTranslated?.(block.sourceText, result);
        if (!block.host.isConnected || hasRenderedTranslation(block.host)) return;
        injectTranslation(block, result);
      } else {
        block.state = 'failed';
        onFailed?.(block.sourceText);
        if (!block.host.isConnected || hasRenderedTranslation(block.host)) return;
        injectFailurePlaceholder(block, '返回结果缺失或为空');
      }
    });
  } else {
    for (const block of batch) {
      block.state = 'failed';
      onFailed?.(block.sourceText);
      if (!block.host.isConnected || hasRenderedTranslation(block.host)) continue;
      injectFailurePlaceholder(block, response.error.message);
    }
    console.debug('[uct] batch failed:', response.error.code, response.error.message);
  }
}

function makeBatches(blocks: TextBlock[]): TextBlock[][] {
  const batches: TextBlock[][] = [];
  let current: TextBlock[] = [];
  let chars = 0;

  const flush = () => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      chars = 0;
    }
  };

  for (const block of blocks) {
    if (block.sourceText.length > BLOCK_MAX_LENGTH) {
      flush();
      batches.push([block]); // 超长块独立成批
      continue;
    }
    if (
      current.length >= MAX_ITEMS_PER_BATCH ||
      chars + block.sourceText.length > MAX_CHARS_PER_BATCH
    ) {
      flush();
    }
    current.push(block);
    chars += block.sourceText.length;
  }
  flush();
  return batches;
}
