# dsh-browsercontrol-mcp

**简体中文** | [English](README.en.md)

把 **Playwright MCP** 挂进 DeepSeek Harness，让智能体直接操作真实浏览器。

安装后自动挂载官方 `@deepseek-ai/dsh-mcp-client` 行，工具以 `mcp__playwright__*` 出现在模型工具表里：
导航、点击、填表、按键、拖拽、上传、快照、截图、控制台、网络请求、执行 JS。

## 为什么是插件而不是一段 YAML

三个只有运行时才知道的事实：

1. `@playwright/mcp` 的 `exports` **不导出** `./cli.js`，直接 resolve 子路径会 `ERR_PACKAGE_PATH_NOT_EXPORTED`；
   正确做法是从它导出的 `./package.json` 读 `bin` 字段再拼接。
2. Windows 上 `npx` 是 `npx.cmd`，Node 的 `spawn` 不加 shell 起不来。
3. `cli.js` 的绝对路径与 `node` 的绝对路径都要等安装完成后才能确定。

所以本插件在 `apply()` 里解析出绝对路径，用 `process.execPath`（当前 node）启动 MCP 服务进程，并把生成的
行挂到 loader 上；插件被卸载时随 fiber 一起回收，不留孤儿配置。

插件**不会因为配置错误而拖垮 Harness**：参数不合法、或找不到 `@playwright/mcp` 时，它打印一条
`dsh-browsercontrol-mcp: not mounting: ...` 并选择"不贡献任何工具"，而不是让整个插件树加载失败。

## 安装

```powershell
# 从 GitHub（发布后）
dsh plugin --profile web add github:<owner>/dsh-browsercontrol-mcp

# 本地开发（改代码即时生效）
dsh plugin --profile web add link:C:\Users\you\Desktop\dsh-browsercontrol-mcp
```

**装完必须重启一次 profile。** `patchReload: live` 只覆盖 patch 文件的改动，**新装的 bundle 要到进程启动时才参与组合**，不重启不会生效（重启 `dsh web` 即可，配置本身不会丢）。

验证方式：问智能体"列出你有哪些浏览器工具"，或走 Inspect：`host / Tool / listTools`，应出现 `mcp__playwright__*`；
用 `/bw` 可直接查看浏览器状态。

卸载：

```powershell
dsh plugin --profile web remove dsh-browsercontrol-mcp
```

## 配置

改本插件那一行的 `config`（写在自己的 `cordis.patch.yml` 里，或 profile patch 里用同一个 `id` 定点覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `serverName` | `playwright` | 工具名前缀：`mcp__<serverName>__browser_navigate` |
| `mode` | `launch` | `launch` 自己开浏览器 / `cdp` 接管正在运行的浏览器 / `extension` 走浏览器扩展 |
| `browser` | `msedge` | launch 模式取值：`chrome` \| `msedge` \| `firefox` \| `webkit`；cdp 模式下作为默认通道名 |
| `cdpEndpoint` | 空 | cdp 目标：Chromium 通道名（`msedge`、`msedge-beta`、`chrome-dev`…）或 CDP URL（`http://localhost:9222`）；空则用 `browser` |
| `cdpTimeoutMs` | `30000` | cdp 连接超时（毫秒） |
| `headless` | `false` | launch 模式是否无窗口 |
| `userDataDir` | 空 | launch 模式的持久化 profile 目录，登录态可留存 |
| `profileDirName` | 空 | extension 模式下要连接的 profile 目录名，如 `Profile 1` |
| `cwd` | 空 | MCP 服务进程工作目录，决定截图/快照落在哪 |
| `env` | `{}` | 传给 MCP 服务进程的额外环境变量 |
| `cliPath` | 空 | 显式指定 cli.js，绕过模块解析 |
| `executablePath` | 空 | launch 模式指定浏览器可执行文件（如便携版 Chrome），会覆盖通道查找 |
| `extraArgs` | `[]` | 追加原始 CLI 参数，如 `['--caps', 'vision,devtools']` |
| `toolCallTimeoutMs` | `120000` | 单次工具调用超时 |
| `failOnStartupError` | `false` | 首次连接失败时是否让该行激活失败（默认只记录日志） |
| `guideSetup` | `open` | cdp 授权引导：`off` 不引导 / `auto` 只提示与拦截 / `open` 额外在回合收尾时自动打开设置页 |
| `probeTimeoutMs` | `1500` | 就绪探测的单次超时（毫秒） |
| `browserExe` | 空 | 打开设置页所用的浏览器可执行文件；空则按通道自动查找 |

未知键会报错并跳过挂载，不会静默忽略。

注意 `browser` 与 cdp 通道**不是同一组取值**：`msedge-beta` / `chrome-canary` 这类通道只能作为 cdp 目标，
不能传给 `--browser`。

## 三种模式怎么选

**launch（默认，最省事）**
用系统已装的浏览器，不下载 Chromium：

```yaml
config:
  mode: launch
  browser: msedge
  userDataDir: 'D:\browser-profiles\dsh'
```

**cdp —— 接管你正在用的浏览器（登录态全在）**

1. 让目标浏览器**处于运行状态**；
2. 在它里面打开 `edge://inspect/#remote-debugging`（Chrome 是 `chrome://inspect/#remote-debugging`），
   勾选 "Allow remote debugging for this browser instance"。这个开关会写进浏览器 profile，重启后仍然有效。

```yaml
config:
  mode: cdp
  browser: msedge            # 或 cdpEndpoint: msedge-beta / http://localhost:9222
```

> 为什么必须用这个 UI 开关：Chromium 136 起，`--remote-debugging-port` 对**默认** profile 已失效
> （官方为防 cookie 窃取所做的安全变更）。UI 开关是现在唯一保留登录态又能被 CDP 接管的路径。

