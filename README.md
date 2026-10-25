# dsh-conversation-digest · 个人提示词效能工作台

DeepSeek Harness（DSH）插件。它把三件事串成**一个闭环**，而不是三个独立功能：

```text
        ┌──────────────────────────────────────────────┐
        │          个人提示词档案 profile.json           │
        │  issues[]（改进项）  assets[]（模板）           │
        └──────────────────────────────────────────────┘
             ▲写                    │读                  ▲写/读
     ┌───────────────┐      ┌───────────────┐    ┌───────────────┐
     │ ① 会话复盘     │      │ ② 发送前优化   │    │ ③ 提示词资产库 │
     │ 读历史提问     │─────▶│ 按改进项改写   │───▶│ 采纳即归档     │
     │ 产出改写草稿   │ 沉淀  │ 预览后替换草稿 │采纳 │ 输入时推荐     │
     └───────────────┘      └───────────────┘    └───────────────┘
```

## 它解决什么问题

你大概率有过这些情况：指令没说清楚，来回返工三轮；输出格式交代过一次，下次又忘了交代；工具调用失败，其实是因为你没说前置条件。

这个插件做的是：**把这些问题从「每次都要自己想起来」变成「存在档案里、下次自动补上」**。

| 功能 | 触发 | 产出 |
|---|---|---|
| ① 会话复盘 | 设置页「开始复盘」 | 一份改进清单，每条带一句可直接粘贴的改写草稿 |
| ② 发送前优化 | 输入框右侧 `✨ 优化` | 按你的历史改进项改写草稿，预览后一键替换 |
| ③ 提示词资产库 | 优化被采纳时自动归档 | 按任务类型打标签，输入时主动提示「上次这条约束有用」 |

## 安装

### 桌面客户端（Electron）

桌面端读的是 `desktop` profile，`dsh plugin` 命令行按设计拒绝碰它。让宿主自己装：

> 请使用内置的 `plugin_manager` 安装 `github:LIN-F1SH/dsh-conversation-digest`。

或本地开发：

> 请用内置 `plugin_manager` 安装 `link:<本目录绝对路径>`。

### Web（`dsh web`）

```powershell
dsh plugin --profile web add github:LIN-F1SH/dsh-conversation-digest
```

> ⚠️ **宿主代码改动后必须重启应用**。插件以 `link:` 安装时，改 `lib/*` 不会热重载（ESM 模块缓存）；禁用再启用也只会重跑 `apply()`，不会重载代码。客户端 `client/client.js` 的改动刷新页面（Ctrl+F5）即可。
>
> ⚠️ **不要在 `link:` 安装之上再试 `file:` 安装。** `link:` 在 `node_modules/<包名>` 建的是指向源码目录的 junction；pnpm 装 `file:` 时会先"移除旧包目录"，它会顺着 junction 把**你源码目录里的文件**删掉（实测把 `.git` 元数据掏空了）。要换安装方式请先卸载并手工删掉那个 junction。

## 怎么用

1. **先复盘**：设置 → 「提示词工作台」→「开始复盘」。它读最近 `reviewWindowDays` 天内的会话（默认 14 天、最多 8 个），只分析**你自己打的字**，调一次模型产出改进项。
2. **再优化**：回到对话，在输入框打一句话，点 `✨ 优化`。它拿你档案里 active 的改进项来改写，并列出「这次补了哪几条」。
3. **点「替换输入框」**：改写稿写回草稿，同时这条被采纳的提示词自动归档进资产库。
4. **之后输入时**，输入框上方会出现提示：「你上次做类似任务时补上这条约束后效果更好，要不要带上？」

## 数据与隐私

| 项 | 说明 |
|---|---|
| 档案位置 | `$DSH_HOME/prompt-workbench/profile.json`（默认 `~/.dsh`） |
| 读取什么 | 本机 `~/.dsh/sessions/**/session.v4.jsonl.zstd`，**只读** |
| 过滤规则 | 只取 `user/message` 且 `source.kind === 'user'` —— 系统注入的运行时上下文、审批通知、技能目录**一律排除**，否则分析结论全是噪声 |
| 联网 | 只有调模型时；读会话与分析不访问任何第三方接口 |
| 凭据 | **不存任何 key**。模型调用走宿主 `llm` 服务，用你当前选择的默认模型 |
| 诊断文件 | 模型输出解析失败时，原文会落到 `$DSH_HOME/prompt-workbench/last-*.txt`，仅本机 |
| 写接口 | 只接受**本机回环**来源（`127.0.0.1` / `localhost` / `::1`），局域网写入一律 403 |

