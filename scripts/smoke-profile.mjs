// ============================================================================
// 档案层自检（不依赖 DSH 运行时）
// 用法：node scripts/smoke-profile.mjs
// ============================================================================
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 必须在导入模块前指向临时目录：profile.mjs 在模块加载时读 DSH_HOME
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pwb-profile-'))
process.env.DSH_HOME = tmpHome

const {
  emptyProfile, loadProfile, saveProfile, mergeIssues, upsertAsset, normalizeTitle,
  issueKey, similarity, recommend, activeIssues, recordReview, normalizeSettings, suggestTitle, pendingSessions,
  PROFILE_FILE, PROFILE_DIR,
} = await import('../lib/profile.mjs')

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('档案层自检')

ok('空档案结构完整', () => {
  const p = emptyProfile()
  assert.equal(p.version, 1)
  assert.deepEqual(p.issues, [])
  assert.deepEqual(p.assets, [])
  assert.equal(p.settings.enabled, true)
})

ok('标题归一化去掉空格与标点', () => {
  assert.equal(normalizeTitle('没有指定 输出格式！'), normalizeTitle('没有指定输出格式'))
  assert.equal(normalizeTitle('A, B。'), 'ab')
})

ok('新问题被加入并带回 id', () => {
  const p = emptyProfile()
  const res = mergeIssues(p, [{
    kind: 'missing-constraint',
    title: '没有指定输出格式',
    detail: '多次要求改格式',
    severity: 'medium',
    occurrences: 2,
    rewrite: '输出必须为 Markdown 表格，含列名。',
    appliesTo: ['文档写作'],
    evidence: [{ sessionId: 's1', seq: 3, excerpt: '这个格式不对' }],
  }])
  assert.equal(res.added, 1)
  assert.equal(res.merged, 0)
  assert.equal(p.issues.length, 1)
  assert.match(p.issues[0].id, /^issue-/)
  assert.equal(p.issues[0].occurrences, 2)
})

ok('同一问题再次复盘：次数累加、证据去重、不新建条目', () => {
  const p = emptyProfile()
  mergeIssues(p, [{ kind: 'missing-constraint', title: '没有指定输出格式', occurrences: 2, evidence: [{ sessionId: 's1', seq: 3, excerpt: 'a' }] }])
  const res = mergeIssues(p, [{
    kind: 'missing-constraint',
    title: '没有指定 输出格式',       // 只是空格不同，应判为同一个问题
    occurrences: 3,
    evidence: [
      { sessionId: 's1', seq: 3, excerpt: 'a' },   // 重复，应被去重
      { sessionId: 's2', seq: 9, excerpt: 'b' },
    ],
  }])
  assert.equal(p.issues.length, 1, '不应产生第二条')
  assert.equal(res.merged, 1)
  assert.equal(res.added, 0)
  assert.equal(p.issues[0].occurrences, 5)
  assert.equal(p.issues[0].evidence.length, 2, '重复证据要被去掉')
})

ok('严重度取更高的一档', () => {
  const p = emptyProfile()
  mergeIssues(p, [{ kind: 'ambiguous', title: '指令模糊', severity: 'low' }])
  mergeIssues(p, [{ kind: 'ambiguous', title: '指令模糊', severity: 'high' }])
  assert.equal(p.issues[0].severity, 'high')
})

ok('更长的 rewrite 覆盖更短的', () => {
  const p = emptyProfile()
  mergeIssues(p, [{ kind: 'ambiguous', title: '指令模糊', rewrite: '短' }])
  mergeIssues(p, [{ kind: 'ambiguous', title: '指令模糊', rewrite: '更详细的一版改写草稿' }])
  assert.match(p.issues[0].rewrite, /更详细/)
})

ok('用户 dismiss 掉的问题不会被再次复盘覆盖回 active', () => {
  const p = emptyProfile()
  mergeIssues(p, [{ kind: 'other', title: '某个问题' }])
  p.issues[0].status = 'dismissed'
  mergeIssues(p, [{ kind: 'other', title: '某个问题' }])
  assert.equal(p.issues[0].status, 'dismissed', '用户的选择必须被尊重')
})

