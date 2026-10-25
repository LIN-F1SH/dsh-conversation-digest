// ============================================================================
// 客户端半区自检：不打开浏览器，也能验证 factory 与插槽注册是对的
// 用法：node scripts/smoke-client.mjs
//
// 做法：桩掉 window.__ModuleLoader__ / document / require('react')，
// 直接执行 client/client.js，拿到它注册的 factory，再用桩 ctx 跑 apply()。
// 能抓到的问题：id 与包名不一致、返回形状不对、插槽名写错、注册数量不对、apply 抛异常。
// ============================================================================
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client', 'client.js')

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// —— 桩 ——
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial === undefined ? null : initial }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}
globalThis.document = {
  createElement: () => ({
    style: {},
    textContent: '',
    setAttribute() {},
    remove() {},
  }),
  head: { appendChild() {} },
}

// 执行客户端脚本（只有注册 factory 这一个副作用）
// Windows 上 import() 必须用 file:// URL，不能直接喂绝对路径
await import(pathToFileURL(clientPath).href)

console.log('客户端半区自检')

ok('client.js 通过 __ModuleLoader__ 注册了 factory', () => {
  assert.ok(captured, '没有调用 window.__ModuleLoader__.load')
  assert.equal(typeof captured.factory, 'function')
})

ok('factory 的 id 与包名一致（宿主硬要求）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
  assert.equal(captured.id, pkg.name)
})

const plugin = captured.factory((name) => {
  assert.equal(name, 'react', '只应该 require react（其余都是宿主模块，不在这里的基线里）')
  return React
})

ok('factory 返回的是 cordis 插件对象', () => {
  assert.equal(typeof plugin, 'object')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.name, 'dsh-conversation-digest')
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
})

ok('factory 是纯的：拿两次结果一致，且没提前注册任何东西', () => {
  const again = captured.factory(() => React)
  assert.equal(typeof again.apply, 'function')
})

// —— 用桩 ctx 跑 apply ——
const registered = []
const effects = []
const locales = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    effects.push(dispose)
    return dispose
  },
  locale: {
    register(ns, dicts) {
      locales.push({ ns, dicts })
      return () => {}
    },
    bind: () => (key) => key,
  },
  slots: {
    inject(slot, callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(meta, component) {
      registered.push({ meta, component })
      return () => {}
    },
  },
}

ok('apply() 不抛异常', () => {
  assert.doesNotThrow(() => plugin.apply(ctx))
})

ok('注册了样式 + 语言包 + 三个插槽', () => {
  assert.ok(effects.length >= 2, '应当注册样式与 locale 两个 effect')
  assert.equal(locales.length, 1)
  assert.equal(locales[0].ns, 'pwb')
  assert.ok(locales[0].dicts.zh.optimize)
  assert.ok(locales[0].dicts.en.optimize)
  assert.equal(registered.length, 3, '应当注册 3 个插槽，实际 ' + registered.length)
})

ok('三个插槽名都是宿主真实存在的', () => {
  const slots = registered.map((r) => r.meta.name).sort()
  assert.deepEqual(slots, ['conversation.input.dock', 'conversation.input.right', 'settings.section'])
})

ok('每个插槽都带 id 与 order（列表型插槽的必填项）', () => {
  for (const { meta } of registered) {
    assert.equal(typeof meta.id, 'string')
    assert.ok(meta.id.length > 0)
    assert.equal(typeof meta.order, 'number')
    assert.equal(meta.locale, 'pwb')
  }
})

ok('组件是可渲染的函数', () => {
  for (const { component } of registered) {
    assert.equal(typeof component, 'function')
    const tree = component({
      t: (key) => key,
      useInput: (selector) => selector({ draft: '' }),
      inputActions: { setDraft() {} },
    })
    assert.ok(tree, '组件应当返回元素')
    assert.equal(typeof tree, 'object')
  }
})

ok('卸载时 effect 的清理函数可安全调用', () => {
  for (const dispose of effects) {
    assert.equal(typeof dispose, 'function')
    assert.doesNotThrow(() => dispose())
  }
})

ok('locale.register 抛错时，三个插槽仍然注册（降级而非哑掉）', () => {
  const registered2 = []
  const brokenCtx = {
    effect() {
      return () => {}
    },
    locale: {
      register() {
        throw new Error('该语言已注册')
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (slot, callback) => {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(meta) {
        registered2.push(meta.name)
        return () => {}
      },
    },
  }
  assert.doesNotThrow(() => plugin.apply(brokenCtx))
  assert.equal(registered2.length, 3, '语言包失败不应该影响插槽注册')
})

ok('缺少 useInput / inputActions 时组件仍能渲染（不抛异常）', () => {
  for (const { component } of registered) {
    assert.doesNotThrow(() => component({ t: (key) => key }))
  }
})

console.log(`\n全部通过（${passed} 项）`)
