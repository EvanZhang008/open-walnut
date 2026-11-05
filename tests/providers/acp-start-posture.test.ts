/**
 * The preset an ACP adapter starts in follows the start's Walnut mode
 * (acp-permission-posture.ts): through INITIAL_AGENT_MODE for codex-acp, and
 * through the adapter's own `mode` control for an engine that advertises a
 * full-access preset. The start's named mode wins over ~/.codex/config.toml;
 * the file applies only when the start named none.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-start-posture'))

import { WALNUT_HOME } from '../../src/constants.js'
import { _resetSessionTrackerForTesting, createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { recordedSessionMode } from '../../src/core/sessions/acp-recorded-mode.js'
import { persistSessionModeChange } from '../../src/core/sessions/session-lifecycle.js'
import { _resetForTesting } from '../../src/core/task-manager.js'
import type { SessionEngine, SessionMode } from '../../src/core/types.js'
import { AcpSession } from '../../src/providers/acp-session.js'
import { AcpModeRefusedError } from '../../src/providers/acp-permission-posture.js'

const ARTIFACTS = { workerCmd: ['worker'], adapterCmd: ['adapter'] }

function modeControl(values: string[], current: string) {
  return { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: current, options: values.map((value) => ({ value, name: value })) }
}

async function establish(o: { engine: SessionEngine; mode: SessionMode; modeNamed: boolean; controls?: unknown[]; sid: string; refuseSet?: boolean }) {
  const session = new AcpSession({
    taskId: '', project: '', cwd: '/tmp', mode: o.mode, modeNamed: o.modeNamed, engine: o.engine,
    runtimeId: `acp-${o.sid}`, artifacts: ARTIFACTS,
  })
  const send = vi.fn(async (command: string, params?: Record<string, unknown>) => {
    if (command === 'acpStart') {
      return {
        ok: true,
        session: { sessionId: o.sid, ...(o.controls ? { configOptions: o.controls } : {}) },
        state: {
          providerSessionId: undefined, adapterPid: 1, turnActive: false, controlActive: false, pendingPermissions: [],
          initializeResponse: {}, capabilities: {}, sessionResponse: { sessionId: o.sid }, lastAcceptedCommands: {}, journalOffset: 0,
          ...(o.controls ? { configOptions: o.controls } : {}),
        },
      }
    }
    if (command === 'acpSetConfigOption') {
      if (o.refuseSet) return { ok: false, error: 'adapter refused' }
      return { ok: true, result: { configOptions: (o.controls ?? []).map((c) => (c as { id: string }).id === params?.configId ? { ...(c as object), currentValue: params?.value } : c) } }
    }
    return { ok: true }
  })
  Object.assign(session as object, { conn: { connected: true, send } })
  const failed = await session.establish().then(() => undefined, (error: unknown) => error)
  if (failed) return { session, env: {}, sets: [], failed, calls: send.mock.calls.map((c) => c[0]), send }
  const start = send.mock.calls.find((c) => c[0] === 'acpStart')?.[1] as { env?: Record<string, string> }
  const sets = send.mock.calls.filter((c) => c[0] === 'acpSetConfigOption').map((c) => c[1])
  return { session, env: start.env ?? {}, sets, failed: undefined, calls: send.mock.calls.map((c) => c[0]), send }
}

let home: string
let previousHome: string | undefined

beforeEach(async () => {
  _resetForTesting()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-start-posture-home-'))
  // The user's own codex config asks before acting.
  await fs.mkdir(path.join(home, '.codex'), { recursive: true })
  await fs.writeFile(path.join(home, '.codex/config.toml'), 'sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n')
  previousHome = process.env.HOME
  process.env.HOME = home
})

afterEach(async () => {
  process.env.HOME = previousHome
  await fs.rm(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('codex start preset', () => {
  it('a start that names bypass runs full access, whatever config.toml says', async () => {
    const { env, session } = await establish({ engine: 'codex', mode: 'bypass', modeNamed: true, sid: 'codex-bypass' })
    expect(env.INITIAL_AGENT_MODE).toBe('agent-full-access')
    expect(session.startAgentMode).toBe('agent-full-access')
    expect(session.mode).toBe('bypass')
  })

  it('a start that names no mode takes the user\'s config.toml', async () => {
    const { env, session } = await establish({ engine: 'codex', mode: 'bypass', modeNamed: false, sid: 'codex-unnamed' })
    expect(env.INITIAL_AGENT_MODE).toBe('agent')
    expect(session.mode).toBe('default')
  })

  it('with no config.toml, a start that names no mode runs as a Claude Code start does (bypass)', async () => {
    await fs.rm(path.join(home, '.codex'), { recursive: true, force: true })
    const { env, session } = await establish({ engine: 'codex', mode: 'bypass', modeNamed: false, sid: 'codex-noconfig' })
    expect(env.INITIAL_AGENT_MODE).toBe('agent-full-access')
    expect(session.mode).toBe('bypass')
  })

  it('a named default asks, even under a full-access config.toml', async () => {
    await fs.writeFile(path.join(home, '.codex/config.toml'), 'sandbox_mode = "danger-full-access"\n')
    const { env } = await establish({ engine: 'codex', mode: 'default', modeNamed: true, sid: 'codex-default' })
    expect(env.INITIAL_AGENT_MODE).toBe('agent')
  })
})

describe('other engines', () => {
  it('a bypass start switches an advertised mode control to its full-access preset', async () => {
    const { sets, session } = await establish({
      engine: 'gemini', mode: 'bypass', modeNamed: true, sid: 'gemini-bypass',
      controls: [modeControl(['default', 'autoEdit', 'yolo'], 'default')],
    })
    expect(sets).toEqual([expect.objectContaining({ configId: 'mode', value: 'yolo' })])
    expect(session.startAgentMode).toBe('yolo')
  })

  it('a restrictive start moves an adapter that came up in full access (its own config) to its asking preset', async () => {
    const { sets, session, failed } = await establish({
      engine: 'gemini', mode: 'default', modeNamed: true, sid: 'gemini-from-yolo',
      controls: [modeControl(['default', 'autoEdit', 'yolo'], 'yolo')],
    })
    expect(failed).toBeUndefined()
    expect(sets).toEqual([expect.objectContaining({ configId: 'mode', value: 'default' })])
    expect(session.sessionControls.find((c) => c.id === 'mode')?.currentValue).toBe('default')
    expect(session.startAgentMode).toBe('default')
  })

  it('an adapter that refuses to leave full access under a restrictive start is stopped and the start fails', async () => {
    const { failed, calls } = await establish({
      engine: 'gemini', mode: 'default', modeNamed: true, sid: 'gemini-stuck-yolo', refuseSet: true,
      controls: [modeControl(['default', 'yolo'], 'yolo')],
    })
    expect(failed).toBeInstanceOf(AcpModeRefusedError)
    expect(calls).toContain('acpStop')
    // No asking preset to move to at all: the same.
    const none = await establish({
      engine: 'goose', mode: 'default', modeNamed: true, sid: 'goose-only-yolo',
      controls: [modeControl(['yolo'], 'yolo')],
    })
    expect(none.failed).toBeInstanceOf(AcpModeRefusedError)
  })

  it('a non-bypass start, or an adapter with no full-access preset, is left as it is', async () => {
    const asked = await establish({
      engine: 'gemini', mode: 'default', modeNamed: true, sid: 'gemini-default',
      controls: [modeControl(['default', 'autoEdit', 'yolo'], 'default')],
    })
    expect(asked.sets).toEqual([])
    const opencode = await establish({
      engine: 'opencode', mode: 'bypass', modeNamed: true, sid: 'opencode-bypass',
      controls: [modeControl(['build', 'plan'], 'build')],
    })
    expect(opencode.sets).toEqual([])
    expect(opencode.session.startAgentMode).toBeUndefined()
  })
})

/** A permission request as the worker journals it (acp-journal-projector.ts). */
function permissionLine(sessionId: string, requestId: string, command: string): string {
  return JSON.stringify({
    kind: 'acp', ts: Date.now(), source: 'live',
    frame: {
      jsonrpc: '2.0', method: 'session/request_permission', providerRequestId: requestId,
      params: {
        sessionId,
        toolCall: { toolCallId: `tc-${requestId}`, kind: 'execute', title: command, rawInput: { command } },
        options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }],
      },
    },
  })
}

