/**
 * Read-only browser readiness detection for CDP mode.
 *
 * Everything here mirrors what the MCP server itself does when handed
 * `--cdp-endpoint=<channel>`: it reads `<user data dir>/DevToolsActivePort` and
 * talks to that port. Both tables below are transcribed from playwright-core's
 * own channel tables, so a probe agrees with the server instead of guessing.
 *
 * This module never writes, launches, or connects: it reads one file and asks
 * one local HTTP endpoint. The only side effect in this plugin lives in
 * `guide.js`.
 */
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const READY = 'ready'
export const NOT_READY = 'not-ready'

const localAppData = (env, home) => env.LOCALAPPDATA || join(home, 'AppData', 'Local')
const programFiles = (env) => env.ProgramFiles || 'C:\\Program Files'
const programFilesX86 = (env) => env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'

/** channel -> default user data directory, per platform (mirrors playwright-core). */
export const CHANNEL_USER_DATA_DIRS = {
  chrome: {
    win32: (env, home) => join(localAppData(env, home), 'Google', 'Chrome', 'User Data'),
    darwin: (_env, home) => join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    linux: (_env, home) => join(home, '.config', 'google-chrome'),
  },
  'chrome-beta': {
    win32: (env, home) => join(localAppData(env, home), 'Google', 'Chrome Beta', 'User Data'),
    darwin: (_env, home) => join(home, 'Library', 'Application Support', 'Google', 'Chrome Beta'),
    linux: (_env, home) => join(home, '.config', 'google-chrome-beta'),
  },
  'chrome-dev': {
    win32: (env, home) => join(localAppData(env, home), 'Google', 'Chrome Dev', 'User Data'),
    darwin: (_env, home) => join(home, 'Library', 'Application Support', 'Google', 'Chrome Dev'),
    linux: (_env, home) => join(home, '.config', 'google-chrome-unstable'),
  },
  'chrome-canary': {
    win32: (env, home) => join(localAppData(env, home), 'Google', 'Chrome SxS', 'User Data'),
    darwin: (_env, home) => join(home, 'Library', 'Application Support', 'Google', 'Chrome Canary'),
    linux: (_env, home) => join(home, '.config', 'google-chrome-canary'),
  },
  msedge: {
    win32: (env, home) => join(localAppData(env, home), 'Microsoft', 'Edge', 'User Data'),
    darwin: (_env, home) => join(home, 'Library', 'Application Support', 'Microsoft Edge'),
    linux: (_env, home) => join(home, '.config', 'microsoft-edge'),
  },
  'msedge-beta': {
    win32: (env, home) => join(localAppData(env, home), 'Microsoft', 'Edge Beta', 'User Data'),
    darwin: (_env, home) => join(home, 'Library', 'Application Support', 'Microsoft Edge Beta'),
    linux: (_env, home) => join(home, '.config', 'microsoft-edge-beta'),
  },
  'msedge-dev': {
    win32: (env, home) => join(localAppData(env, home), 'Microsoft', 'Edge Dev', 'User Data'),
    darwin: (_env, home) => join(home, 'Library', 'Application Support', 'Microsoft Edge Dev'),
    linux: (_env, home) => join(home, '.config', 'microsoft-edge-dev'),
  },
  'msedge-canary': {
    win32: (env, home) => join(localAppData(env, home), 'Microsoft', 'Edge SxS', 'User Data'),
    darwin: (_env, home) => join(home, 'Library', 'Application Support', 'Microsoft Edge Canary'),
    linux: (_env, home) => join(home, '.config', 'microsoft-edge-canary'),
  },
}

/**
 * channel -> candidate install locations, per platform. Only used to open the
 * settings page in the right browser; the first existing candidate wins.
 */
