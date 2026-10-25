// ============================================================================
// HTTP 路由：客户端半区与宿主之间的唯一通道
// ============================================================================
// 全部挂在 /pwb/* 下。规则：
//   · 读接口不限制来源（局域网里也能看自己的档案）；
//   · **写接口只接受本机回环来源** —— 档案能被改写等于能决定"下次优化要塞什么约束"，
//     不能让局域网里随便一个页面 POST 进来；
//   · 请求体有大小上限，不因为一个畸形请求把进程打爆。
// ============================================================================

import {
  loadProfile, saveProfile, mergeIssues, upsertAsset, recordReview, recommend,
  activeIssues, newId, LIMITS,
} from './profile.mjs'
import { listSessions, readSessionFile, extractSignals } from './sessions.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { PROFILE_DIR, PROFILE_FILE } from './profile.mjs'
import {
  buildReviewPrompt, parseReviewOutput, buildOptimizePrompt, parseOptimizeOutput,
  parseTaggingOutput, callModel, OPTIMIZE_SYSTEM, TAG_SYSTEM, REVIEW_SYSTEM,
} from './analyze.mjs'

const PREFIX = '/pwb'
const MAX_BODY = 256 * 1024

/**
 * 模型输出解析失败时，把原文落盘一份。
 * 没有这个，"没有合法 JSON" 对用户和排查者都是句废话。
 * 只在失败路径写，位置在 $DSH_HOME/prompt-workbench/，不联网、不上传。
 */
function saveRawDiagnostic(text, tag) {
  try {
    fs.mkdirSync(PROFILE_DIR, { recursive: true })
    fs.writeFileSync(path.join(PROFILE_DIR, `last-${tag}.txt`), String(text || ''), 'utf8')
  } catch (err) {
    /* 落盘失败不影响主流程 */
  }
}

// —— HTTP 小工具 ——

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function isLoopback(req) {
  const host = String((req.headers && req.headers.host) || '').toLowerCase()
  if (!host) return false
  const name = host.replace(/^\[/, '').replace(/\][^:]*$/, '').replace(/:\d+$/, '')
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name.endsWith('.localhost')
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text)
}

// —— 复盘任务管理 ——

function createReviewManager() {
  const jobs = new Map()

  return {
    start(ctx, run) {
      const id = newId('review')
      const job = { id, status: 'running', startedAt: Date.now() }
      jobs.set(id, job)
      // 不阻塞 HTTP 响应：复盘可能要几十秒，让前端轮询
      run()
        .then((result) => Object.assign(job, { status: 'done', finishedAt: Date.now(), result }))
        .catch((err) => Object.assign(job, {
          status: 'failed',
          finishedAt: Date.now(),
          error: (err && err.message) || String(err),
        }))
        .finally(() => {
          // 只保留最近 20 个任务，避免长期运行堆积
          if (jobs.size > 20) {
            const oldest = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0]
            if (oldest) jobs.delete(oldest.id)
          }
        })
      return id
    },
    get(id) {
      return jobs.get(id) || null
    },
    list() {
      return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
    },
  }
}

function pickRoute(selection) {
  if (!selection) return null
  const provider = selection.provider || (selection.route && selection.route.provider)
  const model = selection.model || (selection.route && selection.route.model)
  if (!provider || !model) return null
  return { provider, model }
}

// —— 路由注册 ——

