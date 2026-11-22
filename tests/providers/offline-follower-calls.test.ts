/**
 * The follower's own away answers (offline-host-core.ts followerCall, task B): a session's
 * agent_memory_write, human_inbox_send and trigger calls the host's follower decided reach the
 * daemon as `follower.op` and are journaled as the VERY record this host's own away answer
 * writes for the same call, so the Mac's drain (apply-agent-memory.ts, apply-letter.ts, the op
 * replay in offline-handover.ts) is unchanged. Each test makes the same call both ways, on two
 * hosts over real journal files, and compares the records. Also: a retry under the same op id is
 * one record and the first attempt's answer; a Mac that does not drain the kind hears
 * `needs_leader mac_too_old`; a plugin job never arms a trigger here.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  JHOME, SID_A, TASK_A, TASK_B, journalTmpDir, cleanupJournalDirs, journalHost, journalStore, jslice, keyOf,
} from '../helpers/offline-journal-harness.js'
import { createOfflineHost, type OfflineTrigger } from '../../src/providers/offline-host-core.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'
import { createSendRules } from '../../src/core/sessions/send-rules.js'
import { createLetterCheck } from '../../src/core/human-inbox/letter-check.js'
import { validateTriggerDef } from '../../src/providers/trigger-check-core.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'
import { MAC_DRAINS } from '../../src/core/offline-merge/apply-v2.js'
import { writeOpId } from '../../src/lib/op-call-id.js'

const T0 = Date.parse('2026-11-21T04:00:00Z')
const CALL = 'oc-FollowerCall_0001'
const SESSION_A = { kind: 'session' as const, sid: SID_A }

afterEach(() => cleanupJournalDirs())

type Rec = Record<string, unknown>
const records = (h: { journal: { records(home: string): unknown[] } }) => h.journal.records(JHOME) as Rec[]
/** A record as the Mac's drain reads it: its seq and time are the journal's, not the call's. */
const content = (r: Rec) => { const { seq: _s, at: _a, v: _v, rev: _r, ...rest } = r; return rest }

function memHost(drains: string[] = [...MAC_DRAINS]) {
  const h = journalHost(journalTmpDir(), { now: T0 }, { drains, letters: true })
  h.host.configure(jslice())
  return h
}

