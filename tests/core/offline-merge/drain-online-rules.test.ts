/**
 * The Mac drain v2 keeps the rules the same write follows online (WP9 review round 4,
 * docs/plan/walnut-replica-servers-impl.md section 7), against the real task store of a
 * temp home:
 *   - a drained field write moves updated_at (the drain's clock), a read-marker write does not;
 *   - a session's away write takes only what its op takes (task_update / task_complete);
 *   - a later record's VALUE that names a re-minted or taken-over create id is remapped;
 *   - a drained depends_on is checked like online (no self, target exists, no cycle);
 *   - an away create follows the online create rules (create-rules.ts).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-drain-online-rules'))
const told = vi.hoisted(() => [] as Array<{ sid: string; text: string }>)
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async (session: { claudeSessionId?: string }, msg: { enqueueText?: string }) => {
    told.push({ sid: String(session?.claudeSessionId ?? ''), text: String(msg?.enqueueText ?? '') })
    return { delivery: 'queued' }
  }),
}))
const SID = 'abcdabcd-1111-4111-8111-111111111111'
vi.mock('../../../src/core/session-tracker.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/session-tracker.js')>()
  return {
    ...orig,
    getSessionByClaudeId: async (sid: string) => sid === 'abcdabcd-1111-4111-8111-111111111111'
      ? { claudeSessionId: sid, taskId: 'task-of-the-caller' } as never
      : orig.getSessionByClaudeId(sid),
  }
})
/** The caller each session sid is placed as (the online route resolves it from the session record). */
const callers = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../../../src/core/sessions/caller-placement.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/caller-placement.js')>()),
  resolveCallerPlacement: async (sid: string | undefined) => callers.get(String(sid ?? '')) ?? { kind: 'human' },
}))

/** Runs once right before the drain's row write of the named task (an online write landing in that window). */
const beforeRawWrite = vi.hoisted(() => ({ taskId: '', run: null as null | (() => Promise<void>) }))
vi.mock('../../../src/core/task-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/task-manager.js')>()
  return {
    ...real,
    updateTaskRaw: async (...a: Parameters<typeof real.updateTaskRaw>) => {
      const run = beforeRawWrite.run
      if (run && a[0] === beforeRawWrite.taskId && a[2]?.source === 'offline-handover') { beforeRawWrite.run = null; await run() }
      return real.updateTaskRaw(...a)
    },
  }
})
/** Board ops the drain replays: the args it passes (the op itself is the board's own code). */
const boardCalls = vi.hoisted(() => [] as Array<{ op: string; args: Record<string, unknown> }>)
vi.mock('../../../src/ops/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/ops/index.js')>()
  return {
    ...real,
    executeOp: async (...a: Parameters<typeof real.executeOp>) => {
      if (!String(a[0]).startsWith('board_')) return real.executeOp(...a)
      boardCalls.push({ op: String(a[0]), args: { ...(a[1] as Record<string, unknown>) } })
      return { ok: true, result: {} } as never
    },
  }
})

/** The fast model the title brake refines a cut title with: answers only the cut heads a test names. */
const titleModel = vi.hoisted(() => ({ answers: new Map<string, string>(), asked: [] as string[] }))
vi.mock('../../../src/core/session-title-backend.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/session-title-backend.js')>()),
  backendTitleAvailable: () => titleModel.answers.size > 0,
  titleViaBackendModel: async (_message: string, placeholder: string) => {
    titleModel.asked.push(placeholder)
    return titleModel.answers.get(placeholder) ?? null
  },
}))

import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { addTask, getTask, updateTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { conflictDir, readConflictLog, type ConflictEntry } from '../../../src/core/offline-merge/conflict-log.js'
import { recordRemap } from '../../../src/core/offline-merge/ledger.js'
import { buildTaskProjection } from '../../../src/core/task-projection.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { heuristicShortTitle } from '../../../src/core/sessions/task-title-brake.js'

let seqN = 900
let opN = 0
const op = (): string => `op-or-${(++opN).toString(16).padStart(12, '0')}`
const NOT_SESSION = { kind: 'trigger', id: 'trg-online-rules' }

function daemon(hostKey: string, records: Array<Record<string, unknown>>) {
  const pending = [...records]
  return {
    pending,
    conn: {
      hostKey, journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.ack') {
          for (const s of (p?.seqs as number[]) ?? []) { const i = pending.findIndex((r) => r.seq === s); if (i !== -1) pending.splice(i, 1) }
          return { ok: true }
        }
        if (cmd === 'offline.drain') return { ok: true, records: pending.slice(), now: Date.now() }
        return { ok: true }
      },
    },
  }
}

