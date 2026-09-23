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
      entries() {
        return existing[Symbol.iterator]()
      },
      async create(options) {
        created.push(options)
        return `entry-${created.length}`
      },
      async remove(id) {
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

test('launch mode builds browser / headless / user-data-dir flags', () => {
  const args = buildServerArgs(
    normalizeConfig({ mode: 'launch', browser: 'msedge', headless: true, userDataDir: 'D:/prof' }),
    'cli.js',
  )
  assert.deepEqual(args, ['cli.js', '--browser', 'msedge', '--headless', '--user-data-dir', 'D:/prof'])
})

test('cdp mode falls back to the channel name, or uses an explicit endpoint', () => {
  assert.deepEqual(buildServerArgs(normalizeConfig({ mode: 'cdp', browser: 'msedge' }), 'cli.js'), [
    'cli.js',
    '--cdp-endpoint=msedge',
    '--cdp-timeout=30000',
  ])
  assert.deepEqual(
    buildServerArgs(normalizeConfig({ mode: 'cdp', cdpEndpoint: 'http://localhost:9222' }), 'cli.js'),
    ['cli.js', '--cdp-endpoint=http://localhost:9222', '--cdp-timeout=30000'],
  )
})

test('extension mode builds the extension flag', () => {
  assert.deepEqual(buildServerArgs(normalizeConfig({ mode: 'extension' }), 'cli.js'), ['cli.js', '--extension'])
})

test('extraArgs are appended verbatim', () => {
  const args = buildServerArgs(normalizeConfig({ extraArgs: ['--caps', 'vision'] }), 'cli.js')
  assert.deepEqual(args.slice(-2), ['--caps', 'vision'])
})

test('bad config is rejected with an actionable message', () => {
  assert.throws(() => normalizeConfig({ nope: 1 }), /unknown config key "nope"/)
  assert.throws(() => normalizeConfig({ mode: 'teleport' }), /mode must be one of/)
  assert.throws(() => normalizeConfig({ browser: 'netscape' }), /browser must be one of/)
  assert.throws(() => normalizeConfig({ serverName: 'bad name!' }), /serverName/)
  assert.throws(() => normalizeConfig({ extraArgs: [1] }), /extraArgs/)
  assert.throws(() => normalizeConfig({ toolCallTimeoutMs: 0 }), /toolCallTimeoutMs/)
  assert.throws(() => normalizeConfig([]), /must be a mapping/)
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
  apply(ctx, {})
  await flush()
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
