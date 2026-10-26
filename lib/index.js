// ============================================================================
// dsh-prompt-lint —— 宿主半区
// ============================================================================
// 「提示词体检」：会话复盘 → 发送前优化 → 提示词资产库，
// 三者共用一份持久化的「个人提示词档案」。
//
// 这一层只做装配：
//   · 需要 webServer 才能注册 /pwb/* 路由，用 ctx.inject 局部等待；
//   · 其余能力（llm / agentDefaultModel）在请求到来时用 ctx.get 取，
//     缺了就明确报错，而不是让整个插件起不来；
//   · 所有注册都进 ctx.effect，卸载时干净释放。
// ============================================================================

import { registerRoutes } from './routes.mjs'

const PLUGIN_NAME = 'dsh-prompt-lint'

export default {
  name: PLUGIN_NAME,

  apply(ctx) {
    const disposers = []

    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (err) {}
      }
      disposers.length = 0
    })

    ctx.inject(['webServer'], (scoped) => {
      try {
        disposers.push(registerRoutes(ctx, { webServer: scoped.webServer }))
        console.info(`[${PLUGIN_NAME}] 已加载，API 前缀 /pwb（档案在 $DSH_HOME/prompt-workbench/profile.json）`)
      } catch (err) {
        // 路由注册失败不应该拖垮宿主：明确报错，插件退化为不提供功能
        console.error(`[${PLUGIN_NAME}] 路由注册失败：${(err && err.message) || err}`)
      }
    })
  },
}
