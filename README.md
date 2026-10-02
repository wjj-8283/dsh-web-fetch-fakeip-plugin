# dsh-web-fetch-fakeip

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 `web_fetch`（网页获取）
在 **Clash / mihomo 的 TUN + fake-ip 模式下正常工作**——不需要设代理环境变量，不需要关 TUN，
不需要把 Clash 的 DNS 改成 `redir-host`。

```
修复前： Error: URL hostname "mpv.io" resolves to a non-public IP address
修复后： Fetched https://mpv.io/manual/master/ (HTTP 200)
```

| | |
|---|---|
| 适用 dsh | 0.2.0-rc.2（已在真实部署上端到端验证） |
| 适用 Node | ≥ 22.19（本机验证于 v24.16.0） |
| 验证平台 | macOS arm64 + Clash Verge TUN（`fake-ip-range: 198.18.0.1/16`） |
| 运行时依赖 | 无第三方依赖，只用 Node 内置的 `node:net` / `node:dns` |
| License | [MIT](LICENSE) |

---

## 目录

- [问题是什么](#问题是什么)
- [它做了什么](#它做了什么)
- [安装](#安装)
- [确认是否生效](#确认是否生效)
- [可选配置](#可选配置)
- [卸载与回滚](#卸载与回滚)
- [故障排查](#故障排查)
- [为什么不换别的做法](#为什么不换别的做法)
- [已知边界](#已知边界)
- [代码结构与测试](#代码结构与测试)
- [License](#license)

---

## 问题是什么

dsh 的 `web_fetch` 在直连前会把 hostname **解析一次**，并要求结果集里 **每一个**地址都是
全局可达的 unicast 地址，否则抛 `WEB_BLOCKED_URL`：

```js
// @deepseek-ai/dsh-web-fetch-http/lib/index.js:70
if (!isPublicIpAddress(entry.address))
  throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, "WEB_BLOCKED_URL")
```

当 Clash 以 `TUN + enhanced-mode: fake-ip` 运行时，`getaddrinfo` 返回的是 fake-ip 池里的地址
（IPv4 默认 `198.18.0.0/15`，AAAA 池另有 `fdfe:dcba:9876::/64`、`2001:2::/64`）。这些段在
ipaddr.js 里被判为 `reserved` / `uniqueLocal` / `benchmarking`，于是校验**必然**失败。

而 fake-ip **本身是可用的**：TUN 收到连向该地址的连接后，会按 fake-ip 反查出域名并代为连接，
TLS SNI 仍然是原域名（dsh 保留了 URL hostname）。所以同一台机器上浏览器、curl、`web_search`
全都正常，**只有 `web_fetch` 挂**——因为公网地址校验只存在于 `dsh-web-fetch-http` 这一个包。

一个容易忽略的细节：解析结果里 IPv4 和 IPv6 **都**是 fake IP，而校验是"结果集里任一地址不合法
就整体拒绝"，所以只豁免 IPv4 段是不够的，AAAA 那半边一样会拦。

## 它做了什么

**不新增 provider，不改任何配置。** `HttpFetchProvider` 把解析器放在实例属性
`resolveAddresses` 上（该包自身的测试也是从这个位置注入的），本插件就地把它包一层：

1. **原逻辑优先**——先调用原本的解析器，正常返回就原样返回，行为零变化；
2. 只有在原逻辑以 `WEB_BLOCKED_URL` 拒绝、且重新解析后确认**整组地址都落在 fake-ip 保留段内**时，
   才放行这组地址；
3. 结果里只要有一个地址不属于 fake-ip 段（真实公网 IP 混入、内网地址、link-local 元数据地址……），
   就保持原来的拒绝。

因此 SSRF 防护对 `127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、
`169.254.169.254`、`::1`、Tailscale CGNAT `100.64.0.0/10` 等等**完全照旧**，被豁免的只有 TUN
自己造出来的地址。没有 fake-ip 时插件完全惰性。

默认豁免段（全部是"公网上不可能作为真实目的地存在"的保留段）：

| 段 | 来源 |
|---|---|
| `198.18.0.0/15` | RFC 2544 benchmarking；Clash / mihomo 默认 `fake-ip-range: 198.18.0.1/16` |
| `fdfe:dcba:9876::/64` | Clash Verge 默认 `fake-ip-range6` |
| `2001:2::/48` | RFC 5180 benchmarking；Clash Verge 另一处 `fake-ip-range6: 2001:2::/64` |

补丁是**可逆**的：插件被禁用或重载时，被包裹的 provider 会恢复原行为（若期间别的代码替换了
`resolveAddresses`，则不回滚，避免踩掉别人的补丁）。

## 安装

### 方式 A：一行命令从 GitHub 装（推荐）

```bash
dsh plugin --profile <profile> add github:wjj-8283/dsh-web-fetch-fakeip-plugin
```

**这一条就够了，不需要手工编辑任何文件。** `dsh plugin` 不是裸 pnpm——它在 pnpm 成功后还会做一次
协调：**凡是本次新装进来、且在 package.json 里声明了 `dsh.bundle` 的依赖，会被自动追加进
`dsh.profile.bundles`**（没有 `dsh.bundle` 的包只会得到一条
`declares no dsh.bundle — installed as a plain dependency, not a profile layer` 警告）。
实测 `dsh plugin --profile <profile> add …` 后的 package.json 变化：

```diff
   "dependencies": {
+    "@wjj-8283/dsh-web-fetch-fakeip": "github:wjj-8283/dsh-web-fetch-fakeip-plugin"
   },
   "dsh": { "profile": { "bundles": [
     "@deepseek-ai/dsh-base",
+    "@wjj-8283/dsh-web-fetch-fakeip"
   ] } }
```

卸载同理，`remove` 会把它从 bundles 里摘掉：

```bash
dsh plugin --profile <profile> remove @wjj-8283/dsh-web-fetch-fakeip
```

装完直接重启 dsh 即可（`add` 已经跑过安装）。

### 方式 B：克隆到本地用 `link:`

```bash
git clone https://github.com/wjj-8283/dsh-web-fetch-fakeip-plugin.git ~/repos/dsh-web-fetch-fakeip-plugin
```

编辑 `$DSH_HOME/profiles/<profile>/package.json`（Web UI 用的 profile 通常叫 `web`），
**两处都要写**：

```jsonc
{
  "dependencies": {
    // ① 依赖：link: 后面是上一步克隆出来的绝对路径
    "@wjj-8283/dsh-web-fetch-fakeip": "link:/Users/you/repos/dsh-web-fetch-fakeip-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        // ② bundle：必须自己写，见下面的说明
        "@wjj-8283/dsh-web-fetch-fakeip"
      ]
    }
  }
}
```

> **为什么这条路径要自己写 bundles，而方式 A 不用？** 协调逻辑只处理**本次操作新增**的依赖。
> 方式 B 是先手工把依赖写进 package.json、再跑 `install`，此时插件早已在依赖列表里，于是被跳过；
> 方式 A 是先 `add` 再由 dsh 补写，正好命中"新增"分支。
>
> 另外 bundle 列表决定 patch 层的应用顺序，而本插件的挂载方式正是自己 bundle 里的
> `cordis.patch.yml` 做一次 `insert`。用 `dsh --profile <profile> --dump-config` 能看到
> `# == @wjj-8283/dsh-web-fetch-fakeip` 这一行，确认 patch 层生效。

然后安装并重启：

```bash
dsh plugin --profile <profile> install
```

### 启动后确认

无论走哪条路，重启 dsh 后启动日志里都会出现（`ctx.logger.info`）：

```
web-fetch-fakeip: 已接管 1 个 fetch provider 的公网地址校验（放行 fake-ip 段：198.18.0.0/15, fdfe:dcba:9876::/64, 2001:2::/48）
```

### Windows 注意

- 走 `link:` 时路径用正斜杠，例如 `"link:D:/repos/dsh-web-fetch-fakeip-plugin"`。
- `package.json` 里的 **`peerDependencies` 不能删**。dsh 的模块路由（`dsh-app-boot` 的
  `routeLinked`）只在插件把自己的框架依赖声明为 peerDependency 时，才把该 import 路由到 dsh
  的安装副本；`link:` 安装的插件目录向上没有任何 `node_modules` 含这些包，删掉后启动会报
  `Cannot find package '@deepseek-ai/schemastery'`。
- Clash 的"系统代理"只写注册表、dsh 不读它——但这不影响本插件，它压根不依赖代理设置。

## 确认是否生效

```bash
# 看解析结果是否 fake-ip（是则说明环境正命中本插件要解决的场景）
node -e "require('node:dns').promises.lookup('mpv.io',{all:true,order:'verbatim'}).then(console.log)"
```

然后在 dsh 里调用一次 `web_fetch`：应当返回 HTTP 200 而不是 `WEB_BLOCKED_URL`。同时建议确认
SSRF 防护仍在——下面这些**必须仍然被拒**：

```
http://127.0.0.1:3080/            -> WEB_BLOCKED_URL
http://169.254.169.254/latest/    -> WEB_BLOCKED_URL
http://10.0.0.1/                  -> WEB_BLOCKED_URL
```

## 可选配置

不配也能用。若你的 Clash 用了非标准 `fake-ip-range`，在 profile 的 patch 层覆盖（例如
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: web-fetch-fakeip
  config:
    enabled: true
    fakeIpRanges:
      - 198.18.0.0/15
      - fdfe:dcba:9876::/64
      - 2001:2::/48
```

`enabled: false` 可临时停用（无需卸载）。配置在启动期校验，非法 CIDR 会立刻报错，而不是等到
第一次抓取才失败。

## 卸载与回滚

**临时停用**：patch 层加

```yaml
- id: web-fetch-fakeip
  config:
    enabled: false
```

**彻底卸载**：方式 A 装的用一条命令（依赖和 bundles 条目会一起清掉）：

```bash
dsh plugin --profile <profile> remove @wjj-8283/dsh-web-fetch-fakeip
```

方式 B（`link:`）装的，删掉 `package.json` 里 dependencies 和 `dsh.profile.bundles` **两处**，再

```bash
dsh plugin --profile <profile> install
```

两条路都要重启 dsh。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 启动日志显示「已接管 **0** 个」 | 上游把 `resolveAddresses` 从 provider 实例上挪走了，插件静默失效。升级 dsh 后遇到请提 issue |
| 启动报 `Cannot find package '@deepseek-ai/schemastery'` | `package.json` 的 `peerDependencies` 被删了，见上文 Windows 注意 |
| 启动报 `patch: entry "web-fetch-fakeip" not found` | `dsh.profile.bundles` 里没有这一条——手工编辑 package.json（方式 B）时最容易漏 |
| `add` 后看到 `declares no dsh.bundle — installed as a plain dependency, not a profile layer` | 装的包里没有 `dsh.bundle` 声明，它不会被当作 profile 层加载。本插件有声明，正常不会出现 |
| 仍然报 `non-public IP address` | ① 插件没加载（需重启 dsh）；② 你的 Clash 用了自定义 `fake-ip-range`，用上面 `fakeIpRanges` 补上 |
| 报 `WEB_PROVIDER_AMBIGUOUS` | 有别的插件也注册了 fetch provider。本插件不新增 provider，不会引发这个错误 |

## 为什么不换别的做法

| 想法 | 为什么不行 |
|---|---|
| 再注册一个 fetch provider | `dsh-web` 在无显式配置时要求"恰好一个可用 provider"，多一个直接 `WEB_PROVIDER_AMBIGUOUS`；用同一个 id 又 `WEB_DUPLICATE_PROVIDER` |
| 设 `ctx.web.fetchProviderId` 指向自己的 provider | 等于替用户改了 provider 选择，且可能被设置界面写回 |
| 设 `http_proxy` / `https_proxy` | 正是本插件要避免的配置；而且对 Clash 的"系统代理"无效——dsh 不读系统代理 |
| 改 Clash DNS 为 `redir-host` | 影响全机所有程序，同样属于"别的配置" |
| 关掉 TUN | 同上，代价更大 |

## 已知边界

- 只接管 `@deepseek-ai/dsh-web-fetch-http`（provider id `http`）这条链路。若上游改了实现，
  插件会静默失效（启动日志会显示"已接管 0 个"）。
- 判定故意保守：一组解析结果里只要混入一个非 fake-ip 地址就维持拒绝。正常 fake-ip 部署下不会
  出现混合结果。
- fake-ip 段内的地址若真被公网服务使用，会被一并放行——RFC 2544 / RFC 5180 保留段实际不会。
- 依赖 `node:net` 的 `BlockList` 做 CIDR 匹配，这是唯一的运行时依赖（Node 内置）。

## 代码结构与测试

| 文件 | 作用 |
|---|---|
| [`lib/resolver.js`](lib/resolver.js) | 纯逻辑：fake-ip 段匹配 + `resolveAddresses` 包装。只依赖 `node:net` / `node:dns`，可单独单测 |
| [`lib/index.js`](lib/index.js) | cordis 插件：inject `web`，在 `apply` 里就地补丁 + 兜住后注册的 provider + 可逆卸载 |
| [`cordis.patch.yml`](cordis.patch.yml) | bundle patch，只 insert 一个 node 半插件（无客户端半插件、不注册路由和设置项） |
| [`test/resolver.test.mjs`](test/resolver.test.mjs) | 36 项断言：保留段判定 + 包装器在各种解析结果下的行为（含内网 / link-local 仍被拒） |

```bash
npm test
```

测试零依赖，`node` 直接跑即可。

## License

[MIT](LICENSE) © 2026 wjj-8283