**extension**
在目标浏览器安装 [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)，然后：

```yaml
config:
  mode: extension
  profileDirName: 'Profile 1'   # 可选，多 profile 时指定
```

## 授权引导与斜杠命令

cdp 模式需要目标浏览器**允许远程调试**（每个浏览器 profile 只需设置一次）。插件在真正需要时才引导，而不是让你先撞一次英文报错：

1. **提前告知**：未授权时向系统提示注入一句说明，模型会先解释情况，而不是盲目调用浏览器工具；
2. **拦截并给出指引**：浏览器工具调用会被拦下，理由是一条中文可执行指引（原生报错是英文技术信息）；
3. **自动打开设置页**：模型这一回合说完话、回合即将收尾时，插件为你打开
   `edge://inspect/#remote-debugging`（Chrome 是 `chrome://inspect/#remote-debugging`）——
   **先文字、后弹窗**，你只需勾选 "Allow remote debugging for this browser instance"。

**副作用声明**：第 3 步会启动浏览器进程（若尚未运行）并打开一个页面。它只在「浏览器调用被拦下且该回合结束」时发生，同一未授权周期内最多一次。不想要弹窗就设 `guideSetup: auto`，完全关闭引导设 `off`。

| 命令 | 作用 |
|---|---|
| `/bw` | 查看状态：模式、目标浏览器、远程调试是否就绪 |
| `/bw-setup` | 立即打开设置页，引导完成授权 |

## 浏览器从哪来

- `chrome` / `msedge`：直接用系统已安装的浏览器，**不需要下载**任何东西（推荐）。
- Chrome 与 Edge **都实测可用**：launch / cdp / extension 三条路径走的是同一套参数，代码里没有按浏览器分支。
- Chrome 不在标准位置（便携版、多版本共存）时用 `executablePath` 指向它即可——实测它会**覆盖通道查找**，与 `browser` 同时给出也不冲突。
- `firefox` / `webkit`：Playwright 没有系统通道，需要 `npx playwright install firefox`（或 `webkit`）。
- 想用 Playwright 自带的 Chromium：安装依赖时不要设置 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`，
  或事后执行 `npx playwright install chromium`。

## 安全

- `cdp` / `extension` 模式下，模型能看到该浏览器里**所有已登录站点**。建议给自动化单独一个浏览器 profile。
- `browser_run_code_unsafe` 与 `browser_evaluate` 等价于在浏览器进程里执行任意 JS（RCE 等价），按需限制使用。

## 与手写配置共存

如果你已经在 `cordis.patch.yml` 手写了 `mcp-playwright` 行（同一个 `serverName`），本插件检测到后会
**跳过挂载**并打印一条警告，不会让启动失败。要让插件接管，请删掉那行。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `not mounting: unknown config key "..."` | 配置键写错，按提示里的合法键列表改 |
| `not mounting: cannot find @playwright/mcp` | 给该 profile 装依赖（`npm i @playwright/mcp`），或设 `cliPath` |
| `serverName ... already in use` | 别处已有同行；改 `serverName` 或删掉旧行 |
| `browserType.launch: spawn EPERM` | 进程被沙箱限制，用正常权限启动 DSH |
| cdp 连不上，提示读不到 `DevToolsActivePort` | 目标浏览器没在运行，或上面的 inspect 开关没勾 |
| 浏览器工具被拦下，理由说"未就绪" | 尚未勾选远程调试开关；运行 `/bw-setup` 或按理由里的地址勾选后重试 |
| 工具没出现 | 是否忘了重启 profile；再查日志里 `browsercontrol-mcp` 的报错 |

## 依赖与版本

`@playwright/mcp` 声明为 `dependencies`（开箱即用）；官方 `@deepseek-ai/*` 声明为 `peerDependencies`。

`@deepseek-ai/dsh-mcp-client` 的区间是**逐版本枚举**的：

```
>=0.1.0-rc.2 <0.2.0-0 || >=0.1.1-rc.1 <0.2.0-0 || >=0.1.2-alpha.2 <0.2.0-0 ||
>=0.1.3-alpha.2 <0.2.0-0 || >=0.1.5-alpha.1 <0.2.0-0 || >=0.1.6-alpha.1 <0.2.0-0 ||
>=0.1.7-alpha.1 <0.2.0-0
```

原因：node-semver 只有当区间里**某个比较符与该版本的 `major.minor.patch` 完全相同、且自身带预发布标签**时，
才允许该预发布版本被匹配。所以看着很宽的 `>=0.1.5-rc.1 <0.2.0-0` 会**静默拒掉 `0.1.6-rc.1`**，用户会撞
`ERESOLVE`。上面这份区间覆盖了 registry 上全部 `0.1.x` 已发布版本（`0.0.1-rc.*` 那批远古版本有意排除）；
harness 再发新的 `0.1.x` 预发布时，照此追加一条分支即可。

## 开发

```powershell
npm install
npm test              # Node 测试运行器
npm run test:direct   # 同进程执行，结果一致
```

用例覆盖：三种模式的参数构造、行生成（命令/超时/失败策略/环境变量）、配置校验的全部拒绝分支、
冲突跳过、`entries()` 抛错时的降级、错误配置只记录不抛出、卸载与"卸载时挂载仍在飞行中"的竞态；
另有就绪探测（三平台目录映射、端口文件各状态、显式 CDP URL）、授权引导（提示文本、守卫匹配与
副作用隔离、回合收尾只开一次窗口）、斜杠命令（注册与各分支返回）。

`npm test` 走 Node 测试运行器（每个测试文件一个子进程）；**在受限沙箱里子进程 fork 会被拒（spawn EPERM）**，
此时用 `npm run test:direct`。

## 许可

MIT
