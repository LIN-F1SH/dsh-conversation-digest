// ============================================================================
// 分析层：把「会话信号」变成「改进项」，把「草稿 + 改进项」变成「改写稿」
// ============================================================================
// 两条铁律：
//   1. **只分析提问方式**，不评价模型能力、不评价任务本身难不难。
//   2. **模型输出必须当不可信输入处理**：剥代码围栏、找 JSON、逐字段校验，
//      任何一个字段不合法就丢掉那一条，绝不让脏数据写进档案。
// ============================================================================

import { LIMITS } from './profile.mjs'

export const ISSUE_KINDS = [
  'ambiguous',            // 指令模糊 → 多轮返工
  'missing-constraint',   // 反复交代的约束
  'missing-precondition', // 漏说前置条件 → 工具失败
  'missing-context',      // 缺必要背景
  'scope-creep',          // 一次要求太多
  'other',
]

const KIND_LABEL = {
  ambiguous: '指令模糊',
  'missing-constraint': '缺约束',
  'missing-precondition': '漏前置条件',
  'missing-context': '缺上下文',
  'scope-creep': '任务边界不清',
  other: '其它',
}

// —— 复盘 ——

export const REVIEW_SYSTEM = `你是一名「提示词教练」，专门帮用户改掉提问方式上的坏习惯。

你只分析**用户怎么提问**，不分析任务难度，不评价助手的能力。判断依据必须来自用户自己打的字。

重点找这几类问题：
- ambiguous：指令含糊（没说清对象、范围、成功标准），导致后面来回返工、反复纠正
- missing-constraint：某个约束（输出格式、长度、语言、技术栈、不许改动什么）用户在多次对话里反复交代——说明它该被固定下来
- missing-precondition：用户没交代前置条件（环境、路径、版本、已有文件），导致工具调用失败
- missing-context：缺少必要背景，助手只能猜
- scope-creep：一次塞进太多互相独立的要求，边界不清

严格按下面的 JSON 输出，不要输出任何其它文字：

{
  "issues": [
    {
      "id": "如果这条与【已有的改进项】是同一个问题，原样填它的 id；是新问题就不填",
      "kind": "ambiguous | missing-constraint | missing-precondition | missing-context | scope-creep | other",
      "title": "一句话概括这个问题（不超过 20 字，不要以「用户」开头）",
      "detail": "具体说明：在哪些对话里、以什么形式出现的",
      "severity": "high | medium | low",
      "occurrences": 3,
      "appliesTo": ["代码", "文档写作"],
      "rewrite": "可以直接粘贴进提示词的一段约束/改写草稿，用第二人称对模型提要求，具体到可执行",
      "evidence": [
        { "sessionId": "会话 id", "seq": 数字, "excerpt": "用户原话片段（不超过 80 字）" }
      ]
    }
  ]
}

规则：
- 最多 5 条，只报真正反复出现的（出现 2 次以上），一次性的偶发问题不要报。
- occurrences 是你估计的出现次数，必须和证据相符。
- rewrite 必须**能直接粘贴使用**，写成对模型的明确要求，例如「输出必须为 Markdown 表格，包含三列：文件、问题、建议」。**不超过 120 字**。
- detail 不超过 120 字，evidence 最多 2 条。
- 没有发现问题就返回 {"issues": []}。
- 不要编造证据，excerpt 必须是材料里真实出现的用户原话。
- 不要在 JSON 之外输出任何内容（不要解释、不要前后缀、不要第二个代码块）。`

