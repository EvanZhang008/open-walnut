/**
 * The Mac adopts a new Ask Walnut a host started while it was away (journal v2 kind
 * `session`, src/core/offline-merge/apply-session.ts, WP12), against the real task store
 * and session tracker of a temp home:
 *   - the ask's task-create then its session: the task is an ask (walnut_agent) under
 *     Ask Walnut, linked to its session as this Mac's own start links one (the plan or exec
 *     slot, session_id), so the Ask panel finds it after a reload; the session record runs
 *     on that host in its folder and mode, with the persona this Mac renders and no walnut
 *     MCP mount (its walnut tools are the `walnut` CLI through the host daemon's gateway),
 *     and the drain asks the connection to look at it (the rescue);
 *   - a non-Walnut agent's ask keeps its agent (agent_id, read back from the store);
 *   - a lost ack drains the session again: adopted once;
 *   - a session whose task never reached the Mac is refused (nothing made), and acked.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-drain-session-adopt'))

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { getTask } from '../../../src/core/task-manager.js'
import { getSessionByClaudeId, getSessionsForTaskSync, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { refreshWalnutSessionProfile } from '../../../src/core/sessions/personal-ai-lane.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { createDevice, listDeviceRecords } from '../../../src/core/device-auth.js'

/** A phone paired with this Mac (the drain refuses a record of a device it no longer knows). */
const DEVICE = { kind: 'device', deviceId: '', name: 'acme-phone' }
let seqN = 4000
let opN = 0
const op = (): string => `op-ask-${(++opN).toString(16).padStart(12, '0')}`

const createRec = (taskId: string) => ({
  v: 2, seq: ++seqN, at: Date.now(), kind: 'task-create', opId: op(), rev: 1, actor: DEVICE,
  taskId, fields: { title: 'Ask Walnut' }, placement: { project: 'Ask Walnut' },
})
const sessionRec = (sid: string, taskId: string, over: Record<string, unknown> = {}) => ({
  v: 2, seq: ++seqN, at: Date.now(), kind: 'session', opId: op(), rev: 1, actor: DEVICE,
  sid, taskId, host: 'marina', cwd: '/srv/marina/walnut/data', agentId: 'general', mode: 'plan', effort: 'low',
  title: 'Ask Walnut', startedAt: Date.now() - 60_000, firstMessage: 'Why is the marina build red?', ...over,
})

/** A host journal that keeps a record until an ack reaches it, and records each rescue. */
function journal(hostKey: string, records: Array<Record<string, unknown>>) {
  const pending = [...records]
  const rescued: string[][] = []
  return {
    pending, rescued,
    conn: {
      hostKey, journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.drain') return { ok: true, records: pending.slice(), now: Date.now() }
        if (cmd === 'offline.ack') for (const s of (p?.seqs as number[]) ?? []) { const i = pending.findIndex((r) => r.seq === s); if (i !== -1) pending.splice(i, 1) }
        return { ok: true }
      },
      rescue: async (ids: string[]) => { rescued.push(ids) },
    },
  }
}

beforeAll(async () => {
  await createDevice(DEVICE.name)
  DEVICE.deviceId = (await listDeviceRecords()).find((d) => d.name === DEVICE.name)!.id
})
beforeEach(() => {
  _resetOfflineHandoverForTesting()
  _resetHostClocksForTesting()
  _setHandoverBackoffForTesting([1, 1])
})
afterAll(() => { _setHandoverBackoffForTesting(null); closeDb() })