describe('agent_memory_write from the follower', () => {
  it('an append is the record this host\'s own answer writes, under the op id the follower\'s self-call already carries', async () => {
    const daemon = memHost()
    const follower = memHost()
    const args = { task: TASK_B, content: 'CR 2 waits on the go-ahead' }
    expect((await daemon.host.handle(JHOME, SID_A, 'tools.call', { name: 'agent_memory_write', args, callId: CALL })).ok).toBe(true)
    // The follower's self-call PUT carries writeOpId(callId, ...) as x-walnut-op-id (ops/executor.ts).
    const opId = writeOpId(CALL, 'PUT', `/tasks/${encodeURIComponent(TASK_B)}/agent-memory`, 0)
    const r = follower.host.handleFollower(JHOME, { op: 'agent_memory_write', args: { ...args, callId: CALL }, actor: SESSION_A, opId })
    expect(r).toMatchObject({ ok: true, result: { queued: true, offline: true, task_id: TASK_B, mode: 'append' } })
    if (r.ok) expect(String(r.result.outcome)).toMatch(/after what it holds then/)
    expect(records(follower).map(content)).toEqual(records(daemon).map(content))
    expect(records(follower)[0]).toMatchObject({ kind: 'agent-memory', opId, actor: SESSION_A })
  })

  it('a retry under the same op id is one record, answered as the first', () => {
    const h = memHost()
    const req = { op: 'agent_memory_write', args: { task: TASK_A, content: 'once' }, actor: SESSION_A, opId: 'oc-AbCdEfGh_1-0a0b0c0d-0' }
    expect(h.host.handleFollower(JHOME, req).ok).toBe(true)
    expect(h.host.handleFollower(JHOME, req)).toMatchObject({ ok: true, result: { duplicate: true, task_id: TASK_A, queued: true } })
    expect(records(h)).toHaveLength(1)
  })

  it('a memory folder note is held for its op as this host\'s own answer holds it (held-op), under the call\'s own id', () => {
    const daemon = memHost()
    const follower = memHost()
    const args = { task: TASK_A, content: '# Steps', file: 'release-steps.md' }
    expect(daemon.host.holdWrite(JHOME, SID_A, 'tools.call', { name: 'agent_memory_write', args, callId: CALL })).toMatchObject({ ok: true })
    const opId = writeOpId(CALL, 'PUT', `/tasks/${TASK_A}/memory-files/release-steps.md`, 0)
    const r = follower.host.handleFollower(JHOME, { op: 'agent_memory_write', args: { ...args, callId: CALL }, actor: SESSION_A, opId })
    expect(r).toMatchObject({ ok: true, result: { held: true, op: 'agent_memory_write' } })
    expect(records(follower).map(content)).toEqual(records(daemon).map(content))
    expect(records(follower)[0]).toMatchObject({ kind: 'op', op: 'agent_memory_write', callerSid: SID_A, callId: CALL, opId: 'held-FollowerCall-0001' })
    // Asked again: still one record.
    expect(follower.host.handleFollower(JHOME, { op: 'agent_memory_write', args: { ...args, callId: CALL }, actor: SESSION_A, opId })).toMatchObject({ ok: true, result: { duplicate: true } })
    expect(records(follower)).toHaveLength(1)
  })

  it('a task the follower could not name is held, as this host\'s own answer holds it', () => {
    const h = memHost()
    const r = h.host.handleFollower(JHOME, { op: 'agent_memory_write', args: { task: 'the lead', content: 'x', held: true, callId: CALL }, actor: SESSION_A, opId: 'op-x1' })
    expect(r).toMatchObject({ ok: true, result: { held: true } })
    expect(records(h)[0]).toMatchObject({ kind: 'op', args: { task: 'the lead', content: 'x' } })
    expect((records(h)[0]!.args as Rec).held).toBeUndefined()
  })

  it('a Mac that drains neither kind hears mac_too_old and nothing is saved; nor is an empty entry or one past the limit', () => {
    const old = memHost(JOURNAL_V2_DRAINS.filter((k) => k !== 'agent-memory'))
    expect(old.host.handleFollower(JHOME, { op: 'agent_memory_write', args: { task: TASK_A, content: 'x' }, actor: SESSION_A, opId: 'op-1' }))
      .toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'mac_too_old' } } })
    const h = memHost()
    expect(h.host.handleFollower(JHOME, { op: 'agent_memory_write', args: { task: TASK_A, content: ' ' }, actor: SESSION_A, opId: 'op-2' })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(h.host.handleFollower(JHOME, { op: 'agent_memory_write', args: { task: TASK_A, content: 'x'.repeat(20_001) }, actor: SESSION_A, opId: 'op-3' })).toMatchObject({ ok: false, error: { code: 'agent_memory_too_long' } })
    expect(records(old)).toEqual([])
    expect(records(h)).toEqual([])
  })
})