ok('同一个问题两次复盘措辞不同：靠证据重叠合并', () => {
  const p = emptyProfile()
  mergeIssues(p, [{
    kind: 'missing-precondition',
    title: '只问能否接入软件，不给路径和环境',
    occurrences: 3,
    evidence: [{ sessionId: 's1', seq: 17, excerpt: '你能接入我的PowerDesigner软件吗' }],
  }])
  const res = mergeIssues(p, [{
    kind: 'missing-precondition',
    title: '接入本地软件前不交代环境与路径',   // 措辞完全不同
    occurrences: 4,
    evidence: [{ sessionId: 's1', seq: 17, excerpt: '你能接入我的PowerDesigner软件吗' }],
  }])
  assert.equal(p.issues.length, 1, '同一条证据应判为同一个问题')
  assert.equal(res.merged, 1)
  assert.equal(p.issues[0].occurrences, 7)
})

ok('模型复用 id 时合并（比字符串匹配可靠）', () => {
  const p = emptyProfile()
  mergeIssues(p, [{ kind: 'ambiguous', title: '交付标准含糊' }])
  const id = p.issues[0].id
  const res = mergeIssues(p, [{ id, kind: 'ambiguous', title: '完全不同的措辞也行', occurrences: 2 }])
  assert.equal(p.issues.length, 1)
  assert.equal(res.merged, 1)
})

ok('只差一个数字、且证据不同的两条不会被合并', () => {
  const p = emptyProfile()
  mergeIssues(p, [{ kind: 'k', title: '问题 1', evidence: [{ sessionId: 's1', seq: 1, excerpt: '' }] }])
  mergeIssues(p, [{ kind: 'k', title: '问题 2', evidence: [{ sessionId: 's2', seq: 9, excerpt: '' }] }])
  assert.equal(p.issues.length, 2, '标题相近但证据不同，不应合并')
})

ok('相似度函数：同文为 1，无关为低', () => {
  assert.equal(similarity('你好世界', '你好世界'), 1)
  assert.ok(similarity('请用 Markdown 表格输出结果', '请用 Markdown 表格输出结果内容') > 0.6)
  assert.ok(similarity('请用表格输出', '完全不相关的一句话') < 0.3)
})

ok('高度相似的资产被合并而非堆积', () => {
  const p = emptyProfile()
  const body = '请以 Markdown 表格输出，列名为：模块、问题、建议。'
  const a = upsertAsset(p, { title: '表格输出模板', category: '文档写作', body })
  assert.equal(a.action, 'added')
  const b = upsertAsset(p, { title: '表格输出模板2', category: '文档写作', body: body + '额外要求。' })
  assert.equal(b.action, 'merged')
  assert.equal(p.assets.length, 1)
  assert.equal(p.assets[0].stats.adoptedCount, 2)
})

ok('只有 active 的问题参与选材，且按影响面排序', () => {
  const p = emptyProfile()
  mergeIssues(p, [
    { kind: 'a', title: '低影响', severity: 'low', occurrences: 1 },
    { kind: 'b', title: '高影响', severity: 'high', occurrences: 5 },
  ])
  p.issues.find((i) => i.title === '低影响').status = 'dismissed'
  const list = activeIssues(p)
  assert.equal(list.length, 1)
  assert.equal(list[0].title, '高影响')
})

ok('推荐能命中相似资产', () => {
  const p = emptyProfile()
  upsertAsset(p, { title: '代码审查模板', category: '代码审查', body: '请逐文件审查，指出安全、性能、可读性三类问题，并给出 patch。' })
  const hits = recommend(p, { text: '帮我审查这段代码，逐文件看安全和性能问题' })
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].type, 'asset')
})

ok('草稿太短时不推荐（避免噪声）', () => {
  const p = emptyProfile()
  upsertAsset(p, { title: 'x', body: '请逐文件审查代码' })
  assert.deepEqual(recommend(p, { text: '你好' }), [])
})

// —— 持久化 ——