describe('an old ACP session whose record says default', () => {
  // Before 2026-11-05 an ACP start that named no mode recorded 'default' (a
  // hardcoded fallback), whatever the adapter ran in. Such a record is no choice.
  async function oldRecord(engine: SessionEngine, sid: string, mode: SessionMode = 'default') {
    await createSessionRecord(sid, '', '', '/tmp', { mode, engine, initialProcessStatus: 'idle' })
    return (await getSessionByClaudeId(sid))!
  }

  it('starts again in full access on an adapter in yolo: no downgrade, no failure, no permission card', async () => {
    const record = await oldRecord('gemini', 'gemini-old-default')
    expect(record.mode).toBe('default')
    expect(record.modeChosen).toBeUndefined()
    const recorded = recordedSessionMode(record)
    expect(recorded).toEqual({ mode: 'bypass', chosen: false })
    // refuseSet: even an adapter that refuses every preset change starts.
    const { session, sets, failed, calls, send } = await establish({
      engine: 'gemini', mode: recorded.mode, modeNamed: recorded.chosen, sid: 'gemini-old-default', refuseSet: true,
      controls: [modeControl(['default', 'autoEdit', 'yolo'], 'yolo')],
    })
    expect(failed).toBeUndefined()
    expect(calls).not.toContain('acpStop')
    expect(sets).toEqual([])
    expect(session.mode).toBe('bypass')
    expect(session.sessionControls.find((c) => c.id === 'mode')?.currentValue).toBe('yolo')

    // A request the adapter still sends is answered by Walnut, never shown as a card.
    ;(session as unknown as { handleDaemonEvent(ev: unknown): void }).handleDaemonEvent({
      sid: 'acp-gemini-old-default', ev: 'jsonl', v: 1, line: permissionLine('gemini-old-default', 'p-old-1', 'rm -rf build'),
    })
    await vi.waitFor(() => expect(send.mock.calls.some((c) => c[0] === 'acpRespond')).toBe(true))
    const respond = send.mock.calls.find((c) => c[0] === 'acpRespond')?.[1] as { optionId?: string }
    expect(respond.optionId).toBe('allow')
    expect(session.getPendingPermissionRequests()).toEqual([])
  })

  it('an old codex session with no preset of its own starts in agent-full-access when no config.toml asks', async () => {
    await fs.rm(path.join(home, '.codex'), { recursive: true, force: true })
    const recorded = recordedSessionMode(await oldRecord('codex', 'codex-old-default'))
    const { env, session } = await establish({ engine: 'codex', mode: recorded.mode, modeNamed: recorded.chosen, sid: 'codex-old-default' })
    expect(env.INITIAL_AGENT_MODE).toBe('agent-full-access')
    expect(session.mode).toBe('bypass')
  })

  it('a default someone chose (a mode change marks it) still moves yolo off full access, and fails when refused', async () => {
    const record = await oldRecord('gemini', 'gemini-chosen-default', 'bypass')
    const changed = await persistSessionModeChange(record, 'gemini-chosen-default', 'default')
    expect(changed.modeChosen).toBe(true)
    const recorded = recordedSessionMode(changed)
    expect(recorded).toEqual({ mode: 'default', chosen: true })
    const moved = await establish({
      engine: 'gemini', mode: recorded.mode, modeNamed: recorded.chosen, sid: 'gemini-chosen-moved',
      controls: [modeControl(['default', 'yolo'], 'yolo')],
    })
    expect(moved.failed).toBeUndefined()
    expect(moved.sets).toEqual([expect.objectContaining({ configId: 'mode', value: 'default' })])
    const refused = await establish({
      engine: 'gemini', mode: recorded.mode, modeNamed: recorded.chosen, sid: 'gemini-chosen-refused', refuseSet: true,
      controls: [modeControl(['default', 'yolo'], 'yolo')],
    })
    expect(refused.failed).toBeInstanceOf(AcpModeRefusedError)
  })

  it('a restrictive mode nobody chose never fails a start, even when the adapter refuses to leave yolo', async () => {
    const { failed, calls } = await establish({
      engine: 'gemini', mode: 'default', modeNamed: false, sid: 'gemini-unchosen-refused', refuseSet: true,
      controls: [modeControl(['default', 'yolo'], 'yolo')],
    })
    expect(failed).toBeUndefined()
    expect(calls).not.toContain('acpStop')
  })

  it('reads every other recorded value as a choice, and a Claude Code record as it is', () => {
    expect(recordedSessionMode({ engine: 'gemini', mode: 'plan' })).toEqual({ mode: 'plan', chosen: true })
    expect(recordedSessionMode({ engine: 'opencode', mode: 'accept' })).toEqual({ mode: 'accept', chosen: true })
    expect(recordedSessionMode({ engine: 'codex', mode: 'default', modeChosen: true })).toEqual({ mode: 'default', chosen: true })
    expect(recordedSessionMode({ engine: 'claude', mode: 'default' })).toEqual({ mode: 'default', chosen: true })
    expect(recordedSessionMode({ engine: undefined, mode: 'default' })).toEqual({ mode: 'default', chosen: true })
  })
})
