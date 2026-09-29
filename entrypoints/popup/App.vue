<script lang="ts" setup>
import { onMounted, ref } from 'vue';
import { sendToActiveTab } from '@/utils/messaging';
import { loadSettings, saveSettings } from '@/utils/settings';
import type { ViewMode } from '@/utils/types';

const llmReady = ref(false);
const pageEnabled = ref(true);
const viewMode = ref<ViewMode>('dual');
const busy = ref(false);
const actionError = ref('');

const viewModes: { mode: ViewMode; label: string }[] = [
  { mode: 'dual', label: '双语' },
  { mode: 'source', label: '原文' },
  { mode: 'target', label: '译文' },
];

onMounted(async () => {
  const settings = await loadSettings();
  llmReady.value = Boolean(settings.llm.apiKey && settings.llm.model);
  pageEnabled.value = settings.page.enabled;
  viewMode.value = settings.page.viewMode;
});

async function togglePageTranslate() {
  busy.value = true;
  actionError.value = '';
  const ok = await sendToActiveTab({ type: 'TOGGLE_PAGE_TRANSLATE' });
  busy.value = false;
  if (!ok) {
    actionError.value = '当前页面没有注入翻译脚本。请刷新页面后再试；浏览器内置页面无法翻译。';
    return;
  }
  window.close();
}

async function setViewMode(mode: ViewMode) {
  viewMode.value = mode;
  await sendToActiveTab({ type: 'SET_VIEW_MODE', mode });
  await saveSettings({ page: { viewMode: mode } });
}

async function openOptions() {
  const current = await browser.windows.getCurrent();
  const sidePanel = (globalThis as { chrome?: { sidePanel?: { open: (options: { windowId: number }) => Promise<void> } } }).chrome?.sidePanel;
  if (current.id != null && sidePanel) {
    await sidePanel.open({ windowId: current.id });
    window.close();
    return;
  }
  await browser.runtime.openOptionsPage();
}
</script>

<template>
  <div class="popup">
    <header>
      <span class="title">UncleChao Translate</span>
      <button type="button" class="link" @click="openOptions">设置</button>
    </header>

    <div v-if="!llmReady" class="warning">
      尚未配置 API Key，
      <button type="button" class="link" @click="openOptions">去设置</button>
    </div>

    <div class="actions">
      <button
        type="button"
        class="primary"
        :disabled="busy || !pageEnabled"
        :title="pageEnabled ? undefined : '整页翻译已在设置中关闭'"
        @click="togglePageTranslate"
      >
        {{ busy ? '正在开启…' : '切换整页翻译（Alt+T）' }}
      </button>
    </div>
    <div v-if="actionError" class="error">{{ actionError }}</div>

    <div class="row">
      <span class="row-label">视图</span>
      <div class="seg">
        <button
          v-for="{ mode, label } in viewModes"
          :key="mode"
          type="button"
          :class="['seg-btn', { active: viewMode === mode }]"
          @click="setViewMode(mode)"
        >
          {{ label }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.popup {
  width: 320px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.title {
  font-size: 14px;
  font-weight: 600;
}
.link {
  border: none;
  background: none;
  color: #4f7cff;
  cursor: pointer;
  font-size: 13px;
  padding: 0;
}
.warning {
  font-size: 13px;
  color: #b45309;
  background: #fef3c7;
  border-radius: 6px;
  padding: 8px 10px;
}
.actions {
  display: flex;
}
.primary {
  flex: 1;
  background: #4f7cff;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 0;
  font-size: 13px;
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.6;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.row-label {
  font-size: 13px;
  color: #6b7280;
}
.seg {
  display: flex;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  overflow: hidden;
  flex: 1;
}
.seg-btn {
  flex: 1;
  border: none;
  background: #fff;
  padding: 6px 0;
  font-size: 12px;
  cursor: pointer;
  color: #374151;
}
.seg-btn + .seg-btn {
  border-left: 1px solid #d0d7de;
}
.seg-btn.active {
  background: #4f7cff;
  color: #fff;
}
.error {
  font-size: 12px;
  color: #dc2626;
  background: #fef2f2;
  border-radius: 6px;
  padding: 8px 10px;
}
</style>
