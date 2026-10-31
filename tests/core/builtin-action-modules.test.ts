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
import { CronService } from '../../src/core/cron/service.js'
import { WALNUT_HOME } from '../../src/constants.js'

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

describe('a routine whose action was removed', () => {
  // An older install keeps its routines: one may still name 'screenshot-track',
  // the screen-capture action removed with the Life Tracker on 2026-10-31.
  const REMOVED = 'screenshot-track'

  it('runAction skips a retired action with the reason, never a text the executor would act on', async () => {
    const result = await runAction(REMOVED, {})
    expect(result).toMatchObject({ invoke: false, status: 'skipped' })
    expect(result.content).toMatch(/retired/)
  })

  it('an action that never existed (a deleted user action) fails the run', async () => {
    const result = await runAction('no-such-action-ever', {})
    expect(result).toMatchObject({ invoke: false, status: 'error' })
    expect(result.content).toMatch(/not found/)
  })

  it('the engine boots with that routine and records its fire as a skipped run, starting nothing', async () => {
    const storePath = path.join(WALNUT_HOME, `cron-removed-action-${Date.now()}.json`)
    fs.mkdirSync(WALNUT_HOME, { recursive: true })
    fs.writeFileSync(storePath, JSON.stringify({ version: 1, jobs: [] }), 'utf-8')
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() }
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({ status: 'ok', summary: 'done' })
    const deps = () => ({
      log: log as never,
      storePath,
      cronEnabled: true,
      broadcastCronNotification: vi.fn(),
      runMainAgentWithPrompt: vi.fn().mockResolvedValue(undefined),
      runIsolatedAgentJob,
      // The server's adapter (src/web/server.ts), reduced to the branches this run takes.
      runAction: async (actionId: string, params: Record<string, unknown>) => {
        const ar = await runAction(actionId, params)
        if (ar.status === 'skipped') return { status: 'skipped' as const, summary: ar.content }
        if (ar.status === 'error') return { status: 'error' as const, error: ar.content }
        return { status: 'ok' as const, summary: ar.content }
      },
    })

    const first = new CronService(deps())
    const job = await first.add({
      name: 'Life Tracker - Screenshot',
      enabled: false,
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: { kind: 'agentTurn', message: 'analyze the screenshot' },
      initProcessor: { actionId: REMOVED },
    })
    first.stop()

    // Boot again on the stored file, as a restart does.
    const service = new CronService(deps())
    await expect(service.start()).resolves.toBeUndefined()
    try {
      expect((await service.list({ includeDisabled: true })).map((j) => j.id)).toContain(job.id)
      await service.run(job.id, 'force')
      const updated = (await service.list({ includeDisabled: true })).find((j) => j.id === job.id)
      expect(updated?.state.lastStatus).toBe('skipped')
      expect(runIsolatedAgentJob).not.toHaveBeenCalled()
    } finally {
      service.stop()
    }
  })
})
