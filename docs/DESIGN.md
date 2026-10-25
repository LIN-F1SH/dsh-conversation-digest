# 个人提示词效能工作台 · 设计文档

> 状态：设计稿（v1 待实现）。本文档描述的是**为什么这么做**，README 描述的是**怎么用**。

## 1. 一句话定义

把「复盘历史对话发现问题 → 下次输入时自动补齐 → 把好用的问法沉淀成模板」串成一个闭环，**三块功能共用同一份「个人提示词档案」**。

关键判断：这不是三个功能，是**一个数据模型 + 三个读写端**。如果三块各自存数据，它就退化成三个玩具。

```text
        ┌──────────────────────────────────────────────┐
        │            个人提示词档案 profile.json         │
        │  issues[]（改进项）  assets[]（模板）  reviews[] │
        └──────────────────────────────────────────────┘
             ▲写                    │读                  ▲写/读
             │                      ▼                    │
     ┌───────────────┐      ┌───────────────┐    ┌───────────────┐
     │ ① 会话复盘     │      │ ② 发送前优化   │    │ ③ 提示词资产库 │
     │ 读历史 jsonl   │      │ 读当前草稿     │    │ 按任务类型归档 │
     │ LLM 找提问问题 │─────▶│ LLM 按 issues  │───▶│ 匹配后主动推荐 │
     │ 产出改写草稿   │ 沉淀  │ 改写，预览应用 │采纳 │ 下一次输入时   │
     └───────────────┘      └───────────────┘    └───────────────┘
```

## 2. 数据模型（唯一事实来源）

存放位置：`$DSH_HOME/prompt-workbench/profile.json`（默认 `~/.dsh`）。原子写 + 损坏保护（读到坏文件不覆盖，先备份改名）。

```ts
interface PromptProfile {
  version: 1
  updatedAt: number
  issues: PromptIssue[]        // 复盘沉淀的改进项 —— 优化器读它
  assets: PromptAsset[]        // 沉下来的好问法 —— 推荐器读它
  reviews: ReviewRun[]         // 复盘历史（最近 50 条）
  settings: WorkbenchSettings
}

interface PromptIssue {
  id: string
  kind:            // 问题分类，决定用哪种改写策略
    | 'ambiguous'            // 指令模糊，导致多轮返工
    | 'missing-constraint'   // 反复交代的约束（输出格式、长度、语言…）
    | 'missing-precondition' // 漏说前置条件，导致工具调用失败
    | 'missing-context'      // 没给必要的背景/文件/环境
    | 'scope-creep'          // 一次要求太多，任务边界不清
    | 'other'
  title: string                  // 一句话概括，如「没有指定输出格式」
  detail: string                 // 具体说明
  evidence: Array<{              // 证据：哪几次对话证明它
    sessionId: string
    seq: number
    excerpt: string              // 原文片段（截断）
  }>
  occurrences: number            // 跨会话累计出现次数（合并同 pattern 时累加）
  severity: 'high' | 'medium' | 'low'
  rewrite: string                // ✅ 可直接复制的改写草稿（约束片段）
  appliesTo: string[]            // 适用任务类型，如 ['代码','数据分析']；空=通用
  status: 'active' | 'dismissed' | 'resolved'
  createdAt: number
  updatedAt: number
}

interface PromptAsset {
  id: string
  title: string
  category: string               // 任务类型：数据分析 / 代码审查 / 文档写作 / ...
  tags: string[]
  body: string                   // 模板正文，支持 {占位符}
  origin: {
    sessionId?: string
    issueIds: string[]           // 由哪些改进项催生
    source: 'optimize' | 'manual' | 'review'
  }
  stats: {
    usedCount: number
    lastUsedAt?: number
    adoptedCount: number         // 被采纳次数（采纳率是它值不值得推荐的核心指标）
  }
  createdAt: number
  updatedAt: number
}

interface ReviewRun {
  id: string
  startedAt: number
  finishedAt?: number
  scope: { sessionIds: string[]; from?: number; to?: number }  // 复盘了哪些会话
  stats: { sessions: number; userMessages: number; toolFailures: number; reworkSignals: number }
  produced: { issueIds: string[]; newCount: number; mergedCount: number }
  status: 'running' | 'done' | 'failed'
  error?: string
}

interface WorkbenchSettings {
  enabled: boolean
  autoRecommend: boolean         // 输入时主动推荐
  recommendThreshold: number     // 匹配分数阈值
  reviewWindowDays: number       // 复盘默认回看天数
  reviewMaxSessions: number      // 单次最多复盘多少个会话（成本闸门）
  optimizeIncludeIssues: 'all-active' | 'matched-only'   // 优化时带哪些改进项
}
```

### 为什么是这些字段

- `evidence` + `occurrences`：让「改进清单」有据可查，而不是模型编的空话；次数决定优化时的权重。
- `rewrite`：需求明确要求「每条附一段改写后的提示词草稿，可直接复制」。所以改写是**存下来的**，不是每次现编——这样优化器能直接引用，也便于用户手改。
- `appliesTo` + `category`：两者是同一个维度的两端（问题适用于哪类任务 / 模板属于哪类任务），优化器靠它做匹配。
- `adoptedCount`：推荐是否有效的唯一客观信号。

## 3. 三个功能的实现要点

### ① 会话复盘

**输入**：`~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl`（v4 格式，逐行事件）

