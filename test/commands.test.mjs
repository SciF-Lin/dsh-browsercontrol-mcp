import test from 'node:test'
import assert from 'node:assert/strict'
import { registerCommands } from '../lib/commands.js'

function fakeCtx() {
  const registered = []
  return {
    registered,
    ctx: {
      inject(_deps, callback) {
        callback({
          effect: (fn) => {
            fn()
          },
          commands: {
            register(definition) {
              registered.push(definition)
              return () => {}
            },
          },
        })
      },
    },
  }
}

function fakeGuide(state = 'not-ready', { openOk = true } = {}) {
  const calls = { refresh: 0, open: 0 }
  return {
    calls,
    state: { state },
    refreshNow: async () => {
      calls.refresh += 1
    },
    statusText: () => `status:${state}`,
    openNow: async () => {
      calls.open += 1
      return openOk ? { ok: true, text: 'opened the page' } : { ok: false, text: 'could not open' }
    },
  }
}

test('registers the two human commands with stable identities', () => {
  const { ctx, registered } = fakeCtx()
  registerCommands(ctx, fakeGuide(), { mode: 'cdp' })
  assert.deepEqual(registered.map((d) => d.name), ['bw', 'bw-setup'])
  assert.deepEqual(registered.map((d) => d.definitionId), [
    'dsh-browsercontrol-mcp:browser-status',
    'dsh-browsercontrol-mcp:browser-setup',
  ])
  for (const definition of registered) {
    assert.equal(typeof definition.handler, 'function')
    assert.ok(definition.description.length > 0)
    assert.match(definition.name, /^[a-z][a-z0-9-]*$/)
  }
})

test('/bw refreshes and reports the current status', async () => {
  const { ctx, registered } = fakeCtx()
  const guide = fakeGuide('ready')
  registerCommands(ctx, guide, { mode: 'cdp' })
  const result = await registered[0].handler({ rawInput: '' })
  assert.deepEqual(result, { kind: 'success', text: 'status:ready' })
  assert.equal(guide.calls.refresh, 1)
})

test('/bw-setup opens the settings page when authorization is missing', async () => {
  const { ctx, registered } = fakeCtx()
  const guide = fakeGuide('not-ready')
  registerCommands(ctx, guide, { mode: 'cdp' })
  const result = await registered[1].handler({ rawInput: '' })
  assert.deepEqual(result, { kind: 'success', text: 'opened the page' })
  assert.equal(guide.calls.open, 1)
})

test('/bw-setup surfaces a failure instead of pretending it worked', async () => {
  const { ctx, registered } = fakeCtx()
  const guide = fakeGuide('not-ready', { openOk: false })
  registerCommands(ctx, guide, { mode: 'cdp' })
  const result = await registered[1].handler({ rawInput: '' })
  assert.deepEqual(result, { kind: 'error', text: 'could not open' })
})

test('/bw-setup does not open anything when there is nothing to authorize', async () => {
  const ready = fakeCtx()
  const readyGuide = fakeGuide('ready')
  registerCommands(ready.ctx, readyGuide, { mode: 'cdp' })
  const readyResult = await ready.registered[1].handler({ rawInput: '' })
  assert.equal(readyResult.kind, 'success')
  assert.equal(readyGuide.calls.open, 0)

  const launch = fakeCtx()
  const launchGuide = fakeGuide('not-ready')
  registerCommands(launch.ctx, launchGuide, { mode: 'launch' })
  const launchResult = await launch.registered[1].handler({ rawInput: '' })
  assert.equal(launchResult.kind, 'error')
  assert.equal(launchGuide.calls.open, 0)
})

test('a context without the commands service is left alone', () => {
  const log = { error() {} }
  assert.doesNotThrow(() => registerCommands({}, fakeGuide(), { mode: 'cdp' }, log))
  assert.doesNotThrow(() => registerCommands({ inject: undefined }, fakeGuide(), { mode: 'cdp' }, log))
})
