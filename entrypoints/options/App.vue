<script lang="ts" setup>
import { computed, onMounted, reactive, ref } from 'vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import { loadSettings, normalizeBaseUrl, saveSettings } from '@/utils/settings';
import type { Settings } from '@/utils/types';

const form = reactive({
  baseUrl: '',
  apiKey: '',
  model: '',
  targetLang: '',
  selectionEnabled: true,
  pageEnabled: true,
});

const saving = ref(false);
const tip = ref('');
const saveError = ref('');

interface ModelChoice {
  id: string;
  note?: string;
}

interface ProviderChoice {
  id: string;
  name: string;
  baseUrl: string;
  needsKey: boolean;
  models: ModelChoice[];
}

const providers: ProviderChoice[] = [
  {
    id: 'mimo',
    name: '小米 MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    needsKey: true,
    models: [
      { id: 'mimo-v2.6-flash', note: '推荐' },
      { id: 'mimo-v2.6-pro' },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    needsKey: true,
    models: [
      { id: 'glm-4.7-flash', note: '免费' },
      { id: 'glm-4-flash' },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    needsKey: true,
    models: [
      { id: 'deepseek-flash' },
      { id: 'deepseek-v4-pro' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    needsKey: true,
    models: [
      { id: 'gpt-4o-mini' },
      { id: 'gpt-4o' },
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    needsKey: true,
    models: [
      { id: 'kimi-k2.6' },
      { id: 'moonshot-v1-8k' },
      { id: 'moonshot-v1-32k' },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama 本地',
    baseUrl: 'http://localhost:11434',
    needsKey: false,
    models: [],
  },
];

const providerId = ref(providers[0].id);
const customModel = ref(false);
const keyring: Record<string, string> = {};
const modelByProvider: Record<string, string> = {};

const activeProvider = computed(() => providers.find((item) => item.id === providerId.value));
const showModelInput = computed(
  () => providerId.value === 'custom' || customModel.value || (activeProvider.value?.models.length ?? 0) === 0,
);

onMounted(async () => {
  const settings: Settings = await loadSettings();
  form.baseUrl = settings.llm.baseUrl;
  form.apiKey = settings.llm.apiKey;
  form.model = settings.llm.model;
  form.targetLang = settings.targetLang;
  form.selectionEnabled = settings.selection.enabled;
  form.pageEnabled = settings.page.enabled;
  Object.assign(keyring, settings.llm.keys ?? {});
  Object.assign(modelByProvider, settings.llm.modelByProvider ?? {});
  syncProviderFromUrl();
  rememberCurrentKey();
  rememberModel();
});

async function save() {
  saving.value = true;
  saveError.value = '';
  rememberCurrentKey();
  rememberModel();
  try {
    await saveSettings({
      llm: {
        baseUrl: normalizeBaseUrl(form.baseUrl),
        apiKey: form.apiKey.trim(),
        model: form.model.trim(),
        keys: { ...keyring, [providerId.value]: form.apiKey.trim() },
        modelByProvider: { ...modelByProvider },
      },
      targetLang: form.targetLang.trim() || '中文',
      selection: { enabled: form.selectionEnabled },
      page: { enabled: form.pageEnabled },
    });
    flash('已保存');
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

function rememberCurrentKey() {
  keyring[providerId.value] = form.apiKey.trim();
}

function rememberModel() {
  const model = form.model.trim();
  if (model) modelByProvider[providerId.value] = model;
}

function syncProviderFromUrl() {
  const matched = providers.find((item) => normalizeBaseUrl(item.baseUrl) === normalizeBaseUrl(form.baseUrl));
  providerId.value = matched?.id ?? 'custom';
  const known = matched?.models.some((item) => item.id === form.model) ?? false;
  customModel.value = Boolean(matched && matched.models.length > 0 && !known);
}

function onProviderChange(event: Event) {
  const next = (event.target as HTMLSelectElement).value;
  rememberCurrentKey();
  rememberModel();
  providerId.value = next;
  const provider = providers.find((item) => item.id === next);
  if (!provider) return;
  form.baseUrl = provider.baseUrl;
  form.apiKey = keyring[next] ?? '';
  const remembered = modelByProvider[next];
  if (provider.models.length === 0) {
    form.model = remembered ?? '';
    customModel.value = true;
  } else if (remembered && provider.models.some((item) => item.id === remembered)) {
    form.model = remembered;
    customModel.value = false;
  } else if (remembered) {
    form.model = remembered;
    customModel.value = true;
  } else {
    form.model = provider.models[0].id;
    customModel.value = false;
  }
  void persistLlm(`已切换到${provider.name}`);
}

function pickModel(model: ModelChoice) {
  customModel.value = false;
  form.model = model.id;
  void persistLlm(`已切换为 ${model.id}`);
}

function useOtherModel() {
  customModel.value = true;
}

function isModelOn(id: string) {
  return !customModel.value && form.model === id;
}

async function persistLlm(message: string) {
  rememberCurrentKey();
  rememberModel();
  saveError.value = '';
  try {
    await saveSettings({
      llm: {
        baseUrl: normalizeBaseUrl(form.baseUrl),
        apiKey: form.apiKey.trim(),
        model: form.model.trim(),
        keys: { ...keyring },
        modelByProvider: { ...modelByProvider },
      },
    });
    form.baseUrl = normalizeBaseUrl(form.baseUrl);
    flash(message);
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
  }
}

function flash(message: string) {
  tip.value = message;
  window.setTimeout(() => {
    if (tip.value === message) tip.value = '';
  }, 2000);
}

/** 侧边栏顶栏已经显示扩展名，页内不再重复标题。embed 是嵌在网页右侧的白栏 */
const inSidePanel = location.pathname.endsWith('sidepanel.html');
const embedded = new URLSearchParams(location.search).has('embed');
if (embedded) document.documentElement.dataset.uctEmbed = '1';
</script>

<template>
  <div class="panel" :class="{ docked: inSidePanel, embed: embedded }">
    <header v-if="!inSidePanel" class="head">
      <h1>设置</h1>
    </header>

    <div class="body">
      <section class="section">
        <h2>翻译服务</h2>
        <label class="field">
          <span class="field-label">服务</span>
          <select class="select" :value="providerId" @change="onProviderChange">
            <option v-for="provider in providers" :key="provider.id" :value="provider.id">
              {{ provider.name }}
            </option>
            <option value="custom">自定义</option>
          </select>
        </label>

        <div v-if="activeProvider && activeProvider.models.length" class="models">
          <span class="field-label">模型</span>
          <button
            v-for="model in activeProvider.models"
            :key="model.id"
            type="button"
            :class="['model', { on: isModelOn(model.id) }]"
            :aria-pressed="isModelOn(model.id)"
            @click="pickModel(model)"
          >
            <span class="model-id">{{ model.id }}</span>
            <span v-if="model.note" class="note">{{ model.note }}</span>
          </button>
          <button type="button" :class="['model', { on: customModel }]" :aria-pressed="customModel" @click="useOtherModel">
            其他模型
          </button>
        </div>

        <label v-if="providerId === 'custom'" class="field">
          <span class="field-label">API 地址</span>
          <input v-model="form.baseUrl" type="text" placeholder="https://open.bigmodel.cn/api/paas/v4" spellcheck="false" />
          <span class="hint">末尾会自动补 /v1；Ollama 填 http://localhost:11434</span>
        </label>

        <label v-if="showModelInput" class="field">
          <span class="field-label">模型名称</span>
          <input
            v-model="form.model"
            type="text"
            :placeholder="activeProvider?.id === 'ollama' ? 'qwen2.5:7b' : 'mimo-v2.6-flash'"
            spellcheck="false"
            @change="persistLlm('已保存模型')"
          />
          <span v-if="activeProvider?.id === 'ollama'" class="hint">填本机已经 pull 过的模型名</span>
        </label>

        <label v-if="activeProvider?.needsKey !== false" class="field">
          <span class="field-label">API Key</span>
          <input v-model="form.apiKey" type="password" placeholder="sk-..." spellcheck="false" autocomplete="off" />
          <span class="hint">只存在这台浏览器里。换服务时会记住各自的 Key</span>
        </label>
      </section>

      <section class="section">
        <h2>翻译行为</h2>
        <label class="field">
          <span class="field-label">目标语言</span>
          <input v-model="form.targetLang" type="text" placeholder="中文" />
          <span class="hint">写进提示词，如「中文」「English」</span>
        </label>

        <div class="toggles">
          <ToggleSwitch v-model="form.selectionEnabled" label="划词翻译" />
          <ToggleSwitch v-model="form.pageEnabled" label="整页翻译" />
        </div>
      </section>
    </div>

    <footer class="foot">
      <button type="button" class="primary" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
      <span v-if="tip" class="tip ok">{{ tip }}</span>
      <span v-if="saveError" class="tip err">{{ saveError }}</span>
    </footer>
  </div>
</template>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
}
body {
  background: #e7eaef;
  color: #1f2328;
  font-family: system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
html[data-uct-embed],
html[data-uct-embed] body {
  background: #fff;
}
</style>

<style scoped>
.panel {
  margin-left: auto;
  width: min(380px, 100%);
  height: 100%;
  background: #fff;
  border-left: 1px solid #e5e7eb;
  box-shadow: -12px 0 28px rgba(15, 23, 42, 0.06);
  display: flex;
  flex-direction: column;
}
.panel.docked {
  width: 100%;
  border-left: none;
  box-shadow: none;
}
.head {
  padding: 18px 18px 14px;
  border-bottom: 1px solid #eef0f3;
}
h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
}
.body {
  flex: 1;
  overflow: auto;
  padding: 4px 18px 18px;
}
.docked .body {
  padding-top: 16px;
}
.panel.embed .body {
  padding-top: 40px;
}
.section {
  padding: 16px 0;
}
.section + .section {
  border-top: 1px solid #eef0f3;
}
.section h2 {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
}
.models {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.model {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  padding: 8px 10px;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.model.on {
  border-color: #4f7cff;
  background: #f3f6ff;
  color: #1e3a8a;
}
.model-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.model:focus-visible {
  outline: 2px solid #4f7cff66;
  outline-offset: 1px;
}
.note {
  font-size: 11px;
  color: #16a34a;
}
.select {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
  background: #fff;
}
.select:focus {
  outline: 2px solid #4f7cff33;
  border-color: #4f7cff;
}
.field {
  display: block;
  margin-bottom: 12px;
}
.field-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 4px;
}
.field input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
}
.field input:focus {
  outline: 2px solid #4f7cff33;
  border-color: #4f7cff;
}
.hint {
  display: block;
  font-size: 11px;
  color: #6b7280;
  margin-top: 4px;
}
.toggles {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 2px;
}
.foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid #eef0f3;
  background: #fff;
}
.primary {
  background: #4f7cff;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 18px;
  font-size: 13px;
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.6;
}
.primary:focus-visible {
  outline: 2px solid #4f7cff66;
  outline-offset: 2px;
}
.tip {
  font-size: 12px;
}
.tip.ok {
  color: #16a34a;
}
.tip.err {
  color: #dc2626;
}
</style>
