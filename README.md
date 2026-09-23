# dsh-browsercontrol-mcp

Real browser control for **DeepSeek Harness**: mounts **Playwright MCP** as native tools
(`mcp__playwright__*`) so the agent can navigate, click, type, drag, upload, snapshot,
screenshot, read console/network, and evaluate JS in a browser you actually use.

## Why a plugin and not a plain YAML row

Three facts are only knowable at runtime:

1. `@playwright/mcp` restricts its `exports`, so `@playwright/mcp/cli.js` cannot be resolved
   (`ERR_PACKAGE_PATH_NOT_EXPORTED`). The real path comes from the package's exported
   `./package.json` plus its `bin` field.
2. On Windows `npx` is a `.cmd`, which Node's spawn cannot execute without a shell.
3. Both the `cli.js` path and the Node path only exist after installation.

So `apply()` resolves them, starts the MCP server with `process.execPath`, and mounts the
generated row on the loader. Disposing the plugin removes the row with it.

## Install

```powershell
dsh plugin --profile web add github:<owner>/dsh-browsercontrol-mcp
# local development
dsh plugin --profile web add link:C:\path\to\dsh-browsercontrol-mcp
```

Verify: ask the agent to list its browser tools, or inspect `host / Tool / listTools` for
`mcp__playwright__*`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `serverName` | `playwright` | Tool namespace: `mcp__<serverName>__browser_navigate` |
| `mode` | `launch` | `launch` own browser / `cdp` attach to a running one / `extension` attach via the Playwright extension |
| `browser` | `msedge` | `chrome` \| `msedge` \| `firefox` \| `webkit`; also the default cdp channel |
| `cdpEndpoint` | empty | cdp target: channel name (`msedge`) or `http://localhost:9222` |
| `headless` | `false` | launch mode without a visible window |
| `userDataDir` | empty | persistent profile directory for launch mode |
| `cwd` | empty | MCP server working directory (where screenshots land) |
| `env` | `{}` | extra environment for the MCP server process |
| `cliPath` | empty | explicit cli.js, bypassing module resolution |
| `extraArgs` | `[]` | raw extra CLI flags, e.g. `['--caps', 'vision,devtools']` |
| `toolCallTimeoutMs` | `120000` | per-tool-call timeout |

Unknown keys raise an error instead of being silently ignored.

## Modes

- **launch** — starts its own browser; defaults to the system Edge/Chrome channel, so no
  Chromium download is needed. Set `userDataDir` to keep logins.
- **cdp** — attaches to a browser you are already using, with its logged-in sessions. Enable
  "Allow remote debugging for this browser instance" at `edge://inspect/#remote-debugging`
  first; the switch is persisted in the browser profile. (Chrome/Edge 136+ ignores
  `--remote-debugging-port` for the default profile, which is why the UI switch is required.)
- **extension** — attaches through the Playwright browser extension.

## Security

- In `cdp` / `extension` mode the model can see **every logged-in site** in that browser.
  Use a dedicated browser profile for automation.
- `browser_run_code_unsafe` and `browser_evaluate` are equivalent to running arbitrary JS in
  the browser process.

## Coexistence

If a hand-written `mcp-playwright` row already serves the same `serverName`, this plugin
detects it, **skips mounting**, and logs a warning instead of failing startup. Remove that row
to let the plugin own the capability.

## Development

```powershell
npm install
npm test
```
> 注意：在受限沙箱里 
ode --test 会因测试运行器 fork 子进程被拒（spawn EPERM）而失败，
> 此时用 
pm run test:direct 同进程执行，结果一致。


## License

MIT