async function drain(records: Array<Record<string, unknown>>, host = 'marina'): Promise<void> {
  const d = daemon(host, records)
  for (let i = 0; i < 6 && d.pending.length; i++) {
    await runOfflineHandover(d.conn as never).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 15))
  }
}

function allEntries(): ConflictEntry[] {
  let names: string[] = []
  try { names = fs.readdirSync(conflictDir()).filter((n) => n.endsWith('.json')) } catch { return [] }
  return names.flatMap((n) => readConflictLog(n.slice(0, -5))?.entries ?? [])
}

const fieldsRec = (taskId: string, fields: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  v: 2, seq: ++seqN, at: Date.now(), kind: 'task-fields', opId: op(), rev: 1, actor: { kind: 'session', sid: SID }, op: 'task_update', taskId, fields, ...over,
})
const createRec = (taskId: string, fields: Record<string, unknown>, placement: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  v: 2, seq: ++seqN, at: Date.now(), kind: 'task-create', opId: op(), rev: 1, actor: NOT_SESSION, taskId, fields, placement, ...over,
})
const newTask = async (title: string, extra: Record<string, unknown> = {}): Promise<string> =>
  (await addTask({ title, project: 'Acme', ...extra } as never)).task.id

beforeEach(() => {
  _resetOfflineHandoverForTesting(); _resetHostClocksForTesting(); _setHandoverBackoffForTesting([1, 1])
  told.length = 0; callers.clear(); titleModel.answers.clear(); titleModel.asked.length = 0
})
/** Polls until `get` is truthy (a background refine), or gives up after ~2 s. */
async function eventually<T>(get: () => Promise<T>): Promise<T> {
  let v = await get()
  for (let i = 0; i < 100 && !v; i++) { await new Promise((r) => setTimeout(r, 20)); v = await get() }
  return v
}
afterAll(() => { _setHandoverBackoffForTesting(null); closeDb() })

describe('a drained write moves updated_at as the online write does', () => {
  it('a drained title write moves updated_at to the drain\'s clock; the projection then carries it past the companion\'s gate', async () => {
    const id = await newTask('Clock before')
    // The companion's copy of the row, as the last projection import left it.
    const companionRow = await getTask(id)
    await new Promise((r) => setTimeout(r, 15))
    // A record time older than the row: the stamp must be the drain's own clock, not the record's.
    const before = Date.now()
    await drain([fieldsRec(id, { title: { base: 'Clock before', value: 'Clock after' } }, { at: before - 60_000 })])
    const t = await getTask(id)
    expect(t.title).toBe('Clock after')
    expect(Date.parse(t.updated_at)).toBeGreaterThanOrEqual(before)
    // task-outbox.ts importProjectionOnCloud imports a row only when the projection is newer.
    const p = (await buildTaskProjection()).tasks.find((x) => x.id === id)!
    expect(p.title).toBe('Clock after')
    expect(Date.parse(p.updated_at)).toBeGreaterThan(Date.parse(companionRow.updated_at))
  })

  it('the bump never moves a field-time fallback: a phase write then a base-unknown description write end the same in one journal, reversed, or one record per drain', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const run = async (shape: 'one' | 'reverse' | 'split') => {
      // Born with no description, so no time of its own for it: fieldTimeOf falls back.
      const id = await newTask(`Born bare ${shape}`)
      await sleep(20)
      const at = Date.now()
      await sleep(20)
      const phase = fieldsRec(id, { phase: { base: 'TODO', value: 'IN_PROGRESS' } }, { actor: NOT_SESSION, at })
      const desc = fieldsRec(id, { description: { base: 'unknown', value: 'Findings written away' } }, { actor: NOT_SESSION, at: at + 5 })
      if (shape === 'one') await drain([phase, desc])
      else if (shape === 'reverse') await drain([desc, phase])
      else { await drain([phase], 'marina-a'); await drain([desc], 'marina-b') }
      const t = await getTask(id)
      return { phase: t.phase, description: t.description ?? '', conflicts: allEntries().filter((e) => e.taskId === id).map((e) => e.why ?? e.kind) }
    }
    const want = { phase: 'IN_PROGRESS', description: 'Findings written away', conflicts: [] }
    expect(await run('one')).toEqual(want)
    expect(await run('reverse')).toEqual(want)
    expect(await run('split')).toEqual(want)
  })

  it('a drained write of the read marker alone leaves updated_at, as online', async () => {
    const id = await newTask('Read marker only')
    await updateTaskRaw(id, { unread: true } as never)
    const at = (await getTask(id)).updated_at
    await new Promise((r) => setTimeout(r, 15))
    await drain([fieldsRec(id, { unread: { base: true, value: false } }, { actor: NOT_SESSION })])
    const t = await getTask(id)
    expect([!!t.unread, t.updated_at]).toEqual([false, at])
  })
})

