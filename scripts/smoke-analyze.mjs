// 分析层自检：重点验证「模型乱输出」时不会污染档案
import assert from 'node:assert/strict'
import {
  extractJson, parseReviewOutput, parseOptimizeOutput, parseTaggingOutput,
  buildOptimizePrompt, buildReviewPrompt, digestSession,
} from '../lib/analyze.mjs'

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('分析层自检')

ok('提取裸 JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
})

ok('提取代码围栏里的 JSON', () => {
  const text = '好的，结果如下：\n```json\n{"issues":[]}\n```\n希望有帮助'
  assert.deepEqual(extractJson(text), { issues: [] })
})

ok('提取带前后废话的 JSON', () => {
  const text = '我先说明一下……{"issues":[],"note":"x"} 以上。'
  assert.deepEqual(extractJson(text), { issues: [], note: 'x' })
})

ok('字符串里含大括号不会截断', () => {
  const text = '{"rewritten":"请输出 {JSON} 格式","applied":[]}'
  assert.equal(extractJson(text).rewritten, '请输出 {JSON} 格式')
})

ok('完全不是 JSON 时返回 null', () => {
  assert.equal(extractJson('抱歉，我无法完成'), null)
  assert.equal(extractJson(''), null)
  assert.equal(extractJson(null), null)
})

ok('复盘输出：合法条目被接受', () => {
  const text = JSON.stringify({
    issues: [{
      kind: 'missing-constraint',
      title: '从不指定输出格式',
      detail: '多次要求改格式',
      severity: 'high',
      occurrences: 4,
      appliesTo: ['文档写作'],
      rewrite: '输出必须为 Markdown 表格',
      evidence: [{ sessionId: 's1', seq: 3, excerpt: '格式不对' }],
    }],
  })
  const { issues, rejected, error } = parseReviewOutput(text)
  assert.equal(error, null)
  assert.equal(rejected, 0)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'missing-constraint')
  assert.equal(issues[0].evidence.length, 1)
})

ok('复盘输出：非法 kind 降级为 other', () => {
  const { issues } = parseReviewOutput(JSON.stringify({ issues: [{ title: '某个问题', kind: '胡说八道' }] }))
  assert.equal(issues[0].kind, 'other')
})

ok('复盘输出：缺标题的条目被丢弃并计数', () => {
  const { issues, rejected } = parseReviewOutput(JSON.stringify({
    issues: [{ title: '' }, { kind: 'ambiguous' }, { title: '有效的问题标题' }],
  }))
  assert.equal(issues.length, 1)
  assert.equal(rejected, 2)
})

ok('复盘输出：数字字段被收敛到合理范围', () => {
  const { issues } = parseReviewOutput(JSON.stringify({
    issues: [{ title: '标题在这里', occurrences: 9999, severity: 'catastrophic' }],
  }))
  assert.equal(issues[0].occurrences, 99)
  assert.equal(issues[0].severity, 'medium')
})

ok('复盘输出：issues 不是数组时报错而不是崩', () => {
  const r = parseReviewOutput('{"issues":"oops"}')
  assert.equal(r.error !== null, true)
  assert.deepEqual(r.issues, [])
})

ok('复盘输出：裸数组形态也能接住', () => {
  const { issues, error } = parseReviewOutput('[{"title":"数组形态的问题"}]')
  assert.equal(error, null)
  assert.equal(issues.length, 1)
})

ok('复盘输出：{issues:{id:…}} 对象形态也能接住', () => {
  const text = JSON.stringify({ issues: { a: { title: '对象形态的问题' } } })
  const { issues, error } = parseReviewOutput(text)
  assert.equal(error, null)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].title, '对象形态的问题')
})

ok('复盘输出：尾逗号容错', () => {
  const { issues } = parseReviewOutput('{"issues":[{"title":"带尾逗号"},]}')
  assert.equal(issues.length, 1)
})

ok('复盘提示词：8 个大会话也不会超预算', () => {
  const sessions = Array.from({ length: 8 }, (_, index) => ({
    session: { sessionId: 's' + index },
    signals: {
      title: 'T' + index,
      turns: 20,
      userMessages: Array.from({ length: 60 }, (_, i) => ({ seq: i, text: '很长的一句话'.repeat(30) })),
      toolFailures: Array.from({ length: 30 }, (_, i) => ({ seq: i, tool: 'pwsh', code: 'E' + i, reason: 'x'.repeat(300) })),
    },
  }))
  const prompt = buildReviewPrompt(sessions)
  assert.ok(prompt.length <= 12000 * 1.4 + 50, '提示词超预算：' + prompt.length)
  assert.match(prompt, /s0/)
  assert.match(prompt, /s7/)
})

ok('复盘输出：最多接受 12 条', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ title: `问题标题 ${i}` }))
  const { issues } = parseReviewOutput(JSON.stringify({ issues: many }))
  assert.equal(issues.length, 12)
})

