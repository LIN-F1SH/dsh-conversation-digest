// ============================================================================
// dsh-conversation-digest —— 宿主半区（host half）
// ============================================================================
// 当前是「骨架阶段」：不做业务，只注册一条自检路由，用来证明这条链路是好的：
//
//   包装得上 → 宿主加载插件 → 服务注入成功 → 路由可访问 → 卸载时干净注销
//
// 摘要与优化的实现位置已经用 TODO 标出来了，等需求定稿再填。
//
// 三条别踩的约定（照现有社区插件的实际写法总结）：
//   1. package.json 的 `dsh.bundle.patch` 指向 cordis.patch.yml —— 宿主靠它知道怎么挂载；
//   2. 插件入口是默认导出对象的 apply(ctx)，ctx 是 cordis 上下文；
//   3. 需要宿主服务时用 `ctx.inject([...], cb)` **局部等待**，不要写对象级 `inject` ——
//      对象级 inject 会把整个 apply() 推迟到服务就绪之后，而桌面端宿主是在启动时
//      一次性收集注入表的，晚到的订阅就永远进不去。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// lib/index.js → 包根目录。写成相对定位，插件被链接安装或放进 node_modules 都能用。
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_NAME = 'dsh-conversation-digest'
const PING_PATH = '/dsh-conversation-digest/ping'

// 版本号只从 package.json 读，避免和发布版本对不上。
function readOwnVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return String(pkg.version || '0.0.0')
  } catch (err) {
    return '0.0.0'
  }
}

export default {
  name: PLUGIN_NAME,

  apply(ctx) {
    const startedAt = Date.now()
    // 自己注册的一切都记下来，卸载时统一释放（effect 是 cordis 的生命周期钩子）。
    const disposers = []

    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose() } catch (err) {}
      }
      disposers.length = 0
    })

    // 只在 webServer 就绪后注册路由。服务不存在时这段根本不会执行，
    // 插件也不会因此起不来 —— 这比把 webServer 写进 inject 更抗宿主版本差异。
    ctx.inject(['webServer'], (scoped) => {
      disposers.push(scoped.webServer.register({
        kind: 'exact',
        path: PING_PATH,
        handler: (_req, res) => {
          const payload = {
            ok: true,
            plugin: PLUGIN_NAME,
            version: readOwnVersion(),
            uptimeMs: Date.now() - startedAt,
            node: process.version,
            now: new Date().toISOString(),
          }
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(payload, null, 2))
        },
      }))

      try {
        console.info(`[${PLUGIN_NAME}] 已加载 v${readOwnVersion()}，自检路由 GET ${PING_PATH}`)
      } catch (err) {}
    })

    // TODO(功能)：对话摘要与优化。
    //   落地时大致需要：读会话事件（ctx.on('session/event', …)）→ 聚合 → 调模型总结 → 输出。
    //   在那之前先把「读得到、算得出、展示得出来」三段各自跑通，别一次写完。
  },
}