export function registerRoutes(ctx, { webServer }) {
  const reviews = createReviewManager()

  const chat = async (system, prompt, options = {}) => {
    const llm = ctx.get('llm')
    if (!llm) throw new Error('宿主没有提供 llm 服务，无法调用模型')
    const selection = ctx.get('agentDefaultModel')
    const route = selection ? pickRoute(selection.currentSelection()) : null
    if (!route) throw new Error('还没有选择默认模型，请先在模型选择器里选一个')
    return callModel(llm, {
      ...route,
      system,
      prompt,
      maxTokens: options.maxTokens,
      signal: options.signal,
    })
  }

  const routes = []

  // 自检
  routes.push({
    kind: 'exact',
    path: `${PREFIX}/ping`,
    handler: (_req, res) => sendJson(res, 200, {
      ok: true,
      plugin: 'dsh-conversation-digest',
      now: new Date().toISOString(),
    }),
  })

  // 自检 + 环境体检：出问题时第一眼要看的就是这个，而不是猜"为什么复盘不动"
  routes.push({
    kind: 'exact',
    path: `${PREFIX}/health`,
    handler: (_req, res) => {
      const llm = ctx.get('llm')
      const selection = ctx.get('agentDefaultModel')
      const route = selection ? pickRoute(selection.currentSelection()) : null
      const { profile, warning } = loadProfile()
      let sessions = []
      try {
        sessions = listSessions({ limit: 100 })
      } catch (err) {}
      const usable = sessions.filter((s) => !s.isSubagent && !s.parentSession)
      const cutoff = Date.now() - profile.settings.reviewWindowDays * 86400_000
      sendJson(res, 200, {
        ok: true,
        plugin: 'dsh-conversation-digest',
        llm: Boolean(llm),
        model: route,
        // 复盘能不能跑，取决于这三条同时成立
        ready: Boolean(llm && route && usable.length > 0),
        profile: {
          path: PROFILE_FILE,
          exists: fs.existsSync(PROFILE_FILE),
          issues: profile.issues.length,
          activeIssues: profile.issues.filter((i) => i.status === 'active').length,
          assets: profile.assets.length,
          reviews: profile.reviews.length,
          warning,
        },
        sessions: {
          total: sessions.length,
          usable: usable.length,
          withinWindow: usable.filter((s) => (s.mtime || s.createdAt || 0) >= cutoff).length,
          windowDays: profile.settings.reviewWindowDays,
          maxSessions: profile.settings.reviewMaxSessions,
        },
      })
    },
  })

  // 读档案
  routes.push({
    kind: 'exact',
    path: `${PREFIX}/profile`,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不支持' })
      if (req.method === 'POST') return handleProfileWrite(req, res)
      const { profile, warning } = loadProfile()
      sendJson(res, 200, {
        ok: true,
        warning,
        settings: profile.settings,
        updatedAt: profile.updatedAt,
        issues: profile.issues,
        assets: profile.assets,
        reviews: profile.reviews.slice(0, 10),
        counts: {
          issues: profile.issues.length,
          activeIssues: profile.issues.filter((i) => i.status === 'active').length,
          assets: profile.assets.length,
          reviews: profile.reviews.length,
        },
      })
    },
  })

  async function handleProfileWrite(req, res) {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '写操作只接受本机来源' })
    let body
    try {
      body = await readJson(req)
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message })
    }
    const { profile, warning } = loadProfile()
    const action = body.action

    if (action === 'update-settings') {
      const next = body.settings
      if (!next || typeof next !== 'object') return sendJson(res, 400, { ok: false, error: 'settings 缺失' })
      for (const key of Object.keys(profile.settings)) {
        if (typeof next[key] === typeof profile.settings[key]) profile.settings[key] = next[key]
      }
    } else if (action === 'set-issue-status') {
      const issue = profile.issues.find((i) => i.id === body.id)
      if (!issue) return sendJson(res, 404, { ok: false, error: '改进项不存在' })
      if (!['active', 'dismissed', 'resolved'].includes(body.status)) {
        return sendJson(res, 400, { ok: false, error: 'status 不合法' })
      }
      issue.status = body.status
    } else if (action === 'update-issue-rewrite') {
      const issue = profile.issues.find((i) => i.id === body.id)
      if (!issue) return sendJson(res, 404, { ok: false, error: '改进项不存在' })
      issue.rewrite = String(body.rewrite || '').slice(0, 4000)
    } else if (action === 'delete-issue') {
      profile.issues = profile.issues.filter((i) => i.id !== body.id)
    } else if (action === 'delete-asset') {
      profile.assets = profile.assets.filter((a) => a.id !== body.id)
    } else if (action === 'clear') {
      profile.issues = []
      profile.assets = []
      profile.reviews = []
    } else {
      return sendJson(res, 400, { ok: false, error: '未知 action' })
    }

    const saved = saveProfile(profile)
    sendJson(res, 200, { ok: true, warning, updatedAt: saved.updatedAt })
  }

  // 可复盘的历史会话
  routes.push({
    kind: 'exact',
    path: `${PREFIX}/sessions`,
    handler: (_req, res) => {
      const { profile } = loadProfile()
      const cutoff = Date.now() - profile.settings.reviewWindowDays * 86400_000
      const all = listSessions({ limit: 100 })
      const usable = all
        .filter((s) => !s.isSubagent && !s.parentSession)
        .filter((s) => (s.mtime || s.createdAt || 0) >= cutoff)
        .slice(0, profile.settings.reviewMaxSessions)
      sendJson(res, 200, {
        ok: true,
        windowDays: profile.settings.reviewWindowDays,
        maxSessions: profile.settings.reviewMaxSessions,
        total: all.length,
        chosen: usable.map((s) => ({
          sessionId: s.sessionId,
          cwd: s.cwd,
          createdAt: s.createdAt,
          bytes: s.bytes,
        })),
      })
    },
  })

  // 启动复盘
  routes.push({
    kind: 'exact',
    path: `${PREFIX}/review`,
    handler: (req, res) => {
      if (req.method === 'GET') {
        const id = new URL(req.url, 'http://x').searchParams.get('id')
        const job = id ? reviews.get(id) : null
        if (id && !job) return sendJson(res, 404, { ok: false, error: '没有这个复盘任务' })
        return sendJson(res, 200, { ok: true, job, jobs: id ? undefined : reviews.list().slice(0, 5) })
      }
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不支持' })
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '写操作只接受本机来源' })

      const id = reviews.start(ctx, async () => {
        const { profile } = loadProfile()
        const cutoff = Date.now() - profile.settings.reviewWindowDays * 86400_000
        const candidates = listSessions({ limit: 100 })
          .filter((s) => !s.isSubagent && !s.parentSession)
          .filter((s) => (s.mtime || s.createdAt || 0) >= cutoff)
          .slice(0, profile.settings.reviewMaxSessions)

        if (!candidates.length) throw new Error('时间窗口内没有可复盘的会话')

        const materials = []
        const scope = { sessionIds: [], from: cutoff, to: Date.now() }
        let messageCount = 0
        let failureCount = 0

        for (const session of candidates) {
          let parsed
          try {
            parsed = readSessionFile(session.file)
          } catch (err) {
            continue
          }
          const signals = extractSignals(parsed.events)
          // 没有真人发言的会话没有复盘价值，直接跳过（省 token）
          if (!signals.userMessages.length) continue
          materials.push({ session, signals })
          scope.sessionIds.push(session.sessionId)
          messageCount += signals.userMessages.length
          failureCount += signals.toolFailures.length
        }

        if (!materials.length) throw new Error('窗口内的会话里没有找到你自己打的提问')

        const prompt = buildReviewPrompt(materials)
        // 用分析层统一维护的系统提示词，避免两处措辞漂移。
        // 8K 输出预算：5 条改进项 × 长改写也放得下；仍被截断会抛 TRUNCATED 并把话说明白。
        let raw = await chat(REVIEW_SYSTEM, prompt, { maxTokens: 8192 })
        let parsed = parseReviewOutput(raw)
        if (parsed.error) {
          // 第一次没解析出来：模型偶尔会先寒暄一段。用一句极短的要求再要一次。
          saveRawDiagnostic(raw, 'review-attempt-1')
          raw = await chat(
            '只输出 JSON，不要任何解释、不要代码围栏、不要前后缀。',
            prompt + '\n\n（上一次的输出无法解析为 JSON，请这次只输出那个 JSON 对象。）',
            { maxTokens: 8192 },
          )
          parsed = parseReviewOutput(raw)
        }
        if (parsed.error) {
          saveRawDiagnostic(raw, 'review-attempt-2')
          const head = String(raw || '').replace(/\s+/g, ' ').slice(0, 200)
          throw new Error(`${parsed.error}（已重试一次；模型返回开头：${head || '空'}）`)
        }
        const { issues, rejected } = parsed

        const fresh = loadProfile().profile
        const merged = mergeIssues(fresh, issues)
        recordReview(fresh, {
          id: newId('review'),
          startedAt: Date.now(),
          finishedAt: Date.now(),
          scope,
          stats: {
            sessions: materials.length,
            userMessages: messageCount,
            toolFailures: failureCount,
            reworkSignals: 0,
          },
          produced: { issueIds: merged.issueIds, newCount: merged.added, mergedCount: merged.merged },
          status: 'done',
        })
        saveProfile(fresh)

        return {
          added: merged.added,
          merged: merged.merged,
          rejected,
          sessions: materials.length,
          userMessages: messageCount,
          toolFailures: failureCount,
          issues: fresh.issues.filter((i) => merged.issueIds.includes(i.id)),
        }
      })

      sendJson(res, 202, { ok: true, reviewId: id })
    },
  })

  // 发送前优化
  routes.push({
    kind: 'exact',
    path: `${PREFIX}/optimize`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不支持' })
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '写操作只接受本机来源' })
      let body
      try {
        body = await readJson(req)
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message })
      }
      const draft = String(body.draft || '').trim()
      if (!draft) return sendJson(res, 400, { ok: false, error: '草稿是空的' })

      const { profile } = loadProfile()
      const issues = activeIssues(profile, {
        category: body.category,
        mode: profile.settings.optimizeIncludeIssues,
      }).slice(0, 8)

      try {
        const raw = await chat(OPTIMIZE_SYSTEM, buildOptimizePrompt({ draft, issues, category: body.category }))
        const parsed = parseOptimizeOutput(raw, { knownIssueIds: issues.map((i) => i.id) })
        if (parsed.error) return sendJson(res, 502, { ok: false, error: parsed.error })
        sendJson(res, 200, {
          ok: true,
          original: draft,
          rewritten: parsed.rewritten,
          applied: parsed.applied,
          category: parsed.category,
          tags: parsed.tags,
          usedIssues: issues.length,
        })
      } catch (err) {
        sendJson(res, 502, { ok: false, error: (err && err.message) || String(err) })
      }
    },
  })

  // 推荐（纯本地匹配，不调模型）
  routes.push({
    kind: 'exact',
    path: `${PREFIX}/recommend`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不支持' })
      let body
      try {
        body = await readJson(req)
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message })
      }
      const { profile } = loadProfile()
      if (!profile.settings.enabled || !profile.settings.autoRecommend) {
        return sendJson(res, 200, { ok: true, items: [] })
      }
      sendJson(res, 200, {
        ok: true,
        items: recommend(profile, {
          text: String(body.draft || ''),
          threshold: profile.settings.recommendThreshold,
        }),
      })
    },
  })

  // 采纳后沉淀为资产
  routes.push({
    kind: 'exact',
    path: `${PREFIX}/assets`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不支持' })
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '写操作只接受本机来源' })
      let body
      try {
        body = await readJson(req)
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message })
      }
      const text = String(body.body || '').trim()
      if (!text) return sendJson(res, 400, { ok: false, error: '内容为空' })

      const { profile } = loadProfile()
      let meta = { title: body.title, category: body.category, tags: body.tags }
      // 没给分类就请模型打标签；失败不阻塞沉淀（宁可归到"其它"）
      if (!meta.category) {
        try {
          const raw = await chat(TAG_SYSTEM, text.slice(0, 4000))
          const tagged = parseTaggingOutput(raw)
          if (tagged) meta = { ...meta, ...tagged }
        } catch (err) {
          meta.category = '其它'
        }
      }

      const result = upsertAsset(profile, {
        title: meta.title,
        category: meta.category,
        tags: meta.tags,
        body: text,
        origin: {
          sessionId: body.sessionId,
          issueIds: Array.isArray(body.issueIds) ? body.issueIds : [],
          source: body.source === 'review' ? 'review' : 'optimize',
        },
      })
      saveProfile(profile)
      sendJson(res, 200, { ok: true, action: result.action, asset: result.asset })
    },
  })

  const disposers = routes.map((route) => webServer.register(route))
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch (err) {}
    }
  }
}
