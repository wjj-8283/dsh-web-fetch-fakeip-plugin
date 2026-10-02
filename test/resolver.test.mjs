// 单测：buildFakeIpMatcher + createFakeIpResolver（不依赖框架包）
import assert from 'node:assert/strict'
import {
  DEFAULT_FAKE_IP_RANGES,
  buildFakeIpMatcher,
  createFakeIpResolver,
} from '../lib/resolver.js'

let pass = 0
const ok = (label, fn) => {
  fn()
  pass++
  console.log('  ok  ', label)
}

console.log('# buildFakeIpMatcher')
const isFakeIp = buildFakeIpMatcher(DEFAULT_FAKE_IP_RANGES)
const cases = [
  // [地址, 是否属于 fake-ip 段]
  ['198.18.0.1', true],
  ['198.18.0.4', true],
  ['198.19.255.254', true],
  ['198.17.255.255', false],
  ['198.20.0.0', false],
  ['fdfe:dcba:9876::1', true],
  ['fdfe:dcba:9876:0:1::5', true],
  ['2001:2::f', true],
  ['2001:2:0:1::5', true],
  ['2001:3::1', false],
  ['::ffff:198.18.0.4', true],
  ['::ffff:8.8.8.8', false],
  ['127.0.0.1', false],
  ['10.0.0.1', false],
  ['172.16.0.1', false],
  ['192.168.1.1', false],
  ['169.254.169.254', false],
  ['100.121.197.100', false],
  ['0.0.0.0', false],
  ['fd00::1', false],
  ['2606:4700:3035::6815:2ba8', false],
  ['[198.18.0.4]', true],
  ['not-an-ip', false],
]
for (const [address, expected] of cases) {
  ok(`${address.padEnd(28)} -> ${expected}`, () => assert.equal(isFakeIp(address), expected))
}
ok('非法 CIDR 会抛错', () => assert.throws(() => buildFakeIpMatcher(['banana'])))
ok('非法前缀长度会抛错', () => assert.throws(() => buildFakeIpMatcher(['198.18.0.0/99'])))

console.log('\n# createFakeIpResolver')
const blocked = Object.assign(new Error('URL hostname "x" resolves to a non-public IP address'), { code: 'WEB_BLOCKED_URL' })
const timeout = Object.assign(new Error('web fetch timed out'), { code: 'WEB_FETCH_TIMEOUT' })
const lookupOf = (entries) => async () => entries

const run = async (original, entries, hostname = 'mpv.io', lookupImpl) => {
  const resolver = createFakeIpResolver(original, {
    ranges: DEFAULT_FAKE_IP_RANGES,
    lookup: lookupImpl ?? lookupOf(entries),
  })
  try {
    return { ok: true, value: await resolver(hostname, undefined) }
  } catch (error) {
    return { ok: false, code: error.code, message: error.message }
  }
}

const checks = []
checks.push(
  ok('原逻辑成功时原样返回，不重复解析', async () => {
    let called = 0
    const value = await createFakeIpResolver(async () => [{ address: '8.8.8.8', family: 4 }], {
      lookup: async () => {
        called++
        return []
      },
    })('example.com', undefined)
    assert.deepEqual(value, [{ address: '8.8.8.8', family: 4 }])
    assert.equal(called, 0)
  }),
)

// 异步断言集中处理
const asyncCases = [
  {
    label: '整组都是 fake-ip -> 放行',
    original: async () => {
      throw blocked
    },
    entries: [{ address: '198.18.0.4', family: 4 }, { address: '2001:2::f', family: 6 }],
    expect: { ok: true, value: [{ address: '198.18.0.4', family: 4 }, { address: '2001:2::f', family: 6 }] },
  },
  {
    label: '有真实公网 IP 混在 fake-ip 里 -> 维持拒绝',
    original: async () => {
      throw blocked
    },
    entries: [{ address: '198.18.0.4', family: 4 }, { address: '8.8.8.8', family: 4 }],
    expect: { ok: false, code: 'WEB_BLOCKED_URL' },
  },
  {
    label: '只有真实公网 IP -> 维持拒绝',
    original: async () => {
      throw blocked
    },
    entries: [{ address: '8.8.8.8', family: 4 }],
    expect: { ok: false, code: 'WEB_BLOCKED_URL' },
  },
  {
    label: '内网地址 -> 维持拒绝',
    original: async () => {
      throw blocked
    },
    entries: [{ address: '10.0.0.1', family: 4 }],
    expect: { ok: false, code: 'WEB_BLOCKED_URL' },
  },
  {
    label: 'link-local 元数据地址 -> 维持拒绝',
    original: async () => {
      throw blocked
    },
    entries: [{ address: '169.254.169.254', family: 4 }],
    expect: { ok: false, code: 'WEB_BLOCKED_URL' },
  },
  {
    label: '别的错误码（超时）原样透传',
    original: async () => {
      throw timeout
    },
    entries: [{ address: '198.18.0.4', family: 4 }],
    expect: { ok: false, code: 'WEB_FETCH_TIMEOUT' },
  },
  {
    label: '重新解析失败时抛回原错误',
    original: async () => {
      throw blocked
    },
    lookupImpl: async () => {
      throw new Error('EAI_AGAIN')
    },
    expect: { ok: false, code: 'WEB_BLOCKED_URL' },
  },
  {
    label: '解析结果为空时抛回原错误',
    original: async () => {
      throw blocked
    },
    entries: [],
    expect: { ok: false, code: 'WEB_BLOCKED_URL' },
  },
  {
    label: 'IP 字面量 198.18.0.4 -> 放行（不走 DNS）',
    original: async () => {
      throw blocked
    },
    hostname: '198.18.0.4',
    entries: null,
    lookupImpl: async () => {
      throw new Error('should not be called')
    },
    expect: { ok: true, value: [{ address: '198.18.0.4', family: 4 }] },
  },
  {
    label: 'IP 字面量 127.0.0.1 -> 维持拒绝',
    original: async () => {
      throw blocked
    },
    hostname: '127.0.0.1',
    entries: null,
    lookupImpl: async () => {
      throw new Error('should not be called')
    },
    expect: { ok: false, code: 'WEB_BLOCKED_URL' },
  },
]

for (const item of asyncCases) {
  const result = await run(item.original, item.entries, item.hostname ?? 'mpv.io', item.lookupImpl)
  if (item.expect.ok) {
    assert.equal(result.ok, true, `${item.label}: 期望放行，实际 ${JSON.stringify(result)}`)
    assert.deepEqual(result.value, item.expect.value)
  } else {
    assert.equal(result.ok, false, `${item.label}: 期望拒绝，实际放行`)
    assert.equal(result.code, item.expect.code, `${item.label}: 错误码不符`)
  }
  pass++
  console.log('  ok  ', item.label)
}

console.log(`\n${pass} 项断言全部通过`)
