// ============================================================================
// 个人提示词档案 · 数据层
// ============================================================================
// 一个插件只有一个事实来源：$DSH_HOME/prompt-workbench/profile.json
//
// 这一层只做「存」和「合并」，不做任何业务判断（谁产生 issues、怎么改写都在别的模块）。
// 三条硬要求：
//   1. **原子写**：先写 .tmp 再 rename，避免半截文件；
//   2. **损坏保护**：读到坏 JSON 绝不覆盖，先备份成 profile.corrupt-<时间>.json；
//   3. **合并去重**：同一个问题反复被复盘出来，是累加证据和次数，不是新建条目。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
export const PROFILE_DIR = path.join(DSH_HOME, 'prompt-workbench')
export const PROFILE_FILE = path.join(PROFILE_DIR, 'profile.json')

export const LIMITS = {
  issues: 200,
  assets: 500,
  reviews: 50,
  evidencePerIssue: 20,
  excerptChars: 240,
}

export const DEFAULT_SETTINGS = {
  enabled: true,
  autoRecommend: true,
  recommendThreshold: 2,
  reviewWindowDays: 14,
  reviewMaxSessions: 8,
  optimizeIncludeIssues: 'matched-only',
}

export function emptyProfile() {
  return {
    version: 1,
    updatedAt: Date.now(),
    issues: [],
    assets: [],
    reviews: [],
    settings: { ...DEFAULT_SETTINGS },
  }
}

export function newId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

// —— 读 ——

function backupCorrupt(raw, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(PROFILE_DIR, `profile.corrupt-${stamp}.json`)
  try {
    fs.mkdirSync(PROFILE_DIR, { recursive: true })
    fs.writeFileSync(target, raw, 'utf8')
    return target
  } catch (err) {
    return null
  }
}

/**
 * 读取档案。永远返回一个可用的 profile，外加 warning（如果有异常情况）。
 * 绝不因为文件坏了就抛错——调用方拿到的必须是能继续工作的对象。
 */
