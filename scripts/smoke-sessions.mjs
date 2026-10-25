// ============================================================================
// 会话读取层自检：重点覆盖「DSH 升级后还能不能读」
// 用法：node scripts/smoke-sessions.mjs
// ============================================================================
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwb-sessions-'))
const ROOT = path.join(tmp, 'root')
process.env.DSH_HOME = tmp

const { findSessionLog, readSessionFile, extractSignals, listSessions } = await import('../lib/sessions.mjs')

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

const HEADER = { type: 'session', version: 4, id: 'session-test', createdAt: 1, cwd: 'D:\\x', isSeeded: false }

function writeLines(file, header, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = [header, ...events].map((x) => JSON.stringify(x)).join('\n') + '\n'
  fs.writeFileSync(file, text, 'utf8')
}

function writeZstdFrames(file, header, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 故意分两帧写：模拟 DSH 每批 append 一帧的真实形态
  const frame1 = zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n'))
  const frame2 = zlib.zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'))
  fs.writeFileSync(file, Buffer.concat([frame1, frame2]))
}

console.log('会话读取层自检')

ok('未压缩的 session.jsonl（v0）也能读', () => {
  const file = path.join(ROOT, 'wsA', 's1', 'session.jsonl')
  writeLines(file, HEADER, [{ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } }])
  const { header, events } = readSessionFile(file)
  assert.equal(header.id, 'session-test')
  assert.equal(events.length, 1)
})

ok('多帧 zstd 能完整解压（不是只读第一帧）', () => {
  const file = path.join(ROOT, 'wsA', 's2', 'session.v4.jsonl.zstd')
  writeZstdFrames(file, HEADER, [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '第一帧之后' }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: 2, data: { turn: 1 } },
  ])
  const { events } = readSessionFile(file)
  assert.equal(events.length, 2, '应当读到两帧里的全部事件')
})

ok('findSessionLog 取版本最高的那个（v5 胜过 v4）', () => {
  const dir = path.join(ROOT, 'wsA', 's3')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'v4')
  fs.writeFileSync(path.join(dir, 'session.v5.jsonl'), 'v5')
  const picked = findSessionLog(dir)
  assert.equal(picked.version, 5)
  assert.equal(picked.name, 'session.v5.jsonl')
})

ok('同版本优先压缩格式', () => {
  const dir = path.join(ROOT, 'wsA', 's4')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), 'plain')
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'zstd')
  const picked = findSessionLog(dir)
  assert.equal(picked.compressed, true)
})

ok('无关文件被忽略，空目录返回 null', () => {
  const dir = path.join(ROOT, 'wsA', 's5')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
  assert.equal(findSessionLog(dir), null)
})

ok('listSessions 能跨代际枚举并报出格式', () => {
  // s1 是 v0 未压缩，s2 是 v4 zstd
  const all = listSessions({ root: ROOT })
  // s5 里只有 notes.txt，没有会话日志 → 应当被跳过
  assert.equal(all.length, 4, '应当枚举到 4 个会话，实际 ' + all.length)
  const s2 = all.find((s) => s.file.includes('s2'))
  assert.equal(s2.compressed, true)
  assert.equal(s2.formatVersion, 4)
  const s1 = all.find((s) => s.file.includes('s1'))
  assert.equal(s1.compressed, false)
})

ok('extractSignals 只算用户自己打的字', () => {
  const events = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '真人提问' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '运行时上下文' }], source: { kind: 'runtime-context' } } },
    { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: '审批通知' }], source: { kind: 'user-approval' } } },
    { type: 'user/message', seq: 4, data: { content: [{ type: 'text', text: 'ptc 模式注入' }], source: { kind: 'ptc-mode' } } },
    { type: 'turn/start', seq: 5, data: { turn: 1 } },
  ]
  const sig = extractSignals(events)
  assert.equal(sig.userMessages.length, 1)
  assert.equal(sig.userMessages[0].text, '真人提问')
  assert.equal(sig.turns, 1)
})

ok('工具失败：结构化字段与文本启发式都算', () => {
  const events = [
    { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'pwsh', arguments: '{}' } },
    { type: 'tool/result', seq: 2, data: { toolCallId: 'c1', message: { content: [{ type: 'text', text: 'ok' }] }, error: { code: 'E_FAIL' } } },
    { type: 'tool/call', seq: 3, data: { callId: 'c2', name: 'edit', arguments: '{}' } },
    { type: 'tool/result', seq: 4, data: { toolCallId: 'c2', message: { content: [{ type: 'text', text: '[exit code: 1]' }] } } },
    { type: 'tool/call', seq: 5, data: { callId: 'c3', name: 'read', arguments: '{}' } },
    { type: 'tool/result', seq: 6, data: { toolCallId: 'c3', message: { content: [{ type: 'text', text: 'fine' }] } } },
  ]
  const sig = extractSignals(events)
  assert.equal(sig.toolFailures.length, 2)
  assert.equal(sig.toolFailures[0].tool, 'pwsh')
  assert.equal(sig.toolFailures[1].code, 'TEXT_MARKED')
})

ok('未知事件类型不会让解析崩', () => {
  const events = [
    { type: 'future/type-from-dsh-v6', seq: 1, data: { anything: [1, 2, 3] } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '还是能读' }], source: { kind: 'user' } } },
  ]
  const sig = extractSignals(events)
  assert.equal(sig.userMessages.length, 1)
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n全部通过（${passed} 项）`)
