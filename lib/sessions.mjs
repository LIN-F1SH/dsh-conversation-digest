// ============================================================================
// 历史会话读取
// ============================================================================
// 会话存在 $DSH_HOME/sessions/<workspace-key>/<session-id>/session.v4.jsonl.zstd
//
// 三个必须知道的坑（都是实测出来的，不是推测）：
//   1. **文件是 zstd 压缩的**，而且**多帧拼接** —— 每次 flush 追加一帧。
//      Node 的 zstdDecompressSync / createZstdDecompress 只解第一帧，
//      直接读会只拿到一行头部，看起来"这个会话是空的"。必须逐帧解。
//   2. 首行是 session 头部（JSON），之后每行一个事件。
//   3. `user/message` 里混着**系统注入**的消息：source.kind 为
//      `runtime-context`（运行时上下文快照）或 `user-approval`（审批策略变更通知）。
//      这些不是用户打的字，分析提问方式必须排除，否则结论全是噪声。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
export const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')

// 会话日志文件名随格式代际变化：session.jsonl（v0）、session.v4.jsonl、以及 .zstd 压缩形态。
// **不能写死版本号** —— DSH 升到 v5 时写死会让插件静默读不到任何会话。
const SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// zstd 解压是 Node 22.15+ 才有的能力。老 Node 上不要抛一个看不懂的 TypeError。
export const HAS_ZSTD = typeof zlib.zstdDecompressSync === 'function'

/**
 * 在一个会话目录里挑出应当读取的日志文件：取**版本最高**的；
 * 同版本优先压缩格式。找不到返回 null。
 */
export function findSessionLog(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (err) {
    return null
  }
  let best = null
  for (const name of names) {
    const matched = SESSION_LOG_RE.exec(name)
    if (!matched) continue
    const version = matched[1] ? Number(matched[1]) : 0
    const compressed = Boolean(matched[2])
    const better = !best
      || version > best.version
      || (version === best.version && compressed && !best.compressed)
    if (better) best = { name, version, compressed, file: path.join(dir, name) }
  }
  return best
}

export const LIMITS = {
  maxEventsPerSession: 4000,
  maxUserMessagesPerSession: 200,
  maxTextPerMessage: 1200,
  maxSessionsPerReview: 8,
}

// —— 解压 ——

function magicPositions(raw) {
  const out = []
  let pos = 0
  while (true) {
    const idx = raw.indexOf(ZSTD_MAGIC, pos)
    if (idx < 0) break
    out.push(idx)
    pos = idx + 4
  }
  return out
}

/**
 * 解压一个（可能由多个 zstd 帧拼接而成的）会话文件。
 * 按魔数切帧逐帧解；某个切分点如果解不开（魔数假阳性），就并到下一帧重试。
 */
export function decompressMultiFrame(raw) {
  if (!HAS_ZSTD) {
    throw new Error('当前 Node 不支持 zstd 解压（需要 22.15 或更高），无法读取压缩的会话日志')
  }
  const starts = magicPositions(raw)
  if (starts.length === 0) throw new Error('不是 zstd 数据（找不到帧魔数）')
  if (starts.length === 1) return zlib.zstdDecompressSync(raw)

  const parts = []
  let i = 0
  while (i < starts.length) {
    const start = starts[i]
    let next = i + 1
    let settled = false
    let lastError = null

    while (!settled) {
      const end = next < starts.length ? starts[next] : raw.length
      try {
        parts.push(zlib.zstdDecompressSync(raw.subarray(start, end)))
        settled = true
        i = next
      } catch (err) {
        lastError = err
        next++
        if (next > starts.length) throw lastError
      }
    }
  }
  return Buffer.concat(parts)
}

// —— 读取 ——

function safeJson(line) {
  try {
    return JSON.parse(line)
  } catch (err) {
    return null
  }
}

/**
 * 读一个会话文件。
 * 返回 { header, events, totalLines, truncated }；
 * 坏行被跳过并计数，不因为一行坏数据丢掉整个会话。
 */
export function readSessionFile(file, { maxEvents = LIMITS.maxEventsPerSession } = {}) {
  const raw = fs.readFileSync(file)
  // 压缩是可选的：先看魔数，别假设后缀就是真相
  const isZstd = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC)
  const text = (isZstd ? decompressMultiFrame(raw) : raw).toString('utf8')
  const lines = text.split('\n')
  let badLines = 0
  let header = null
  const events = []
  let totalLines = 0

  for (const line of lines) {
    if (!line.trim()) continue
    totalLines++
    const parsed = safeJson(line)
    if (!parsed) {
      badLines++
      continue
    }
    if (!header && parsed.type === 'session') {
      header = parsed
      continue
    }
    if (events.length < maxEvents) events.push(parsed)
  }

  return {
    header,
    events,
    totalLines,
    truncated: totalLines - 1 > events.length,
    badLines,
  }
}

