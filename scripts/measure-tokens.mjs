// ============================================================================
// token 成本实测：用本机真实会话量三件事
//   1. 复盘「实际会发给模型的材料」有多大（对比原始日志）
//   2. 你的历史里模型真报了多少 token（assistant/message.data.usage）
//   3. 其中有多少花在「返工轮」上 —— 也就是更好的首轮提示词本可省掉的部分
//
// 用法：node scripts/measure-tokens.mjs [会话数上限]
// 注意：usage 是模型自报的真实 token；字符折算只用于"我们的提示词"，会标明是估算。
// ============================================================================

import os from 'node:os'
import path from 'node:path'
import { listSessions, readSessionFile, extractSignals } from '../lib/sessions.mjs'
import { digestSession } from '../lib/analyze.mjs'

const limit = Number(process.argv[2]) || 8

function norm(text) {
  return String(text || '').replace(/@\S+/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 字符 bigram Jaccard，同 profile.mjs 里那套 */
function similarity(a, b) {
  const grams = (s) => {
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

/** 中文为主时约 1.6 字符/token；英文约 4。取偏保守的 1.6 */
const CHARS_PER_TOKEN = 1.6

const sessions = listSessions()
  .filter((s) => !s.isSubagent && !s.parentSession)
  .slice(0, limit)

const rows = []
let totalInput = 0
let totalOutput = 0
let totalCacheRead = 0
let reworkInput = 0
let reworkOutput = 0
let reworkTurns = 0
let retryAfterFailure = 0
let retryAfterFailureTokens = 0
let totalTurns = 0
let rawBytes = 0
let decompressedBytes = 0
let digestChars = 0
let userMessages = 0
let toolFailures = 0

for (const session of sessions) {
  let parsed
  try {
    parsed = readSessionFile(session.file)
  } catch (err) {
    continue
  }
  const signals = extractSignals(parsed.events)
  if (!signals.userMessages.length) continue

  rawBytes += session.bytes
  // 解压后大小：用事件条数近似太重，这里用「文本总量」更贴近实际
  const eventsBytes = parsed.events.reduce((sum, event) => sum + JSON.stringify(event).length, 0)
  decompressedBytes += eventsBytes

  const digest = digestSession(session, signals)
  digestChars += digest.length

  userMessages += signals.userMessages.length
  toolFailures += signals.toolFailures.length

  // —— 按 turn 聚合真实 usage ——
  const turnUsage = new Map() // turn -> {input, output}
  const endReason = new Map() // turn -> completed | error | aborted
  let currentTurn = 0
  for (const event of parsed.events) {
    if (event.type === 'turn/start') currentTurn = event.data.turn
    if (event.type === 'turn/end') endReason.set(event.data.turn, (event.data.reason && event.data.reason.kind) || 'unknown')
    if (event.type === 'assistant/message' && event.data.usage) {
      const bucket = turnUsage.get(currentTurn) || { input: 0, output: 0 }
      bucket.input += event.data.usage.inputTokens || 0
      bucket.output += event.data.usage.outputTokens || 0
      turnUsage.set(currentTurn, bucket)
    }
  }

  // —— 找出「返工轮」：与上一次提问相同或高度相似 ——
  // 归属：user message 的 seq 落在哪个 turn/end 之前，就算哪个 turn
  const turnBounds = []
  for (const event of parsed.events) {
    if (event.type === 'turn/start') turnBounds.push({ turn: event.data.turn, start: event.seq, end: Infinity })
    if (event.type === 'turn/end') {
      const last = [...turnBounds].reverse().find((b) => b.turn === event.data.turn)
      if (last) last.end = event.seq
    }
  }
  // 提问触发的是「它之后开始的那一轮」；落在某轮区间内则归该轮
  const turnOfSeq = (seq) => {
    const inside = turnBounds.find((b) => seq >= b.start && seq <= b.end)
    if (inside) return inside.turn
    const next = turnBounds.find((b) => b.start > seq)
    return next ? next.turn : null
  }

  // 重复提交分两种，必须分开量：
  //   失败重发 —— 上一轮 turn/end 是 error/aborted（网络或 provider 故障），改提示词省不掉
  //   真·返工 —— 上一轮正常完成，用户仍要重说（这才是提问方式的问题）
  const prompts = signals.userMessages
  let rework = 0
  for (let i = 1; i < prompts.length; i++) {
    const a = norm(prompts[i - 1].text)
    const b = norm(prompts[i].text)
    if (!a || !b) continue
    const same = a === b
    const similar = similarity(a, b) >= 0.6
    if (!same && !similar) continue
    const prevTurn = turnOfSeq(prompts[i - 1].seq)
    const turn = turnOfSeq(prompts[i].seq)
    if (turn == null) continue
    const usage = turnUsage.get(turn)
    const prevReason = prevTurn != null ? endReason.get(prevTurn) : null
    const failedBefore = prevReason === 'error' || prevReason === 'aborted'
    if (failedBefore) {
      retryAfterFailure++
      retryAfterFailureTokens += usage ? usage.input + usage.output : 0
      continue
    }
    rework++
    reworkInput += usage ? usage.input : 0
    reworkOutput += usage ? usage.output : 0
  }

  let sessionInput = 0
  let sessionOutput = 0
  for (const value of turnUsage.values()) {
    sessionInput += value.input
    sessionOutput += value.output
  }
  totalTurns += turnUsage.size
  reworkTurns += rework

  // 缓存命中：assistant/message.data.usage.cacheReadTokens
  for (const event of parsed.events) {
    if (event.type === 'assistant/message' && event.data.usage) {
      totalCacheRead += event.data.usage.cacheReadTokens || 0
    }
  }

  totalInput += sessionInput
  totalOutput += sessionOutput
  rows.push({
    id: session.sessionId.slice(0, 20),
    turns: turnUsage.size,
    prompts: prompts.length,
    failures: signals.toolFailures.length,
    input: sessionInput,
    output: sessionOutput,
    rework,
    digestChars: digest.length,
  })
}

function n(value) {
  return value.toLocaleString('en-US')
}

console.log('═'.repeat(78))
console.log('token 成本实测（真实 usage，非估算）')
console.log('═'.repeat(78))
console.log('\n按会话（前 %d 个有真人提问的会话）：', rows.length)
console.log('会话                  轮次  提问  失败      input     output  返工轮  材料字符')
for (const row of rows) {
  console.log(
    `${row.id.padEnd(20)} ${String(row.turns).padStart(4)} ${String(row.prompts).padStart(5)} ${String(row.failures).padStart(5)} `
    + `${n(row.input).padStart(10)} ${n(row.output).padStart(10)} ${String(row.rework).padStart(6)} ${n(row.digestChars).padStart(9)}`,
  )
}

const totalTokens = totalInput + totalOutput
console.log('\n' + '─'.repeat(78))
console.log('【1】历史总消耗（模型自报）')
console.log(`  input  ${n(totalInput)}`)
console.log(`  output ${n(totalOutput)}`)
console.log(`  合计   ${n(totalTokens)}`)
console.log(`  其中缓存命中读取 ${n(totalCacheRead)}（占比 ${totalInput ? ((totalCacheRead / totalInput) * 100).toFixed(1) : 0}%）`)

console.log('\n【2】复盘要发出去的材料 vs 原始日志')
console.log(`  原始压缩日志  ${(rawBytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`  事件全文      ${(decompressedBytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`  我们实际发送  ${n(digestChars)} 字符（约 ${n(Math.round(digestChars / CHARS_PER_TOKEN))} tokens，估算）`)
const ratio = decompressedBytes / Math.max(1, digestChars)
console.log(`  压缩比        ${ratio.toFixed(0)} : 1（相对事件全文）`)
console.log(`  若直接塞事件全文，约 ${n(Math.round(decompressedBytes / CHARS_PER_TOKEN))} tokens —— 一次就超过多数模型窗口`)

console.log('\n【3】重复提交：两种成因必须分开看')
const reworkTokens = reworkInput + reworkOutput
console.log(`  a) 失败后重发（上一轮 error/aborted，属于网络/服务故障）`)
console.log(`     次数 ${retryAfterFailure}，其中有 usage 的部分共 ${n(retryAfterFailureTokens)} tokens`)
console.log(`     → 这类靠改提示词省不掉`)
console.log(`  b) 真·返工（上一轮正常完成，仍要重说一遍）`)
console.log(`     次数 ${reworkTurns} / ${totalTurns} 轮（${totalTurns ? ((reworkTurns / totalTurns) * 100).toFixed(1) : 0}%）`)
console.log(`     token ${n(reworkTokens)}（占总消耗 ${totalTokens ? ((reworkTokens / totalTokens) * 100).toFixed(1) : 0}%）`)
console.log(`     → 这类才是"首轮说清楚就能省下"的部分`)

console.log('\n【4】单条提示词层面：优化会让它变长')
console.log('  优化是"加上你反复漏掉的约束"，所以单条会变长（通常 +30~200 字）—— 这是明面上的成本。')
console.log('  它想换回来的是【3】里的返工轮：每少返工一轮，省的是一整轮的 input+output。')
console.log(`  按你历史数据：平均每轮 ${n(Math.round(totalTokens / Math.max(1, totalTurns)))} tokens，`)
console.log(`  平均每个返工轮 ${n(Math.round(reworkTokens / Math.max(1, reworkTurns)))} tokens。`)

console.log('\n' + '═'.repeat(78))
console.log(`口径说明：usage 来自 assistant/message.data.usage（模型自报）；`)
console.log(`字符→token 用 ${CHARS_PER_TOKEN} 字符/token 估算，只用于"我们的提示词"这一项。`)
console.log('═'.repeat(78))
