import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import {
  name,
  inject,
  normalizeConfig,
  resolveServerCli,
  buildServerArgs,
  buildClientConfig,
  hasConflictingRow,
  isCdpTarget,
  apply,
} from '../lib/index.js'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

function fakeLoader(existing = []) {
  const created = []
  const removed = []
  return {
    created,
    removed,
    loader: {
      entries: () => existing[Symbol.iterator](),
      create: async (options) => {
        created.push(options)
        return `entry-${created.length}`
      },
      remove: async (id) => {
        removed.push(id)
      },
    },
  }
}

function fakeCtx(loader) {
  const disposers = []
  return { disposers, ctx: { loader, effect: (fn) => disposers.push(fn()) } }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

function captureConsole(method) {
  const original = console[method]
  const lines = []
  console[method] = (...args) => lines.push(args.join(' '))
  return { lines, restore: () => { console[method] = original } }
}

const withSuppressedConsole = async (method, run) => {
  const capture = captureConsole(method)
  try {
    await run(capture)
  } finally {
    capture.restore()
  }
}

test('exposes the namespace-plugin contract (named exports, no default)', () => {
  assert.equal(name, 'dsh-browsercontrol-mcp')
  assert.deepEqual(inject, ['loader'])
  assert.equal(typeof apply, 'function')
})

test('the Playwright MCP CLI resolves to a real file through the bin field', () => {
  const cli = resolveServerCli(normalizeConfig({}))
  assert.ok(existsSync(cli), `expected a real file, got ${cli}`)
  assert.match(cli, /cli\.js$/)
})

test('cliPath overrides resolution and is validated', () => {
  assert.equal(resolveServerCli(normalizeConfig({ cliPath: process.execPath })), process.execPath)
  assert.throws(() => resolveServerCli(normalizeConfig({ cliPath: 'C:/definitely/missing.js' })), /does not exist/)
})

test('isCdpTarget accepts CDP URLs and Chromium channels only', () => {
  for (const good of ['msedge', 'msedge-beta', 'chrome-canary', 'http://localhost:9222', 'ws://127.0.0.1:9222/devtools'])
    assert.equal(isCdpTarget(good), true, good)
  for (const bad of ['', 'firefox', 'webkit', 'not-a-thing', undefined, 42])
    assert.equal(isCdpTarget(bad), false, String(bad))
})

test('launch mode builds browser / headless / user-data-dir flags', () => {
  const args = buildServerArgs(
    normalizeConfig({ mode: 'launch', browser: 'msedge', headless: true, userDataDir: 'D:/prof' }),
    'cli.js',
  )
  assert.deepEqual(args, ['cli.js', '--browser', 'msedge', '--headless', '--user-data-dir', 'D:/prof'])
})

test('cdp mode uses the channel default, an explicit URL, or an alias channel', () => {
  assert.deepEqual(buildServerArgs(normalizeConfig({ mode: 'cdp' }), 'cli.js'), [
    'cli.js',
    '--cdp-endpoint=msedge',
    '--cdp-timeout=30000',
  ])
  assert.deepEqual(
    buildServerArgs(normalizeConfig({ mode: 'cdp', cdpEndpoint: 'http://localhost:9222' }), 'cli.js'),
    ['cli.js', '--cdp-endpoint=http://localhost:9222', '--cdp-timeout=30000'],
  )
  assert.deepEqual(buildServerArgs(normalizeConfig({ mode: 'cdp', cdpEndpoint: 'msedge-beta' }), 'cli.js'), [
    'cli.js',
    '--cdp-endpoint=msedge-beta',
    '--cdp-timeout=30000',
  ])
  assert.deepEqual(buildServerArgs(normalizeConfig({ mode: 'cdp', cdpTimeoutMs: 60000 }), 'cli.js'), [
    'cli.js',
    '--cdp-endpoint=msedge',
    '--cdp-timeout=60000',
  ])
})

test('extension mode builds the extension flags', () => {
  assert.deepEqual(buildServerArgs(normalizeConfig({ mode: 'extension' }), 'cli.js'), ['cli.js', '--extension'])
  assert.deepEqual(
    buildServerArgs(normalizeConfig({ mode: 'extension', profileDirName: 'Profile 1' }), 'cli.js'),
    ['cli.js', '--extension', '--profile-dir-name', 'Profile 1'],
  )
})

test('extraArgs are appended verbatim', () => {
  const args = buildServerArgs(normalizeConfig({ extraArgs: ['--caps', 'vision'] }), 'cli.js')
  assert.deepEqual(args.slice(-2), ['--caps', 'vision'])
})

test('bad config is rejected with an actionable message', () => {
  assert.throws(() => normalizeConfig({ nope: 1 }), /unknown config key "nope"/)
  assert.throws(() => normalizeConfig({ mode: 'teleport' }), /mode must be one of/)
  assert.throws(() => normalizeConfig({ browser: 'netscape' }), /browser must be one of/)
  assert.throws(() => normalizeConfig({ mode: 'launch', browser: 'msedge-beta' }), /launch mode/)
  assert.throws(() => normalizeConfig({ mode: 'cdp', cdpEndpoint: 'firefox' }), /cdp mode needs/)
  assert.throws(() => normalizeConfig({ serverName: 'bad name!' }), /serverName/)
  assert.throws(() => normalizeConfig({ extraArgs: [1] }), /extraArgs/)
  assert.throws(() => normalizeConfig({ env: [] }), /env must be a mapping/)
  assert.throws(() => normalizeConfig({ toolCallTimeoutMs: 0 }), /toolCallTimeoutMs/)
  assert.throws(() => normalizeConfig({ cdpTimeoutMs: -1 }), /cdpTimeoutMs/)
  assert.throws(() => normalizeConfig({ headless: 'yes' }), /headless must be a boolean/)
  assert.throws(() => normalizeConfig({ failOnStartupError: 1 }), /failOnStartupError must be a boolean/)
  assert.throws(() => normalizeConfig({ profileDirName: 1 }), /profileDirName must be a string/)
  assert.throws(() => normalizeConfig([]), /must be a mapping/)
})

test('extension mode tolerates a channel alias for browser (it is unused there)', () => {
  assert.equal(normalizeConfig({ mode: 'extension', browser: 'msedge-dev' }).browser, 'msedge-dev')
})

test('the generated row is a stdio row started by this very node', () => {
  const config = normalizeConfig({})
  const row = buildClientConfig(config, buildServerArgs(config, resolveServerCli(config)))
  assert.equal(row.serverName, 'playwright')
  assert.equal(row.transport, 'stdio')
  assert.equal(row.command, process.execPath)
  assert.ok(existsSync(row.args[0]))
  assert.equal(row.cwd, undefined)
  assert.equal(row.env, undefined)
  assert.equal(row.failOnStartupError, false)
})

test('the row carries cwd, env and failOnStartupError when configured', () => {
  const config = normalizeConfig({ cwd: 'E:/work', env: { A: '1' }, failOnStartupError: true })
  const row = buildClientConfig(config, ['cli.js'])
  assert.equal(row.cwd, 'E:/work')
  assert.deepEqual(row.env, { A: '1' })
  assert.equal(row.failOnStartupError, true)
})

test('apply mounts exactly one row and removes it on dispose', async () => {
  const { loader, created, removed } = fakeLoader()
  const { ctx, disposers } = fakeCtx(loader)
  apply(ctx, { serverName: 'browserctl', headless: true })
  await flush()
  assert.equal(created.length, 1)
  assert.equal(created[0].name, MCP_CLIENT)
  assert.equal(created[0].config.serverName, 'browserctl')
  assert.ok(existsSync(created[0].config.args[0]))
  assert.equal(disposers.length, 1)
  await disposers[0]()
  assert.deepEqual(removed, ['entry-1'])
})

test('a hand-written row with the same serverName wins and nothing is mounted', async () => {
  const existing = [{ options: { name: MCP_CLIENT, config: { serverName: 'playwright' } } }]
  const { loader, created } = fakeLoader(existing)
  const { ctx } = fakeCtx(loader)
  assert.equal(hasConflictingRow(loader, 'playwright'), true)
  assert.equal(hasConflictingRow(loader, 'other'), false)
  await withSuppressedConsole('warn', async () => {
    apply(ctx, {})
    await flush()
  })
  assert.equal(created.length, 0)
})

test('a broken loader.entries() never blocks the mount', async () => {
  const created = []
  const loader = {
    entries: () => {
      throw new Error('nope')
    },
    create: async (options) => {
      created.push(options)
      return 'entry-1'
    },
    remove: async () => {},
  }
  const { ctx } = fakeCtx(loader)
  apply(ctx, {})
  await flush()
  assert.equal(created.length, 1)
})

test('a bad config logs and mounts nothing instead of failing the plugin tree', async () => {
  const { loader, created } = fakeLoader()
  const { ctx, disposers } = fakeCtx(loader)
  await withSuppressedConsole('error', async (capture) => {
    assert.doesNotThrow(() => apply(ctx, { mode: 'teleport' }))
    await flush()
    assert.match(capture.lines.join('\n'), /not mounting: .*mode must be one of/)
  })
  assert.equal(created.length, 0)
  assert.equal(disposers.length, 0)
})

test('a missing Playwright MCP CLI logs and mounts nothing', async () => {
  const { loader, created } = fakeLoader()
  const { ctx } = fakeCtx(loader)
  await withSuppressedConsole('error', async (capture) => {
    assert.doesNotThrow(() => apply(ctx, { cliPath: 'C:/definitely/missing.js' }))
    await flush()
    assert.match(capture.lines.join('\n'), /not mounting: .*cliPath does not exist/)
  })
  assert.equal(created.length, 0)
})

test('disposing while the mount is still in flight still removes the row', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const removed = []
  const loader = {
    entries: () => [][Symbol.iterator](),
    create: async () => {
      await gate
      return 'entry-9'
    },
    remove: async (id) => {
      removed.push(id)
    },
  }
  const { ctx, disposers } = fakeCtx(loader)
  apply(ctx, {})
  const disposal = disposers[0]()
  release()
  await disposal
  assert.deepEqual(removed, ['entry-9'])
})
