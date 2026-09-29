import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'UncleChao Translate',
    description: '基于 LLM 的划词翻译与整页双语翻译插件',
    permissions: ['storage', 'scripting'],
    host_permissions: ['<all_urls>'],
    commands: {
      'toggle-page-translate': {
        suggested_key: { default: 'Alt+T' },
        description: '切换整页翻译',
      },
    },
  },
});