export function loadProfile() {
  let raw
  try {
    raw = fs.readFileSync(PROFILE_FILE, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return { profile: emptyProfile(), warning: null }
    return { profile: emptyProfile(), warning: `档案读取失败（${err.code || err.message}），本次使用空档案` }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const backup = backupCorrupt(raw, 'json')
    return {
      profile: emptyProfile(),
      warning: `档案 JSON 损坏${backup ? `，原文已备份到 ${path.basename(backup)}` : ''}；本次使用空档案，未覆盖原文件`,
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const backup = backupCorrupt(raw, 'shape')
    return {
      profile: emptyProfile(),
      warning: `档案结构不是对象${backup ? `，原文已备份到 ${path.basename(backup)}` : ''}；本次使用空档案`,
    }
  }

  return { profile: normalizeProfile(parsed), warning: null }
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeIssue(raw) {
  if (!raw || typeof raw !== 'object') return null
  const title = asString(raw.title).trim()
  if (!title) return null
  return {
    id: asString(raw.id) || newId('issue'),
    kind: asString(raw.kind, 'other'),
    title,
    detail: asString(raw.detail),
    evidence: asArray(raw.evidence)
      .filter((e) => e && typeof e === 'object')
      .slice(0, LIMITS.evidencePerIssue)
      .map((e) => ({
        sessionId: asString(e.sessionId),
        seq: asNumber(e.seq),
        excerpt: asString(e.excerpt).slice(0, LIMITS.excerptChars),
      })),
    occurrences: Math.max(1, asNumber(raw.occurrences, 1)),
    severity: ['high', 'medium', 'low'].includes(raw.severity) ? raw.severity : 'medium',
    rewrite: asString(raw.rewrite),
    appliesTo: asArray(raw.appliesTo).filter((x) => typeof x === 'string'),
    status: ['active', 'dismissed', 'resolved'].includes(raw.status) ? raw.status : 'active',
    createdAt: asNumber(raw.createdAt, Date.now()),
    updatedAt: asNumber(raw.updatedAt, Date.now()),
  }
}

function normalizeAsset(raw) {
  if (!raw || typeof raw !== 'object') return null
  const body = asString(raw.body)
  if (!body.trim()) return null
  return {
    id: asString(raw.id) || newId('asset'),
    title: asString(raw.title) || suggestTitle(body),
    category: asString(raw.category, '未分类'),
    tags: asArray(raw.tags).filter((x) => typeof x === 'string'),
    body,
    origin: {
      sessionId: raw.origin && typeof raw.origin.sessionId === 'string' ? raw.origin.sessionId : undefined,
      issueIds: asArray(raw.origin && raw.origin.issueIds).filter((x) => typeof x === 'string'),
      source: ['optimize', 'manual', 'review'].includes(raw.origin && raw.origin.source)
        ? raw.origin.source
        : 'manual',
    },
    stats: {
      usedCount: asNumber(raw.stats && raw.stats.usedCount, 0),
      lastUsedAt: asNumber(raw.stats && raw.stats.lastUsedAt, 0) || undefined,
      adoptedCount: asNumber(raw.stats && raw.stats.adoptedCount, 0),
    },
    createdAt: asNumber(raw.createdAt, Date.now()),
    updatedAt: asNumber(raw.updatedAt, Date.now()),
  }
}

function normalizeReview(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    id: asString(raw.id) || newId('review'),
    startedAt: asNumber(raw.startedAt, Date.now()),
    finishedAt: asNumber(raw.finishedAt, 0) || undefined,
    scope: {
      sessionIds: asArray(raw.scope && raw.scope.sessionIds).filter((x) => typeof x === 'string'),
      from: asNumber(raw.scope && raw.scope.from, 0) || undefined,
      to: asNumber(raw.scope && raw.scope.to, 0) || undefined,
    },
    stats: {
      sessions: asNumber(raw.stats && raw.stats.sessions, 0),
      userMessages: asNumber(raw.stats && raw.stats.userMessages, 0),
      toolFailures: asNumber(raw.stats && raw.stats.toolFailures, 0),
      reworkSignals: asNumber(raw.stats && raw.stats.reworkSignals, 0),
    },
    produced: {
      issueIds: asArray(raw.produced && raw.produced.issueIds).filter((x) => typeof x === 'string'),
      newCount: asNumber(raw.produced && raw.produced.newCount, 0),
      mergedCount: asNumber(raw.produced && raw.produced.mergedCount, 0),
    },
    status: ['running', 'done', 'failed'].includes(raw.status) ? raw.status : 'done',
    error: asString(raw.error) || undefined,
  }
}

export function normalizeProfile(raw) {
  const settings = { ...DEFAULT_SETTINGS }
  if (raw.settings && typeof raw.settings === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const value = raw.settings[key]
      if (typeof value === typeof DEFAULT_SETTINGS[key]) settings[key] = value
    }
  }
  return {
    version: 1,
    updatedAt: asNumber(raw.updatedAt, Date.now()),
    issues: asArray(raw.issues).map(normalizeIssue).filter(Boolean).slice(0, LIMITS.issues),
    assets: asArray(raw.assets).map(normalizeAsset).filter(Boolean).slice(0, LIMITS.assets),
    reviews: asArray(raw.reviews).map(normalizeReview).filter(Boolean).slice(0, LIMITS.reviews),
    settings,
  }
}

// —— 写 ——

/**
 * 原子写：先写临时文件再 rename。
 * 不保留 .bak —— 归档备份会随每次写变化，留着反而制造噪声；
 * 真正的保护在 loadProfile 的"损坏不覆盖"上。
 */
export function saveProfile(profile) {
  const normalized = normalizeProfile(profile)
  normalized.updatedAt = Date.now()
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  const tmp = PROFILE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf8')
  fs.renameSync(tmp, PROFILE_FILE)
  return normalized
}

// —— 合并 ——

/** 归一化标题：去空格、标点、全半角差异，用于判断"是不是同一个问题" */
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？,.;:!?（）()【】\[\]"'`~\-_/\\|]/g, '')
}

export function issueKey(issue) {
  return `${issue.kind}::${normalizeTitle(issue.title)}`
}

