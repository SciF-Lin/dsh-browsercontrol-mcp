/**
 * Authorization guidance for CDP mode.
 *
 * Attaching to a browser the user is already signed in to requires remote
 * debugging to be allowed for that browser instance. Without guidance the first
 * tool call fails with a raw English Playwright error and the user has to be
 * told, by hand, which page and checkbox to use. This module turns that into:
 *
 *   1. a prompt section that tells the model the browser is not ready, so it
 *      explains the situation instead of blindly calling a browser tool;
 *   2. a pre-execute guard that denies browser tool calls with the same
 *      instruction in Chinese, instead of leaking the raw error;
 *   3. `agent/turn-stopping` — the moment the model has finished speaking —
 *      which opens the settings page for the user, so the text arrives first
 *      and the window opens second.
 *
 * The guard is deliberately side-effect free: opening a window while denying a
 * call would put the window ahead of the model's explanation.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { NOT_READY, READY, resolveBrowserExe, settingsUrl } from './probe.js'

const LOG_PREFIX = 'dsh-browsercontrol-mcp:'

/** The checkbox the user has to tick on the inspect page. */
export const DEBUG_CHECKBOX = 'Allow remote debugging for this browser instance'

/** How long to wait between probes: fast while not ready, slow once ready. */
const PROBE_INTERVAL_NOT_READY_MS = 2000
const PROBE_INTERVAL_READY_MS = 30000

/** Human-readable reason for a not-ready probe result. */
export function describeNotReady(state) {
  switch (state?.kind) {
    case 'not-probed':
      return '尚未完成探测'
    case 'probe-failed':
      return `探测失败（${state.reason ?? '未知原因'}）`
    case 'no-devtools-port-file':
      return `${state.channel} 未开启远程调试（或浏览器尚未运行，还没有调试端口文件）`
    case 'unreadable-port-file':
      return '调试端口文件读不出来'
    case 'malformed-port-file':
      return '调试端口文件内容异常'
    case 'devtools-unreachable':
      return `调试端口文件存在但连不上（浏览器可能已关闭，文件是陈旧的；端口 ${state.port}）`
    case 'devtools-handshake-failed':
      return `端口 ${state.port} 有进程在监听，但它不是可用的 CDP 端点`
    case 'devtools-http-404':
      return '调试端口有响应但不是 CDP 端点'
    case 'cdp-url-unreachable':
      return `指定的 CDP 端点连不上（${state.endpoint}）`
    case 'ws-endpoint-unverifiable':
      return 'cdpEndpoint 是 ws:// 地址，无法在调用前预检'
    case 'unknown-channel':
      return `不认识的浏览器通道：${state.channel}`
    default:
      return state?.kind ? `未就绪（${state.kind}）` : '未就绪'
  }
}

/**
 * @param {object} options
 * @param {Record<string, any>} options.config normalized plugin config
 * @param {() => Promise<object>} options.probe read-only state probe
 * @param {Function} [options.spawn] injectable for tests
 * @param {Console} [options.log]
 * @param {Function} [options.exists]
 */