/** 把一个会话的信号压成给模型看的材料，严格控制长度 */
export function digestSession(session, signals, { maxUserMessages = 25, maxFailures = 12 } = {}) {
  const lines = []
  lines.push(`### 会话 ${session.sessionId}`)
  const meta = []
  if (signals.title) meta.push(`标题：${signals.title}`)
  if (session.createdAt) meta.push(`时间：${new Date(session.createdAt).toISOString().slice(0, 10)}`)
  meta.push(`轮次：${signals.turns}`, `用户消息：${signals.userMessages.length}`)
  lines.push(meta.join('　'))

  const msgs = signals.userMessages.slice(0, maxUserMessages)
  if (msgs.length) {
    lines.push('用户的原话（按时间顺序，seq 是位置）：')
    for (const m of msgs) {
      const text = m.text.replace(/\s+/g, ' ').slice(0, 300)
      lines.push(`- [seq=${m.seq}] ${text}`)
    }
  }

  const fails = signals.toolFailures.slice(0, maxFailures)
  if (fails.length) {
    lines.push('工具调用失败：')
    for (const f of fails) {
      const reason = (f.reason || '').replace(/\s+/g, ' ').slice(0, 160)
      lines.push(`- [seq=${f.seq}] ${f.tool} 失败(${f.code || f.name || '未知'})：${reason}`)
    }
  }
  return lines.join('\n')
}

export function buildReviewPrompt(sessions, { budget = 12000, existing = [] } = {}) {
  // 全局字符预算：把历史上限按会话数均分，避免 8 个大会话把提示词撑到几十万字符。
  // 单条消息在 digestSession 里会被截到 300 字符，加上 seq 前缀约 320，
  // 所以每个会话带几条提问 = 分到的额度 / 320（3–25 条之间）。
  const share = Math.max(600, Math.floor((budget - 400) / Math.max(1, sessions.length)))
  const perSessionMessages = Math.min(25, Math.max(3, Math.floor(share / 320)))

  const parts = []
  // 把已有改进项交给模型，是为了让它复用 id —— 纯靠标题匹配去重，两次复盘必然重复
  if (existing.length) {
    parts.push('【已有的改进项】如果是同一个问题，请原样复用它的 id，不要当成新问题：')
    for (const issue of existing.slice(0, 20)) {
      parts.push(`- id=${issue.id}　[${issue.kind}] ${issue.title}（已出现 ${issue.occurrences} 次）`)
    }
    parts.push('')
  }
  parts.push('下面是用户最近的若干次对话（已剔除系统注入的运行时上下文，只保留用户自己打的字和工具失败记录）。')
  parts.push('请分析他在「提问方式」上反复出现的问题。\n')
  for (const { session, signals } of sessions) {
    parts.push(digestSession(session, signals, { maxUserMessages: perSessionMessages, maxFailures: 6 }))
    parts.push('')
  }
  parts.push('现在按系统提示里的 JSON 格式输出。')

  const prompt = parts.join('\n')
  // 兜底：仍然超预算就硬截断（宁少看一些，也不要因为超窗口整次失败）
  return prompt.length > budget * 1.4 ? prompt.slice(0, Math.floor(budget * 1.4)) : prompt
}

// —— 输出解析 ——

/** 从 candidate 的 start 位置起，截出一个配平的 JSON 值（对象或数组）并解析 */
function parseBalancedAt(candidate, start) {
  const open = candidate[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1)
        try {
          return JSON.parse(slice)
        } catch (err) {
          // 模型最常见的两种小毛病：尾逗号、把换行写成了裸换行
          try {
            return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'))
          } catch (err2) {
            return null
          }
        }
      }
    }
  }
  return null
}

/** 从模型输出里抠出第一个可解析的 JSON 值（容忍代码围栏、前后废话、尾逗号、裸数组） */
export function extractJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = []
  if (fenced) candidates.push(fenced[1].trim())
  candidates.push(raw)

  for (const candidate of candidates) {
    // 按**出现顺序**试每个 { 或 [ 起点 —— 外层数组必须优先于它内层的对象，
    // 否则 '[{"title":…}]' 会被当成 {"title":…} 而丢掉数组语义。
    let scanned = 0
    for (let i = 0; i < candidate.length && scanned < 40; i++) {
      const ch = candidate[i]
      if (ch !== '{' && ch !== '[') continue
      scanned++
      const parsed = parseBalancedAt(candidate, i)
      if (parsed !== null && typeof parsed === 'object') return parsed
    }
  }
  return null
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function clampSeverity(value) {
  return ['high', 'medium', 'low'].includes(value) ? value : 'medium'
}