describe('human_inbox_send from the follower', () => {
  const LETTER = { subject: 'CR 2 is ready for review', type: 'review', markdown: 'Please look at **CR 2** 你好', text: 'CR 2' }

  it('is the letter record this host\'s own answer writes: its fields, its body as the same blob, the session as actor', async () => {
    const daemon = memHost()
    const follower = memHost()
    const a = await daemon.host.handle(JHOME, SID_A, 'tools.call', { name: 'human_inbox_send', args: LETTER })
    const b = follower.host.handleFollower(JHOME, { op: 'human_inbox_send', args: LETTER, actor: SESSION_A, opId: 'oc-Letter_00001-01020304-0' })
    expect(a.ok && b.ok).toBe(true)
    const strip = (r: Rec) => { const { letterId: _l, opId: _o, ...rest } = content(r); return rest }
    expect(records(follower).map(strip)).toEqual(records(daemon).map(strip))
    expect(records(follower)[0]).toMatchObject({ kind: 'letter', format: 'markdown', actor: SESSION_A, letterId: expect.stringMatching(/^lt-[a-z0-9]+-[0-9a-f]{6}$/) })
    if (b.ok) {
      expect(b.result).toMatchObject({ queued: true, offline: true, kind: 'letter', letterId: records(follower)[0]!.letterId })
      expect(String(b.result.next)).toMatch(/human_inbox_reply/)
    }
  })

  it('a retry under the same op id is one letter and names the first one\'s id', () => {
    const h = memHost()
    const req = { op: 'human_inbox_send', args: LETTER, actor: SESSION_A, opId: 'oc-Letter_00002-01020304-0' }
    const first = h.host.handleFollower(JHOME, req)
    const again = h.host.handleFollower(JHOME, req)
    expect(records(h)).toHaveLength(1)
    expect(first.ok && again.ok && again.result.letterId === first.result.letterId).toBe(true)
    expect(again).toMatchObject({ ok: true, result: { duplicate: true } })
  })

  it('a plugin job\'s letter is its own actor (a Mac that drains plugin-job-actor); a Mac that drains no letter hears mac_too_old', () => {
    const h = memHost()
    const job = { kind: 'plugin-job' as const, plugin: 'acme', job: 'digest' }
    expect(h.host.handleFollower(JHOME, { op: 'human_inbox_send', args: LETTER, actor: job, opId: 'op-job-1' }).ok).toBe(true)
    expect(records(h)[0]).toMatchObject({ kind: 'letter', actor: job })
    const old = memHost(JOURNAL_V2_DRAINS.filter((k) => k !== 'letter'))
    expect(old.host.handleFollower(JHOME, { op: 'human_inbox_send', args: LETTER, actor: SESSION_A, opId: 'op-l' }))
      .toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'mac_too_old' } } })
  })

  it('a letter the store would refuse is refused here too, nothing saved', () => {
    const h = memHost()
    expect(h.host.handleFollower(JHOME, { op: 'human_inbox_send', args: { subject: 'x', type: 'action_required', markdown: 'pick' }, actor: SESSION_A, opId: 'op-bad' }))
      .toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(records(h)).toEqual([])
  })
})