**提取**（纯规则，不花 token）：
- 用户提问序列（`user/message`）
- 工具失败（`tool/result` 里带 error 的）
- 返工信号：同一 turn 内连续多条 user/message、用户在后续消息里重复同一约束、对话轮次远超同类任务中位数

**分析**（花 token）：把「提问序列 + 失败点 + 返工信号」压缩后交给 LLM，用**结构化输出**（JSON）返回 issues。分块处理，单块超限就按 turn 切。

**产出**：合并进 `profile.issues`——同一 `kind` + 相似 `title` 的算同一个问题，累加 `occurrences` 和 `evidence`，不重复建条目。

**展示**：`settings.section` 页里的「改进清单」，每条可复制 `rewrite`、可 dismiss、可手动编辑。

### ② 发送前优化

**触发**：composer 工具栏按钮（`conversation.input.right` 插槽）

**流程**：
1. 读当前草稿文本
2. 从档案取 active 的 issues，按「通用 + 与当前任务匹配」筛
3. LLM 改写：系统提示要求**只补不删**、保留用户原意与语气、把缺失约束显式化、输出「改写稿 + 本次补了哪几条（引用 issue id）」
4. 预览：显示改写稿与「补了这几条」清单，用户点「应用」才替换输入框

**关键设计**：改写**必须引用 issue id**，否则无法统计「哪条改进项真的有用」，闭环就断了。

### ③ 提示词资产库

**沉淀**：优化被采纳 → 把采纳后的文本交 LLM 打标签（category + tags）→ 存入 `assets`（与已有 asset 相似度高于阈值则合并、累加 `adoptedCount`）

**推荐**：输入时 debounce 后判断草稿的任务类型 → 匹配 `assets` 与 `issues` → 在 `conversation.input.dock` 显示一行提示，点击把约束片段插入草稿。

**冷启动问题**：档案为空时推荐器无话可说。所以 v1 允许从「一次成功对话」手动存一条 asset 起家。

## 4. 技术架构

### Host 半区（`lib/`）

| 模块 | 职责 |
|---|---|
| `profile.mjs` | 档案读写（原子写、备份、损坏保护、合并去重） |
| `sessions.mjs` | 扫 `session.v4.jsonl`，提取提问/失败/返工信号 |
| `analyze.mjs` | 调 `ctx.llm.stream()` 做复盘与改写，强制 JSON 输出 + 校验 |
| `routes.mjs` | `/prompt-workbench/*` HTTP 路由（档案 CRUD、复盘任务、优化、推荐） |
| `index.js` | 插件入口：装配上面几块 + 注册命令/工具 |

**LLM 调用**：`ctx.llm.stream({ provider, model, messages, system })`，provider/model 取 `ctx.agentDefaultModel.currentSelection()`。用户没配模型时降级：只出规则结论，不调模型，并明确告知。

**长任务**：复盘是异步任务（可能几十秒）。`POST /review` 返回 `reviewId`，前端轮询 `GET /review/:id` —— 避免 HTTP 超时，也让界面能显示进度。

### Client 半区（`client/client.js`）

手写、**不打包**：`window.__ModuleLoader__.load({ id: 'dsh-conversation-digest', factory: (require) => { ... return { name, inject: ['slots'], apply } } })`，`require('react')` 拿 React，`ctx.slots.inject(...)` 注册。

挂载点：

| 插槽 | 用途 |
|---|---|
| `conversation.input.right` | 「✨ 优化」按钮 |
| `conversation.input.dock` | 推荐横幅（"你上次做类似任务时…"） |
| `conversation.input.overlay` | 优化结果预览层 |
| `settings.section` | 「提示词工作台」页：改进清单 / 资产库 / 复盘入口 |

### 数据流与信任边界

- 所有写请求只接受本机回环来源（沿用小鲸鱼的 `requestRejection` 思路），防止局域网写档案。
- 档案里**不存任何凭据**；模型调用走宿主 `llm` 服务，不自己管 key。
- 复盘读的是本机会话文件，**不联网**。

## 5. V1 范围（先跑通闭环，再谈规模）

- [x] 设计
- [ ] 档案层：读写 + 合并去重 + 损坏保护 + 自检
- [ ] 会话提取：单会话复盘（不扫全库）
- [ ] 复盘 → issues（LLM 结构化输出 + 校验失败降级）
- [ ] 优化：读草稿 → 按 issues 改写 → 预览 → 应用
- [ ] 资产：采纳即归档 + 打标签
- [ ] 推荐：dock 横幅（关键词匹配，不调 LLM）
- [ ] 设置页：改进清单 / 资产库
- [ ] 多会话复盘（按时间窗口批量扫描）
- [ ] 推荐排序用 `adoptedCount` 学习

## 6. 风险与未解点

| 风险 | 现状 | 对策 |
|---|---|---|
| 客户端插槽能否读写输入框草稿 | **调研中** | 拿不到就退化为「复制到剪贴板 + 提示手动粘贴」，闭环仍成立 |
| 手写 client.js 是否被宿主接受 | **调研中** | 兜底：走 webServer 注入 vanilla JS（小鲸鱼方案） |
| LLM 结构化输出不稳定 | 已知 | 强制 JSON + 一次重试 + 校验失败降级为规则结论 |
| 复盘成本 | 已知 | 默认只回看 N 天 / M 个会话，界面显示预估 token 数 |
| 会话 jsonl 格式随版本变化 | 已知 | 解析层做版本探测，不认识的字段忽略而不是崩 |