## HTTP 接口

前缀 `/pwb`。读接口不限来源，写接口仅本机。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/pwb/ping` | 自检 |
| GET | `/pwb/health` | 环境体检：llm / 默认模型 / 档案 / 可复盘会话，`ready` 一句话回答"现在能不能跑复盘" |
| GET | `/pwb/profile` | 读档案（改进项 / 资产 / 复盘记录 / 设置） |
| POST | `/pwb/profile` | 改设置、改改进项状态、删条目（用 `action` 区分） |
| GET | `/pwb/sessions` | 列出可复盘的时间窗口 |
| POST | `/pwb/review` | 启动复盘，返回 `reviewId`（异步，避免 HTTP 超时） |
| GET | `/pwb/review?id=` | 轮询复盘进度与结果 |
| POST | `/pwb/optimize` | 按档案改写草稿 |
| POST | `/pwb/recommend` | 按草稿推荐资产/改进项（纯本地匹配，不调模型） |
| POST | `/pwb/assets` | 把一条提示词沉淀进资产库 |

## 目录结构

```text
dsh-conversation-digest/
├── package.json          # dsh.bundle.patch + dsh.client（platform: web）
├── cordis.patch.yml      # 挂载声明
├── lib/
│   ├── index.js          # 宿主入口：装配
│   ├── routes.mjs        # /pwb/* 路由与信任边界
│   ├── profile.mjs       # 档案层：原子写 / 损坏保护 / 合并去重
│   ├── sessions.mjs      # 读历史会话：多帧 zstd 解压 + 提问/失败提取
│   └── analyze.mjs       # 提示词工程 + 模型输出校验
├── client/client.js      # 客户端半区（手写、零构建）
├── scripts/              # 三套自检
└── docs/DESIGN.md        # 设计文档：为什么是这些字段
```

## 开发

```powershell
npm run smoke          # 62 项：宿主 14 + 档案 17 + 分析 21 + 客户端 10
```

客户端半区不需要浏览器也能验：`scripts/smoke-client.mjs` 桩掉 `window.__ModuleLoader__`、`document` 和 `require('react')`，直接跑 factory 与 `apply()`，断言 id 与包名一致、返回 cordis 插件、三个插槽名真实存在、组件可渲染、清理函数可用。

重启宿主后，一条命令验证真机闭环：

```powershell
node scripts/verify-live.mjs          # 默认 http://127.0.0.1:19387
node scripts/verify-live.mjs 3080     # 或指定 dsh web 的端口
```

它会依次打印环境体检、跑一次真实复盘、列出改进项与改写草稿、试跑一次优化、复核档案。

### 三个踩过的坑（写这类插件的人会再踩一遍）

1. **会话文件是 `session.v4.jsonl.zstd`，而且是多帧拼接的**。`zlib.zstdDecompressSync` 只解第一帧 → 你只会读到一行头部，看起来「这个会话是空的」。必须按魔数 `28 B5 2F FD` 逐帧解（见 `lib/sessions.mjs`）。
2. **`user/message` 里大部分不是你打的字**。实测 300 条里只有 62 条 `source.kind === 'user'`；其余是 `ptc-mode`、`runtime-context`、`skill-catalog` 等系统注入。不过滤就会把系统模板当成你的提问习惯来分析。
3. **`tool/result` 的 `error` 字段只覆盖约 1/3 的真实失败**（32/1195）。真实的内层工具失败在 `tool/ptc-dispatch`，另外还要叠加文本启发式（`[exit code: N]`、`STDERR:`、`ToolCallError`…）。

## 已知限制

- 复盘一次只发一个模型请求，材料已压缩（只取真人提问 + 失败摘要），但仍受窗口大小限制；输出被截断时插件会明确报 `TRUNCATED` 并重试一次，而不是静默失败。
- 资产推荐用字符 bigram 相似度做本地匹配，不做语义检索——够用、零成本、可预测。
- 会话压缩（compaction）后，被折叠的早期事件仍在日志里，本插件按时间顺序读取，不区分「模型当前可见」的 surface。
- 只支持 `session.v4`；将来格式升到 v5 需要适配（解析层会忽略未知事件类型，不会崩）。

## 许可

[MIT](./LICENSE) © 2026 LIN-F1SH
