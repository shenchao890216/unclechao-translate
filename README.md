# UncleChao Translate

基于 LLM 的自用 Chrome 翻译插件：划词翻译 + 整页双语翻译。

技术栈：[WXT](https://wxt.dev) + TypeScript + Vue 3（Manifest V3，仅支持 Chromium 系浏览器）。

## 功能

### 划词翻译

- 选中网页文本自动弹出浮层显示译文，支持复制
- 双击选词同样可用；`Esc`、点击外部、滚动页面关闭浮层
- 输入框 / 可编辑区域内选中文本不触发

### 整页翻译

- 快捷键 `Alt+T`（或 popup 按钮）切换整页翻译
- 双语对照：译文显示在原文下方，保留原排版
- 三种视图切换：双语 / 原文 / 译文（popup 快捷切换，记忆上次选择）
- 支持 SPA：路由切换、滚动加载的新内容自动增量翻译
- 代码块（`<pre>`/`<code>`）不翻译；中文内容自动跳过

## 安装使用

### 开发

```bash
pnpm install
pnpm dev        # 自动拉起 Chrome 并加载插件，支持热更新
```

### 生产构建

```bash
pnpm build      # 产物在 .output/chrome-mv3
```

然后在 `chrome://extensions` 打开「开发者模式」→「加载已解压的扩展程序」→ 选择 `.output/chrome-mv3` 目录。

## 配置

在扩展设置页（popup 右上角「设置」）配置任意 OpenAI 兼容服务：

| 服务 | Base URL | 模型示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| OpenAI | `https://api.openai.com` | `gpt-4o-mini` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| Ollama 本地 | `http://localhost:11434` | 任意已拉取模型 |

Base URL 末尾会自动补 `/v1` 版本段。API Key 仅保存在本机（`chrome.storage.local`），不跨设备同步。

## 架构

```
content script                    background (service worker)
┌──────────────────────────┐                    ┌─────────────────────┐
│ 划词检测 → 浮层(ShadowDOM)│  TRANSLATE_BATCH   │ LLM 客户端           │
│ DOM 提取 → 分块 → 并发调度 │ ─────────────────→ │ OpenAI 兼容 fetch    │
│ 译文注入 → 视图切换        │ ←───────────────── │ JSON 容错 / 重试      │
└──────────────────────────┘  results(对齐数组) └─────────────────────┘
```

- content script 负责所有 DOM 编排（提取/分块/并发/注入）；background 只做无状态的"翻译一批文本"端点，每批一次短事务，不受 MV3 service worker 空闲回收影响
- 批量协议：`[{ id, text }]` 显式 id 对齐，每批 ≤20 条 / ≤3000 字符，并发最多 3，指数退避重试 2 次
- 译文注入全程 `textContent` 赋值，杜绝 LLM 输出造成的页面注入
- SPA 增量：MutationObserver（去抖 300ms，过滤自家注入）+ `wxt:locationchange` 路由兜底

## 已知限制（MVP 有意取舍）

- iframe 内的选中文本不支持划词翻译（`all_frames: false`）
- 表格单元格（`td`/`th`）在"仅译文"视图下会塌陷（宿主整体隐藏导致）
- 译文为扁平文本，不保留行内链接/加粗结构（原文侧不受影响）
- SPA 路由切换会全量重译（无翻译缓存，重复内容会重复计费）
- 无翻译持久缓存、无流式输出

## 明确不做（MVP 边界）

TTS、输入框翻译、Firefox 兼容、多翻译引擎切换、PDF/字幕翻译、翻译历史、上下文菜单、自动翻译整站、页面黑名单。
