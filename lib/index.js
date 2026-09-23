/**
 * dsh-browsercontrol-mcp
 *
 * Mounts the official MCP client row for Playwright MCP as native DSH tools.
 *
 * Why a plugin instead of a plain cordis.patch.yml row:
 *   - `@playwright/mcp` restricts its `exports`, so `@playwright/mcp/cli.js`
 *     cannot be resolved (ERR_PACKAGE_PATH_NOT_EXPORTED). The CLI path has to
 *     come from the package's `bin` field.
 *   - Windows resolves `npx` to a `.cmd`, which Node's spawn cannot execute
 *     without a shell. Using `process.execPath` + an absolute cli path keeps
 *     the row portable.
 *   - Both of those values are only knowable at runtime, after install.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'

export const name = 'dsh-browsercontrol-mcp'
export const inject = ['loader']

const LOG_PREFIX = 'dsh-browsercontrol-mcp:'
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const MCP_SERVER = '@playwright/mcp'
const MCP_SERVER_BIN = 'playwright-mcp'

const MODES = ['launch', 'cdp', 'extension']

/** Values `--browser` accepts (system channels plus the Playwright engines). */
const LAUNCH_BROWSERS = ['chrome', 'msedge', 'firefox', 'webkit']

/**
 * Channel names `--cdp-endpoint` accepts. Attaching over CDP only works against
 * a Chromium-family browser, and the beta/dev/canary channels are valid here
 * even though `--browser` rejects them.
 */
const CDP_CHANNELS = [
  'chrome',
  'chrome-beta',
  'chrome-dev',
  'chrome-canary',
  'msedge',
  'msedge-beta',
  'msedge-dev',
  'msedge-canary',
]

const STRING_KEYS = ['cdpEndpoint', 'userDataDir', 'cwd', 'cliPath', 'profileDirName']

/** @type {Record<string, unknown>} */
export const DEFAULTS = {
  /** Namespace of the generated tools: mcp__<serverName>__*. */
  serverName: 'playwright',
  /** launch = start our own browser, cdp = attach to a running one, extension = attach via the Playwright extension. */
  mode: 'launch',
  /** Browser for launch mode; also the default CDP target when cdpEndpoint is empty. */
  browser: 'msedge',
  /** CDP target: a Chromium channel name (`msedge`, `msedge-beta`, ...) or a CDP URL (`http://localhost:9222`). */
  cdpEndpoint: '',
  /** Milliseconds the CDP attach may take before it gives up. */
  cdpTimeoutMs: 30000,
  /** Run the browser without a visible window (launch mode only). */
  headless: false,
  /** Persistent profile directory for launch mode; keeps logins across restarts. */
  userDataDir: '',
  /** Browser profile directory name used by extension mode, e.g. "Profile 1". */
  profileDirName: '',
  /** Working directory of the MCP server process: where screenshots and snapshots land. */
  cwd: '',
  /** Extra environment for the MCP server process. */
  env: {},
  /** Explicit path to @playwright/mcp's cli.js, bypassing module resolution. */
  cliPath: '',
  /** Extra CLI flags appended verbatim. */
  extraArgs: [],
  /** Per-tool-call timeout handed to the MCP client. */
  toolCallTimeoutMs: 120000,
  /** Make a failed initial connection abort plugin activation instead of only logging. */
  failOnStartupError: false,
}

/**
 * True when a value is a usable CDP target: a CDP URL or a Chromium channel.
 * @param {unknown} value
 */
export function isCdpTarget(value) {
  if (typeof value !== 'string' || value === '') return false
  if (/^(https?|wss?):\/\//i.test(value)) return true
  return CDP_CHANNELS.includes(value)
}

/**
 * Merge user config over the defaults and reject anything that cannot work.
 * @param {Record<string, unknown> | undefined} raw
 */
export function normalizeConfig(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw)))
    throw new Error(`${LOG_PREFIX} config must be a mapping`)

  const config = { ...DEFAULTS, ...(raw ?? {}) }

  for (const key of Object.keys(raw ?? {}))
    if (!Object.hasOwn(DEFAULTS, key))
      throw new Error(
        `${LOG_PREFIX} unknown config key "${key}"; known keys: ${Object.keys(DEFAULTS).join(', ')}`,
      )

  if (typeof config.serverName !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(config.serverName))
    throw new Error(`${LOG_PREFIX} serverName must match [A-Za-z0-9_-]{1,32}`)
  if (!MODES.includes(config.mode))
    throw new Error(`${LOG_PREFIX} mode must be one of ${MODES.join(' | ')}`)

  if (config.mode === 'launch' && !LAUNCH_BROWSERS.includes(config.browser))
    throw new Error(
      `${LOG_PREFIX} browser must be one of ${LAUNCH_BROWSERS.join(' | ')} in launch mode` +
        ` (Chromium channels such as msedge-beta are only valid as a cdp target)`,
    )
  if (config.mode === 'cdp' && !isCdpTarget(config.cdpEndpoint || config.browser))
    throw new Error(
      `${LOG_PREFIX} cdp mode needs cdpEndpoint to be a CDP URL or one of ${CDP_CHANNELS.join(' | ')}`,
    )

  if (!Array.isArray(config.extraArgs) || config.extraArgs.some((a) => typeof a !== 'string'))
    throw new Error(`${LOG_PREFIX} extraArgs must be an array of strings`)
  if (config.env === null || typeof config.env !== 'object' || Array.isArray(config.env))
    throw new Error(`${LOG_PREFIX} env must be a mapping`)
  if (!Number.isFinite(config.toolCallTimeoutMs) || config.toolCallTimeoutMs <= 0)
    throw new Error(`${LOG_PREFIX} toolCallTimeoutMs must be a positive number`)
  if (!Number.isFinite(config.cdpTimeoutMs) || config.cdpTimeoutMs <= 0)
    throw new Error(`${LOG_PREFIX} cdpTimeoutMs must be a positive number`)
  for (const key of ['headless', 'failOnStartupError'])
    if (typeof config[key] !== 'boolean') throw new Error(`${LOG_PREFIX} ${key} must be a boolean`)
  for (const key of STRING_KEYS)
    if (typeof config[key] !== 'string') throw new Error(`${LOG_PREFIX} ${key} must be a string`)

  return config
}

