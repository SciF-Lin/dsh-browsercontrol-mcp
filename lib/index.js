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

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const MCP_SERVER = '@playwright/mcp'
const MCP_SERVER_BIN = 'playwright-mcp'

const MODES = ['launch', 'cdp', 'extension']
const BROWSERS = ['chrome', 'msedge', 'firefox', 'webkit']

/** @type {Record<string, unknown>} */
export const DEFAULTS = {
  /** Namespace of the generated tools: mcp__<serverName>__*. */
  serverName: 'playwright',
  /** launch = start our own browser, cdp = attach to a running one, extension = attach via the Playwright extension. */
  mode: 'launch',
  /** Browser or channel used by launch mode, and the default channel name for cdp mode. */
  browser: 'msedge',
  /** CDP target: a channel name such as `msedge`, or `http://localhost:9222`. Empty means `browser`. */
  cdpEndpoint: '',
  /** Run the browser without a visible window (launch mode only). */
  headless: false,
  /** Persistent profile directory for launch mode; keeps logins across restarts. */
  userDataDir: '',
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
}

/**
 * Merge user config over the defaults and reject anything that cannot work.
 * @param {Record<string, unknown> | undefined} raw
 */
export function normalizeConfig(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw)))
    throw new Error('dsh-browsercontrol-mcp: config must be a mapping')

  const config = { ...DEFAULTS, ...(raw ?? {}) }

  for (const key of Object.keys(raw ?? {}))
    if (!Object.hasOwn(DEFAULTS, key))
      throw new Error(
        `dsh-browsercontrol-mcp: unknown config key "${key}"; known keys: ${Object.keys(DEFAULTS).join(', ')}`,
      )

  if (typeof config.serverName !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(config.serverName))
    throw new Error('dsh-browsercontrol-mcp: serverName must match [A-Za-z0-9_-]{1,32}')
  if (!MODES.includes(config.mode))
    throw new Error(`dsh-browsercontrol-mcp: mode must be one of ${MODES.join(' | ')}`)
  if (!BROWSERS.includes(config.browser))
    throw new Error(`dsh-browsercontrol-mcp: browser must be one of ${BROWSERS.join(' | ')}`)
  if (!Array.isArray(config.extraArgs) || config.extraArgs.some((a) => typeof a !== 'string'))
    throw new Error('dsh-browsercontrol-mcp: extraArgs must be an array of strings')
  if (config.env === null || typeof config.env !== 'object' || Array.isArray(config.env))
    throw new Error('dsh-browsercontrol-mcp: env must be a mapping')
  if (!Number.isFinite(config.toolCallTimeoutMs) || config.toolCallTimeoutMs <= 0)
    throw new Error('dsh-browsercontrol-mcp: toolCallTimeoutMs must be a positive number')
  for (const key of ['cdpEndpoint', 'userDataDir', 'cwd', 'cliPath'])
    if (typeof config[key] !== 'string')
      throw new Error(`dsh-browsercontrol-mcp: ${key} must be a string`)

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
      throw new Error(`dsh-browsercontrol-mcp: cliPath does not exist: ${explicit}`)
    return explicit
  }

  let pkgPath
  try {
    pkgPath = req.resolve(`${MCP_SERVER}/package.json`)
  } catch (error) {
    throw new Error(
      `dsh-browsercontrol-mcp: cannot find ${MCP_SERVER}.\n` +
        `Install it for this profile (npm i ${MCP_SERVER}), or point "cliPath" at its cli.js.\n` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[MCP_SERVER_BIN]
  if (!bin)
    throw new Error(`dsh-browsercontrol-mcp: ${MCP_SERVER} has no "${MCP_SERVER_BIN}" bin entry`)

  const cli = join(dirname(pkgPath), bin)
  if (!existsSync(cli))
    throw new Error(`dsh-browsercontrol-mcp: ${MCP_SERVER} bin points at a missing file: ${cli}`)
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
  } else if (config.mode === 'cdp') {
    args.push(`--cdp-endpoint=${config.cdpEndpoint || config.browser}`, '--cdp-timeout=30000')
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
  const config = normalizeConfig(rawConfig)
  const cli = resolveServerCli(config)
  const args = buildServerArgs(config, cli)
  const row = buildClientConfig(config, args)

  if (hasConflictingRow(ctx.loader, config.serverName)) {
    console.warn(
      `dsh-browsercontrol-mcp: a loader row already provides serverName "${config.serverName}" ` +
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
          `dsh-browsercontrol-mcp: failed to mount the "${config.serverName}" MCP row: ` +
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
