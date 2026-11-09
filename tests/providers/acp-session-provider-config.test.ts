/**
 * A control the provider changes itself (direct Codex leaving plan mode once a plan is
 * approved, or `/plan`) reaches the session: its controls, the stored pick a restart
 * replays (acpConfig) and every open window (session:controls-changed).
 */
import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-session-provider-config'))

import { WALNUT_HOME } from '../../src/constants.js'
import { _resetSessionTrackerForTesting, createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { AcpSession } from '../../src/providers/acp-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

beforeEach(async () => {
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(() => { bus.unsubscribe('acp-provider-config-test') })

const collaboration = (value: string) => ({
  type: 'select', id: 'collaboration_mode', name: 'Collaboration mode', currentValue: value,
  options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }],
})
const mode = { type: 'select', id: 'mode', name: 'Mode', currentValue: 'auto', options: [{ value: 'auto', name: 'Agent' }] }

async function setup() {
  const sessionId = 'codex-provider-config-1'
  const runtimeId = 'rt-provider-config-1'
  await createSessionRecord(sessionId, '', 'Quick Start', '/tmp', {
    initialProcessStatus: 'running', messageCount: 0, engine: 'codex', acpRuntimeId: runtimeId,
  })
  await updateSessionRecord(sessionId, { acpConfig: { collaboration_mode: 'plan', mode: 'auto' }, mode: 'plan' })
  const session = new AcpSession({
    taskId: '', project: 'Quick Start', cwd: '/tmp', mode: 'default', engine: 'codex',
    providerSessionId: sessionId, runtimeId, consumedOffset: 0,
  })
  ;(session as unknown as { _configOptions: unknown[] })._configOptions = [collaboration('plan'), mode]
  const events: Array<Record<string, unknown>> = []
  bus.subscribe('acp-provider-config-test', (e) => {
    if (e.name === EventNames.SESSION_CONTROLS_CHANGED) events.push(e.data as Record<string, unknown>)
  }, { global: true, interest: [EventNames.SESSION_CONTROLS_CHANGED] })
  const consume = (session as unknown as { consumeJournalLine(line: string, offset: number): void }).consumeJournalLine.bind(session)
  const update = (v: number, configOptions: unknown[], source = 'live') => consume(JSON.stringify({
    kind: 'acp', ts: v, source,
    frame: { method: 'session/update', params: { sessionId, update: { sessionUpdate: 'config_option_update', configOptions } } },
  }), v)
  return { sessionId, session, events, update }
}

describe('a control the provider changed itself', () => {
  it('updates the controls, the stored pick and every open window', async () => {
    const { sessionId, session, events, update } = await setup()
    update(100, [collaboration('default'), mode])
    expect(session.sessionControls.find((c) => c.id === 'collaboration_mode')?.currentValue).toBe('default')
    await vi.waitFor(async () => {
      expect((await getSessionByClaudeId(sessionId))?.acpConfig).toEqual({ collaboration_mode: 'default', mode: 'auto' })
      // Plan vs exec is mirrored onto the record's mode, as a person's pick is.
      expect((await getSessionByClaudeId(sessionId))?.mode).toBe('default')
      expect(events).toEqual([expect.objectContaining({ sessionId })])
    })
  })

  it('two quick changes land in order: plan then default leaves the record on default', async () => {
    const { sessionId, session, update } = await setup()
    // Start from default, then Codex turns plan on and straight off again.
    await updateSessionRecord(sessionId, { acpConfig: { collaboration_mode: 'default', mode: 'auto' }, mode: 'default' })
    ;(session as unknown as { _configOptions: unknown[] })._configOptions = [collaboration('default'), mode]
    // Each mode write announces itself; both changes must write one (plan, then default).
    const modeWrites: string[] = []
    bus.subscribe('acp-provider-config-test-modes', (e) => {
      const data = e.data as { sessionId?: string; mode?: string }
      if (data.sessionId === sessionId && data.mode) modeWrites.push(data.mode)
    }, { global: true, interest: [EventNames.SESSION_STATUS_CHANGED] })
    try {
      update(200, [collaboration('plan'), mode])
      update(300, [collaboration('default'), mode])
      await vi.waitFor(() => expect(modeWrites).toEqual(['plan', 'default']), { timeout: 3000 })
    } finally {
      bus.unsubscribe('acp-provider-config-test-modes')
    }
    const rec = await getSessionByClaudeId(sessionId)
    expect(rec?.acpConfig?.collaboration_mode).toBe('default')
    expect(rec?.mode).toBe('default')
    expect((session as unknown as { _mode: string })._mode).toBe('default')
  })

  it('a replayed frame changes nothing', async () => {
    const { sessionId, session, events, update } = await setup()
    // A replayed frame is turned away before anything asynchronous starts.
    update(100, [collaboration('default'), mode], 'replay')
    expect(session.sessionControls.find((c) => c.id === 'collaboration_mode')?.currentValue).toBe('plan')
    expect((await getSessionByClaudeId(sessionId))?.acpConfig).toEqual({ collaboration_mode: 'plan', mode: 'auto' })
    expect(events).toHaveLength(0)
  })
})
