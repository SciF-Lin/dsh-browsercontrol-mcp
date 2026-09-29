import test from 'node:test'
import assert from 'node:assert/strict'
import { DEBUG_CHECKBOX, createGuide, describeNotReady } from '../lib/guide.js'
import { NOT_READY, READY, settingsUrl } from '../lib/probe.js'

const config = (over = {}) => ({
  mode: 'cdp',
  browser: 'msedge',
  guideSetup: 'open',
  serverName: 'playwright',
  browserExe: 'C:/fake/msedge.exe',
  ...over,
})

const NOT_READY_STATE = { state: NOT_READY, kind: 'no-devtools-port-file', channel: 'msedge' }
const READY_STATE = { state: READY, kind: 'devtools-port', channel: 'msedge', port: 1982, browser: 'Edg/153.0' }

async function makeGuide(state = NOT_READY_STATE, over = {}, extra = {}) {
  const spawnCalls = []
  const guide = createGuide({
    config: config(over),
    probe: async () => state,
    spawn: (...args) => {
      spawnCalls.push(args)
      return { unref() {} }
    },
    log: { warn() {}, error() {} },
    exists: () => true,
    ...extra,
  })
  await guide.refreshNow()
  return { guide, spawnCalls }
}

const BROWSER_TOOL = { name: 'mcp__playwright__browser_navigate', agent: { id: 'agent-1' } }

test('the prompt section only speaks while the browser is not ready', async () => {
  const { guide } = await makeGuide(NOT_READY_STATE)
  const text = guide.promptText()
  assert.match(text, /不要调用浏览器工具/)
  assert.ok(text.includes(settingsUrl('msedge')))
  assert.ok(text.includes(DEBUG_CHECKBOX))

  const ready = await makeGuide(READY_STATE, {}, {})
  assert.equal(ready.guide.promptText(), '')

  const launch = await makeGuide(NOT_READY_STATE, { mode: 'launch' })
  assert.equal(launch.guide.promptText(), '')

  const off = await makeGuide(NOT_READY_STATE, { guideSetup: 'off' })
  assert.equal(off.guide.promptText(), '')
})

test('the guard denies only this server\'s tools, and only while not ready', async () => {
  const { guide } = await makeGuide(NOT_READY_STATE)
  assert.equal(guide.guardFor({ name: 'other_tool' }), undefined)
  assert.equal(guide.guardFor({ name: 'mcp__else__browser_navigate' }), undefined)
  assert.equal(guide.guardFor({}), undefined)

  const denial = guide.guardFor(BROWSER_TOOL)
  assert.equal(typeof denial, 'string')
  assert.ok(denial.includes(settingsUrl('msedge')))
  assert.ok(denial.includes(DEBUG_CHECKBOX))
  assert.equal(guide.pendingAgents.has(BROWSER_TOOL.agent), true)

  const ready = await makeGuide(READY_STATE)
  assert.equal(ready.guide.guardFor(BROWSER_TOOL), undefined)
  assert.equal(ready.guide.pendingAgents.size, 0)
})

test('the guard stays inert when guidance is off or the mode needs no authorization', async () => {
  const off = await makeGuide(NOT_READY_STATE, { guideSetup: 'off' })
  assert.equal(off.guide.guardFor(BROWSER_TOOL), undefined)
  const launch = await makeGuide(NOT_READY_STATE, { mode: 'launch' })
  assert.equal(launch.guide.guardFor(BROWSER_TOOL), undefined)
})

test('the settings page opens once, after a denied call, when the turn stops', async () => {
  const { guide, spawnCalls } = await makeGuide(NOT_READY_STATE)
  await guide.onTurnStopping({ agent: { id: 'unrelated' } })
  assert.equal(spawnCalls.length, 0, 'no window without a denied call')

  guide.guardFor(BROWSER_TOOL)
  await guide.onTurnStopping({ agent: BROWSER_TOOL.agent })
  assert.equal(spawnCalls.length, 1)
  assert.equal(spawnCalls[0][0], 'C:/fake/msedge.exe')
  assert.deepEqual(spawnCalls[0][1], [settingsUrl('msedge')])
  assert.equal(spawnCalls[0][2].detached, true)

  // The same unauthorized episode must not keep opening windows.
  guide.guardFor(BROWSER_TOOL)
  await guide.onTurnStopping({ agent: BROWSER_TOOL.agent })
  assert.equal(spawnCalls.length, 1)
})

