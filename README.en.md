# dsh-browsercontrol-mcp

**English** | [简体中文](README.md)

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

The plugin never takes the harness down with it: invalid config or a missing `@playwright/mcp`
prints `dsh-browsercontrol-mcp: not mounting: ...` and contributes no tools, instead of
failing the whole plugin tree.

## Install

```powershell
dsh plugin --profile web add github:<owner>/dsh-browsercontrol-mcp
# local development
dsh plugin --profile web add link:C:\path\to\dsh-browsercontrol-mcp
```

**Restart the profile once after installing.** `patchReload: live` covers edits to patch files,
but a newly installed bundle only joins the composition at profile start, so nothing changes
until you restart (`dsh web`); nothing in the config is lost.

Verify: ask the agent to list its browser tools, or inspect `host / Tool / listTools` for
`mcp__playwright__*`. `/bw` reports the browser state directly.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `serverName` | `playwright` | Tool namespace: `mcp__<serverName>__browser_navigate` |
| `mode` | `launch` | `launch` own browser / `cdp` attach to a running one / `extension` attach via the Playwright extension |
| `browser` | `msedge` | launch mode: `chrome` \| `msedge` \| `firefox` \| `webkit`; also the default CDP channel |
| `cdpEndpoint` | empty | CDP target: a Chromium channel (`msedge`, `msedge-beta`, `chrome-dev`, ...) or a CDP URL (`http://localhost:9222`) |
| `cdpTimeoutMs` | `30000` | CDP attach timeout in milliseconds |
| `headless` | `false` | launch mode without a visible window |
| `userDataDir` | empty | persistent profile directory for launch mode |
| `profileDirName` | empty | browser profile directory name used by extension mode, e.g. `Profile 1` |
| `cwd` | empty | MCP server working directory (where screenshots land) |
| `env` | `{}` | extra environment for the MCP server process |
| `cliPath` | empty | explicit cli.js, bypassing module resolution |
| `executablePath` | empty | launch mode: explicit browser binary, e.g. a portable Chrome; overrides the channel lookup |
| `extraArgs` | `[]` | raw extra CLI flags, e.g. `['--caps', 'vision,devtools']` |
| `toolCallTimeoutMs` | `120000` | per-tool-call timeout |
| `failOnStartupError` | `false` | make a failed initial connection abort activation instead of only logging |
| `guideSetup` | `open` | CDP authorization guidance: `off` / `auto` (prompt and guard only) / `open` (also open the settings page when a denied call's turn closes) |
| `probeTimeoutMs` | `1500` | timeout for one readiness probe, in milliseconds |
| `browserExe` | empty | executable used to open the settings page; empty means look it up from the channel |

Unknown keys are rejected and reported, never silently ignored.

Note that `browser` and CDP channels are different sets: `msedge-beta` / `chrome-canary` are
valid **CDP targets** but are not accepted by `--browser`.

## Modes

- **launch** — starts its own browser; `chrome`/`msedge` use the installed system browser, so
  no Chromium download is needed. Set `userDataDir` to keep logins.
- **cdp** — attaches to a browser you are already using, with its logged-in sessions. The
  target browser must be running; enable "Allow remote debugging for this browser instance" at
  `edge://inspect/#remote-debugging` (`chrome://inspect/#remote-debugging` in Chrome). The
  switch is persisted in the browser profile. Chromium 136+ ignores
  `--remote-debugging-port` for the default profile, which is why the UI switch is the only
  path that keeps your sessions.
- **extension** — attaches through the
  [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm);
  use `profileDirName` to pick a profile.

## Authorization guidance and slash commands

CDP mode needs the target browser to **allow remote debugging** (once per browser profile). The plugin
guides you at the moment it matters instead of letting the first call fail with an English error:

1. **Prompt**: while unauthorized, a prompt section tells the model to explain the situation instead of calling a browser tool;
2. **Guard**: browser tool calls are denied with an actionable message instead of the raw Playwright error;
3. **Automatic window**: when a denied call's turn is about to close, the plugin opens
   `edge://inspect/#remote-debugging` (`chrome://inspect/#remote-debugging` in Chrome) — text first,
   window second. You only tick "Allow remote debugging for this browser instance".

**Side effect**: step 3 starts the browser (when it is not running) and opens one page. It happens only
after a denied browser call ends a turn, at most once per unauthorized episode. Set `guideSetup: auto`
to guide without opening anything, or `off` to disable guidance entirely.

| Command | Purpose |
|---|---|
| `/bw` | Report mode, target browser and whether remote debugging is ready |
| `/bw-setup` | Open the settings page now |

## Where the browser comes from

- `chrome` / `msedge`: the system browser, nothing to download (recommended).
- Chrome and Edge are **both verified**: all three modes use the same arguments, with no per-browser branch in the code.
- When Chrome is not in a standard location (portable build, several versions installed), point `executablePath` at it: it overrides the channel lookup and coexists with `browser`.
- `firefox` / `webkit`: no system channel, so run `npx playwright install firefox` (or `webkit`).
- Playwright's own Chromium: do not set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` when installing, or
  run `npx playwright install chromium` afterwards.

## Security

- In `cdp` / `extension` mode the model can see **every logged-in site** in that browser. Use a
  dedicated browser profile for automation.
- `browser_run_code_unsafe` and `browser_evaluate` are equivalent to running arbitrary JS in
  the browser process.

## Coexistence

If a hand-written `mcp-playwright` row already serves the same `serverName`, this plugin
detects it, **skips mounting**, and logs a warning instead of failing startup. Remove that row
to let the plugin own the capability.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `not mounting: unknown config key "..."` | Fix the key; the message lists the valid ones |
| `not mounting: cannot find @playwright/mcp` | Install it for the profile (`npm i @playwright/mcp`) or set `cliPath` |
| `serverName ... already in use` | Another row owns it; rename or remove that row |
| `browserType.launch: spawn EPERM` | The process is sandboxed; start DSH with normal rights |
| cdp cannot connect, reads no `DevToolsActivePort` | The target browser is not running, or the inspect switch is off |
| Browser tool calls are denied as not ready | The inspect switch is off; run `/bw-setup`, tick it as instructed, then retry |
| No tools appear | Did you restart the profile? Then check the logs for `browsercontrol-mcp` |

## Dependencies and versions

`@playwright/mcp` is a `dependency`; official `@deepseek-ai/*` packages are `peerDependencies`.

The `@deepseek-ai/dsh-mcp-client` range enumerates one branch per released tuple:

```
>=0.1.0-rc.2 <0.2.0-0 || >=0.1.1-rc.1 <0.2.0-0 || >=0.1.2-alpha.2 <0.2.0-0 ||
>=0.1.3-alpha.2 <0.2.0-0 || >=0.1.5-alpha.1 <0.2.0-0 || >=0.1.6-alpha.1 <0.2.0-0 ||
>=0.1.7-alpha.1 <0.2.0-0
```

node-semver only admits a prerelease when some comparator shares its exact
`major.minor.patch` tuple *and* carries a prerelease tag, so a broad-looking
`>=0.1.5-rc.1 <0.2.0-0` silently rejects `0.1.6-rc.1` and leaves users with an `ERESOLVE`.
This range covers every published `0.1.x` version (the ancient `0.0.1-rc.*` line is
deliberately excluded); append a branch when the harness ships a new `0.1.x` prerelease.

## Development

```powershell
npm install
npm test              # Node test runner
npm run test:direct   # same tests, in-process
```

Coverage: argument building for all three modes, row generation (command, timeouts, failure
policy, env), every config-rejection branch, conflict skip, degradation when `entries()`
throws, error reporting without throwing, and the dispose race while a mount is in flight.
Readiness probing (three-platform directory mapping, every port-file state, explicit CDP URLs),
authorization guidance (prompt text, guard matching and side-effect isolation, one window per
turn close) and the slash commands each have their own suite.

`npm test` uses the Node test runner, which forks a child process per file; inside a confined
sandbox that fork is refused (`spawn EPERM`), so use `npm run test:direct` there.

## License

MIT
