/**
 * A trigger_update the host's follower decided while the Mac is away, on the daemon's side
 * (offline-host-core.ts followerTriggerUpdate, applyTriggerHolds): one `trigger_update` op record
 * whose args are only the fields changed (what the Mac replays through the op), with the changed
 * def under this Walnut's home and whether the trigger ran; the change runs here at once, in place
 * of the def the server's set carries, while that set still says whether it runs; a retry is one
 * record and the first answer; the Mac's ack lifts it. An older Mac (no `trigger-update` drain)
 * hears mac_too_old, nothing saved.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { JHOME, SID_A, TASK_A, journalTmpDir, cleanupJournalDirs, journalStore, jslice, keyOf } from '../helpers/offline-journal-harness.js'
import { createOfflineHost, type OfflineTrigger } from '../../src/providers/offline-host-core.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'
import { createSendRules } from '../../src/core/sessions/send-rules.js'
import { createLetterCheck } from '../../src/core/human-inbox/letter-check.js'
import { validateTriggerDef, type TriggerDef } from '../../src/providers/trigger-check-core.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'
import { MAC_DRAINS } from '../../src/core/offline-merge/apply-v2.js'

const T0 = Date.parse('2026-11-21T04:00:00Z')
const SESSION_A = { kind: 'session' as const, sid: SID_A }
const ID = 'mcopy-watch-01'
const SERVER_DEF: TriggerDef = { id: ID, name: 'Pipeline watch', everyMs: 300_000, check: { run: 'bash check.sh', cwd: '/work', timeoutSeconds: 30 }, deliver: { home: JHOME, taskId: TASK_A, prompt: 'Look at the pipeline.' } }
/** What the follower sends: the def with the follower's own data dir as its home. */
const CHANGED = { ...SERVER_DEF, check: { ...SERVER_DEF.check, timeoutSeconds: 120 }, deliver: { ...SERVER_DEF.deliver!, home: '/follower/data' } }

afterEach(() => cleanupJournalDirs())

type Rec = Record<string, unknown>

/** A host whose daemon arms as the twins do: the server's set with this Walnut's holds over it. */
function host(drains: string[] = [...MAC_DRAINS], configured: TriggerDef[] = [SERVER_DEF]) {
  const dir = journalTmpDir('trigger-update-')
  const journal = journalStore(dir, { now: T0 })
  const table = { configured, armed: [] as TriggerDef[] }
  const parse = (raw: unknown) => validateTriggerDef(raw) as { ok: true; def: TriggerDef } | { ok: false }
  const h = createOfflineHost({
    fs, path, dir, now: () => T0, randomHex: (b) => '0'.repeat(b * 2), keyOf,
    kit: createEnvelopeKit(), rules: createSendRules(), log: () => {}, isLive: () => true, turnActive: () => false, streamOffset: () => undefined,
    deliver: async () => ({ ok: true }), journal, drainsOf: () => drains, letters: createLetterCheck(),
    triggers: {
      armed: () => table.armed.map((def) => ({ home: JHOME, def: def as OfflineTrigger, status: {} })),
      test: async () => ({}),
      changed: () => { rearm() },
      validate: (def) => { const r = validateTriggerDef(def); return r.ok ? { ok: true as const } : { ok: false as const, error: r.error } },
    },
  })
  const rearm = () => { table.armed = h.applyTriggerHolds(h.triggerHoldsByHome().get(JHOME) ?? new Map(), table.configured, parse) }
  h.configure(jslice())
  rearm()
  const records = () => journal.records(JHOME) as Rec[]
  const update = (args: Rec, on = true, opId = 'oc-Update_00001-0a0b0c0d-0') =>
    h.handleFollower(JHOME, { op: 'trigger_update', args: { id: ID, args: { id: ID, ...args }, def: CHANGED, on }, actor: SESSION_A, opId })
  return { h, journal, table, records, update, rearm }
}