describe('triggers from the follower', () => {
  const PLAN = {
    run: 'bash ~/.open-walnut/triggers/review/check.sh', prompt: 'Send the review request now.',
    description: 'Checks the clock every 5 minutes; at 9:07 the session sends the review request.',
    name: 'Review request clock', everyMs: 300_000, taskId: TASK_A, cwd: '/work/session-cwd', timeoutSeconds: 30, watches: null, own: true,
  }

  /** A host whose daemon runs triggers (the twins' deps.triggers, its own def check), random parts fixed. */
  function trigHost(drains: string[] = [...MAC_DRAINS]) {
    const dir = journalTmpDir('follower-triggers-')
    const clock = { now: T0 }
    const journal = journalStore(dir, clock)
    const table = { armed: [] as OfflineTrigger[], tests: [] as unknown[] }
    let n = 0
    const host = createOfflineHost({
      fs, path, dir, now: () => clock.now, randomHex: (b) => (n++).toString(16).padStart(b * 2, '0'), keyOf,
      kit: createEnvelopeKit(), rules: createSendRules(), log: () => {}, isLive: () => true, turnActive: () => false, streamOffset: () => undefined,
      deliver: async () => ({ ok: true }), journal, drainsOf: () => drains, letters: createLetterCheck(),
      triggers: {
        armed: () => table.armed.map((def) => ({ home: JHOME, def, status: { nextRunAtMs: T0 + 5_000 } })),
        test: async (check, id) => { table.tests.push({ check, id }); return { parsed: { fire: false }, wouldFire: false } },
        changed: () => { table.armed = [...host.triggerHolds().values()].filter((x) => x.on && x.def).map((x) => x.def!) },
        cwdOf: (sid) => (sid === SID_A ? '/work/session-cwd' : undefined),
        validate: (def) => { const r = validateTriggerDef(def); return r.ok ? { ok: true as const } : { ok: false as const, error: r.error } },
      },
    })
    host.configure(jslice())
    return { host, journal, table }
  }

  it('a create is the trigger_create record this host\'s own answer writes, armed at once', async () => {
    const daemon = trigHost()
    const follower = trigHost()
    const a = await daemon.host.handle(JHOME, SID_A, 'tools.call', { name: 'trigger_create', args: { run: PLAN.run, prompt: PLAN.prompt, description: PLAN.description, name: PLAN.name, every: '5m' } })
    const b = follower.host.handleFollower(JHOME, { op: 'trigger_create', args: PLAN, actor: SESSION_A, opId: 'oc-Trigger_0001-0a0b0c0d-0' })
    expect(a.ok && b.ok).toBe(true)
    const strip = (r: Rec) => { const { opId: _o, ...rest } = content(r); return rest }
    expect(records(follower).map(strip)).toEqual(records(daemon).map(strip))
    expect(records(follower)[0]).toMatchObject({ kind: 'op', op: 'trigger_create', callerSid: SID_A, opId: 'oc-Trigger_0001-0a0b0c0d-0' })
    expect(follower.table.armed.map((d) => d.id)).toEqual([records(follower)[0]!.args && (records(follower)[0]!.args as Rec).id])
    if (a.ok && b.ok) {
      expect(b.result.outcome).toBe(a.result.outcome)
      expect(b.result).toMatchObject({ queued: true, offline: true, id: (records(follower)[0]!.args as Rec).id })
    }
    // A retry under the same op id: one record, the first one's id.
    const again = follower.host.handleFollower(JHOME, { op: 'trigger_create', args: PLAN, actor: SESSION_A, opId: 'oc-Trigger_0001-0a0b0c0d-0' })
    expect(again).toMatchObject({ ok: true, result: { duplicate: true, id: (records(follower)[0]!.args as Rec).id } })
    expect(records(follower)).toHaveLength(1)
  })

  it('wait:true parks the task with a task-fields record on the base the follower showed', () => {
    const h = trigHost()
    const r = h.host.handleFollower(JHOME, { op: 'trigger_create', args: { ...PLAN, park: { wait_until: '2026-11-21T08:00:00.000Z' } }, actor: SESSION_A, opId: 'op-park-1', base: { phase: 'IN_PROGRESS', wait_until: null } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(String(r.result.outcome)).toMatch(/queued to wait/)
    expect(records(h)[1]).toMatchObject({
      kind: 'task-fields', op: 'task_update', taskId: TASK_A, opId: 'op-park-1-park',
      fields: { phase: { base: 'IN_PROGRESS', value: 'WAITING' }, wait_until: { base: null, value: '2026-11-21T08:00:00.000Z' } },
    })
  })

  it('pause, resume and delete are the records this host\'s own answer writes; follower.triggers lists what changed here', async () => {
    const daemon = trigHost()
    const follower = trigHost()
    await daemon.host.handle(JHOME, SID_A, 'tools.call', { name: 'trigger_create', args: { run: PLAN.run, prompt: PLAN.prompt, description: PLAN.description, name: PLAN.name, every: '5m' } })
    follower.host.handleFollower(JHOME, { op: 'trigger_create', args: PLAN, actor: SESSION_A, opId: 'op-c' })
    const id = String((records(follower)[0]!.args as Rec).id)
    expect(id).toBe(String((records(daemon)[0]!.args as Rec).id))
    await daemon.host.handle(JHOME, SID_A, 'tools.call', { name: 'trigger_pause', args: { id } })
    const p = follower.host.handleFollower(JHOME, { op: 'trigger_pause', args: { id }, actor: SESSION_A, opId: 'op-p' })
    expect(p).toMatchObject({ ok: true, result: { state: 'paused', changed: true, offline: true } })
    const strip = (r: Rec) => { const { opId: _o, ...rest } = content(r); return rest }
    expect(records(follower).map(strip)).toEqual(records(daemon).map(strip))
    expect(follower.table.armed).toEqual([])
    expect(follower.host.followerTriggers(JHOME)).toMatchObject({ host: 'devbox', triggers: [{ id, state: 'paused', created: true, description: PLAN.description }] })
    // Asked again under the same op id: the first answer, nothing more written.
    expect(follower.host.handleFollower(JHOME, { op: 'trigger_pause', args: { id }, actor: SESSION_A, opId: 'op-p' })).toMatchObject({ ok: true, result: { duplicate: true, state: 'paused' } })
    follower.host.handleFollower(JHOME, { op: 'trigger_delete', args: { id }, actor: SESSION_A, opId: 'op-d' })
    expect(follower.host.followerTriggers(JHOME, id)).toMatchObject({ triggers: [{ id, state: 'deleted' }] })
    expect(records(follower)).toHaveLength(3)
  })

  it('a trigger this host does not run needs the Mac (routine_writes_need_mac); a plugin job never arms one here; an older Mac is told so', () => {
    const h = trigHost()
    expect(h.host.handleFollower(JHOME, { op: 'trigger_pause', args: { id: 'mabc-elsewhere' }, actor: SESSION_A, opId: 'op-1' }))
      .toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'routine_writes_need_mac' } } })
    expect(h.host.handleFollower(JHOME, { op: 'trigger_create', args: PLAN, actor: { kind: 'plugin-job', plugin: 'acme', job: 'sync' }, opId: 'op-2' }))
      .toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'routine_writes_need_mac' } } })
    const old = trigHost(JOURNAL_V2_DRAINS.slice())
    expect(old.host.handleFollower(JHOME, { op: 'trigger_create', args: PLAN, actor: SESSION_A, opId: 'op-3' }))
      .toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'mac_too_old' } } })
    expect(h.host.handleFollower(JHOME, { op: 'trigger_create', args: { ...PLAN, everyMs: 5 }, actor: SESSION_A, opId: 'op-4' })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(records(h)).toEqual([])
    expect(records(old)).toEqual([])
  })

  it('follower.trigger.test runs the check once through the daemon\'s own test, writing nothing', async () => {
    const h = trigHost()
    const r = await h.host.followerTriggerTest(JHOME, { actor: SESSION_A, args: { run: 'bash check.sh', timeoutSeconds: 20 } })
    expect(r).toMatchObject({ ok: true, result: { offline: true, result: { wouldFire: false } } })
    if (r.ok) expect(String(r.result.outcome)).toMatch(/would NOT fire/)
    // The caller's own folder when the follower names none (the daemon knows the session's).
    expect(h.table.tests).toEqual([{ check: { run: 'bash check.sh', cwd: '/work/session-cwd', timeoutSeconds: 20 }, id: undefined }])
    expect(records(h)).toEqual([])
  })
})

describe('the twins carry the follower\'s trigger commands', () => {
  it('both twins allow, route and implement follower.triggers and follower.trigger.test', () => {
    for (const twin of ['daemon-standalone.ts', 'daemon-source.ts']) {
      const src = fs.readFileSync(path.join(import.meta.dirname, '../../src/providers', twin), 'utf8')
      expect(src, twin).toContain("'follower.triggers', 'follower.trigger.test',")
      expect(src, twin).toMatch(/case 'follower\.triggers': return cmdFollowerTriggers\(/)
      expect(src, twin).toMatch(/case 'follower\.trigger\.test': return cmdFollowerTriggerTest\(/)
      // Through the follower entry both twins share (follower-entry-core.ts).
      expect(src, twin).toContain('followerEntry.triggers(home, cmd)')
      expect(src, twin).toContain('followerEntry.triggerTest(home, cmd)')
    }
    const entry = fs.readFileSync(path.join(import.meta.dirname, '../../src/providers/follower-entry-core.ts'), 'utf8')
    expect(entry).toContain('offline.followerTriggers(home, cmd.triggerId)')
    expect(entry).toContain('offline.followerTriggerTest(home, { actor: cmd.actor, args: cmd.args })')
  })
})