describe('a session\'s away write takes what its op takes online', () => {
  it('task_update {status} and {summary} from a session are refused whole and the session is told', async () => {
    const id = await newTask('Session scope')
    await drain([
      fieldsRec(id, { status: { base: 'todo', value: 'done' } }),
      fieldsRec(id, { summary: { base: '', value: 'written by the agent' }, title: { base: 'Session scope', value: 'Renamed too' } }),
    ])
    const t = await getTask(id)
    expect({ phase: t.phase, summary: t.summary ?? '', title: t.title }).toEqual({ phase: 'TODO', summary: '', title: 'Session scope' })
    const refused = allEntries().filter((e) => e.taskId === id)
    expect(refused.map((e) => e.reason ?? '')).toEqual([expect.stringContaining('status'), expect.stringContaining('summary')])
    await new Promise((r) => setTimeout(r, 30))
    expect(told.filter((x) => x.sid === SID).map((x) => x.text).join('\n')).toMatch(/does not take status[\s\S]*does not take summary/)
  })

  it('task_complete from a session sets only the phase; the same fields from an actor that is not a session still land', async () => {
    const id = await newTask('Device scope')
    await drain([fieldsRec(id, { phase: { base: 'TODO', value: 'COMPLETE' }, note: { base: '', value: 'x' } }, { op: 'task_complete' })])
    expect((await getTask(id)).phase).toBe('TODO')
    await drain([fieldsRec(id, { summary: { base: '', value: 'set on the phone' }, status: { base: 'todo', value: 'in_progress' } }, { actor: NOT_SESSION })])
    const t = await getTask(id)
    expect({ summary: t.summary, phase: t.phase }).toEqual({ summary: 'set on the phone', phase: 'IN_PROGRESS' })
  })
})

describe('a later record that names an away create by the id the host minted', () => {
  it('after a collision re-mint, a parent link and a dependency to the minted id land on the re-minted task, not on the task that owned the id', async () => {
    const owner = await newTask('Owns the id')
    const child = await newTask('Away child')
    const blocked = await newTask('Away blocked')
    // The host minted `owner`'s id for its own create: a collision, re-minted here.
    await drain([
      createRec(owner, { title: 'Made away' }, { project: 'Acme' }),
      fieldsRec(child, { parent_task_id: { base: '', value: owner } }, { actor: NOT_SESSION }),
      fieldsRec(blocked, { depends_on: { base: [], value: [owner] } }, { actor: NOT_SESSION }),
    ])
    const made = allEntries().find((e) => e.kind === 'create-collision')!
    expect(made.taskId).not.toBe(owner)
    expect((await getTask(made.taskId)).title).toBe('Made away')
    expect((await getTask(child)).parent_task_id).toBe(made.taskId)
    expect((await getTask(blocked)).depends_on).toEqual([made.taskId])
  })

  it('after a createdAs remap (the Mac answered the create under its own id), the link lands on the Mac\'s id', async () => {
    const macId = await newTask('Created on the Mac')
    const child = await newTask('Linked away')
    recordRemap('marina', WALNUT_HOME, 'mintedonhost00000000aa', macId)
    await drain([fieldsRec(child, { parent_task_id: { base: '', value: 'mintedonhost00000000aa' } }, { actor: NOT_SESSION })])
    expect((await getTask(child)).parent_task_id).toBe(macId)
    expect(allEntries().filter((e) => e.taskId === child && e.kind === 'parent-refused')).toEqual([])
  })
})

