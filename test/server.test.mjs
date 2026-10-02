// 服务端半插件的回归测试：volatile 标记、自有设置页声明、接管与撤销、
// enabled:false 的短路、以及非法 fakeIpRanges 的回落。
//
// 需要 `@deepseek-ai/schemastery` 能被解析（dsh 运行时由安装副本提供）。裸 node
// 下解析不到时本文件会跳过而不是失败 —— 跑 `npm install` 装 devDependencies 或
// 在 dsh profile 的拦截层里执行即可完整运行。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

let apply, Config
try {
  ;({ apply, Config } = await import('../lib/index.js'))
} catch (error) {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('schemastery')) {
    console.log('skipped: 解析不到 @deepseek-ai/schemastery（装好依赖或在 dsh 环境里跑即可）')
    process.exit(0)
  }
  throw error
}

let pass = 0
const ok = (label, detail = '') => {
  pass++
  console.log('  ok  ', label, detail)
}

/** 递归收集 schema JSON 里所有 meta.volatile 的节点。 */
function volatileNodes(node, seen = new Set()) {
  if (node === null || typeof node !== 'object' || seen.has(node)) return []
  seen.add(node)
  const out = node.meta?.volatile === true ? [node] : []
  for (const value of Object.values(node)) out.push(...volatileNodes(value, seen))
  return out
}

// settings.describe() 只收录「有 volatile 字段」的 entry，所以这是能被设置页
// 看见的前提。
assert.ok(volatileNodes(Config.toJSON()).length >= 2, '两个字段都应是 volatile')
ok('Config 字段标了 volatile', `volatile 节点数=${volatileNodes(Config.toJSON()).length}`)

const FAILING = (hostname) => {
  const error = new Error(`URL hostname "${hostname}" resolves to a non-public IP address`)
  error.code = 'WEB_BLOCKED_URL'
  throw error
}

function mount({ enabled = true, fakeIpRanges = ['198.18.0.0/15'] } = {}) {
  const logs = { info: [], error: [] }
  const configureCalls = []
  const disposers = []
  let injectDeps
  const provider = { id: 'http', available: () => true, resolveAddresses: async (h) => FAILING(h) }
  const childCtx = {
    effect: (fn) => {
      const dispose = fn()
      disposers.push(dispose)
      return () => dispose?.()
    },
    settings: {
      configure: (presentation, owner) => {
        configureCalls.push({ presentation, owner })
        return () => {}
      },
    },
  }
  const ctx = {
    fiber: { sentinel: 'plugin-fiber' },
    web: {
      fetchProviders: new Map([['http', provider]]),
      registerFetchProvider(candidate) {
        this.fetchProviders.set(candidate.id, candidate)
        return () => this.fetchProviders.delete(candidate.id)
      },
    },
    effect: (fn) => {
      const dispose = fn()
      disposers.push(dispose)
      return () => dispose?.()
    },
    inject: (deps, callback) => {
      injectDeps = deps
      callback(childCtx)
      return {}
    },
    logger: { info: (m) => logs.info.push(m), error: (m) => logs.error.push(m), warn: () => {} },
  }
  apply(ctx, { enabled, fakeIpRanges })
  return { ctx, provider, logs, configureCalls, injectDeps, dispose: () => disposers.forEach((d) => d?.()) }
}

const attempt = async (provider, hostname) => {
  try {
    return { ok: true, value: await provider.resolveAddresses(hostname, undefined) }
  } catch (error) {
    return { ok: false, code: error.code }
  }
}

{
  const mounted = mount()
  assert.deepEqual(mounted.injectDeps, ['settings'], '应只依赖 settings 服务')
  assert.equal(mounted.configureCalls.length, 1)
  assert.deepEqual(mounted.configureCalls[0].presentation, { auto: false }, '自带设置页应关闭自动生成页')
  assert.equal(mounted.configureCalls[0].owner, mounted.ctx.fiber, '策略必须归属插件自己的 fiber')
  ok('声明自有设置页策略', 'configure({auto:false}, ctx.fiber)')

  assert.deepEqual((await attempt(mounted.provider, '198.18.0.4')).value, [{ address: '198.18.0.4', family: 4 }])
  ok('provider 被接管', '198.18.0.4 放行')
  assert.equal((await attempt(mounted.provider, '8.8.8.8')).code, 'WEB_BLOCKED_URL')
  ok('非 fake-ip 地址仍按原逻辑拒绝')

  mounted.dispose()
  assert.equal((await attempt(mounted.provider, '198.18.0.4')).ok, false)
  ok('卸载后恢复原行为')
}

{
  const mounted = mount({ enabled: false })
  assert.equal(mounted.configureCalls.length, 0)
  assert.equal(mounted.injectDeps, undefined)
  assert.equal((await attempt(mounted.provider, '198.18.0.4')).ok, false)
  ok('enabled:false 时短路：不接管、不声明、不报错')
}

{
  // 设置页能直接改这个字段，所以手误不能让它抛错：entry 一旦 apply 失败就不在
  // settings 的 describe 里，设置页上反而看不到、改不回来。
  const mounted = mount({ fakeIpRanges: ['banana'] })
  assert.equal(mounted.logs.error.length, 1, '应记录一条错误')
  assert.ok(mounted.logs.error[0].includes('非法'), mounted.logs.error[0])
  assert.equal((await attempt(mounted.provider, '198.19.9.9')).ok, true, '应回落到默认段 198.18.0.0/15')
  assert.equal((await attempt(mounted.provider, '2001:2::f')).ok, true, '默认段含 2001:2::/48')
  ok('非法 ranges 不抛错：回落默认段并报错')
}

{
  const mounted = mount({ fakeIpRanges: ['203.0.113.0/24'] })
  assert.ok(mounted.logs.info[0].includes('203.0.113.0/24'), mounted.logs.info[0])
  ok('启动日志反映生效段')
}

console.log(`\n${pass} 项通过（服务端）`)
