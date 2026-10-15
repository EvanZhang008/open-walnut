/**
 * Journal v2 against an OLD Mac (plan section 5 "Ack", R25): the 1fe1fd194 drain loop
 * (`handover`) and its `applyRecord`, read from git into a temp module, run against
 * the new daemon core exactly as the twins answer `offline.drain` / `offline.ack` for a
 * Mac that sends no `kinds`.
 *
 * Why the daemon must withhold v2 kinds: the old `applyRecord` has no case for them, so
 * it applies nothing and the old loop acks them by watermark (the first test pins that
 * hazard). The daemon therefore hands an old Mac only the v1 prefix, and an `upTo` ack
 * drops only seqs it handed out, so no v2 record is ever acked or lost by an old Mac.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'
import { JHOME, SID_A, TASK_A, DEVICE, journalTmpDir, cleanupJournalDirs, journalHost, jslice } from '../helpers/offline-journal-harness.js'
import { oldMacDrain, cleanupOldSources } from '../helpers/v1-daemon-sources.js'

const T0 = Date.parse('2026-10-14T12:00:00Z')

/** One example of every v2 kind, as the daemon writes it. */
const V2_RECORDS: Array<Record<string, unknown>> = [
  { kind: 'task-fields', op: 'task_update', taskId: TASK_A, fields: { title: { base: 'Leader work', value: 'Renamed' } } },
  { kind: 'task-create', taskId: 'mtask-new-0001', fields: { title: 'From the phone' }, placement: { project: 'Acme' } },
  { kind: 'task-move', taskId: TASK_A, anchor: { after: 'mtaskbbb-0002' }, tier: 'focus', base: 'unknown' },
  { kind: 'board', op: 'board_post', args: { task: TASK_A, thread: 'plan', text: 'hello' }, postId: 'bm-host-0001' },
  { kind: 'note', path: 'notes/acme.md', mode: 'put', baseHash: 'h0', baseBlob: null, oursBlob: null },
  { kind: 'session', sid: 'eeeeeeee-5555-4555-8555-555555555555', taskId: 'mtask-ask-0002', host: 'devbox', cwd: '/w', agentId: 'walnut', model: 'm', effort: 'high', mode: 'default', title: 'Ask', startedAt: 'x' },
  { kind: 'device-revoke', deviceId: 'dev-acme-phone' },
]

let old: Awaited<ReturnType<typeof oldMacDrain>>
const applied: string[] = []

beforeAll(async () => {
  old = await oldMacDrain()
  old.setStubs({
    './session-requests.js': { importOfflineRequest: async () => { applied.push('row'); return true }, settleReplied: async () => true, getSessionRequest: async () => undefined },
    './task-manager.js': { getTask: async (id: string) => ({ id, phase: 'IN_PROGRESS', updated_at: '2026-10-14T09:00:00Z' }) },
    '../ops/index.js': { executeOp: async (op: string) => { applied.push(op); return { ok: true } } },
    '../lib/caller-origin.js': { hostOrigin: (h: string) => h },
    './session-tracker.js': { getSessionByClaudeId: async () => null, updateSessionRecord: async () => { applied.push('settings') } },
    '../providers/claude-code-session.js': { sessionRunner: { findByClaudeId: () => null } },
    './sessions/session-stop.js': { sessionStops: { flush: async () => {} } },
    './phase.js': { applySessionPhase: async () => {} },
    './peers/walnut-message-tag.js': { buildWalnutMessage: () => '' },
    './sessions/session-send-core.js': { deliverToSession: async () => {} },
  })
})

afterEach(() => { cleanupJournalDirs(); applied.length = 0 })
afterEach(() => cleanupOldSources())

/** The old Mac's connection: the twins' offline.drain / offline.ack over the new core, no kinds. */
function oldMacConn(host: ReturnType<typeof journalHost>['host'], sent: Array<Record<string, unknown>>) {
  return {
    hostKey: 'devbox',
    send: async (cmd: string, args: Record<string, unknown>) => {
      sent.push({ cmd, ...args })
      if (cmd === 'offline.drain') return host.drain(String(args.home), Array.isArray(args.kinds) ? args.kinds as string[] : null) as unknown as Record<string, unknown>
      if (cmd === 'offline.ack') return host.ack(String(args.home), Array.isArray(args.seqs) ? { seqs: args.seqs } : args.upTo as number) as unknown as Record<string, unknown>
      throw new Error(`unexpected ${cmd}`)
    },
  }
}