describe('a board record names an away create by the id the host minted', () => {
  const boardRec = (task: string) => ({ v: 2, seq: ++seqN, at: Date.now(), kind: 'board', opId: op(), rev: 1, actor: NOT_SESSION, op: 'board_post', args: { task, thread: 'plan', text: 'hello' } })
  it('after a createdAs remap and after a collision re-mint, the board write goes to the task the Mac holds', async () => {
    boardCalls.length = 0
    const macId = await newTask('Board on the Mac')
    recordRemap('marina', WALNUT_HOME, 'mintedboard000000000aa', macId)
    const owner = await newTask('Owns the board id')
    await drain([boardRec('mintedboard000000000aa'), createRec(owner, { title: 'Board made away' }, { project: 'Acme' }), boardRec(owner)])
    let made = ''
    for (const e of allEntries().filter((x) => x.kind === 'create-collision')) {
      if ((await getTask(e.taskId).catch(() => null))?.title === 'Board made away') made = e.taskId
    }
    expect(made).not.toBe('')
    expect(made).not.toBe(owner)
    expect(boardCalls.map((c) => c.args.task)).toEqual([macId, made])
  })
})

describe('a drained depends_on is checked as online', () => {
  it('a self dependency, a missing target and a cycle are refused; a good one lands', async () => {
    const a = await newTask('Dep A')
    const b = await newTask('Dep B')
    await updateTask(b, { set_depends_on: [a] } as never)
    await drain([
      fieldsRec(a, { depends_on: { base: [], value: [a] } }, { actor: NOT_SESSION }),
      fieldsRec(a, { depends_on: { base: [], value: ['no-such-task-dep'] } }, { actor: NOT_SESSION }),
      fieldsRec(a, { depends_on: { base: [], value: [b] } }, { actor: NOT_SESSION }),
    ])
    expect((await getTask(a)).depends_on ?? []).toEqual([])
    const reasons = allEntries().filter((e) => e.taskId === a).map((e) => String(e.reason ?? ''))
    expect(reasons).toEqual([expect.stringMatching(/cannot depend on itself/), expect.stringMatching(/not found/), expect.stringMatching(/ircular|cycle/)])
    // An online write made after the drain read the record and before its row lock is seen.
    const x = await newTask('Dep race X')
    const y = await newTask('Dep race Y')
    beforeRawWrite.taskId = x
    beforeRawWrite.run = async () => { await updateTask(y, { set_depends_on: [x] } as never) }
    await drain([fieldsRec(x, { depends_on: { base: [], value: [y] } }, { actor: NOT_SESSION })])
    expect(beforeRawWrite.run).toBeNull()
    expect([(await getTask(y)).depends_on, (await getTask(x)).depends_on ?? []]).toEqual([[x], []])
    expect(allEntries().filter((e) => e.taskId === x).map((e) => String(e.reason ?? ''))).toEqual([expect.stringMatching(/ircular|cycle/)])
    const c = await newTask('Dep C')
    await drain([fieldsRec(c, { depends_on: { base: [], value: [a, a] } }, { actor: NOT_SESSION })])
    expect((await getTask(c)).depends_on).toEqual([a])
  })
})