/**
 * 校验模型返回的 issues。宁可丢条，不可污染档案。
 * 返回 { issues, rejected }，rejected 用于在界面上告诉用户"模型有 N 条输出不合格"。
 */
export function parseReviewOutput(text) {
  const json = extractJson(text)
  if (!json) return { issues: [], rejected: 0, error: '没有找到合法的 JSON 输出' }

  // 模型有三种常见形态：{issues:[…]}、裸数组 […]、{issues:{id:{…}}}。
  // 都接住，否则一次可用的输出会被判成失败。
  let rawList = null
  if (Array.isArray(json)) rawList = json
  else if (Array.isArray(json.issues)) rawList = json.issues
  else if (json.issues && typeof json.issues === 'object') rawList = Object.values(json.issues)
  if (!rawList) return { issues: [], rejected: 0, error: '没有找到合法的 JSON 输出' }

  const issues = []
  let rejected = 0

  for (const raw of rawList.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') { rejected++; continue }
    const title = asString(raw.title)
    const rewrite = asString(raw.rewrite)
    if (!title || title.length < 3) { rejected++; continue }

    const kind = ISSUE_KINDS.includes(raw.kind) ? raw.kind : 'other'
    const evidence = Array.isArray(raw.evidence)
      ? raw.evidence
          .filter((e) => e && typeof e === 'object' && typeof e.sessionId === 'string')
          .slice(0, LIMITS.evidencePerIssue)
          .map((e) => ({
            sessionId: e.sessionId,
            seq: Number.isFinite(e.seq) ? e.seq : 0,
            excerpt: asString(e.excerpt).slice(0, LIMITS.excerptChars),
          }))
      : []

    const reusedId = asString(raw.id)
    issues.push({
      // 只接受形如 issue-xxxx 的复用 id；模型顺手编一个字符串时不采信
      ...(reusedId && /^issue-[a-z0-9]{4,}$/i.test(reusedId) ? { id: reusedId } : {}),
      kind,
      title: title.slice(0, 60),
      detail: asString(raw.detail).slice(0, 600),
      severity: clampSeverity(raw.severity),
      occurrences: Math.max(1, Math.min(99, Number(raw.occurrences) || 1)),
      appliesTo: Array.isArray(raw.appliesTo)
        ? raw.appliesTo.filter((x) => typeof x === 'string').slice(0, 6)
        : [],
      rewrite,
      evidence,
    })
  }

  return { issues, rejected, error: null }
}

// —— 优化 ——

export const OPTIMIZE_SYSTEM = `你是一名提示词优化器。用户会给你一段**正在写的草稿**，以及他自己的**历史改进项**（他过去反复踩的坑）。

你的任务：把草稿改写成一条更好的提示词，**主动补上他历史上反复遗漏的约束**。

硬性要求：
1. **保留原意**：不要改变用户想做的事，不要替他做决定，不要扩写成另一个任务。
2. **只补不删**：他写清楚的内容原样保留；你补的是他没写的（格式、范围、前置条件、边界、验收标准）。
3. **补的每一条都必须能对应到给定的改进项 id**；对不上的不要硬凑。
4. 不要加客套话、不要解释、不要在结果里出现「以下是优化后的提示词」这类前缀。
5. 只输出下面的 JSON，不要其它文字：

{
  "rewritten": "改写后的完整提示词（用户会直接拿它替换输入框）",
  "applied": [
    { "issueId": "改进项 id", "added": "你补进去的那句话（简短）" }
  ],
  "category": "这条提示词属于什么任务类型（如：数据分析 / 代码审查 / 文档写作 / 其它）",
  "tags": ["不超过 4 个标签"]
}

如果他草稿已经足够好，applied 可以为空数组，rewritten 基本等于原文（仅做必要的措辞整理）。`