export function createGuide({
  config,
  probe,
  spawn = nodeSpawn,
  log = console,
  exists = existsSync,
  platform = process.platform,
  env = process.env,
}) {
  let state = { state: 'unknown', kind: 'not-probed' }
  let timer = null
  let stopped = true
  let autoOpened = false
  const pending = new Set()

  const enabled = () => config.mode === 'cdp' && config.guideSetup !== 'off'

  const record = (next) => {
    state = next ?? { state: NOT_READY, kind: 'probe-returned-nothing' }
    if (state.state === READY) {
      autoOpened = false
      pending.clear()
    }
    return state
  }

  const refreshNow = async () => {
    try {
      return record(await probe())
    } catch (error) {
      log.warn?.(`${LOG_PREFIX} probe failed: ${error instanceof Error ? error.message : String(error)}`)
      return record({ state: NOT_READY, kind: 'probe-failed', reason: error instanceof Error ? error.message : String(error) })
    }
  }

  const schedule = () => {
    if (stopped) return
    clearTimeout(timer)
    timer = setTimeout(async () => {
      await refreshNow()
      schedule()
    }, state.state === READY ? PROBE_INTERVAL_READY_MS : PROBE_INTERVAL_NOT_READY_MS)
    timer.unref?.()
  }

  /** Own the refresh timer for the plugin's lifetime. */
  const start = (ctx) => {
    ctx.effect(() => {
      stopped = false
      schedule()
      return () => {
        stopped = true
        clearTimeout(timer)
        timer = null
      }
    }, 'browsercontrol-mcp.probe')
  }

  /** System-prompt contribution: empty whenever there is nothing to guide. */
  const promptText = () => {
    if (!enabled() || state.state === READY) return ''
    return [
      `浏览器自动化当前不可用（cdp / ${config.browser}）：${describeNotReady(state)}。`,
      '不要调用浏览器工具：先用一两句话把原因和做法告诉用户，然后等它完成授权；本插件会在该回合结束时自动为它打开设置页。',
      `授权方法：在 ${config.browser} 中打开 ${settingsUrl(config.browser)}，勾选 "${DEBUG_CHECKBOX}"。`,
    ].join('\n')
  }

  /** Synchronous pre-execute guard: deny with guidance, but never with a side effect. */
  const guardFor = (exec) => {
    if (!enabled()) return undefined
    const toolName = typeof exec?.name === 'string' ? exec.name : ''
    if (!toolName.startsWith(`mcp__${config.serverName}__`)) return undefined
    if (state.state === READY) return undefined
    if (exec?.agent) pending.add(exec.agent)
    // The cache may be a couple of seconds stale; re-check so a retry succeeds.
    void refreshNow()
    return (
      `浏览器自动化未就绪（cdp / ${config.browser}）：${describeNotReady(state)}。` +
      `请先用一两句话告知用户，并让其在 ${settingsUrl(config.browser)} 勾选 "${DEBUG_CHECKBOX}" 后重试；` +
      '本插件会在该回合结束时自动打开这个设置页。'
    )
  }

  /** The only side effect: open the browser (or a tab) at the inspect page. */
  const openNow = async () => {
    if (config.mode !== 'cdp') return { ok: false, text: `当前 mode=${config.mode}，不需要远程调试授权。` }
    const url = settingsUrl(config.browser)
    const exe = config.browserExe || resolveBrowserExe(config.browser, { platform, env, exists })
    if (!exe) return { ok: false, text: `没找到 ${config.browser} 的可执行文件；请手动打开 ${url} 并勾选 "${DEBUG_CHECKBOX}"。` }
    try {
      const child = spawn(exe, [url], { detached: true, stdio: 'ignore' })
      child.unref?.()
      log.warn?.(`${LOG_PREFIX} opened ${url}`)
      return { ok: true, text: `已打开 ${url} —— 勾选 "${DEBUG_CHECKBOX}" 后重试即可。` }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, text: `打开设置页失败（${reason}）；请手动访问 ${url}。` }
    }
  }

  /**
   * Runs when a turn is about to close: the model has said its part, so opening
   * the settings page here keeps the text first and the window second.
   */
  const onTurnStopping = async (payload = {}) => {
    if (!enabled() || config.guideSetup !== 'open') return
    const { agent } = payload
    if (agent === undefined || !pending.has(agent)) return
    pending.delete(agent)
    if (state.state === READY || autoOpened) return
    autoOpened = true
    await openNow()
  }

  const statusText = () => {
    if (config.mode !== 'cdp') return `mode=${config.mode}，目标浏览器 ${config.browser}；该模式不需要远程调试授权。`
    if (state.state === READY)
      return `已就绪：${config.browser} 的远程调试可用${state.port ? `（端口 ${state.port}）` : ''}${state.browser ? `，${state.browser}` : ''}。`
    return `未就绪：${describeNotReady(state)}。运行 /bw-setup 打开设置页，或在 ${settingsUrl(config.browser)} 勾选 "${DEBUG_CHECKBOX}"。`
  }

  return {
    start,
    refreshNow,
    promptText,
    guardFor,
    onTurnStopping,
    openNow,
    statusText,
    describeNotReady,
    get state() {
      return state
    },
    /** exposed for tests */
    pendingAgents: pending,
  }
}
