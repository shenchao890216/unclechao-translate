<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import { getActiveTab, sendToActiveTab } from '@/utils/messaging';
import { loadSettings, saveSettings } from '@/utils/settings';
import type { ViewMode } from '@/utils/types';
import { isYouTubeWatchUrl } from '@/utils/youtube';

const llmReady = ref(false);
const pageEnabled = ref(true);
const viewMode = ref<ViewMode>('dual');
const busy = ref(false);
const actionError = ref('');
const pageShortcut = ref('');
const videoShortcut = ref('');

const pageButtonLabel = computed(() =>
  busy.value ? '正在开启…' : withShortcut('切换整页翻译', pageShortcut.value),
);
const videoButtonLabel = computed(() => withShortcut('翻译 YouTube 字幕', videoShortcut.value));

const viewModes: { mode: ViewMode; label: string }[] = [
  { mode: 'dual', label: '双语' },
  { mode: 'source', label: '原文' },
  { mode: 'target', label: '译文' },
];

onMounted(async () => {
  const [settings, commands] = await Promise.all([loadSettings(), browser.commands.getAll()]);
  llmReady.value = Boolean(settings.llm.apiKey && settings.llm.model);
  pageEnabled.value = settings.page.enabled;
  viewMode.value = settings.page.viewMode;
  pageShortcut.value = shortcutOf(commands, 'toggle-page-translate');
  videoShortcut.value = shortcutOf(commands, 'toggle-video-translate');
});

function shortcutOf(commands: Browser.commands.Command[], name: string): string {
  const shortcut = commands.find((command) => command.name === name)?.shortcut ?? '';
  return shortcut.replaceAll('MacCtrl', 'Ctrl');
}

function withShortcut(label: string, shortcut: string): string {
  return shortcut ? `${label}（${shortcut}）` : label;
}

async function toggleVideoTranslate() {
  busy.value = true;
  actionError.value = '';
  const tab = await getActiveTab();
  if (!isYouTubeWatchUrl(tab?.url)) {
    busy.value = false;
    actionError.value = '请先打开一个 YouTube 视频页。';
    return;
  }
  const ok = await sendToActiveTab({ type: 'TOGGLE_VIDEO_TRANSLATE' });
  busy.value = false;
  if (!ok) {
    actionError.value = '当前页面没有注入翻译脚本。请刷新 YouTube 页面后再试。';
    return;
  }
  window.close();
}

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
  const ok = await sendToActiveTab({ type: 'TOGGLE_SETTINGS' });
  if (ok) {
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
        {{ pageButtonLabel }}
      </button>
      <button type="button" class="primary" :disabled="busy" @click="toggleVideoTranslate">
        {{ videoButtonLabel }}
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
  flex-direction: column;
  gap: 8px;
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