export const CHANNEL_EXECUTABLES = {
  chrome: {
    win32: (env, home) => [
      join(localAppData(env, home), 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFiles(env), 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86(env), 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    darwin: () => ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: () => ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
  },
  'chrome-beta': {
    win32: (env, home) => [join(localAppData(env, home), 'Google', 'Chrome Beta', 'Application', 'chrome.exe')],
    darwin: () => ['/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'],
    linux: () => ['/usr/bin/google-chrome-beta'],
  },
  'chrome-dev': {
    win32: (env, home) => [join(localAppData(env, home), 'Google', 'Chrome Dev', 'Application', 'chrome.exe')],
    darwin: () => ['/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev'],
    linux: () => ['/usr/bin/google-chrome-unstable'],
  },
  'chrome-canary': {
    win32: (env, home) => [join(localAppData(env, home), 'Google', 'Chrome SxS', 'Application', 'chrome.exe')],
    darwin: () => ['/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'],
    linux: () => ['/usr/bin/google-chrome-canary'],
  },
  msedge: {
    win32: (env, home) => [
      join(programFilesX86(env), 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles(env), 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(localAppData(env, home), 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    darwin: () => ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: () => ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'],
  },
  'msedge-beta': {
    win32: (env) => [join(programFiles(env), 'Microsoft', 'Edge Beta', 'Application', 'msedge.exe')],
    darwin: () => ['/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta'],
    linux: () => ['/usr/bin/microsoft-edge-beta'],
  },
  'msedge-dev': {
    win32: (env) => [join(programFiles(env), 'Microsoft', 'Edge Dev', 'Application', 'msedge.exe')],
    darwin: () => ['/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev'],
    linux: () => ['/usr/bin/microsoft-edge-dev'],
  },
  'msedge-canary': {
    win32: (env) => [join(programFiles(env), 'Microsoft', 'Edge SxS', 'Application', 'msedge.exe')],
    darwin: () => ['/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary'],
    linux: () => ['/usr/bin/microsoft-edge-canary'],
  },
}

/**
 * The browser's default user data directory for one channel.
 * @returns {string | undefined} undefined for an unknown channel or platform
 */
export function resolveUserDataDir(channel, { platform = process.platform, env = process.env, home = homedir() } = {}) {
  return CHANNEL_USER_DATA_DIRS[channel]?.[platform]?.(env, home)
}

/**
 * The first installed executable for one channel.
 * @returns {string | undefined}
 */
export function resolveBrowserExe(
  channel,
  { platform = process.platform, env = process.env, home = homedir(), exists = existsSync } = {},
) {
  const candidates = CHANNEL_EXECUTABLES[channel]?.[platform]?.(env, home) ?? []
  return candidates.find((candidate) => exists(candidate))
}

/** `msedge*` uses `edge://`, every other supported channel uses `chrome://`. */
export function inspectScheme(channel) {
  return typeof channel === 'string' && channel.startsWith('msedge') ? 'edge' : 'chrome'
}

/** The page a user must open to allow remote debugging for this browser instance. */
export function settingsUrl(channel) {
  return `${inspectScheme(channel)}://inspect/#remote-debugging`
}

/** True for an explicit CDP endpoint instead of a channel name. */
export function isCdpUrl(value) {
  return typeof value === 'string' && /^(https?|wss?):\/\//i.test(value)
}

const reasonOf = (error) => (error instanceof Error ? error.message : String(error))

/** True when something accepts a TCP connection on host:port within the timeout. */
export function tcpConnect(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        // already gone
      }
      resolve(ok)
    }
    const socket = net.connect({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** True when a CDP websocket handshake succeeds. Resolves before closing. */
export function wsHandshake(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false
    let socket
    const finish = (ok) => {
      if (settled) return
      settled = true
      // Resolve first: closing an open websocket can emit 'error', which must
      // not be able to overwrite a successful handshake.
      resolve(ok)
      try {
        socket?.close()
      } catch {
        // already closed
      }
    }
    try {
      socket = new WebSocket(url)
    } catch {
      finish(false)
      return
    }
    socket.addEventListener('open', () => finish(true))
    socket.addEventListener('error', () => finish(false))
    socket.addEventListener('close', () => finish(false))
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
  })
}

/**
 * Probe one CDP target without side effects.
 *
 * The channel form is decided by TCP plus the websocket path from
 * `DevToolsActivePort`, because a browser that was authorized through the
 * inspect-page switch serves **only** that websocket: its HTTP discovery
 * endpoints (`/json/version`) answer 404. Checking HTTP there would report a
 * perfectly usable browser as not ready, and the guard would then deny valid
 * calls.
 *
 * @returns {Promise<{state: string, kind: string, [key: string]: unknown}>}
 */
export async function probeBrowserState({
  channel,
  endpoint = '',
  userDataDir = '',
  timeoutMs = 1500,
  fetchImpl = globalThis.fetch,
  exists = existsSync,
  readFile = (path) => readFileSync(path, 'utf8'),
  tcpConnectImpl = tcpConnect,
  wsHandshakeImpl = wsHandshake,
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  const timeout = () => AbortSignal.timeout(timeoutMs)

  if (isCdpUrl(endpoint)) {
    const base = endpoint.replace(/\/+$/, '')
    if (!/^https?:/i.test(base))
      return { state: NOT_READY, kind: 'ws-endpoint-unverifiable', endpoint: base }
    try {
      const response = await fetchImpl(`${base}/json/version`, { signal: timeout() })
      if (!response.ok) return { state: NOT_READY, kind: `cdp-http-${response.status}`, endpoint: base }
      const info = await response.json().catch(() => null)
      return { state: READY, kind: 'cdp-url', endpoint: base, browser: info?.Browser ?? null }
    } catch (error) {
      return { state: NOT_READY, kind: 'cdp-url-unreachable', endpoint: base, reason: reasonOf(error) }
    }
  }

  const dir = userDataDir || resolveUserDataDir(channel, { platform, env, home })
  if (!dir) return { state: NOT_READY, kind: 'unknown-channel', channel }

  const portFile = join(dir, 'DevToolsActivePort')
  if (!exists(portFile)) return { state: NOT_READY, kind: 'no-devtools-port-file', channel, portFile }

  let lines
  try {
    lines = String(readFile(portFile))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch (error) {
    return { state: NOT_READY, kind: 'unreadable-port-file', channel, portFile, reason: reasonOf(error) }
  }

  const [port, wsPath = ''] = lines
  if (!port || !/^\d+$/.test(port))
    return { state: NOT_READY, kind: 'malformed-port-file', channel, portFile, port: port ?? null }
  const numericPort = Number(port)

  if (!(await tcpConnectImpl('127.0.0.1', numericPort, timeoutMs)))
    return { state: NOT_READY, kind: 'devtools-unreachable', channel, port: numericPort, portFile }

  if (wsPath) {
    const upgraded = await wsHandshakeImpl(`ws://127.0.0.1:${numericPort}${wsPath}`, timeoutMs)
    if (!upgraded)
      return { state: NOT_READY, kind: 'devtools-handshake-failed', channel, port: numericPort, portFile }
    return { state: READY, kind: 'devtools-websocket', channel, port: numericPort, portFile }
  }

  // No websocket path in the file: fall back to HTTP, which a browser started
  // with an explicit --remote-debugging-port does serve.
  try {
    const response = await fetchImpl(`http://127.0.0.1:${numericPort}/json/version`, { signal: timeout() })
    if (!response.ok)
      return { state: NOT_READY, kind: `devtools-http-${response.status}`, channel, port: numericPort, portFile }
    const info = await response.json().catch(() => null)
    return { state: READY, kind: 'devtools-http', channel, port: numericPort, portFile, browser: info?.Browser ?? null }
  } catch (error) {
    return {
      state: NOT_READY,
      kind: 'devtools-unreachable',
      channel,
      port: numericPort,
      portFile,
      reason: reasonOf(error),
    }
  }
}