test('auto mode guides without opening anything, and a ready browser never opens', async () => {
  const auto = await makeGuide(NOT_READY_STATE, { guideSetup: 'auto' })
  auto.guide.guardFor(BROWSER_TOOL)
  await auto.guide.onTurnStopping({ agent: BROWSER_TOOL.agent })
  assert.equal(auto.spawnCalls.length, 0)

  const ready = await makeGuide(READY_STATE)
  assert.equal(ready.guide.guardFor(BROWSER_TOOL), undefined)
  await ready.guide.onTurnStopping({ agent: BROWSER_TOOL.agent })
  assert.equal(ready.spawnCalls.length, 0)
})

test('a fulfilled authorization re-arms the automatic window for the next episode', async () => {
  let state = NOT_READY_STATE
  const { guide, spawnCalls } = await makeGuide(NOT_READY_STATE, {}, { probe: async () => state })
  guide.guardFor(BROWSER_TOOL)
  await guide.onTurnStopping({ agent: BROWSER_TOOL.agent })
  assert.equal(spawnCalls.length, 1)

  state = READY_STATE
  await guide.refreshNow()
  assert.equal(guide.promptText(), '')

  state = NOT_READY_STATE
  await guide.refreshNow()
  guide.guardFor(BROWSER_TOOL)
  await guide.onTurnStopping({ agent: BROWSER_TOOL.agent })
  assert.equal(spawnCalls.length, 2, 'a new unauthorized episode may open once more')
})

test('openNow reports what it did, and degrades to instructions when it cannot', async () => {
  const { guide } = await makeGuide(NOT_READY_STATE)
  const ok = await guide.openNow()
  assert.equal(ok.ok, true)
  assert.ok(ok.text.includes(settingsUrl('msedge')))

  const noExe = await makeGuide(NOT_READY_STATE, { browserExe: '' }, { exists: () => false })
  const failed = await noExe.guide.openNow()
  assert.equal(failed.ok, false)
  assert.ok(failed.text.includes(settingsUrl('msedge')))

  const throwing = await makeGuide(NOT_READY_STATE, {}, {
    spawn: () => {
      throw new Error('EPERM')
    },
  })
  const broke = await throwing.guide.openNow()
  assert.equal(broke.ok, false)
  assert.match(broke.text, /EPERM/)

  const launch = await makeGuide(NOT_READY_STATE, { mode: 'launch' })
  assert.equal((await launch.guide.openNow()).ok, false)
})

test('statusText describes each situation, and describeNotReady maps every kind', async () => {
  const ready = await makeGuide(READY_STATE)
  assert.match(ready.guide.statusText(), /已就绪/)
  assert.match(ready.guide.statusText(), /1982/)

  const notReady = await makeGuide(NOT_READY_STATE)
  assert.match(notReady.guide.statusText(), /未就绪/)
  assert.ok(notReady.guide.statusText().includes(settingsUrl('msedge')))

  const launch = await makeGuide(NOT_READY_STATE, { mode: 'launch' })
  assert.match(launch.guide.statusText(), /不需要远程调试授权/)

  for (const kind of [
    'no-devtools-port-file',
    'unreadable-port-file',
    'malformed-port-file',
    'devtools-unreachable',
    'devtools-http-404',
    'cdp-url-unreachable',
    'ws-endpoint-unverifiable',
    'unknown-channel',
    'probe-failed',
    'not-probed',
  ]) {
    const text = describeNotReady({ kind, channel: 'msedge', port: 1, endpoint: 'http://x' })
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 0, kind)
  }
})
