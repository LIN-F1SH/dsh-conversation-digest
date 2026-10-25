// ============================================================================
// 宿主半区自检：不装进 DSH 也能验证「能加载 + 路由注册 + 能响应 + 能注销」
// 用法：node scripts/smoke.mjs
// ============================================================================
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// profile.mjs / sessions.mjs 在模块加载时读 DSH_HOME，必须先指到临时目录
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pwb-host-'))
process.env.DSH_HOME = tmpHome

const { default: plugin } = await import('../lib/index.js')

let passed = 0
const cases = []

/** 收集断言，最后统一 await（有些用例是异步的） */
function ok(name, fn) {
  cases.push({ name, fn })
}

function makeCtx({ withWebServer = true } = {}) {
  const state = { routes: [], effects: [] }
  const ctx = {
    state,
    get(name) {
      if (name === 'webServer') return withWebServer ? ctx.webServer : undefined
      return undefined // llm / agentDefaultModel 故意不给：验证"缺服务不崩"
    },
    effect(fn) {
      const dispose = fn()
      state.effects.push(dispose)
      return dispose
    },
    inject(services, cb) {
      if (services.every((name) => ctx.get(name) !== undefined)) cb(ctx)
    },
    on() {
      return () => {}
    },
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => {
          state.routes = state.routes.filter((r) => r !== route)
        }
      },
    },
  }
  return ctx
}

function fakeReq({ method = 'GET', url = '/', headers = { host: '127.0.0.1:3080' }, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeRes() {
  const headers = {}
  return {
    statusCode: 0,
    headers,
    body: null,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value
    },
    end(body) {
      this.body = body
    },
  }
}

async function invoke(ctx, pathname, options = {}) {
  const route = ctx.state.routes.find((r) => r.path === pathname)
  assert.ok(route, `应当注册了 ${pathname}`)
  const res = fakeRes()
  await route.handler(fakeReq(Object.assign({ url: pathname }, options)), res)
  return { res, json: res.body ? JSON.parse(res.body) : null }
}

const ctx = makeCtx()
plugin.apply(ctx)

ok('插件名与包名一致', () => {
  assert.equal(plugin.name, 'dsh-conversation-digest')
})

ok('注册了 /pwb/* 全部路由', () => {
  const paths = ctx.state.routes.map((r) => r.path)
  for (const expected of ['/pwb/ping', '/pwb/profile', '/pwb/sessions', '/pwb/review', '/pwb/optimize', '/pwb/recommend', '/pwb/assets']) {
    assert.ok(paths.includes(expected), `缺少 ${expected}`)
  }
})

ok('ping 返回 200 + 合法 JSON', async () => {
  const { res, json } = await invoke(ctx, '/pwb/ping')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(json.ok, true)
  assert.equal(json.plugin, 'dsh-conversation-digest')
})

ok('GET /pwb/profile 返回完整结构（空档案也能用）', async () => {
  const { res, json } = await invoke(ctx, '/pwb/profile')
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.deepEqual(json.issues, [])
  assert.deepEqual(json.assets, [])
  assert.equal(json.settings.enabled, true)
  assert.equal(json.counts.issues, 0)
})

ok('写接口拒绝非本机来源（403）', async () => {
  const { res, json } = await invoke(ctx, '/pwb/profile', {
    method: 'POST',
    headers: { host: '192.168.1.20:3080' },
    body: { action: 'clear' },
  })
  assert.equal(res.statusCode, 403)
  assert.match(json.error, /本机/)
})

ok('写接口接受本机来源并生效', async () => {
  const first = await invoke(ctx, '/pwb/profile', {
    method: 'POST',
    headers: { host: '127.0.0.1:3080' },
    body: { action: 'update-settings', settings: { reviewWindowDays: 30 } },
  })
  assert.equal(first.res.statusCode, 200)
  const second = await invoke(ctx, '/pwb/profile')
  assert.equal(second.json.settings.reviewWindowDays, 30)
})

ok('未知 action 被拒绝（400）', async () => {
  const { res } = await invoke(ctx, '/pwb/profile', {
    method: 'POST',
    headers: { host: '127.0.0.1:3080' },
    body: { action: 'rm -rf' },
  })
  assert.equal(res.statusCode, 400)
})

ok('优化接口在没有模型时给出明确错误，而不是崩溃', async () => {
  const { res, json } = await invoke(ctx, '/pwb/optimize', {
    method: 'POST',
    headers: { host: '127.0.0.1:3080' },
    body: { draft: '帮我看看这个报告' },
  })
  assert.equal(res.statusCode, 502)
  assert.equal(json.ok, false)
  assert.match(json.error, /llm|模型/)
})

ok('推荐接口在开关关闭时返回空列表', async () => {
  await invoke(ctx, '/pwb/profile', {
    method: 'POST',
    headers: { host: '127.0.0.1:3080' },
    body: { action: 'update-settings', settings: { autoRecommend: false } },
  })
  const { res, json } = await invoke(ctx, '/pwb/recommend', {
    method: 'POST',
    headers: { host: '127.0.0.1:3080' },
    body: { draft: '帮我审查一下这段代码的安全问题' },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(json.items, [])
})

ok('空草稿被拒绝', async () => {
  const { res } = await invoke(ctx, '/pwb/optimize', {
    method: 'POST',
    headers: { host: '127.0.0.1:3080' },
    body: { draft: '   ' },
  })
  assert.equal(res.statusCode, 400)
})

ok('卸载后所有路由被注销', () => {
  ctx.state.effects[0]()
  assert.equal(ctx.state.routes.length, 0)
})

ok('宿主没有 webServer 时：不抛异常、不注册路由', () => {
  const bare = makeCtx({ withWebServer: false })
  assert.doesNotThrow(() => plugin.apply(bare))
  assert.equal(bare.state.routes.length, 0)
})

ok('档案确实写到了 DSH_HOME 指定的位置', () => {
  const file = path.join(tmpHome, 'prompt-workbench', 'profile.json')
  assert.ok(fs.existsSync(file), '档案文件应当存在')
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(parsed.version, 1)
})

console.log('宿主半区自检')
for (const { name, fn } of cases) {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

fs.rmSync(tmpHome, { recursive: true, force: true })
console.log(`\n全部通过（${passed} 项）`)
