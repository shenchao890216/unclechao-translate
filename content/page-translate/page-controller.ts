import { SCROLL_TRANSLATE_DEBOUNCE_MS } from '@/utils/constants';
import type { TextBlock, ViewMode } from '@/utils/types';
import { extractBlocks } from './extractor';
import {
  applyViewMode,
  clearTranslations,
  hasRenderedTranslation,
  hidePageNotice,
  injectPageStyles,
  injectTranslation,
  showPageNotice,
  showTranslatingPlaceholder,
} from './injector';
import { scheduleTranslation } from './scheduler';
import { isInTranslatedRange } from './viewport';

/**
 * 整页翻译状态机：先译视口及其上方，其余随滚动补译。
 * session 会话号在 stop/restart 时递增，使在途调度自动失效。
 */
export class PageTranslationController {
  private blocks: TextBlock[] = [];
  private nextId = 1;
  private session = 0;
  private active = false;
  private viewMode: ViewMode = 'dual';
  /** 本轮会话已译过的原文。滚动把同一段 DOM 拆掉重建时直接复用，不再请求模型 */
  private cache = new Map<string, string>();
  private inflight = new Set<string>();
  /** 同一句已经在请求中时，后出现的宿主等结果回来再注入 */
  private waiters = new Map<string, TextBlock[]>();
  /** 当前还有几批视口翻译在请求，用于开关「正在翻译…」 */
  private noticeDepth = 0;
  private scrollTimer: number | undefined;
  private readonly onScroll = (): void => {
    window.clearTimeout(this.scrollTimer);
    this.scrollTimer = window.setTimeout(() => {
      if (!this.active) return;
      this.flushReached();
    }, SCROLL_TRANSLATE_DEBOUNCE_MS);
  };

  get isActive(): boolean {
    return this.active;
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    if (this.active) applyViewMode(mode);
  }

  toggle(): void {
    if (this.active) {
      this.stop();
    } else {
      void this.start();
    }
  }

  /** SPA 增量：新节点先入队，只有已经滚到视口附近的才翻译 */
  handleAddedNodes(nodes: Element[]): void {
    if (!this.active) return;
    const blocks = this.collectBlocks(nodes);
    if (blocks.length === 0) return;
    this.blocks.push(...blocks);
    this.flushReached();
  }

  /** 路径变化：清理后全量重提取。滚动和 hash 定位不会走到这里 */
  handleRouteSwitch(): void {
    if (!this.active) return;
    void this.start();
  }

  stop(): void {
    this.cache.clear();
    this.inflight.clear();
    this.waiters.clear();
    this.invalidate();
  }

  private invalidate(): void {
    this.session++;
    this.active = false;
    this.blocks = [];
    this.inflight.clear();
    this.waiters.clear();
    this.noticeDepth = 0;
    this.unbindScroll();
    clearTranslations();
  }

  private async start(): Promise<void> {
    this.invalidate(); // 清掉页面上的旧译文，但保留 cache，避免同一句再次请求
    this.active = true;

    injectPageStyles();
    applyViewMode(this.viewMode);
    this.bindScroll();

    const blocks = this.collectBlocks([document.body]);
    this.blocks = blocks;
    if (blocks.length === 0) {
      this.stop();
      showPageNotice('没有找到可翻译的外文。中文内容会跳过，代码块和隐藏区域也不会翻译。');
      return;
    }

    this.flushReached();
  }

  /** 把文档顶部到当前视口（再加一点提前量）之内、尚未翻译的块送出去 */
  private flushReached(): void {
    if (!this.active) return;
    const due: TextBlock[] = [];
    for (const block of this.blocks) {
      if (block.state !== 'pending') continue;
      if (!block.host.isConnected || !isInTranslatedRange(block.host)) continue;
      block.state = 'translating';
      due.push(block);
    }
    if (due.length === 0) return;
    void this.runTranslation(due, this.session);
  }

  private async runTranslation(blocks: TextBlock[], session: number): Promise<void> {
    const fresh = this.restoreCached(blocks);
    if (fresh.length === 0 || session !== this.session) return;

    this.noticeDepth++;
    if (this.noticeDepth === 1) showPageNotice('正在翻译…', true);
    for (const block of fresh) showTranslatingPlaceholder(block);
    try {
      await this.translate(fresh);
    } finally {
      if (session !== this.session) return;
      this.noticeDepth = Math.max(0, this.noticeDepth - 1);
      if (this.noticeDepth === 0) hidePageNotice();
    }
  }

  private bindScroll(): void {
    document.addEventListener('scroll', this.onScroll, { passive: true, capture: true });
    window.addEventListener('resize', this.onScroll, { passive: true });
  }

  private unbindScroll(): void {
    document.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onScroll);
    window.clearTimeout(this.scrollTimer);
  }

  private collectBlocks(roots: Element[]): TextBlock[] {
    const blocks: TextBlock[] = [];
    for (const root of roots) {
      const found = extractBlocks(root, this.nextId);
      this.nextId += found.length;
      blocks.push(...found);
    }
    return blocks;
  }

  /** 命中缓存的块立即注入，返回仍需请求模型的块 */
  private restoreCached(blocks: TextBlock[]): TextBlock[] {
    const fresh: TextBlock[] = [];
    for (const block of blocks) {
      if (!block.host.isConnected) {
        if (block.state === 'translating') block.state = 'pending';
        continue;
      }
      if (hasRenderedTranslation(block.host)) {
        block.state = 'done';
        continue;
      }
      const cached = this.cache.get(block.sourceText);
      if (cached) {
        block.state = 'done';
        block.translatedText = cached;
        injectTranslation(block, cached);
        continue;
      }
      if (this.inflight.has(block.sourceText)) {
        const waiting = this.waiters.get(block.sourceText) ?? [];
        waiting.push(block);
        this.waiters.set(block.sourceText, waiting);
        showTranslatingPlaceholder(block);
        continue;
      }
      this.inflight.add(block.sourceText);
      fresh.push(block);
    }
    return fresh;
  }

  private translate(blocks: TextBlock[]): Promise<void> {
    const currentSession = this.session;
    return scheduleTranslation(
      blocks,
      () => currentSession !== this.session,
      (source, translated) => {
        if (currentSession !== this.session) return;
        this.remember(source, translated);
      },
      (source) => {
        if (currentSession !== this.session) return;
        this.inflight.delete(source);
        const waiting = this.waiters.get(source) ?? [];
        this.waiters.delete(source);
        for (const block of waiting) {
          if (block.state === 'translating') block.state = 'pending';
        }
      },
    );
  }

  private remember(sourceText: string, translated: string): void {
    this.cache.set(sourceText, translated);
    this.inflight.delete(sourceText);
    const waiting = this.waiters.get(sourceText) ?? [];
    this.waiters.delete(sourceText);
    for (const block of waiting) {
      if (!block.host.isConnected || hasRenderedTranslation(block.host)) continue;
      block.state = 'done';
      block.translatedText = translated;
      injectTranslation(block, translated);
    }
  }
}
