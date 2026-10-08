import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'UncleChao Translate',
    description: '基于 LLM 的划词翻译、整页双语翻译与 YouTube 字幕翻译',
    permissions: ['storage', 'scripting', 'webNavigation'],
    host_permissions: ['<all_urls>'],
    web_accessible_resources: [
      {
        resources: ['sidepanel.html'],
        matches: ['<all_urls>'],
      },
    ],
    commands: {
      'toggle-page-translate': {
        suggested_key: { default: 'Alt+T' },
        description: '切换整页翻译',
      },
      'toggle-video-translate': {
        suggested_key: { default: 'Alt+V' },
        description: '翻译 YouTube 字幕',
      },
    },
  },
});