describe('an away create follows the online create rules (create-rules.ts)', () => {
  const worker = (task: Record<string, unknown>) => ({ kind: 'worker', task: { group_id: undefined, ...task }, session: { id: SID, host: '' } })
  const sessionCreate = (id: string, fields: Record<string, unknown>, placement: Record<string, unknown> = {}) =>
    createRec(id, fields, placement, { actor: { kind: 'session', sid: SID }, op: 'task_create' })

  it('a create that names no pin is pinned by default (Satellite); pinned:false stays off the board', async () => {
    await drain([createRec('mintrules0000000000a1', { title: 'Phone quick add' }, { project: 'Acme' })])
    expect(await getTask('mintrules0000000000a1')).toMatchObject({ pinned: true })
    await drain([createRec('mintrules0000000000a2', { title: 'Not on the board', pinned: false }, { project: 'Acme' })])
    expect(!!(await getTask('mintrules0000000000a2')).pinned).toBe(false)
  })

  it('a session\'s long title is cut to its head; the long form becomes the description', async () => {
    const lead = await newTask('Lead')
    callers.set(SID, worker({ id: lead, title: 'Lead', project: 'Acme' }))
    const long = 'Investigate why the nightly export job writes duplicate rows into the marina ledger table after a retry'
    // The fast model answers for the cut head, as the online route's background refine asks it.
    titleModel.answers.set(heuristicShortTitle(long), 'Duplicate export rows')
    await drain([sessionCreate('mintrules0000000000b1', { title: long })])
    const t = await getTask('mintrules0000000000b1')
    expect(t.title.length).toBeLessThanOrEqual(60)
    expect(t.description).toBe(long)
    expect(t.parent_task_id).toBe(lead)
    expect(titleModel.asked).toEqual([heuristicShortTitle(long)])
    expect(await eventually(async () => (await getTask('mintrules0000000000b1')).title === 'Duplicate export rows')).toBe(true)
  })

  it('a session\'s long away rename is cut and then refined in the background; a device\'s is neither', async () => {
    const id = await newTask('Short name')
    const long = 'Rename this task to say that the marina ledger export is now retried twice with a backoff of ten minutes'
    titleModel.answers.set(heuristicShortTitle(long), 'Ledger export retries')
    await drain([fieldsRec(id, { title: { base: 'Short name', value: long } })])
    expect(titleModel.asked).toEqual([heuristicShortTitle(long)])
    expect(await eventually(async () => (await getTask(id)).title === 'Ledger export retries')).toBe(true)
    const other = await newTask('Device name')
    await drain([fieldsRec(other, { title: { base: 'Device name', value: long } }, { actor: NOT_SESSION })])
    expect((await getTask(other)).title).toBe(long)
    expect(titleModel.asked).toHaveLength(1)
  })

  it('a session at the depth cap gets no deeper subtask: refused, listed and told', async () => {
    const root = await newTask('Root')
    const a = await newTask('Level 1', { parent_task_id: root })
    const b = await newTask('Level 2', { parent_task_id: a })
    const c = await newTask('Level 3', { parent_task_id: b })
    callers.set(SID, worker({ id: c, title: 'Level 3', project: 'Acme' }))
    await drain([sessionCreate('mintrules0000000000c1', { title: 'Too deep' })])
    expect(await getTask('mintrules0000000000c1').catch(() => null)).toBeNull()
    expect(allEntries().some((e) => /levels deep|subtask/i.test(String(e.reason ?? '')))).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(told.some((x) => x.sid === SID)).toBe(true)
  })

  it('a worker\'s create naming another project (it cannot carry the user\'s words away) is refused, listed and told; a device create there is made', async () => {
    const lead = await newTask('Lead elsewhere')
    callers.set(SID, worker({ id: lead, title: 'Lead elsewhere', project: 'Acme' }))
    await drain([sessionCreate('mintrules0000000000f1', { title: 'Filed in the wrong place' }, { project: 'Other' })])
    expect(await getTask('mintrules0000000000f1').catch(() => null)).toBeNull()
    expect(allEntries().filter((e) => e.taskId === 'mintrules0000000000f1').map((e) => String(e.reason ?? ''))).toEqual([expect.stringMatching(/user_words/)])
    await new Promise((r) => setTimeout(r, 30))
    expect(told.filter((x) => x.sid === SID).map((x) => x.text).join('\n')).toMatch(/user_words/)
    // The same project named by the worker's own: made, beside the caller.
    await drain([sessionCreate('mintrules0000000000f2', { title: 'Filed at home' }, { project: 'acme' })])
    expect((await getTask('mintrules0000000000f2')).parent_task_id).toBe(lead)
    // A device (not a session) names any project, as online.
    await drain([createRec('mintrules0000000000f3', { title: 'Phone create elsewhere' }, { project: 'Other' })])
    expect((await getTask('mintrules0000000000f3')).project).toBe('Other')
  })

  // 2026-10-29: a worker stays in its lead's project; a queued move cannot carry the user's words.
  it('a session\'s queued move of a worker out of its lead\'s project is refused and listed; a device\'s moves it', async () => {
    const lead = await newTask('Move lead')
    const w = await newTask('Its worker', { parent_task_id: lead })
    callers.set(SID, worker({ id: lead, title: 'Move lead', project: 'Acme' }))
    await drain([fieldsRec(w, { project: { base: 'Acme', value: 'Other' } })])
    expect((await getTask(w)).project).toBe('Acme')
    expect(allEntries().some((e) => e.taskId === w && /is a worker of "Move lead"/.test(String(e.reason ?? '')))).toBe(true)
    await drain([fieldsRec(w, { project: { base: 'Acme', value: 'Other' } }, { actor: NOT_SESSION })])
    expect((await getTask(w)).project).toBe('Other')
  })

  it('a worker\'s task is born in the caller\'s tier and filed beside the caller in a folder', async () => {
    const lead = await newTask('Focus lead', { pinned: true, focus_tier: 'focus' })
    callers.set(SID, worker({ id: lead, title: 'Focus lead', project: 'Acme', pinned: true, focus_tier: 'focus' }))
    await drain([sessionCreate('mintrules0000000000d1', { title: 'Focus worker' })])
    const t = await getTask('mintrules0000000000d1')
    expect({ pinned: t.pinned, tier: t.focus_tier, parent: t.parent_task_id, project: t.project }).toEqual({ pinned: true, tier: 'focus', parent: lead, project: 'Acme' })
    expect(t.group_id).toBeTruthy()
    expect((await getTask(lead)).group_id).toBe(t.group_id)
  })

  it('an ask\'s create with no project lands in the default project, never the ask\'s own', async () => {
    const ask = (await addTask({ title: 'A chat', project: 'Ask Walnut' } as never)).task.id
    callers.set(SID, { kind: 'ask', task: { id: ask, title: 'A chat', project: 'Ask Walnut' }, session: { id: SID, host: '' } })
    await drain([sessionCreate('mintrules0000000000e1', { title: 'Asked for' })])
    const t = await getTask('mintrules0000000000e1')
    expect(t.project ?? '').not.toMatch(/^ask /i)
    expect(t.parent_task_id).toBe(ask)
  })
})

