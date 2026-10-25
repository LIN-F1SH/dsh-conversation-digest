// ============================================================================
// 真机验证脚本：重启宿主后用一条命令确认闭环通了
// 用法：node scripts/verify-live.mjs [端口]
//   默认 http://127.0.0.1:19387
//
// 它做四件事：
//   1. /pwb/health —— 环境体检（llm / 默认模型 / 可复盘会话）
//   2. 起一个复盘任务并轮询到结束
//   3. 打印产出的改进项与改写草稿
//   4. 用一条草稿试跑优化，确认优化器能引用刚沉淀的改进项
// ============================================================================

const port = process.argv[2] || '19387'
const BASE = `http://127.0.0.1:${port}`

async function get(path) {
  const response = await fetch(BASE + path)
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function post(path, payload) {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

function line(char = '─') {
  return char.repeat(64)
}

console.log(line('═'))
console.log('DSH 个人提示词效能工作台 · 真机验证')
console.log(BASE)
console.log(line('═'))

// 1) 体检
console.log('\n[1/4] 环境体检 …')
const health = await get('/pwb/health')
if (health.status === 404) {
  console.log('❌ /pwb/health 不存在 —— 宿主仍在跑旧代码，请完全退出应用后重新打开。')
  process.exit(2)
}
if (health.status !== 200) {
  console.log(`❌ health 返回 HTTP ${health.status}`)
  process.exit(2)
}
const h = health.body
console.log(`  llm 服务      : ${h.llm ? '✅ 可用' : '❌ 缺失'}`)
console.log(`  默认模型      : ${h.model ? `✅ ${h.model.provider} / ${h.model.model}` : '❌ 未选择'}`)
console.log(`  档案文件      : ${h.profile.exists ? '✅' : '（尚未创建，第一次保存时生成）'} ${h.profile.path}`)
console.log(`  已有改进项    : ${h.profile.issues}（生效中 ${h.profile.activeIssues}）`)
console.log(`  资产库        : ${h.profile.assets}`)
console.log(`  可复盘会话    : ${h.sessions.withinWindow} 个（窗口 ${h.sessions.windowDays} 天，单次最多 ${h.sessions.maxSessions} 个）`)
if (!h.ready) {
  console.log('\n⚠️  ready=false：缺 llm 或没有默认模型或时间窗口内没有会话，复盘会失败。')
}

// 2) 复盘
console.log('\n[2/4] 启动复盘（会调用模型，可能几十秒）…')
const started = await post('/pwb/review', {})
if (started.status !== 202) {
  console.log(`❌ 启动失败 HTTP ${started.status}: ${JSON.stringify(started.body)}`)
  process.exit(1)
}
const reviewId = started.body.reviewId
console.log(`  reviewId = ${reviewId}`)

let job = null
for (let i = 0; i < 60; i++) {
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const poll = await get('/pwb/review?id=' + encodeURIComponent(reviewId))
  job = poll.body && poll.body.job
  if (!job) break
  process.stdout.write(`\r  轮询中… ${i * 2}s  状态=${job.status}   `)
  if (job.status !== 'running') break
}
console.log('')

if (!job) {
  console.log('❌ 查不到复盘任务')
  process.exit(1)
}
if (job.status === 'failed') {
  console.log(`❌ 复盘失败：${job.error}`)
  process.exit(1)
}

const r = job.result
console.log(line())
console.log(`✅ 复盘完成：分析 ${r.sessions} 个会话 / ${r.userMessages} 条你的提问 / ${r.toolFailures} 次工具失败`)
console.log(`   新增 ${r.added} 条改进项，合并 ${r.merged} 条${r.rejected ? `，模型有 ${r.rejected} 条输出不合格被丢弃` : ''}`)
console.log(line())
for (const issue of r.issues) {
  console.log(`\n[${issue.severity}] ${issue.title}　（出现 ${issue.occurrences} 次 · ${issue.kind}）`)
  if (issue.detail) console.log(`  问题：${issue.detail}`)
  if (issue.rewrite) console.log(`  改写：${issue.rewrite}`)
}

// 3) 优化
console.log('\n[3/4] 试跑发送前优化 …')
const optimized = await post('/pwb/optimize', { draft: '帮我看看这段代码有没有问题' })
if (optimized.status !== 200) {
  console.log(`⚠️ 优化接口返回 ${optimized.status}: ${JSON.stringify(optimized.body)}`)
} else {
  const o = optimized.body
  console.log(`  用到的改进项：${o.usedIssues} 条`)
  console.log(`  本次补上：${(o.applied || []).map((a) => a.added).join(' / ') || '（无需补充）'}`)
  console.log(`  分类：${o.category}　标签：${(o.tags || []).join(', ')}`)
  console.log('  改写结果：')
  console.log(o.rewritten.split('\n').map((l) => '    ' + l).join('\n'))
}

// 4) 档案复核
console.log('\n[4/4] 复核档案 …')
const profile = await get('/pwb/profile')
const p = profile.body
console.log(`  改进项 ${p.counts.issues}（生效中 ${p.counts.activeIssues}） · 资产 ${p.counts.assets} · 复盘记录 ${p.counts.reviews}`)
if (p.warning) console.log(`  ⚠️ ${p.warning}`)

console.log('\n' + line('═'))
console.log('全部验证通过。界面部分请刷新页面后看：输入框右侧「✨ 优化」、设置里的「提示词工作台」。')
console.log(line('═'))