/**
 * Locate Playwright MCP's CLI entry point.
 *
 * `@playwright/mcp`'s `exports` map does not expose `./cli.js`, so resolving the
 * subpath throws ERR_PACKAGE_PATH_NOT_EXPORTED. `./package.json` *is* exported,
 * so read the `bin` field from it and resolve relative to that.
 *
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {NodeJS.Require} [req]
 * @returns {string} absolute path to cli.js
 */
export function resolveServerCli(config, req = createRequire(import.meta.url)) {
  if (config.cliPath) {
    const explicit = resolvePath(config.cliPath)
    if (!existsSync(explicit))
      throw new Error(`${LOG_PREFIX} cliPath does not exist: ${explicit}`)
    return explicit
  }

  let pkgPath
  try {
    pkgPath = req.resolve(`${MCP_SERVER}/package.json`)
  } catch (error) {
    throw new Error(
      `${LOG_PREFIX} cannot find ${MCP_SERVER}.\n` +
        `Install it for this profile (npm i ${MCP_SERVER}), or point "cliPath" at its cli.js.\n` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[MCP_SERVER_BIN]
  if (!bin)
    throw new Error(`${LOG_PREFIX} ${MCP_SERVER} has no "${MCP_SERVER_BIN}" bin entry`)

  const cli = join(dirname(pkgPath), bin)
  if (!existsSync(cli))
    throw new Error(`${LOG_PREFIX} ${MCP_SERVER} bin points at a missing file: ${cli}`)
  return cli
}

/**
 * Build the Playwright MCP server arguments.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {string} cli absolute path to cli.js
 */
export function buildServerArgs(config, cli) {
  const args = [cli]

  if (config.mode === 'extension') {
    args.push('--extension')
    if (config.profileDirName) args.push('--profile-dir-name', config.profileDirName)
  } else if (config.mode === 'cdp') {
    args.push(`--cdp-endpoint=${config.cdpEndpoint || config.browser}`)
    args.push(`--cdp-timeout=${config.cdpTimeoutMs}`)
  } else {
    args.push('--browser', config.browser)
    if (config.headless) args.push('--headless')
    if (config.userDataDir) args.push('--user-data-dir', config.userDataDir)
  }

  args.push(...config.extraArgs)
  return args
}

/**
 * Build the dsh-mcp-client row config.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {string[]} args
 */
export function buildClientConfig(config, args) {
  /** @type {Record<string, unknown>} */
  const row = {
    serverName: config.serverName,
    transport: 'stdio',
    command: process.execPath,
    args,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    failOnStartupError: config.failOnStartupError,
  }
  if (config.cwd) row.cwd = config.cwd
  if (Object.keys(config.env).length > 0) row.env = config.env
  return row
}

/**
 * True when another loader row already serves this serverName.
 * Coexistence guard: a hand-written `mcp-playwright` row in cordis.patch.yml
 * must not turn into a duplicate-serverName startup failure.
 */
export function hasConflictingRow(loader, serverName) {
  try {
    for (const entry of loader.entries()) {
      const options = entry?.options
      if (options?.name === MCP_CLIENT && options?.config?.serverName === serverName) return true
    }
  } catch {
    // Enumeration is best-effort; never fail the mount because of it.
  }
  return false
}

/**
 * @param {any} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  let config
  let row
  try {
    config = normalizeConfig(rawConfig)
    const cli = resolveServerCli(config)
    row = buildClientConfig(config, buildServerArgs(config, cli))
  } catch (error) {
    // A static loader row that throws during activation fails the whole plugin
    // tree, so a single typo here would take the harness down with it. Report
    // loudly and contribute no tools instead.
    console.error(`${LOG_PREFIX} not mounting: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  if (hasConflictingRow(ctx.loader, config.serverName)) {
    console.warn(
      `${LOG_PREFIX} a loader row already provides serverName "${config.serverName}" ` +
        '(likely a hand-written dsh-mcp-client row); skipping mount. ' +
        'Remove that row or pick a different serverName.',
    )
    return
  }

  // Register the effect first, then mount: a disposal that lands while
  // loader.create() is still in flight must still remove the created entry.
  ctx.effect(() => {
    let entryId
    let disposed = false
    const mounting = ctx.loader.create({ name: MCP_CLIENT, config: row }).then(
      (id) => {
        if (disposed) return ctx.loader.remove(id)
        entryId = id
      },
      (error) => {
        console.error(
          `${LOG_PREFIX} failed to mount the "${config.serverName}" MCP row: ` +
            (error instanceof Error ? error.message : String(error)),
        )
      },
    )

    return async () => {
      disposed = true
      await mounting.catch(() => {})
      if (entryId !== undefined) await ctx.loader.remove(entryId)
    }
  }, 'browsercontrol-mcp.mount')
}
