import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, name as pluginName } from '../lib/index.js'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Read the `| `key` | `default` |` rows of a config table. Troubleshooting rows
 * are ignored because their first cell is prose, not a bare identifier.
 */
function configTable(file) {
  const rows = new Map()
  for (const line of readFileSync(join(repo, file), 'utf8').split('\n')) {
    const match = line.match(/^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|\s*([^|]*?)\s*\|/)
    if (match) rows.set(match[1], match[2])
  }
  return rows
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The README cell that must truthfully describe a default value. */
function expectedCell(actual) {
  if (typeof actual === 'string') return actual === '' ? /空|empty/ : new RegExp(escape(actual))
  if (Array.isArray(actual)) return /\[\]/
  if (actual !== null && typeof actual === 'object') return /\{\}/
  return new RegExp(escape(String(actual)))
}

for (const file of ['README.md', 'README.en.md']) {
  test(`${file}: the config table documents exactly the supported keys`, () => {
    assert.deepEqual([...configTable(file).keys()].sort(), Object.keys(DEFAULTS).sort())
  })

  test(`${file}: every documented default matches the code`, () => {
    for (const [key, cell] of configTable(file))
      assert.match(cell, expectedCell(DEFAULTS[key]), `${file}: ${key} is documented as "${cell}"`)
  })

  test(`${file}: states the package name`, () => {
    assert.ok(readFileSync(join(repo, file), 'utf8').includes(pluginName))
  })
}

test('README.md is the Chinese homepage default and README.en.md is English', () => {
  const home = readFileSync(join(repo, 'README.md'), 'utf8')
  const english = readFileSync(join(repo, 'README.en.md'), 'utf8')
  const cjk = (text) => (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  assert.ok(cjk(home) > 500, 'README.md should be the Chinese edition')
  assert.ok(cjk(english) < 20, 'README.en.md should be English apart from its switcher')
})

test('the two READMEs link to each other (language switcher)', () => {
  const zh = readFileSync(join(repo, 'README.md'), 'utf8')
  const en = readFileSync(join(repo, 'README.en.md'), 'utf8')
  assert.match(zh, /\]\(README\.en\.md\)/, 'README.md (the Chinese homepage) must link to README.en.md')
  assert.match(en, /\]\(README\.md\)/, 'README.en.md must link to README.md')
})

test('the bundle patch and the plugin agree on the row id and package name', () => {
  const patch = readFileSync(join(repo, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: browsercontrol-mcp/)
  assert.match(patch, /name: 'dsh-browsercontrol-mcp'/)
})