describe('a new ask a host started while the Mac was away', () => {
  it('is adopted: an ask under Ask Walnut linked to its session, the session on that host with no walnut mount, and the connection looks at it', async () => {
    const minted = 'mtaskask0000adopt0001'
    const sid = 'dddddddd-4444-4444-8444-000000000001'
    const j = journal('marina', [createRec(minted), sessionRec(sid, minted)])
    await runOfflineHandover(j.conn as never)
    expect(j.pending).toHaveLength(0)
    const s = await getSessionByClaudeId(sid)
    expect(s).toMatchObject({ claudeSessionId: sid, host: 'marina', cwd: '/srv/marina/walnut/data', mode: 'plan', effort: 'low', title: 'Ask Walnut', process_status: 'stopped' })
    const task = await getTask(s!.taskId)
    expect(task).toMatchObject({ title: 'Ask Walnut', project: 'Ask Walnut', walnut_agent: true })
    // Linked as this Mac's own start links a plan-mode session: the Ask panel finds it by the task.
    expect(task).toMatchObject({ session_id: sid, plan_session_id: sid })
    expect(task.session_ids).toContain(sid)
    // The persona as this Mac renders it, and no walnut MCP mount (never this Mac's execPath,
    // never the host's app talking to that host's 127.0.0.1:3456).
    expect(s!.profile?.systemPrompt?.length ?? 0).toBeGreaterThan(0)
    expect(s!.profile?.mcpServers).toBeUndefined()
    expect(j.rescued.flat()).toContain(sid)
  })

  it('a default-mode ask fills the exec slot; a Mentor ask keeps its agent (agent_id, read back from the store)', async () => {
    const minted = 'mtaskask0000adopt0005'
    const sid = 'dddddddd-4444-4444-8444-000000000005'
    await runOfflineHandover(journal('marina', [
      { ...createRec(minted), placement: { project: 'Ask Mentor' }, fields: { title: 'Ask Mentor' } },
      sessionRec(sid, minted, { agentId: 'mentor', mode: 'default', title: 'Ask Mentor' }),
    ]).conn as never)
    const s = await getSessionByClaudeId(sid)
    expect(s).not.toBeNull()
    const task = await getTask(s!.taskId)
    expect(task).toMatchObject({ walnut_agent: true, agent_id: 'mentor', session_id: sid, exec_session_id: sid })
  })

  it('a lost ack drains the same session again: adopted once', async () => {
    const minted = 'mtaskask0000adopt0002'
    const sid = 'dddddddd-4444-4444-8444-000000000002'
    const create = createRec(minted)
    const session = sessionRec(sid, minted)
    await runOfflineHandover(journal('marina', [create, session]).conn as never)
    const taskId = (await getSessionByClaudeId(sid))!.taskId
    const again = journal('marina', [create, session])
    await runOfflineHandover(again.conn as never)
    expect(again.pending).toHaveLength(0)
    expect(getSessionsForTaskSync(taskId).filter((x) => x.claudeSessionId === sid)).toHaveLength(1)
  })

  it('an adoption stopped between its record and its link (a restart) is linked by the redrain, once', async () => {
    const minted = 'mtaskask0000adopt0006'
    const sid = 'dddddddd-4444-4444-8444-000000000006'
    const create = createRec(minted)
    const session = sessionRec(sid, minted)
    await runOfflineHandover(journal('marina', [create, session]).conn as never)
    const taskId = (await getSessionByClaudeId(sid))!.taskId
    // The link never happened: the task lists no session.
    const { updateTaskRaw } = await import('../../../src/core/task-manager.js')
    await updateTaskRaw(taskId, { session_ids: [], session_id: undefined, plan_session_id: undefined } as never, { source: 'offline-handover' })
    expect((await getTask(taskId)).session_ids ?? []).not.toContain(sid)
    // Nor its ledger row (written after the apply returns): the redrain reaches the adoption again.
    const { _setLedgerFileForTesting } = await import('../../../src/core/offline-merge/ledger.js')
    _setLedgerFileForTesting(path.join(os.tmpdir(), `ledger-relink-${process.pid}-${Date.now()}.json`))
    const again = journal('marina', [session])
    try { await runOfflineHandover(again.conn as never) } finally { _setLedgerFileForTesting(null) }
    expect(again.pending).toHaveLength(0)
    expect((await getTask(taskId)).session_ids).toContain(sid)
    expect(getSessionsForTaskSync(taskId).filter((x) => x.claudeSessionId === sid)).toHaveLength(1)
    expect(again.rescued.flat()).toContain(sid)
  })

  it('a host ask whose record holds a walnut mount loses it at the next send, before the cold resume reads the record', async () => {
    const minted = 'mtaskask0000adopt0004'
    const sid = 'dddddddd-4444-4444-8444-000000000004'
    await runOfflineHandover(journal('acme', [createRec(minted), sessionRec(sid, minted)]).conn as never)
    const before = await getSessionByClaudeId(sid)
    expect(before).toMatchObject({ host: 'acme', process_status: 'stopped' })
    // A record an earlier build wrote with a mount of the host's app.
    await updateSessionRecord(sid, { profile: { ...before!.profile!, mcpServers: { walnut: { command: '/usr/bin/node', args: ['/srv/acme/walnut/app/dist/cli.js', 'mcp'] } } } })
    await refreshWalnutSessionProfile(sid)
    const after = await getSessionByClaudeId(sid)
    expect(after!.profile?.mcpServers).toBeUndefined()
    expect(after!.profile?.systemPrompt).toBe(before!.profile!.systemPrompt)
  })

  it('a session whose task never reached this Mac is refused: nothing is made, and the record is taken', async () => {
    const sid = 'dddddddd-4444-4444-8444-000000000003'
    const j = journal('marina', [sessionRec(sid, 'mtaskask0000nowhere03')])
    await runOfflineHandover(j.conn as never)
    expect(j.pending).toHaveLength(0)
    expect(await getSessionByClaudeId(sid)).toBeNull()
  })
})
