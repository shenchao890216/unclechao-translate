import { initSelectionDetector } from '@/content/selection/detector';
import { fillSelectionError, fillSelectionResult, insertSelectionPending } from '@/content/selection/inline';
import { createSelectionTranslateButton } from '@/content/selection/popup';
import { PageTranslationController } from '@/content/page-translate/page-controller';
import { toggleSettingsPanel } from '@/content/settings-panel';
import { initPageObserver } from '@/content/page-translate/observer';
import { isContentMessage, requestTranslateBatch } from '@/utils/messaging';
import { loadSettings, onSettingsChanged } from '@/utils/settings';
import type { Settings } from '@/utils/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  cssInjectionMode: 'ui',
  async main(ctx) {
    // 监听必须在任何 await 之前注册。划词浮层初始化若卡住，整页翻译按钮会完全没反应。
    let settings: Settings | undefined;
    const pageController = new PageTranslationController();
    browser.runtime.onMessage.addListener((msg) => {
      if (!isContentMessage(msg)) return;
      if (msg.type === 'TOGGLE_PAGE_TRANSLATE') {
        if (settings && !settings.page.enabled) return;
        pageController.toggle();
      } else if (msg.type === 'TOGGLE_SETTINGS') {
        toggleSettingsPanel();
      } else {
        pageController.setViewMode(msg.mode);
      }
    });

    settings = await loadSettings();
    pageController.setViewMode(settings.page.viewMode);
    const translateButton = await createSelectionTranslateButton(ctx, (target) => {
      const slot = insertSelectionPending(target.range);
      if (!slot) return;
      void (async () => {
        const response = await requestTranslateBatch([target.text]);
        if (!slot.isConnected) return;
        if (response.ok) {
          const result = response.results[0];
          if (result) {
            fillSelectionResult(slot, result);
          } else {
            fillSelectionError(slot, '翻译结果为空');
          }
        } else {
          fillSelectionError(slot, response.error.message);
        }
      })();
    });

    initSelectionDetector(ctx, {
      isEnabled: () => settings?.selection.enabled ?? false,
      isInsidePopup: (event) => translateButton.containsTarget(event),
      onHide: () => translateButton.hide(),
      onShow: (target) => translateButton.show(target),
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
      if (!next.page.enabled && pageController.isActive) {
        pageController.stop();
      }
    });
  },
});