ok('优化输出：编造的 issueId 被过滤掉', () => {
  const text = JSON.stringify({
    rewritten: '改写后的提示词',
    applied: [{ issueId: 'real-1', added: '补了格式' }, { issueId: 'fake-9', added: '编的' }],
    category: '代码审查',
    tags: ['a', 'b'],
  })
  const out = parseOptimizeOutput(text, { knownIssueIds: ['real-1', 'real-2'] })
  assert.equal(out.applied.length, 1)
  assert.equal(out.applied[0].issueId, 'real-1')
})

ok('优化输出：没有 rewrite 内容时报错', () => {
  assert.ok(parseOptimizeOutput('{"applied":[]}').error)
  assert.ok(parseOptimizeOutput('完全不是 JSON').error)
})

ok('优化输出：三档方案按 简洁→标准→严谨 排序，默认推荐标准', () => {
  const text = JSON.stringify({
    options: [
      { label: '严谨', text: '严谨版内容' },
      { label: '简洁', text: '简洁版内容' },
      { label: '标准', text: '标准版内容' },
    ],
    category: '代码审查',
  })
  const out = parseOptimizeOutput(text)
  assert.equal(out.error, null)
  assert.deepEqual(out.options.map((o) => o.label), ['简洁', '标准', '严谨'])
  assert.equal(out.rewritten, '标准版内容', 'rewritten 兼容字段应取标准版')
})

ok('优化输出：缺 label 时按顺序补名', () => {
  const out = parseOptimizeOutput(JSON.stringify({ options: [{ text: 'A' }, { text: 'B' }] }))
  assert.deepEqual(out.options.map((o) => o.label), ['简洁', '标准'])
})

ok('优化输出：超长方案被截断并加省略号（不许出现小作文）', () => {
  const out = parseOptimizeOutput(JSON.stringify({ options: [{ label: '简洁', text: 'X'.repeat(600) }] }))
  assert.ok(out.options[0].text.length <= 201, '实际 ' + out.options[0].text.length)
  assert.ok(out.options[0].text.endsWith('…'))
})

ok('优化输出：applied 里编造的 issueId 被过滤', () => {
  const out = parseOptimizeOutput(JSON.stringify({
    options: [{ label: '标准', text: '正文', applied: [{ issueId: 'issue-real', note: '补格式' }, { issueId: 'issue-fake', note: '编的' }] }],
  }), { knownIssueIds: ['issue-real'] })
  assert.equal(out.options[0].applied.length, 1)
  assert.equal(out.options[0].applied[0].note, '补格式')
})

ok('优化输出：空 options 会回落，不至于整次失败', () => {
  const out = parseOptimizeOutput(JSON.stringify({ options: [] }))
  assert.ok(out.error, '没有任何版本时应报错')
})

ok('优化输出：老形态（单个 rewritten）仍然兼容', () => {
  const out = parseOptimizeOutput(JSON.stringify({ rewritten: '老格式正文', applied: [] }))
  assert.equal(out.error, null)
  assert.equal(out.options.length, 1)
  assert.equal(out.options[0].label, '标准')
})

ok('打标签输出：缺 category 时返回 null', () => {
  assert.equal(parseTaggingOutput('{"title":"x"}'), null)
  assert.equal(parseTaggingOutput('{"category":"数据分析","title":"表格输出","tags":["t"]}').category, '数据分析')
})

ok('会话材料：长消息被截断，含 seq 与标题', () => {
  const digest = digestSession(
    { sessionId: 'sess-1', createdAt: Date.parse('2026-10-01T00:00:00Z') },
    {
      title: '测试会话',
      turns: 3,
      userMessages: [{ seq: 7, text: 'A'.repeat(1000) }],
      toolFailures: [{ seq: 9, tool: 'bash', code: 'E_FAIL', reason: 'B'.repeat(500) }],
    },
  )
  assert.match(digest, /sess-1/)
  assert.match(digest, /测试会话/)
  assert.match(digest, /seq=7/)
  assert.ok(digest.length < 1200, '材料必须被压缩，实际 ' + digest.length)
})

ok('优化提示词里带上改进项 id 与改写建议', () => {
  const prompt = buildOptimizePrompt({
    draft: '帮我看看这个报告',
    issues: [{ id: 'issue-abc', kind: 'missing-constraint', title: '没指定格式', occurrences: 3, rewrite: '输出为 Markdown' }],
  })
  assert.match(prompt, /issue-abc/)
  assert.match(prompt, /没指定格式/)
  assert.match(prompt, /输出为 Markdown/)
  assert.match(prompt, /帮我看看这个报告/)
})

ok('复盘提示词聚合多个会话', () => {
  const prompt = buildReviewPrompt([
    { session: { sessionId: 's1' }, signals: { title: 'A', turns: 1, userMessages: [{ seq: 1, text: '你好' }], toolFailures: [] } },
    { session: { sessionId: 's2' }, signals: { title: 'B', turns: 2, userMessages: [{ seq: 2, text: '再来' }], toolFailures: [] } },
  ])
  assert.match(prompt, /s1/)
  assert.match(prompt, /s2/)
})

console.log(`\n全部通过（${passed} 项）`)