export function buildOptimizePrompt({ draft, issues, category }) {
  const lines = []
  lines.push('【用户正在写的草稿】')
  lines.push(draft)
  lines.push('')
  if (category) {
    lines.push(`【他当前的任务类型（推断）】${category}`)
    lines.push('')
  }
  lines.push('【他历史上的提示词改进项】')
  if (!issues.length) {
    lines.push('（暂无沉淀的改进项——那就在不改变原意的前提下，只做最必要的清晰化。）')
  } else {
    for (const issue of issues) {
      lines.push(`- id=${issue.id}　类型=${KIND_LABEL[issue.kind] || issue.kind}　出现${issue.occurrences}次`)
      lines.push(`  问题：${issue.title}`)
      if (issue.rewrite) lines.push(`  可用改法：${issue.rewrite}`)
    }
  }
  lines.push('')
  lines.push('现在按要求输出 JSON。')
  return lines.join('\n')
}

export function parseOptimizeOutput(text, { knownIssueIds = [] } = {}) {
  const json = extractJson(text)
  if (!json) return { error: '没有找到合法的 JSON 输出' }
  const rewritten = asString(json.rewritten)
  if (!rewritten) return { error: '改写结果为空' }

  const known = new Set(knownIssueIds)
  const applied = Array.isArray(json.applied)
    ? json.applied
        .filter((a) => a && typeof a === 'object' && typeof a.issueId === 'string')
        // 只接受真的存在于档案里的 id —— 模型编造的引用会让闭环统计失真
        .filter((a) => known.size === 0 || known.has(a.issueId))
        .map((a) => ({ issueId: a.issueId, added: asString(a.added).slice(0, 200) }))
    : []

  return {
    rewritten,
    applied,
    category: asString(json.category, '其它').slice(0, 40),
    tags: Array.isArray(json.tags) ? json.tags.filter((t) => typeof t === 'string').slice(0, 4) : [],
    error: null,
  }
}

// —— 打标签（资产入库时用） ——

export const TAG_SYSTEM = `你给提示词模板分类。只输出 JSON：{"title":"不超过 14 字的标题","category":"任务类型","tags":["不超过 4 个标签"]}
任务类型优先从这些里选：数据分析、代码审查、文档写作、信息检索、方案设计、调试排错、其它。`

export function parseTaggingOutput(text) {
  const json = extractJson(text)
  if (!json) return null
  const title = asString(json.title)
  const category = asString(json.category)
  if (!category) return null
  return {
    title: title.slice(0, 40) || category,
    category: category.slice(0, 20),
    tags: Array.isArray(json.tags) ? json.tags.filter((t) => typeof t === 'string').slice(0, 4) : [],
  }
}

// —— 调模型 ——

/**
 * 调一次模型，把流式输出拼成整段文本。
 * 这里只负责"打通"，不做重试策略——重试由调用方按业务决定（复盘可失败，优化要即时反馈）。
 */
export async function callModel(llm, { provider, model, system, prompt, signal, maxTokens = 4096 }) {
  const stream = llm.stream({
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens,
    signal,
  })

  let text = ''
  let failure = null
  let finishKind = null
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') {
      const reason = chunk.reason
      finishKind = reason && reason.kind
      if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) failure = reason.failure
    }
  }
  if (failure) {
    const error = new Error(failure.message || '模型调用失败')
    error.code = failure.code
    throw error
  }
  // 截断的 JSON 一定解析不出来 —— 与其让下游报"没有合法 JSON"，不如在这里说清楚
  if (finishKind === 'max-tokens') {
    const error = new Error(`模型输出达到上限被截断（${maxTokens} tokens），请减少复盘范围或改进项数量`)
    error.code = 'TRUNCATED'
    throw error
  }
  return text
}
