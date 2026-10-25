// ============================================================================
// 不装进 DSH 也能跑的自检
// ============================================================================
// 用一个最小 ctx 桩调用 apply()，再把注册到的 handler 直接跑一遍。
// 覆盖四件事：
//   1. apply() 能注册出预期的路由；
//   2. handler 返回 200 + 合法 JSON；
//   3. effect 的 disposer 会把路由注销干净；
//   4. 宿主没有 webServer 时 apply() 不抛异常、也不注册路由。
//
// 用法：node scripts/smoke.mjs    （或 npm run smoke）
// ============================================================================

import assert from 'node:assert/strict'
import plugin from '../lib/index.js'

const PLUGIN_NAME = 'dsh-conversation-digest'
const PING_PATH = '/dsh-conversation-digest/ping'

function makeCtx({ withWebServer = true } = {}) {
  /** @type {{ routes: any[], effects: (() => void)[] }} */
  const state = { routes: [], effects: [] }

  const ctx = {
    state,

    get(name) {
      return withWebServer && name === 'webServer' ? ctx.webServer : undefined
    },

    // 桩：真实 cordis 在卸载时调用返回的 disposer
    effect(fn) {
      const dispose = fn()
      state.effects.push(dispose)
      return dispose
    },

    // 桩：只有请求的服务全部存在时才执行回调
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

// —— 1. 正常宿主：注册 + 响应 ——
const ctx = makeCtx()
plugin.apply(ctx)
assert.equal(ctx.state.routes.length, 1, '应当注册且只注册一条路由')

const [route] = ctx.state.routes
assert.equal(route.kind, 'exact')
assert.equal(route.path, PING_PATH)
assert.equal(typeof route.handler, 'function')

const headers = {}
const res = {
  statusCode: 0,
  setHeader(name, value) { headers[name.toLowerCase()] = value },
  end(body) { this.body = body; this.done = true },
}
await route.handler({ method: 'GET', url: route.path, headers: {} }, res)

assert.equal(res.statusCode, 200)
assert.equal(res.done, true)
assert.equal(headers['content-type'], 'application/json; charset=utf-8')

const payload = JSON.parse(res.body)
assert.equal(payload.ok, true)
assert.equal(payload.plugin, PLUGIN_NAME)
assert.match(payload.version, /^\d+\.\d+\.\d+$/, 'version 应当来自 package.json')
assert.equal(typeof payload.uptimeMs, 'number')

// —— 2. 卸载：路由要注销干净 ——
ctx.state.effects[0]()
assert.equal(ctx.state.routes.length, 0, 'disposer 应当把路由注销掉')

// —— 3. 没有 webServer 的宿主：不抛、不注册 ——
const bare = makeCtx({ withWebServer: false })
assert.doesNotThrow(() => plugin.apply(bare))
assert.equal(bare.state.routes.length, 0)

console.log('smoke ok — 自检路由响应示例：')
console.log(JSON.stringify(payload, null, 2))
