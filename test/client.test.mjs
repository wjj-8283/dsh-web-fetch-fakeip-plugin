// 客户端半插件的回归测试：加载构建产物 lib/client.js，在假浏览器环境里跑它的
// factory，用真实 React 渲染设置页并驱动交互（开关、保存、恢复默认、非法输入拦截）。
//
// 需要 react + react-test-renderer（peer/开发依赖）。解析不到时会跳过而不是失败。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

let React, TestRenderer
try {
  React = require('react')
  TestRenderer = require('react-test-renderer')
} catch {
  console.log('skipped: 装好 react 与 react-test-renderer 后本文件会完整运行（npm install）')
  process.exit(0)
}

let pass = 0
const ok = (label, detail = '') => {
  pass++
  console.log('  ok  ', label, detail)
}

// ── 在假浏览器里执行构建产物，捕获 __ModuleLoader__.load 注册项 ──────────────
const code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
let loaded
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
new Function('window', code)(globalThis.window)
assert.ok(loaded, '产物没有调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, '@wjj-8283/dsh-web-fetch-fakeip')
ok('产物遵守 __ModuleLoader__.load({id, factory}) 契约', `id=${loaded.id}`)

const clientModule = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
assert.deepEqual(clientModule.inject, ['slots', 'locale', 'configForms'])
ok('客户端 inject 声明', JSON.stringify(clientModule.inject))

/** 实现 ConfigForm 契约的最小假表单。 */
function makeForm(initial, { writable = true, status = 'ready' } = {}) {
  let snapshot = { status, value: initial, base: undefined, user: undefined, revision: 1, writable, mode: 'host' }
  const listeners = new Set()
  const calls = []
  return {
    calls,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: async (field, value) => {
      calls.push(['set', field, value])
      snapshot = { ...snapshot, value: { ...snapshot.value, [field]: value }, revision: snapshot.revision + 1 }
      listeners.forEach((listener) => listener())
      return true
    },
    unset: async (field) => {
      calls.push(['unset', field])
      const next = { ...snapshot.value }
      delete next[field]
      snapshot = { ...snapshot, value: next, revision: snapshot.revision + 1 }
      listeners.forEach((listener) => listener())
      return true
    },
  }
}

function mount({ value, writable = true, status = 'ready', localeLang = 'zh' } = {}) {
  const form = makeForm(value, { writable, status })
  let registered
  const disposers = []
  const slots = {
    inject: (name, callback) => {
      assert.equal(name, 'settings.section')
      return callback()
    },
    register: (options, Component) => {
      registered = { options, Component }
      return () => {
        registered = undefined
      }
    },
  }
  const locale = { get: () => localeLang, subscribe: () => () => {} }
  const services = { slots, locale, configForms: { get: (id) => {
    assert.equal(id, 'web-fetch-fakeip')
    return form
  } } }
  const ctx = {
    fiber: {},
    get: (name) => services[name],
    effect: (fn) => {
      const dispose = fn()
      disposers.push(dispose)
      return () => dispose?.()
    },
  }
  clientModule.apply(ctx)
  assert.ok(registered, '没有注册 settings.section')
  return { form, registered, dispose: () => disposers.forEach((d) => d?.()) }
}

const DEFAULT_VALUE = { enabled: true, fakeIpRanges: ['198.18.0.0/15', 'fdfe:dcba:9876::/64', '2001:2::/48'] }
const textOf = (tree) => JSON.stringify(tree.toJSON())
const render = (registered) => TestRenderer.create(React.createElement(registered.Component))

// ── 注册契约 ───────────────────────────────────────────────────────────────
{
  const { registered } = mount({ value: DEFAULT_VALUE })
  assert.equal(registered.options.name, 'settings.section')
  assert.equal(registered.options.id, 'web-fetch-fakeip')
  assert.equal(typeof registered.options.order, 'number')
  const label = registered.options.label()
  assert.ok(typeof label === 'string' && label.length > 0)
  ok('注册 settings.section', `id=${registered.options.id} order=${registered.options.order} label="${label}"`)
}
{
  const { registered } = mount({ value: DEFAULT_VALUE, localeLang: 'en' })
  assert.equal(registered.options.label(), 'fake-ip fix')
  ok('导航标签跟随 locale 服务（en）')
}

// ── 渲染各状态 ─────────────────────────────────────────────────────────────
{
  const { registered } = mount({ value: DEFAULT_VALUE })
  const tree = render(registered)
  assert.equal(tree.root.findByType('textarea').props.value, '198.18.0.0/15\nfdfe:dcba:9876::/64\n2001:2::/48')
  assert.equal(tree.root.findByType('input').props.checked, true)
  assert.equal(tree.root.findByType('textarea').props.disabled, false)
  assert.ok(textOf(tree).includes('198.18.0.0/15, fdfe:dcba:9876::/64, 2001:2::/48'), '生效行显示当前段')
  ok('渲染就绪态：开关 + CIDR 文本域 + 生效行')
}
{
  const { registered } = mount({ value: { ...DEFAULT_VALUE, enabled: false } })
  const tree = render(registered)
  assert.equal(tree.root.findByType('input').props.checked, false)
  assert.ok(textOf(tree).includes('未启用'))
  ok('渲染：enabled=false 的生效行')
}
{
  const { registered } = mount({ value: undefined, status: 'unavailable', writable: false })
  const tree = render(registered)
  assert.equal(tree.root.findByType('textarea').props.disabled, true)
  assert.ok(textOf(tree).includes('不可编辑'))
  ok('渲染：unavailable 时禁用并说明')
}
{
  const { registered } = mount({ value: DEFAULT_VALUE, status: 'loading' })
  assert.ok(textOf(render(registered)).includes('正在读取'))
  ok('渲染：loading 态')
}

// ── 交互：写回路径 ─────────────────────────────────────────────────────────
{
  const { form, registered } = mount({ value: DEFAULT_VALUE })
  const tree = render(registered)
  await TestRenderer.act(async () => {
    tree.root.findByType('input').props.onChange({ currentTarget: { checked: false } })
  })
  assert.deepEqual(form.calls, [['set', 'enabled', false]])
  ok('交互：关闭开关 → form.set("enabled", false)')
}
{
  const { form, registered } = mount({ value: DEFAULT_VALUE })
  const tree = render(registered)
  await TestRenderer.act(async () => {
    tree.root.findByType('textarea').props.onChange({ currentTarget: { value: '10.0.0.0/8\n\n172.16.0.0/12  ' } })
  })
  await TestRenderer.act(async () => {
    await tree.root.findAllByType('button')[0].props.onClick()
  })
  assert.deepEqual(form.calls, [['set', 'fakeIpRanges', ['10.0.0.0/8', '172.16.0.0/12']]])
  assert.ok(textOf(tree).includes('已保存'))
  ok('交互：保存 CIDR（去空行与首尾空格）并提示')
}
{
  const { form, registered } = mount({ value: DEFAULT_VALUE })
  const tree = render(registered)
  await TestRenderer.act(async () => {
    tree.root.findByType('textarea').props.onChange({ currentTarget: { value: 'banana\n10.0.0.0/8' } })
  })
  await TestRenderer.act(async () => {
    await tree.root.findAllByType('button')[0].props.onClick()
  })
  assert.equal(form.calls.length, 0, '非法输入不应写回')
  assert.ok(textOf(tree).includes('不是合法 CIDR：'))
  ok('交互：非法 CIDR 被拦下，不写回')
}
{
  // 前缀越界 / 裸地址 / 垃圾输入都要拦住 —— 写进 patch 的值会进 schema 校验，
  // 手误不该变成启动期的坏配置。
  const { form, registered } = mount({ value: DEFAULT_VALUE })
  const tree = render(registered)
  for (const bad of ['999.1.1.1/8', '198.18.0.0/40', '198.18.0.0', 'not-a-cidr']) {
    await TestRenderer.act(async () => {
      tree.root.findByType('textarea').props.onChange({ currentTarget: { value: bad } })
    })
    await TestRenderer.act(async () => {
      await tree.root.findAllByType('button')[0].props.onClick()
    })
  }
  assert.equal(form.calls.length, 0, `非法输入被放行：${JSON.stringify(form.calls)}`)
  ok('交互：越界前缀 / 裸地址 / 垃圾输入全部拦住')
}
{
  const { form, registered } = mount({ value: DEFAULT_VALUE })
  const tree = render(registered)
  await TestRenderer.act(async () => {
    await tree.root.findAllByType('button')[1].props.onClick()
  })
  assert.deepEqual(form.calls, [['unset', 'fakeIpRanges']])
  ok('交互：恢复默认 → form.unset("fakeIpRanges")')
}

// ── 卸载 ───────────────────────────────────────────────────────────────────
{
  const { dispose } = mount({ value: DEFAULT_VALUE })
  dispose()
  ok('卸载：effect disposer 可释放')
}

console.log(`\n${pass} 项通过（客户端，真实构建产物 + 真 React 渲染/交互）`)