describe('v1 parity: an old Mac never takes a v2 record', () => {
  it.each(V2_RECORDS.map((r) => [r.kind, r] as const))('the 1fe1fd194 applyRecord applies nothing for %s and would ack it: the daemon never hands it out', async (_kind, body) => {
    // The hazard: the old switch has no case, so the record "applies" as nothing.
    const result = { rounds: 0, records: 0, imported: 0, settled: 0, replayed: 0, skipped: 0, failed: 0 }
    await expect(old.applyRecord('devbox', { seq: 1, at: T0, ...body }, new Map(), result, [])).resolves.toBeUndefined()
    expect(result).toEqual({ rounds: 0, records: 0, imported: 0, settled: 0, replayed: 0, skipped: 0, failed: 0 })
    // The guard: the old loop over the new core is handed nothing of it, and acks nothing.
    const h = journalHost(journalTmpDir(), { now: T0 }, { drains: null })
    h.host.configure(jslice())
    expect(h.journal.append(JHOME, body, { actor: DEVICE }).ok).toBe(true)
    const sent: Array<Record<string, unknown>> = []
    const r = await old.handover(oldMacConn(h.host, sent))
    expect(r.records).toBe(0)
    expect(sent.filter((s) => s.cmd === 'offline.ack')).toEqual([])
    expect(h.journal.records(JHOME).map((x) => x.kind)).toEqual([body.kind])
  })

  it('an old-Mac drain over a mixed v1 and v2 journal never loses a v2 record; a newer Mac takes the rest in order', async () => {
    const h = journalHost(journalTmpDir(), { now: T0 }, { drains: null })
    h.host.configure(jslice())
    const v1 = (body: Record<string, unknown>) => h.journal.append(JHOME, body)
    v1({ kind: 'settings', sid: SID_A, effort: 'high' })
    v1({ kind: 'op', op: 'task_update', args: { id: TASK_A, title: 'Old title' }, callerSid: SID_A, base: '2026-10-14T09:00:00Z' })
    for (const body of V2_RECORDS.slice(0, 3)) h.journal.append(JHOME, body, { actor: DEVICE })
    v1({ kind: 'stop', sid: SID_A, stopRequestId: 'stop-1', requestedAt: '2026-10-14T11:00:00Z' })
    for (const body of V2_RECORDS.slice(3)) h.journal.append(JHOME, body, { actor: DEVICE })
    const before = h.journal.records(JHOME).map((x) => x.seq)
    const sent: Array<Record<string, unknown>> = []
    const r = await old.handover(oldMacConn(h.host, sent))
    // The old Mac applied the v1 prefix only, and acked by watermark.
    expect(r.records).toBe(2)
    expect(applied).toEqual(['settings', 'task_update'])
    expect(sent.find((s) => s.cmd === 'offline.ack')).toMatchObject({ upTo: 2 })
    const left = h.journal.records(JHOME)
    expect(left.map((x) => x.seq)).toEqual(before.slice(2))
    expect(left.filter((x) => (JOURNAL_V2_DRAINS as string[]).indexOf(x.kind) !== -1)).toHaveLength(V2_RECORDS.length)
    // A newer Mac (kinds) then drains every remaining record, in append order.
    h.drains.kinds = JOURNAL_V2_DRAINS.slice()
    const next = h.host.drain(JHOME, JOURNAL_V2_DRAINS)
    expect(next.records.map((x) => x.seq)).toEqual(before.slice(2))
  })

  it('an old Mac that acks a higher watermark than it was handed drops nothing it was not handed', () => {
    const h = journalHost(journalTmpDir(), { now: T0 }, { drains: null })
    h.journal.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'a' })
    h.journal.append(JHOME, V2_RECORDS[0], { actor: DEVICE })
    h.journal.append(JHOME, { kind: 'settings', sid: SID_A, effort: 'b' })
    expect(h.host.drain(JHOME, null).records.map((x) => x.seq)).toEqual([1])
    h.host.ack(JHOME, 1000)
    expect(h.journal.records(JHOME).map((x) => x.seq)).toEqual([2, 3])
  })
})
