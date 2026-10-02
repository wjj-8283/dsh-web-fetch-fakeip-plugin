// @wjj-8283/dsh-web-fetch-fakeip — node half。
//
// 解决的问题：Clash / mihomo 以 TUN + fake-ip 运行时，`web_fetch` 报
//   URL hostname "mpv.io" resolves to a non-public IP address
// 而同一台机器上的浏览器、curl、web_search 都正常（fake-ip 由 TUN 反查域名后
// 代为连接）。dsh 的公网地址校验把 fake-ip 当成 SSRF 目标拒掉了。
//
// 做法：不新增 provider、不改任何配置。`@deepseek-ai/dsh-web-fetch-http` 的
// `HttpFetchProvider` 把解析器放在实例属性 `resolveAddresses` 上（其自身的测试
// 也是从这里注入的），本插件就地把它包一层，只在"原逻辑以 WEB_BLOCKED_URL 拒绝
// 且整组地址都落在 fake-ip 保留段内"时放行。详见 ./resolver.js。
//
// 补丁是可逆的：插件被禁用或重载时，被包裹的 provider 会恢复原行为。

import z from '@deepseek-ai/schemastery'
import { DEFAULT_FAKE_IP_RANGES, buildFakeIpMatcher, createFakeIpResolver } from './resolver.js'

/** cordis 插件名，用于加载器诊断。 */
export const name = 'web-fetch-fakeip'

/** 依赖 `ctx.web` 服务：provider 注册在它上面。 */
export const inject = ['web']

export const Config = z.object({
  // `.volatile()`：把字段开放给 `ctx.settings`，于是可以在「设置」界面里改，
  // 写入会落到当前 profile 的 Cordis patch（cordis.patch.yml），不再需要手工编辑。
  enabled: z.boolean().default(true).volatile(),
  fakeIpRanges: z.array(z.string()).default([...DEFAULT_FAKE_IP_RANGES]).volatile(),
})

/** 打标用的 symbol，避免重复包装同一个 provider。 */
const PATCHED = Symbol.for('dsh.web-fetch-fakeip.patched')

/**
 * 就地包装一个 fetch provider 的地址解析器。同一个 provider 只包装一次。
 * @param provider - 注册进 `ctx.web` 的 provider。
 * @param config - 解析后的插件配置。
 * @returns 撤销本次包装的函数；没包装（已包装过 / 不是目标 provider）时返回 undefined。
 */
export function patchFetchProvider(provider, config) {
  if (provider === null || provider === undefined) return undefined
  if (typeof provider.resolveAddresses !== 'function') return undefined
  if (provider[PATCHED] === true) return undefined
  const original = provider.resolveAddresses
  const wrapped = createFakeIpResolver(original, { ranges: config.fakeIpRanges })
  provider.resolveAddresses = wrapped
  Object.defineProperty(provider, PATCHED, { value: true, enumerable: false, configurable: true, writable: true })
  return function unpatch() {
    // 期间被别的代码替换过就不再回滚，避免踩掉别人的补丁。
    if (provider.resolveAddresses !== wrapped) return
    provider.resolveAddresses = original
    delete provider[PATCHED]
  }
}

export function apply(ctx, config) {
  if (!config.enabled) return

  // 设置界面可以直接改 fakeIpRanges，所以非法值不能让它抛错：entry 一旦 apply 失败
  // 就不在 settings 的 describe 里，设置页上反而看不到、改不回来。回落到默认段并明确报错。
  let ranges = config.fakeIpRanges
  try {
    buildFakeIpMatcher(ranges)
  } catch (error) {
    ctx.logger.error(
      `web-fetch-fakeip: fakeIpRanges 非法（${error.message}），本次回落到默认段 ${DEFAULT_FAKE_IP_RANGES.join(', ')}；请在「设置」里修正。`,
    )
    ranges = [...DEFAULT_FAKE_IP_RANGES]
  }
  const effective = { ...config, fakeIpRanges: ranges }

  /** provider -> 撤销函数。 */
  const patches = new Map()

  const patchOne = (provider) => {
    if (patches.has(provider)) return false
    const unpatch = patchFetchProvider(provider, effective)
    if (unpatch === undefined) return false
    patches.set(provider, unpatch)
    return true
  }

  ctx.effect(() => {
    const service = ctx.web
    // 1) 立刻补丁：bundle 顺序上 dsh-base 的 web-fetch-http 通常已经注册好了。
    let count = 0
    for (const provider of service.fetchProviders.values()) if (patchOne(provider)) count++

    // 2) 兜底：web-fetch-http 之后重新加载（改配置 / 热重载）会注册新实例。
    //    wrapper 装不上（service 被冻结等）时静默降级，不影响插件加载。
    const own = service.registerFetchProvider
    const hadOwn = Object.prototype.hasOwnProperty.call(service, 'registerFetchProvider')
    let wrapped = false
    try {
      service.registerFetchProvider = function registerFetchProvider(provider) {
        patchOne(provider)
        return own.call(this, provider)
      }
      wrapped = true
    } catch {
      /* 装不上 wrapper 就只靠上面的立即补丁 */
    }

    ctx.logger.info(
      `web-fetch-fakeip: 已接管 ${count} 个 fetch provider 的公网地址校验（放行 fake-ip 段：${ranges.join(', ')}）`,
    )

    return () => {
      if (wrapped) {
        if (hadOwn) service.registerFetchProvider = own
        else delete service.registerFetchProvider
      }
      for (const unpatch of patches.values()) unpatch()
      patches.clear()
    }
  }, 'web-fetch-fakeip: relax the public-address check for fake-ip ranges')

  // 本插件自带设置页（见 dsh.client / src/client.js），所以声明不使用框架的
  // 自动生成页。`settings` 服务没挂载时这个子 fiber 不运行，插件照常工作。
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(
      () => sctx.settings.configure({ auto: false }, ctx.fiber),
      'web-fetch-fakeip: 声明自有设置页（关闭自动生成页）',
    )
  })
}
