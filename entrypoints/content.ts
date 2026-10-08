import { YouTubeSubtitleController } from '@/content/video/youtube-controller';
import { initSelectionDetector } from '@/content/selection/detector';
import {
  applySelectionSourceMarks,
  captureSelectionSource,
  fillSelectionError,
  fillSelectionResult,
  insertSelectionPending,
  isAlreadyTranslatedSelection,
} from '@/content/selection/inline';
import { createSelectionTranslateButton } from '@/content/selection/popup';
import { PageTranslationController } from '@/content/page-translate/page-controller';
import { toggleSettingsPanel } from '@/content/settings-panel';
import { initPageObserver } from '@/content/page-translate/observer';
import { isContentMessage, requestTranslateBatch } from '@/utils/messaging';
import { loadSettings, onSettingsChanged } from '@/utils/settings';
import type { Settings } from '@/utils/types';
import { isDesktopYouTube } from '@/utils/youtube';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  cssInjectionMode: 'ui',
  async main(ctx) {
    // 广告和像素小框不翻译。Claude artifact 这类正文在跨域大 iframe 里。
    if (!isTranslatableFrame()) return;
    // 监听必须在任何 await 之前注册。划词浮层初始化若卡住，整页翻译按钮会完全没反应。
    let settings: Settings | undefined;
    const pageController = new PageTranslationController();
    const youtube = window.top === window && isDesktopYouTube() ? new YouTubeSubtitleController() : null;
    browser.runtime.onMessage.addListener((msg) => {
      if (!isContentMessage(msg)) return;
      if (msg.type === 'TOGGLE_PAGE_TRANSLATE') {
        if (settings && !settings.page.enabled) return;
        pageController.toggle();
      } else if (msg.type === 'TOGGLE_VIDEO_TRANSLATE') {
        youtube?.toggle();
      } else if (msg.type === 'TOGGLE_SETTINGS') {
        toggleSettingsPanel();
      } else {
        pageController.setViewMode(msg.mode);
        youtube?.setViewMode(msg.mode);
      }
    });

    settings = await loadSettings();
    pageController.setViewMode(settings.page.viewMode);
    youtube?.setViewMode(settings.page.viewMode);
    const translateButton = await createSelectionTranslateButton(ctx, (target) => {
      if (isAlreadyTranslatedSelection(target.range)) return;
      const slices = captureSelectionSource(target.range);
      pageController.holdSelection(target.text);
      const slot = insertSelectionPending(target.range);
      if (!slot) {
        pageController.releaseSelection(target.text);
        return;
      }
      void (async () => {
        const response = await requestTranslateBatch([target.text]);
        if (!slot.isConnected) {
          pageController.releaseSelection(target.text);
          return;
        }
        if (response.ok) {
          const result = response.results[0];
          if (result) {
            fillSelectionResult(slot, result);
            applySelectionSourceMarks(slices);
            pageController.finishSelection(target.text);
          } else {
            fillSelectionError(slot, '翻译结果为空');
            pageController.releaseSelection(target.text);
          }
        } else {
          fillSelectionError(slot, response.error.message);
          pageController.releaseSelection(target.text);
        }
      })();
    });

    initSelectionDetector(ctx, {
      isEnabled: () => settings?.selection.enabled ?? false,
      isInsidePopup: (event) => translateButton.containsTarget(event),
      onHide: () => translateButton.hide(),
      onShow: (target) => {
        if (isAlreadyTranslatedSelection(target.range)) {
          translateButton.hide();
          return;
        }
        translateButton.show(target);
      },
    });

    // ---------- SPA 增量翻译 ----------
    initPageObserver(ctx, {
      isActive: () => pageController.isActive,
      onAddedNodes: (nodes) => pageController.handleAddedNodes(nodes),
      onRouteSwitch: () => pageController.handleRouteSwitch(),
    });

    // ---------- 设置热更新：开关与视图模式即时生效 ----------
    onSettingsChanged((next) => {
      settings = next;
      pageController.setViewMode(next.page.viewMode);
      youtube?.setViewMode(next.page.viewMode);
      if (!next.page.enabled && pageController.isActive) {
        pageController.stop();
      }
    });
  },
});

/** 顶层页面，或足够大的内容 iframe。小于这个尺寸的多半是广告和统计像素。 */
function isTranslatableFrame(): boolean {
  if (window.top === window) return true;
  const width = Math.max(window.innerWidth, document.documentElement?.clientWidth ?? 0);
  const height = Math.max(window.innerHeight, document.documentElement?.clientHeight ?? 0);
  return width >= 480 && height >= 240;
}