ok('保存后能原样读回', () => {
  const p = emptyProfile()
  mergeIssues(p, [{ kind: 'k', title: '往返测试', rewrite: 'R' }])
  saveProfile(p)
  assert.ok(fs.existsSync(PROFILE_FILE))
  const { profile, warning } = loadProfile()
  assert.equal(warning, null)
  assert.equal(profile.issues.length, 1)
  assert.equal(profile.issues[0].title, '往返测试')
})

ok('文件损坏时：不覆盖、给警告、留备份', () => {
  fs.writeFileSync(PROFILE_FILE, '{ 这不是 JSON ', 'utf8')
  const { profile, warning } = loadProfile()
  assert.ok(warning && warning.includes('损坏'), '应当给出损坏警告')
  assert.equal(profile.issues.length, 0)
  const backups = fs.readdirSync(PROFILE_DIR).filter((f) => f.startsWith('profile.corrupt-'))
  assert.ok(backups.length >= 1, '应当留下备份文件')
  assert.equal(fs.readFileSync(PROFILE_FILE, 'utf8'), '{ 这不是 JSON ', '原文件必须保持未被覆盖')
})

ok('结构不是对象时也走保护路径', () => {
  fs.writeFileSync(PROFILE_FILE, '[1,2,3]', 'utf8')
  const { profile, warning } = loadProfile()
  assert.ok(warning)
  assert.equal(profile.issues.length, 0)
})

ok('设置校验：非法档位被过滤、默认档回落到列表首项', () => {
  const s = normalizeSettings({ optimizeVariants: ['简洁', '胡说'], optimizeDefault: '严谨' })
  assert.deepEqual(s.optimizeVariants, ['简洁'])
  assert.equal(s.optimizeDefault, '简洁', '默认档不在生成列表里时必须回落')
})

ok('设置校验：空档位列表不会被接受（否则没有可生成的版本）', () => {
  const s = normalizeSettings({ optimizeVariants: [] })
  assert.deepEqual(s.optimizeVariants, ['简洁', '标准', '严谨'])
})

ok('设置校验：数值越界被夹到合理区间', () => {
  const s = normalizeSettings({ reviewWindowDays: 0, reviewMaxSessions: 999, recommendThreshold: -5 })
  assert.equal(s.reviewWindowDays, 1)
  assert.equal(s.reviewMaxSessions, 20)
  assert.equal(s.recommendThreshold, 0)
})

ok('设置校验：缺字段时保留默认值', () => {
  const s = normalizeSettings({})
  assert.equal(s.enabled, true)
  assert.equal(s.optimizeDefault, '标准')
})

ok('增量复盘：已看过且没变的会话被跳过', () => {
  const sessions = [
    { sessionId: 'a', mtime: 100 },
    { sessionId: 'b', mtime: 200 },
    { sessionId: 'c', mtime: 300 },
  ]
  // a 看过且没变；b 看过但之后变过；c 没看过
  const pending = pendingSessions(sessions, { a: 100, b: 150 })
  assert.deepEqual(pending.map((s) => s.sessionId), ['b', 'c'])
})

ok('增量复盘：force 时全部重跑', () => {
  const sessions = [{ sessionId: 'a', mtime: 100 }]
  assert.deepEqual(pendingSessions(sessions, { a: 100 }, { force: true }).map((s) => s.sessionId), ['a'])
})

ok('coverage 能存进档案并读回', () => {
  const p = emptyProfile()
  p.coverage = { 'session-a': 123 }
  saveProfile(p)
  const { profile } = loadProfile()
  assert.equal(profile.coverage['session-a'], 123)
})

ok('复盘记录写入并裁剪', () => {
  const p = emptyProfile()
  for (let i = 0; i < 60; i++) {
    recordReview(p, { id: `r${i}`, startedAt: i, status: 'done' })
  }
  assert.equal(p.reviews.length, 50)
  assert.equal(p.reviews[0].id, 'r59')
})

ok('超量数据被裁剪，不会无限增长', () => {
  const p = emptyProfile()
  const many = Array.from({ length: 260 }, (_, i) => ({ kind: 'k', title: `问题 ${i}` }))
  mergeIssues(p, many)
  assert.equal(p.issues.length, 200)
})

fs.rmSync(tmpHome, { recursive: true, force: true })
console.log(`\n全部通过（${passed} 项）`)