describe('a long text both sides rewrote is merged off the event loop', () => {
  it('a 12,000-line both-sides description rewrite never holds the loop over 100 ms; the newer side is kept with one conflict', async () => {
    const lines = (tag: string): string => Array.from({ length: 12_000 }, (_, i) => `${tag} ${i} ${'y'.repeat(8)}\n`).join('')
    const base = lines('base')
    const id = await newTask('Long doc', { description: base })
    await updateTaskRaw(id, { description: lines('mac') } as never)
    expect((await getTask(id)).description).toBe(lines('mac'))
    // Warm the drain's own imports first, so the probe measures the merge.
    await drain([fieldsRec(id, { priority: { base: 'none', value: 'backlog' } }, { actor: NOT_SESSION })])
    let last = Date.now()
    let gap = 0
    const probe = setInterval(() => { const now = Date.now(); gap = Math.max(gap, now - last); last = now }, 10)
    try {
      await drain([fieldsRec(id, { description: { base, value: lines('away') } }, { actor: NOT_SESSION, at: Date.now() + 1000 })])
    } finally {
      clearInterval(probe)
    }
    expect(gap).toBeLessThan(100)
    // Over budget is one conflict over the whole text, the newer side kept (section 6): the
    // away write is newer here, so it wins and the Mac's text is in the conflict log.
    expect((await getTask(id)).description).toBe(lines('away'))
    expect(allEntries().filter((e) => e.taskId === id)).toMatchObject([{ field: 'description', kept: 'replica', why: 'text-conflict', mac: lines('mac') }])
    // The same both-sides rewrite made before the Mac's edit keeps the Mac's text.
    const older = await newTask('Long doc older', { description: base })
    await updateTaskRaw(older, { description: lines('mac') } as never)
    await drain([fieldsRec(older, { description: { base, value: lines('away') } }, { actor: NOT_SESSION, at: Date.now() - 60_000 })])
    expect((await getTask(older)).description).toBe(lines('mac'))
    expect(allEntries().filter((e) => e.taskId === older)).toMatchObject([{ field: 'description', kept: 'mac', why: 'text-conflict' }])
  }, 30_000)
})