describe('trigger_update from the follower', () => {
  it('is one op record of only the changed fields, the def under this Walnut\'s home; armed at once in place of the server\'s', () => {
    const t = host()
    const r = t.update({ timeoutSeconds: 120 })
    expect(r).toMatchObject({ ok: true, result: { triggerId: ID, state: 'armed', changed: true, queued: true, offline: true } })
    if (r.ok) expect(String(r.result.outcome)).toMatch(/^Updated "Pipeline watch" in place on this host: same id/)
    expect(t.records()).toHaveLength(1)
    expect(t.records()[0]).toMatchObject({
      kind: 'op', op: 'trigger_update', args: { id: ID, timeoutSeconds: 120 }, callerSid: SID_A, armed: true, opId: 'oc-Update_00001-0a0b0c0d-0',
      trigger: { id: ID, check: { timeoutSeconds: 120 }, deliver: { home: JHOME, taskId: TASK_A } },
    })
    expect(t.table.armed).toHaveLength(1)
    expect(t.table.armed[0]!.check.timeoutSeconds).toBe(120)
    // The follower lists what changed here, to show it over its copy.
    expect(t.h.followerTriggers(JHOME, ID)).toMatchObject({ triggers: [{ id: ID, state: 'armed', changes: { timeoutSeconds: 120 } }] })
  })

  it('a second change folds over the first in the list; a retry under the same op id is one record, answered as the first', () => {
    const t = host()
    t.update({ timeoutSeconds: 120 })
    expect(t.update({ timeoutSeconds: 120 })).toMatchObject({ ok: true, result: { duplicate: true, state: 'armed', triggerId: ID } })
    expect(t.records()).toHaveLength(1)
    t.update({ every: 60_000, timeoutSeconds: 90 }, true, 'oc-Update_00002-0a0b0c0d-0')
    expect(t.h.followerTriggers(JHOME, ID)).toMatchObject({ triggers: [{ changes: { timeoutSeconds: 90, every: 60_000 } }] })
    expect(t.records()).toHaveLength(2)
  })

  it('a change leaves on and off to the server\'s set: one it paused is not armed by it, one it resumes runs the changed def', () => {
    const t = host(undefined, [])
    expect(t.update({ timeoutSeconds: 120 }, false)).toMatchObject({ ok: true, result: { state: 'paused' } })
    expect(t.table.armed).toEqual([])
    expect(t.h.followerTriggers(JHOME, ID)).toMatchObject({ triggers: [{ id: ID, state: 'paused' }] })
    // The Mac resumed it meanwhile: its set carries it again, and the change made here runs.
    t.table.configured = [SERVER_DEF]
    t.rearm()
    expect(t.table.armed.map((d) => d.check.timeoutSeconds)).toEqual([120])
  })

  it('a pause made here still holds over a change made after it; a resume here arms the changed def', () => {
    const t = host()
    expect(t.h.handleFollower(JHOME, { op: 'trigger_pause', args: { id: ID }, actor: SESSION_A, opId: 'op-p' })).toMatchObject({ ok: true })
    expect(t.table.armed).toEqual([])
    t.update({ timeoutSeconds: 120 }, false)
    expect(t.table.armed).toEqual([])
    t.h.handleFollower(JHOME, { op: 'trigger_resume', args: { id: ID }, actor: SESSION_A, opId: 'op-r' })
    expect(t.table.armed.map((d) => d.check.timeoutSeconds)).toEqual([120])
  })

  it('the Mac\'s ack lifts it: the server\'s set alone runs again', () => {
    const t = host()
    t.update({ timeoutSeconds: 120 })
    // The Mac drains it (the record as the drain hands it) and acks it.
    const drained = t.journal.drain(JHOME, { kinds: [...MAC_DRAINS] }).records
    expect(drained.map((r) => (r as Rec).op)).toEqual(['trigger_update'])
    expect(t.h.ack(JHOME, { seqs: drained.map((r) => r.seq) }).error).toBeUndefined()
    t.rearm()
    expect(t.records()).toEqual([])
    expect(t.table.armed).toEqual([SERVER_DEF])
  })

  it('an older Mac hears mac_too_old; an incomplete change, a bad def or a trigger deleted here is refused; nothing saved', () => {
    const old = host(JOURNAL_V2_DRAINS.slice())
    expect(old.update({ timeoutSeconds: 120 })).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'mac_too_old' } } })
    expect(old.records()).toEqual([])
    const t = host()
    expect(t.h.handleFollower(JHOME, { op: 'trigger_update', args: { id: ID, args: { id: ID }, def: CHANGED, on: true }, actor: SESSION_A, opId: 'op-1' })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(t.h.handleFollower(JHOME, { op: 'trigger_update', args: { id: ID, args: { id: ID, every: 5 }, def: { ...CHANGED, everyMs: 5 }, on: true }, actor: SESSION_A, opId: 'op-2' })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(t.h.handleFollower(JHOME, { op: 'trigger_update', args: { id: ID, args: { id: ID, timeoutSeconds: 120 }, def: CHANGED, on: true }, actor: { kind: 'plugin-job', plugin: 'acme', job: 'sync' }, opId: 'op-3' }))
      .toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'routine_writes_need_mac' } } })
    expect(t.records()).toEqual([])
    t.h.handleFollower(JHOME, { op: 'trigger_delete', args: { id: ID }, actor: SESSION_A, opId: 'op-d' })
    expect(t.update({ timeoutSeconds: 120 }, true, 'op-4')).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(t.records().map((r) => r.op)).toEqual(['trigger_delete'])
  })
})