/** 截一句能当标题的话：取正文第一句，限长，绝不用硬截断的一长串 */
export function suggestTitle(body, max = 24) {
  const text = String(body || '').replace(/\s+/g, ' ').trim()
  if (!text) return '未命名模板'
  const first = text.split(/[。！？!?；;，,]/).map((s) => s.trim()).filter(Boolean)[0] || text
  return first.length > max ? first.slice(0, max) + '…' : first
}

/**
 * 找这条候选问题应该并进哪一条已有记录。
 * 顺序很重要（从最可信到最宽松）：
 *   1. 模型显式复用了 id            → 同一个问题
 *   2. kind + 归一化标题完全相同     → 同一个问题
 *   3. **引用了同一条证据**（同 session 同 seq）→ 几乎必然是同一个问题，
 *      这比标题措辞可靠得多：模型两次复盘的标题可以完全不同，但会指向同一句话
 *   4. kind 相同且标题几乎逐字相同   → 同一个问题（阈值必须高，
 *      否则「问题 1」和「问题 2」这种只差一个数字的都会被合并）
 */
function findExisting(profile, candidate) {
  if (candidate.id) {
    const byId = profile.issues.find((issue) => issue.id === candidate.id)
    if (byId) return byId
  }
  const key = issueKey(candidate)
  const byTitle = profile.issues.find((issue) => issueKey(issue) === key)
  if (byTitle) return byTitle

  const evidenceKeys = new Set(candidate.evidence.map((e) => `${e.sessionId}#${e.seq}`))
  if (evidenceKeys.size) {
    for (const issue of profile.issues) {
      if (issue.kind !== candidate.kind) continue
      if (issue.evidence.some((e) => evidenceKeys.has(`${e.sessionId}#${e.seq}`))) return issue
    }
  }

  let best = null
  let bestScore = 0
  for (const issue of profile.issues) {
    if (issue.kind !== candidate.kind) continue
    const score = similarity(issue.title, candidate.title)
    if (score > bestScore) {
      bestScore = score
      best = issue
    }
  }
  return bestScore >= 0.85 ? best : null
}

/**
 * 把新复盘出来的 issues 合并进档案。
 * 同一个问题：累加 occurrences、合并 evidence（去重、截断）、
 * 采纳更长的 rewrite；**用户手动 dismiss/resolved 的状态不被覆盖**。
 */
export function mergeIssues(profile, incoming) {
  const now = Date.now()
  let added = 0
  let merged = 0
  const touched = []

  for (const raw of incoming) {
    const candidate = normalizeIssue({ ...raw, createdAt: now, updatedAt: now })
    if (!candidate) continue
    const existing = findExisting(profile, candidate)

    if (!existing) {
      profile.issues.push(candidate)
      added++
      touched.push(candidate.id)
      continue
    }

    existing.occurrences += Math.max(1, candidate.occurrences)
    existing.updatedAt = now
    if (candidate.rewrite && candidate.rewrite.length > (existing.rewrite || '').length) {
      existing.rewrite = candidate.rewrite
    }
    // 标题取更具体的那条：模型第二次往往会说得更准
    if (candidate.title.length > existing.title.length) existing.title = candidate.title
    if (candidate.detail && candidate.detail.length > (existing.detail || '').length) {
      existing.detail = candidate.detail
    }
    if (candidate.appliesTo.length) {
      existing.appliesTo = Array.from(new Set([...existing.appliesTo, ...candidate.appliesTo]))
    }
    // 严重度取更高的那个
    const rank = { low: 0, medium: 1, high: 2 }
    if (rank[candidate.severity] > rank[existing.severity]) existing.severity = candidate.severity

    const seen = new Set(existing.evidence.map((e) => `${e.sessionId}#${e.seq}`))
    for (const ev of candidate.evidence) {
      const id = `${ev.sessionId}#${ev.seq}`
      if (seen.has(id)) continue
      seen.add(id)
      existing.evidence.push(ev)
    }
    existing.evidence = existing.evidence.slice(-LIMITS.evidencePerIssue)
    merged++
    touched.push(existing.id)
  }

  // 按"影响面"排序并裁剪
  profile.issues.sort((a, b) => {
    const rank = { high: 2, medium: 1, low: 0 }
    if (rank[b.severity] !== rank[a.severity]) return rank[b.severity] - rank[a.severity]
    return b.occurrences - a.occurrences
  })
  if (profile.issues.length > LIMITS.issues) profile.issues.length = LIMITS.issues

  return { added, merged, issueIds: Array.from(new Set(touched)) }
}