function readHeaderOnly(file) {
  // 头部在第一帧里：只解第一帧，避免为了列标题去解压整个大文件
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const buf = Buffer.alloc(Math.min(64 * 1024, size))
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    const slice = buf.subarray(0, n)
    // 未压缩的日志：第一行就是头部
    if (!magicPositions(slice).length) {
      const firstLine = slice.toString('utf8').split('\n').find((l) => l.trim())
      const plain = firstLine ? safeJson(firstLine) : null
      return plain && plain.type === 'session' ? plain : null
    }
    const starts = magicPositions(slice)
    const end = starts.length > 1 ? starts[1] : slice.length
    const text = zlib.zstdDecompressSync(slice.subarray(0, end)).toString('utf8')
    const first = text.split('\n').find((l) => l.trim())
    const parsed = first ? safeJson(first) : null
    return parsed && parsed.type === 'session' ? parsed : null
  } catch (err) {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 枚举本机所有会话（按修改时间倒序）。
 * 只读头部就能拿到 cwd / createdAt，列目录时不碰会话正文。
 */
export function listSessions({ root = SESSIONS_ROOT, limit = 200 } = {}) {
  let workspaces
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch (err) {
    return []
  }

  const out = []
  for (const ws of workspaces) {
    const wsDir = path.join(root, ws.name)
    let ids
    try {
      ids = fs.readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch (err) {
      continue
    }
    for (const id of ids) {
      const dir = path.join(wsDir, id.name)
      const log = findSessionLog(dir)
      if (!log) continue
      let stat
      try {
        stat = fs.statSync(log.file)
      } catch (err) {
        continue
      }
      const header = readHeaderOnly(log.file)
      out.push({
        sessionId: (header && header.id) || id.name,
        workspaceKey: ws.name,
        cwd: (header && header.cwd) || null,
        createdAt: (header && header.createdAt) || stat.birthtimeMs,
        agentPreset: (header && header.agentPreset) || null,
        parentSession: (header && header.parentSession) || null,
        isSubagent: Boolean(header && header.origin === 'subagent'),
        // 格式信息上报给 /pwb/health，升级 DSH 后一眼就能看出读的是哪一代
        formatVersion: (header && Number(header.version)) || log.version,
        compressed: log.compressed,
        file: log.file,
        bytes: stat.size,
        mtime: stat.mtimeMs,
      })
    }
  }

  out.sort((a, b) => b.mtime - a.mtime)
  return out.slice(0, limit)
}

// —— 提取 ——

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function clip(text, max) {
  const s = String(text || '').replace(/\r\n/g, '\n').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

// 工具结果里的失败痕迹。结构化字段会漏，这些文本标记骗不了人。
const FAILURE_TEXT = /\[exit code: [1-9]\d*\]|\bToolCallError\b|(^|\n)\s*(Error|Exception|ENOENT|EPERM|timed out)\b|STDERR:/i

function softFailure(text) {
  return FAILURE_TEXT.test(String(text || '').slice(0, 4000))
}

/**
 * 从一个会话的事件流里抽信号。
 * **只统计用户真的打的字**：source.kind === 'user'，排除 runtime-context / user-approval。
 */
export function extractSignals(events) {
  const userMessages = []
  const toolFailures = []
  // callId → 工具名。用 Map 而不是数组 find：大会话里几百次调用，逐次线性查找是 O(n²)
  const callNames = new Map()
  let turns = 0
  let assistantMessages = 0
  let title = null
  const seenUserIds = new Set()

  for (const event of events) {
    const data = event.data || {}
    switch (event.type) {
      case 'user/message': {
        const kind = data.source && data.source.kind
        if (kind !== 'user') break
        const id = data.id
        if (id && seenUserIds.has(id)) break
        if (id) seenUserIds.add(id)
        userMessages.push({
          seq: event.seq,
          time: event.time,
          text: clip(textOfContent(data.content), LIMITS.maxTextPerMessage),
        })
        break
      }
      case 'assistant/message':
        assistantMessages++
        break
      case 'turn/start':
        turns++
        break
      case 'tool/call':
        if (data.callId) callNames.set(data.callId, data.name)
        break
      case 'tool/ptc-dispatch': {
        // 真实的内层工具调用（run_code 里的 edit / read / pwsh / grep…）落在这一种事件上，
        // 只统计 tool/result 会漏掉大部分失败。结构化的 isError 是最可靠的信号。
        if (data && data.isError) {
          const err = data.error || null
          toolFailures.push({
            seq: event.seq,
            callId: data.subCallId || null,
            tool: data.name || '(未知工具)',
            code: (err && err.code) || 'PTC_IS_ERROR',
            name: (err && err.name) || null,
            reason: clip(textOfContent(data.content) || (err && (err.reason || err.message)) || '', 300),
          })
        }
        break
      }
      case 'tool/result': {
        const error = data.error
        const text = textOfContent(data.message && data.message.content)
        // data.error 只覆盖约 1/3 的真实失败，必须叠加文本启发式
        const isError = Boolean(error) || Boolean(data.message && data.message.isError) || softFailure(text)
        if (!isError) break
        const callId = data.toolCallId || (data.message && data.message.toolCallId)
        toolFailures.push({
          seq: event.seq,
          callId,
          tool: callNames.get(callId) || '(未知工具)',
          code: (error && error.code) || 'TEXT_MARKED',
          name: (error && error.name) || null,
          reason: clip(text, 300),
        })
        break
      }
      case 'session/title': {
        const candidate = data.title || data.text || data.name
        if (typeof candidate === 'string' && candidate.trim()) title = candidate.trim()
        break
      }
      default:
        break
    }
  }

  if (userMessages.length > LIMITS.maxUserMessagesPerSession) {
    userMessages.length = LIMITS.maxUserMessagesPerSession
  }

  return { title, userMessages, toolFailures, turns, assistantMessages, toolCallCount: callNames.size }
}
