/**
 * A Codex model picked at start (launcher, task_create, task_start, an engine
 * switch) lands on the endpoint's id when engines.codex.provider has a
 * model_prefix. Codex lists the bare id, and on such an endpoint the bare id
 * starts a session with no tools; the prefixed one is not in codex's list, so the
 * start used to drop the pick and launch on the default. The fake session stands
 * in for AcpSession only: it starts its thread on the model its config carries,
 * as the real one does through CODEX_CONFIG (tests/providers/codex-engine-config.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-start-codex-pick'))

let nextSid = 0
/** Whether the start's pick rides the thread config (true with engines.codex.provider). */
let ridesPick = true
const made: Array<{ cfg: Record<string, unknown> }> = []
vi.mock('../../src/providers/acp-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/acp-session.js')>()
  class FakeAcpSession {
    runtimeId = `rt-pick-${++nextSid}`
    sessionId: string | undefined
    activity = 'idle'
    // Codex's own list: bare ids only.
    sessionControls = [{ id: 'model', currentValue: 'gpt-default', options: [{ value: 'gpt-default' }, { value: 'gpt-other' }] }]
    constructor(readonly cfg: Record<string, unknown>) { made.push(this) }
    get modelCatalog() {
      const pick = (this.cfg.acpConfig as { model?: string; reasoning_effort?: string } | undefined)
      const listed = pick?.model && this.sessionControls[0].options.some((o) => o.value === pick.model)
      const on = pick?.model && (listed || ridesPick)
      return { availableModels: [], currentModelId: on ? `${pick!.model}[${pick!.reasoning_effort ?? 'medium'}]` : 'gpt-default[medium]' }
    }
    async establish() { this.sessionId = `acp-pick-sid-${nextSid}`; return this.sessionId }
    async send() {}
    async abortTurn() {}
    async requestTurnCompleteSelfReport() { return '' }
  }
  return { ...actual, AcpSession: FakeAcpSession }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { addTask } from '../../src/core/task-manager.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js'

const start = (data: Record<string, unknown>) => (sessionRunner as unknown as {
  handleAcpStart(d: Record<string, unknown>): Promise<{ claudeSessionId: string }>
}).handleAcpStart.call(sessionRunner, data)

async function startWith(model: string) {
  const { task } = await addTask({ title: 'Pick a model' })
  await createSessionRecord(`acp-pick-sid-${nextSid + 1}`, task.id, '', '/tmp/demo', { engine: 'codex' } as never)
  const { claudeSessionId } = await start({ taskId: task.id, message: 'go', engine: 'codex', cwd: '/tmp/demo', model })
  return { cfg: made.at(-1)!.cfg, record: await getSessionByClaudeId(claudeSessionId) }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

describe('a Codex start pick on an endpoint with its own model ids', () => {
  it('a bare pick starts on the prefixed id and is kept, so a respawn replays it', async () => {
    await updateConfig({ engines: { codex: { provider: { base_url: 'http://127.0.0.1:9000/v1', name: 'my-proxy', model_prefix: 'vendor.' } } } } as never)
    const { cfg, record } = await startWith('gpt-other[xhigh]')
    expect(cfg.acpConfig).toEqual({ model: 'vendor.gpt-other', reasoning_effort: 'xhigh' })
    expect(record?.acpConfig).toEqual({ model: 'vendor.gpt-other', reasoning_effort: 'xhigh' })
    expect(record?.acpModel).toBe('vendor.gpt-other[xhigh]')
  })

  it('an already prefixed pick is taken as it is', async () => {
    await updateConfig({ engines: { codex: { provider: { base_url: 'http://127.0.0.1:9000/v1', model_prefix: 'vendor.' } } } } as never)
    const { cfg, record } = await startWith('vendor.gpt-other[low]')
    expect(cfg.acpConfig).toEqual({ model: 'vendor.gpt-other', reasoning_effort: 'low' })
    expect(record?.acpModel).toBe('vendor.gpt-other[low]')
  })

  it('without a provider nothing changes: a listed pick is kept, an unlisted one falls back to the default', async () => {
    await updateConfig({ engines: { codex: {} } } as never)
    ridesPick = false
    try {
      const listed = await startWith('gpt-other[high]')
      expect(listed.cfg.acpConfig).toEqual({ model: 'gpt-other', reasoning_effort: 'high' })
      expect(listed.record?.acpConfig).toEqual({ model: 'gpt-other', reasoning_effort: 'high' })
      const stale = await startWith('gpt-gone')
      expect(stale.cfg.acpConfig).toEqual({ model: 'gpt-gone' })
      expect(stale.record?.acpConfig).toBeUndefined()
      expect(stale.record?.acpModel).toBeUndefined()
    } finally {
      ridesPick = true
    }
  })
})
