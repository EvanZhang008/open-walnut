/**
 * Built-in actions load through the host bundle (src/actions/builtin-modules.ts).
 *
 * As separate build entries each was a full private copy of core, and discovery
 * imported every one at boot: the triage action alone put a 14.8 MB bundle (about
 * 30 MB of source text) in the server's heap.
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('builtin-action-modules'))

import { BUILTIN_ACTION_MODULES } from '../../src/actions/builtin-modules.js'
import { discoverActions, runAction } from '../../src/actions/registry.js'

const root = path.resolve(import.meta.dirname, '../..')
const NOT_ACTIONS = new Set(['types', 'registry', 'index', 'builtin-modules'])

describe('built-in actions load as host modules', () => {
  it('lists every action file in src/actions, and nothing else', () => {
    const files = fs.readdirSync(path.join(root, 'src/actions'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.slice(0, -3))
      .filter((f) => !NOT_ACTIONS.has(f))
    expect(Object.keys(BUILTIN_ACTION_MODULES).sort()).toEqual(files.sort())
  })

  it('the build emits no separate action bundle', async () => {
    const { default: config } = await import('../../tsup.config.ts') as { default: { entry: string[] } }
    expect(config.entry.filter((e) => /(^|\/)src\/actions\//.test(e))).toEqual([])
  })

  it('discovery finds the built-ins from the table, and runAction runs one by id', async () => {
    const actions = await discoverActions()
    const triage = actions.find((a) => a.id === 'inbox-triage-batch')
    expect(triage).toMatchObject({ source: 'builtin', filePath: 'builtin:inbox-triage-batch' })
    // Off by default: the action answers without touching anything.
    const result = await runAction('inbox-triage-batch', {})
    expect(result.content).not.toMatch(/not found|failed:/)
  })
})
