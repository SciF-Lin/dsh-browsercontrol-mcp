import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NOT_READY,
  READY,
  inspectScheme,
  isCdpUrl,
  probeBrowserState,
  resolveBrowserExe,
  resolveUserDataDir,
  settingsUrl,
  tcpConnect,
} from '../lib/probe.js'

const root = mkdtempSync(join(tmpdir(), 'bcm-probe-'))
after(() => rmSync(root, { recursive: true, force: true }))

const portDir = (name, contents) => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (contents !== undefined) writeFileSync(join(dir, 'DevToolsActivePort'), contents, 'utf8')
  return dir
}

/** Stand-ins for the two transport primitives a channel probe uses. */
const transport = ({ tcp = true, ws = true } = {}) => ({
  tcpConnectImpl: async () => tcp,
  wsHandshakeImpl: async () => ws,
})

const fakeEnv = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86' }
const fakeHome = '/home/u'

const withServer = async (handler, run) => {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await run(port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const jsonVersion = (body) => (req, res) => {
  if (req.url === '/json/version') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  res.writeHead(404)
  res.end('')
}

test('channel -> user data directory matches the browser defaults', () => {
  const win = { platform: 'win32', env: fakeEnv, home: fakeHome }
  assert.equal(resolveUserDataDir('msedge', win), join('C:\\Users\\u\\AppData\\Local', 'Microsoft', 'Edge', 'User Data'))
  assert.equal(resolveUserDataDir('chrome', win), join('C:\\Users\\u\\AppData\\Local', 'Google', 'Chrome', 'User Data'))
  assert.equal(resolveUserDataDir('chrome-canary', win), join('C:\\Users\\u\\AppData\\Local', 'Google', 'Chrome SxS', 'User Data'))
  assert.equal(
    resolveUserDataDir('chrome', { platform: 'darwin', env: {}, home: fakeHome }),
    join('/home/u', 'Library', 'Application Support', 'Google', 'Chrome'),
  )
  assert.equal(resolveUserDataDir('msedge', { platform: 'linux', env: {}, home: fakeHome }), join('/home/u', '.config', 'microsoft-edge'))
  assert.equal(resolveUserDataDir('firefox', win), undefined)
})

test('browser executable lookup takes the first candidate that exists', () => {
  const opts = { platform: 'win32', env: fakeEnv, home: fakeHome }
  const wanted = join('C:\\Users\\u\\AppData\\Local', 'Google', 'Chrome', 'Application', 'chrome.exe')
  assert.equal(resolveBrowserExe('chrome', { ...opts, exists: (p) => p === wanted }), wanted)
  assert.equal(resolveBrowserExe('chrome', { ...opts, exists: () => false }), undefined)
  assert.equal(resolveBrowserExe('firefox', { ...opts, exists: () => true }), undefined)
})

test('scheme, settings URL and CDP URL detection', () => {
  assert.equal(inspectScheme('msedge'), 'edge')
  assert.equal(inspectScheme('msedge-beta'), 'edge')
  assert.equal(inspectScheme('chrome'), 'chrome')
  assert.equal(inspectScheme('chrome-canary'), 'chrome')
  assert.equal(settingsUrl('msedge'), 'edge://inspect/#remote-debugging')
  assert.equal(settingsUrl('chrome'), 'chrome://inspect/#remote-debugging')
  assert.equal(isCdpUrl('http://localhost:9222'), true)
  assert.equal(isCdpUrl('ws://127.0.0.1:9222/devtools/browser/x'), true)
  assert.equal(isCdpUrl('msedge'), false)
  assert.equal(isCdpUrl(''), false)
})

test('the websocket path decides readiness for a UI-authorized browser', async () => {
  // Regression for the real case: a browser authorized through the inspect-page
  // switch serves only its websocket and answers 404 on the HTTP endpoints.
  // That browser is ready, and reporting otherwise would deny valid calls.
  const dir = portDir('opt-in', '1982\n/devtools/browser/abc\n')
  const state = await probeBrowserState({
    channel: 'msedge',
    userDataDir: dir,
    ...transport({ tcp: true, ws: true }),
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
  })
  assert.equal(state.state, READY)
  assert.equal(state.kind, 'devtools-websocket')
  assert.equal(state.port, 1982)
})

test('a port nobody listens on is reported as unreachable', async () => {
  const dir = portDir('stale', '1\n/devtools/browser/abc\n')
  const state = await probeBrowserState({ channel: 'msedge', userDataDir: dir, ...transport({ tcp: false }) })
  assert.equal(state.state, NOT_READY)
  assert.equal(state.kind, 'devtools-unreachable')
  assert.equal(state.port, 1)
})

test('a listening port that is not a CDP endpoint is not ready', async () => {
  const dir = portDir('stolen', '1982\n/devtools/browser/abc\n')
  const state = await probeBrowserState({ channel: 'msedge', userDataDir: dir, ...transport({ tcp: true, ws: false }) })
  assert.equal(state.state, NOT_READY)
  assert.equal(state.kind, 'devtools-handshake-failed')
})

test('without a websocket path the HTTP endpoint decides', async () => {
  await withServer(jsonVersion({ Browser: 'Chrome/154.0.0.0' }), async (port) => {
    const dir = portDir('http-ok', `${port}\n`)
    const ready = await probeBrowserState({ channel: 'msedge', userDataDir: dir, ...transport({}) })
    assert.equal(ready.state, READY)
    assert.equal(ready.kind, 'devtools-http')
    assert.equal(ready.browser, 'Chrome/154.0.0.0')
  })
  await withServer((_req, res) => { res.writeHead(404); res.end('') }, async (port) => {
    const dir = portDir('http-404', `${port}\n`)
    const state = await probeBrowserState({ channel: 'msedge', userDataDir: dir, ...transport({}) })
    assert.equal(state.state, NOT_READY)
    assert.equal(state.kind, 'devtools-http-404')
  })
})

test('a missing port file reports not-ready without touching the network', async () => {
  const dir = portDir('missing')
  const state = await probeBrowserState({ channel: 'msedge', userDataDir: dir, ...transport({ tcp: false, ws: false }) })
  assert.equal(state.state, NOT_READY)
  assert.equal(state.kind, 'no-devtools-port-file')
})

test('a malformed port file is reported as such', async () => {
  const dir = portDir('malformed', 'not-a-port\n')
  const state = await probeBrowserState({ channel: 'msedge', userDataDir: dir, ...transport({}) })
  assert.equal(state.state, NOT_READY)
  assert.equal(state.kind, 'malformed-port-file')
})

test('an explicit CDP url is probed over HTTP', async () => {
  await withServer(jsonVersion({ Browser: 'Chrome/154.0.0.0' }), async (port) => {
    const ready = await probeBrowserState({ endpoint: `http://127.0.0.1:${port}` })
    assert.equal(ready.state, READY)
    assert.equal(ready.kind, 'cdp-url')
  })
  const unreachable = await probeBrowserState({ endpoint: 'http://127.0.0.1:1', timeoutMs: 800 })
  assert.equal(unreachable.state, NOT_READY)
  assert.equal(unreachable.kind, 'cdp-url-unreachable')
})

test('an http endpoint answering with an error status is not ready', async () => {
  await withServer((_req, res) => { res.writeHead(500); res.end('boom') }, async (port) => {
    const state = await probeBrowserState({ endpoint: `http://127.0.0.1:${port}` })
    assert.equal(state.state, NOT_READY)
    assert.equal(state.kind, 'cdp-http-500')
  })
})

test('an unknown channel cannot be probed', async () => {
  const state = await probeBrowserState({ channel: 'firefox' })
  assert.equal(state.state, NOT_READY)
  assert.equal(state.kind, 'unknown-channel')
})

test('a ws endpoint is reported as unverifiable rather than guessed', async () => {
  const state = await probeBrowserState({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/x' })
  assert.equal(state.state, NOT_READY)
  assert.equal(state.kind, 'ws-endpoint-unverifiable')
})

test('the real tcp primitive answers for a live and for a closed port', async () => {
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  assert.equal(await tcpConnect('127.0.0.1', port, 800), true)
  await new Promise((resolve) => server.close(resolve))
  assert.equal(await tcpConnect('127.0.0.1', port, 800), false)
})
