// @wjj-8283/dsh-web-fetch-fakeip — 地址校验接管（纯逻辑，无 cordis 依赖）。
//
// 背景：`@deepseek-ai/dsh-web-fetch-http` 在直连前会把 hostname 解析一次，并要求
// 结果集里**每一个**地址都是全局可达的 unicast 地址，否则抛
// `WEB_BLOCKED_URL: URL hostname "..." resolves to a non-public IP address`。
// 当 Clash/mihomo 以 TUN + fake-ip 模式运行时，`getaddrinfo` 返回的是
// fake-ip 池里的地址（198.18.0.0/15 或 AAAA 池），于是这条校验必然失败，
// 而同一台机器上浏览器、curl、web_search 全都正常——因为 fake-ip 本身是可用的：
// TUN 会按该地址反查出域名并代为连接。
//
// 本模块把 provider 实例上的 `resolveAddresses` 包一层：**原逻辑优先**，只有
// 原逻辑以 WEB_BLOCKED_URL 拒绝、且重新解析后确认"结果集全部落在 fake-ip 段内"
// 时才放行。这样 SSRF 防护对 127.0.0.1 / 10.x / 192.168.x / 169.254.x 等等仍然
// 完全生效，只有 TUN 自己造出来的地址被豁免。

import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

/**
 * 默认豁免的地址段：全部是"公网上不可能作为真实目的地存在"的保留段，
 * 只可能由本机 TUN 的 fake-ip 池产生。
 */
export const DEFAULT_FAKE_IP_RANGES = Object.freeze([
  '198.18.0.0/15', // RFC 2544 benchmarking；Clash / mihomo 默认 fake-ip-range 198.18.0.1/16
  'fdfe:dcba:9876::/64', // Clash Verge 默认 fake-ip-range6
  '2001:2::/48', // RFC 5180 benchmarking；Clash Verge 另一处 fake-ip-range6 2001:2::/64
])

/** 去掉 WHATWG URL 保留的 IPv6 方括号。 */
function stripBrackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/**
 * 把 CIDR 列表编译成地址判定函数。
 * 用 node:net 内置的 BlockList 做前缀匹配，所以本插件不需要 ipaddr.js。
 * @param ranges - CIDR 或裸 IP 字符串数组。
 * @returns 判断某个地址文本是否落在任一豁免段内。
 */
export function buildFakeIpMatcher(ranges = DEFAULT_FAKE_IP_RANGES) {
  const v4 = new BlockList()
  const v6 = new BlockList()
  for (const raw of ranges) {
    const text = String(raw).trim()
    const slash = text.lastIndexOf('/')
    const address = slash === -1 ? text : text.slice(0, slash)
    const bits = slash === -1 ? undefined : Number(text.slice(slash + 1))
    const family = isIP(address)
    if (family === 0) throw new Error(`web-fetch-fakeip: "${raw}" 不是合法的 IP / CIDR`)
    if (bits !== undefined && (!Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128))) {
      throw new Error(`web-fetch-fakeip: "${raw}" 的前缀长度不合法`)
    }
    if (family === 4) v4.addSubnet(address, bits ?? 32, 'ipv4')
    else v6.addSubnet(address, bits ?? 128, 'ipv6')
  }
  return (input) => {
    const address = stripBrackets(String(input))
    const family = isIP(address)
    if (family === 4) return v4.check(address, 'ipv4')
    if (family !== 6) return false
    // IPv4-mapped 的 v6 写法按内嵌 v4 判定，避免绕过豁免（也避免误豁免）。
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
    if (mapped !== null) return v4.check(mapped[1], 'ipv4')
    return v6.check(address, 'ipv6')
  }
}

/** 与 provider 内部一致的一次性解析：IP 字面量直接用，否则走 OS getaddrinfo。 */
async function resolveAll(hostname, signal, lookup) {
  const bare = stripBrackets(hostname)
  const literal = isIP(bare)
  if (literal !== 0) return [{ address: bare, family: literal }]
  if (signal?.aborted) return []
  const entries = await lookup(bare, { all: true, order: 'verbatim' })
  return entries.map((entry) => ({ address: entry.address, family: entry.family }))
}

/**
 * 包装一个 `resolveAddresses` 实现。
 * @param original - provider 原本的解析器（即 publicHttpNetwork.resolve）。
 * @param options - 豁免段与 lookup 实现（测试注入用）。
 * @returns 行为不变、但额外放行"整组都是 fake-ip"的解析器。
 */
export function createFakeIpResolver(original, options = {}) {
  const { ranges = DEFAULT_FAKE_IP_RANGES, lookup = dnsLookup } = options
  const isFakeIp = buildFakeIpMatcher(ranges)
  return async function resolveAddresses(hostname, signal) {
    try {
      return await original(hostname, signal)
    } catch (error) {
      // 只接管"被公网地址校验拒绝"这一种失败；解析超时、无地址、被取消等原样抛。
      if (error?.code !== 'WEB_BLOCKED_URL') throw error
      let addresses
      try {
        addresses = await resolveAll(hostname, signal, lookup)
      } catch {
        throw error
      }
      if (addresses.length === 0) throw error
      // 保守判定：只要有一个地址不在 fake-ip 段内，就保持原来的拒绝。
      for (const { address } of addresses) if (!isFakeIp(address)) throw error
      return addresses
    }
  }
}