/** 文本相似度的轻量近似：字符 bigram 的 Jaccard 系数，0–1 */
export function similarity(a, b) {
  const grams = (text) => {
    const s = String(text || '').toLowerCase().replace(/\s+/g, ' ')
    const set = new Set()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const ga = grams(a)
  const gb = grams(b)
  if (!ga.size || !gb.size) return 0
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / (ga.size + gb.size - inter)
}

/**
 * 存入一条资产。与已有资产高度相似（默认 0.82）则合并：累加采纳次数、合并标签，
 * 而不是让资产库被同一段话的十个小变体灌满。
 */
export function upsertAsset(profile, asset, { mergeAt = 0.82 } = {}) {
  const now = Date.now()
  const candidate = normalizeAsset({ ...asset, createdAt: now, updatedAt: now })
  if (!candidate) return { action: 'skipped', asset: null }

  let best = null
  let bestScore = 0
  for (const existing of profile.assets) {
    const score = similarity(existing.body, candidate.body)
    if (score > bestScore) {
      bestScore = score
      best = existing
    }
  }

  if (best && bestScore >= mergeAt) {
    best.stats.usedCount += 1
    // 合并本身就是又一次采纳：调用方显式给了采纳次数就用它，否则记 1
    best.stats.adoptedCount += Math.max(1, candidate.stats.adoptedCount)
    best.stats.lastUsedAt = now
    best.updatedAt = now
    best.tags = Array.from(new Set([...best.tags, ...candidate.tags]))
    best.origin.issueIds = Array.from(new Set([...best.origin.issueIds, ...candidate.origin.issueIds]))
    return { action: 'merged', asset: best, score: bestScore }
  }

  // 新资产：能走到"存进资产库"说明它已经被采纳过一次
  candidate.stats.adoptedCount = Math.max(1, candidate.stats.adoptedCount)

  profile.assets.push(candidate)
  if (profile.assets.length > LIMITS.assets) {
    profile.assets.sort((a, b) => b.stats.adoptedCount - a.stats.adoptedCount)
    profile.assets.length = LIMITS.assets
  }
  return { action: 'added', asset: candidate }
}

export function recordReview(profile, review) {
  profile.reviews.unshift(normalizeReview(review))
  if (profile.reviews.length > LIMITS.reviews) profile.reviews.length = LIMITS.reviews
}

// —— 查询 ——

/** 取可用的改进项（active），按影响面排序；匹配当前任务类型的优先 */
export function activeIssues(profile, { category, mode = 'matched-only' } = {}) {
  const rank = { high: 2, medium: 1, low: 0 }
  const list = profile.issues.filter((issue) => issue.status === 'active')
  const scored = list.map((issue) => {
    const matchesCategory = category
      ? issue.appliesTo.length === 0 || issue.appliesTo.includes(category)
      : true
    return { issue, matchesCategory, score: rank[issue.severity] * 10 + Math.min(issue.occurrences, 9) }
  })
  const filtered = mode === 'matched-only' ? scored.filter((s) => s.matchesCategory) : scored
  return filtered.sort((a, b) => b.score - a.score).map((s) => s.issue)
}

/** 推荐：把当前草稿和资产/改进项做一次轻量匹配（不调模型） */
export function recommend(profile, { text, limit = 3, threshold = 2 }) {
  const draft = String(text || '')
  if (draft.trim().length < 4) return []
  const out = []

  for (const asset of profile.assets) {
    const score = similarity(draft, asset.body) * 10 + Math.min(asset.stats.adoptedCount, 5)
    if (score >= threshold) {
      out.push({ type: 'asset', id: asset.id, title: asset.title, score, payload: asset.body, category: asset.category })
    }
  }
  for (const issue of activeIssues(profile)) {
    if (!issue.rewrite) continue
    const score = similarity(draft, issue.title) * 4 + Math.min(issue.occurrences, 5)
    if (score >= threshold) {
      out.push({ type: 'issue', id: issue.id, title: issue.title, score, payload: issue.rewrite, category: issue.kind })
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}
