/**
 * The attach of an ACP session from its record (claude-code-session.ts attachAcpSessionFromRecord, what a
 * restart and so every deploy leads to) mounts Walnut's tools on an ask, as its start did: the session's
 * task carries `walnut_agent`. A session whose task is no ask gets none, as before.
 *
 * 2026-11-26: the attach read the record's lane alone, so an ask on Codex or OpenCode that loaded its
 * thread again after a deploy had no Walnut tools (tests/providers/acp-attach-mount.test.ts pins the
 * derivation; this file the attach that uses it).
 *
 * Real: SessionRunner, its attach, the session and task stores. Faked: AcpSession (it records the config
 * it was built with), the daemon's probes, the cloud link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const fake = vi.hoisted(() => ({ built: [] as Array<{ cfg: Record<string, unknown> }> }))
vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-attach-mount-runner'))
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  disconnectAllDaemons: vi.fn(),
  probeDaemonSession: vi.fn(async () => ({ alive: false })),
  probeAcpWorker: vi.fn(async () => false),
}))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))
vi.mock('../../src/providers/acp-session.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const { vi: v } = await import('vitest')
  class FakeAcpSession {
    readonly runtimeId: string
    readonly engineId: string
    readonly mode = 'bypass'
    sessionId: string | null = null
    active = false
    activity = 'idle'
    hasPendingPermission = false
    outlivingWork: string[] = []
    cursorCommitting = false
    detach = v.fn()
    kill = v.fn(async () => {})
    constructor(readonly cfg: Record<string, unknown>) {
      this.runtimeId = String(cfg.runtimeId)
      this.engineId = String(cfg.engine)
      fake.built.push(this as never)
    }
    async establish(): Promise<string> {
      this.active = true
      this.sessionId = String(this.cfg.providerSessionId)
      return this.sessionId
    }
    async send(): Promise<void> {}
    async abortTurn(): Promise<void> {}
  }
  return { ...real, AcpSession: FakeAcpSession }
})

import { SID, harness, probeSetup, probeTeardown, settle } from '../helpers/runner-probe-harness.js'
import { setHostJudgeProbe, _resetJudgeOfForTesting } from '../../src/core/sessions/judge-of.js'
import { _setHostSwitchForTesting } from '../../src/core/session-channel/resume-hosts.js'
import { updateSessionRecord } from '../../src/core/session-tracker.js'
import { updateTaskRaw } from '../../src/core/task-manager.js'

/** A Codex session of this machine that ended (as after a restart), no ACP object of it here. */
async function stoppedCodex(lane?: string) {
  const h = harness({ running: false })
  Object.assign(h.session, { _active: false, _transport: undefined, pid: null })
  await updateSessionRecord(SID, { process_status: 'stopped', pid: undefined, engine: 'codex', acpRuntimeId: 'acp-0011223344556677', ...(lane ? { lane } : {}) } as never)
  h.runner.init()
  await settle(100)
  return h
}

beforeEach(async () => {
  await probeSetup()
  _resetJudgeOfForTesting()
  setHostJudgeProbe(() => false)
  _setHostSwitchForTesting(null)
  fake.built = []
})
afterEach(async () => {
  _resetJudgeOfForTesting()
  await probeTeardown()
})

describe('an ACP session attached from its record after a restart', () => {
  it('an ask (its task carries walnut_agent) gets Walnut\'s tools, naming this install, as its start did', async () => {
    await updateTaskRaw('gate-task', { walnut_agent: true } as never)
    const h = await stoppedCodex()
    await h.runner.findOrAttachAcpSession(SID)
    expect(fake.built).toHaveLength(1)
    const mount = fake.built[0]!.cfg.walnutMcpServer as { name: string; args: string[] } | undefined
    expect(mount?.name).toBe('walnut')
    expect(mount?.args.at(-1)).toBe('mcp')
    expect(fake.built[0]!.cfg.lane).toBeUndefined()
  })

  it('a session whose task is no ask gets none (the opt-in flag decides), as before', async () => {
    const h = await stoppedCodex()
    await h.runner.findOrAttachAcpSession(SID)
    expect(fake.built).toHaveLength(1)
    expect(fake.built[0]!.cfg.walnutMcpServer).toBeUndefined()
  })

  it('a lane keeps its whole lane bundle, as before', async () => {
    const h = await stoppedCodex('chat:general:conv-codex')
    await h.runner.findOrAttachAcpSession(SID)
    expect(fake.built[0]!.cfg).toMatchObject({ lane: 'chat:general:conv-codex', disableProjectInstructions: true })
    expect((fake.built[0]!.cfg.walnutMcpServer as { name?: string } | undefined)?.name).toBe('walnut')
  })
})
