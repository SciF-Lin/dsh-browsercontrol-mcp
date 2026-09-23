# dsh-browsercontrol-mcp

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

## 安装

```powershell
# 从 GitHub（发布后）
dsh plugin --profile web add github:<owner>/dsh-browsercontrol-mcp

# 本地开发（改代码即时生效）
dsh plugin --profile web add link:C:\Users\you\Desktop\dsh-browsercontrol-mcp
```

web profile 的 patch 是 `patchReload: live`，装完必须**重启一次 profile**：`patchReload: live` 只覆盖 patch 文件的改动，**新装的 bundle 要到进程启动时才参与组合**，不重启不会生效（重启 `dsh web` 即可，配置本身不会丢）。验证方式：问智能体"列出你有哪些浏览器工具"，
或走 Inspect：`host / Tool / listTools`，应出现 `mcp__playwright__*`。

卸载：

```powershell
dsh plugin --profile web remove dsh-browsercontrol-mcp
```

## 配置

改 `cordis.patch.yml` 里（或 profile patch 里覆盖）本插件那一行的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `serverName` | `playwright` | 工具名前缀：`mcp__<serverName>__browser_navigate` |
| `mode` | `launch` | `launch` 自己开浏览器 / `cdp` 接管正在运行的浏览器 / `extension` 走浏览器扩展 |
| `browser` | `msedge` | `chrome` \| `msedge` \| `firefox` \| `webkit`；cdp 模式下作为 channel 默认值 |
| `cdpEndpoint` | 空 | cdp 模式的目标：channel 名（如 `msedge`）或 `http://localhost:9222`；空则用 `browser` |
| `headless` | `false` | launch 模式是否无窗口 |
| `userDataDir` | 空 | launch 模式的持久化 profile 目录，登录态可留存 |
| `cwd` | 空 | MCP 服务进程工作目录，决定截图/快照落在哪 |
| `env` | `{}` | 传给 MCP 服务进程的额外环境变量 |
| `cliPath` | 空 | 显式指定 cli.js，绕过模块解析 |
| `extraArgs` | `[]` | 追加原始 CLI 参数，如 `['--caps', 'vision,devtools']` |
| `toolCallTimeoutMs` | `120000` | 单次工具调用超时 |

未知键会直接报错，不会静默忽略。

## 三种模式怎么选

**launch（默认，最省事）**
用系统 Edge，不下载 Chromium：

```yaml
config:
  mode: launch
  browser: msedge
  userDataDir: 'D:\browser-profiles\dsh'
```

**cdp —— 接管你正在用的浏览器（登录态全在）**

先在该浏览器里打开 `edge://inspect/#remote-debugging`，勾选
"Allow remote debugging for this browser instance"。这个开关会写进浏览器 profile，重启后仍然有效。
（注意：Chrome/Edge 136 起，`--remote-debugging-port` 对**默认** profile 已失效，所以必须用这个 UI 开关。）

```yaml
config:
  mode: cdp
  browser: msedge      # 或 cdpEndpoint: http://localhost:9222
```

**extension**
在目标浏览器安装 Playwright 扩展，然后 `mode: extension`。

## 浏览器从哪来

默认走系统 Edge/Chrome，**不需要**下载 Chromium。若想用 Playwright 自带的浏览器，安装依赖时不要设置
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`，或事后执行 `npx playwright install chromium`。

## 安全

- `cdp` / `extension` 模式下，模型能看到该浏览器里**所有已登录站点**。建议给自动化单独一个浏览器 profile。
- `browser_run_code_unsafe` 与 `browser_evaluate` 等价于在浏览器进程里执行任意 JS（RCE 等价），按需限制使用。

## 与手写配置共存

如果你已经在 `cordis.patch.yml` 手写了 `mcp-playwright` 行（同一个 `serverName`），本插件检测到后会
**跳过挂载**并打印一条警告，不会让启动失败。要让插件接管，请删掉那行。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `cannot find @playwright/mcp` | 给该 profile 装依赖（`npm i @playwright/mcp`），或设 `cliPath` |
| `serverName ... already in use` | 别处已有同行；改 `serverName` 或删掉旧行 |
| `browserType.launch: spawn EPERM` | 进程被沙箱限制，用正常权限启动 DSH |
| cdp 连不上，提示读不到 `DevToolsActivePort` | 上面的 `edge://inspect` 开关没勾 |
| 工具没出现 | `host / Tool / listTools` 确认；再看日志里 `browsercontrol-mcp` 的报错 |

## 开发

```powershell
npm install
npm test          # node:test，覆盖参数构造、行生成、冲突跳过、卸载竞态

> 在受限沙箱里 
ode --test 会因测试运行器 fork 子进程被拒（spawn EPERM）而失败，改用 
pm run test:direct 同进程执行，结果一致。
```

## 许可

MIT


