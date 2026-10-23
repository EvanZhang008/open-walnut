/**
 * A claude-code routine's run started on its host while the Mac is away
 * (src/providers/clock-host-start-core.ts, clock-host-start-v1).
 *
 * Why: the daemon starts a real Claude Code CLI with nobody watching. One run per
 * slot whatever crashes or retries (the ids are derived from the slot), nothing
 * left behind by a start that fails (the CLI goes before the records, and a CLI
 * whose records were refused is stopped), and every refusal leaves the run owed
 * for the Mac. These run the real host-start core on a temp dir, with fake
 * journal, spawn and stop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClockHostStart, type ClockHostStartDeps } from '../../src/providers/clock-host-start-core.js'
import { createHostStart, type HostStart } from '../../src/providers/host-start-core.js'
import { buildRoutineSpawnTemplate } from '../../src/providers/spawn-template.js'
import { START_TASK_TOKEN, type ClockStartSpec } from '../../src/providers/trigger-clock-core.js'

const HOME = '/Users/marina/.open-walnut'
const SLOT = Date.UTC(2026, 9, 20, 9, 0)
const SID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

let dir: string
let workDir: string
let hostStart: HostStart
let calls: string[]
let logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }>
let journal: { sessions: Set<string>; taskOk: boolean; sessionOk: boolean; room: boolean }
let answers: boolean
let ranSids: Set<string>
let spawnThrows: boolean

function spec(over: Partial<ClockStartSpec> = {}): ClockStartSpec {
  return {
    home: HOME, host: 'marina', title: 'Routine: nightly report', project: 'Routines', cwd: workDir,
    message: 'write the nightly report', mode: 'bypass',
    context: `You are working on the task "Routine: nightly report" (id ${START_TASK_TOKEN}, project "Routines").`, ...over,
  }
}

function deps(over: Partial<ClockHostStartDeps> = {}): ClockHostStartDeps {
  return {
    hostStart,
    offline: {
      checkRoutineRun: () => journal.room ? { ok: true, result: {} } : { ok: false, error: { code: 'needs_leader', message: 'your Mac runs an older Walnut' } },
      noteRoutineTask: (_h, rec, opId) => {
        calls.push(`task ${rec.taskId} ${opId}`)
        return journal.taskOk ? { ok: true, result: {} } : { ok: false, error: { code: 'journal_full', message: 'the journal is full' } }
      },
      noteSession: (_h, rec, opId) => {
        calls.push(`session ${rec.sid} ${opId}`)
        if (!journal.sessionOk) return { ok: false, error: { code: 'journal_full', message: 'the journal is full' } }
        journal.sessions.add(rec.sid)
        return { ok: true, result: {} }
      },
      knowsSession: (_h, sid) => journal.sessions.has(sid),
    },
    primaryAnswers: () => answers,
    ownsDir: () => true,
    ran: (sid) => ranSids.has(sid),
    spawn: async (_home, taskId, plan) => {
      calls.push(`spawn ${plan.sid} ${taskId} pending=${hostStart.pendingStarts().length}`)
      if (spawnThrows) throw new Error('claude: not found')
      ranSids.add(plan.sid)
    },
    stop: (sid) => { calls.push(`stop ${sid}`) },
    marker: (sid, text, messageId) => { calls.push(`marker ${sid} ${messageId} ${text}`) },
    taskToken: () => START_TASK_TOKEN,
    sha256: (t) => crypto.createHash('sha256').update(t).digest('hex'),
    now: () => SLOT + 60_000,
    log: (level, msg, data) => { logs.push({ level, msg, ...(data ? { data } : {}) }) },
    ...over,
  }
}

const def = (over: Partial<ClockStartSpec> = {}) => ({ id: 'job-nightly', name: 'nightly report', start: spec(over) })
const fire = (slotMs = SLOT) => ({ seq: 1, atMs: slotMs + 5, clock: { slotMs } })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-clock-start-'))
  workDir = path.join(dir, 'repo')
  fs.mkdirSync(workDir)
  hostStart = createHostStart({ fs, path, dir, keyOf: () => 'k1', now: () => SLOT, log: () => {}, busy: () => 0 })
  hostStart.setTemplate(HOME, buildRoutineSpawnTemplate({ home: HOME, hostKey: 'marina', env: {}, now: SLOT }), 'routine')
  calls = []
  logs = []
  journal = { sessions: new Set(), taskOk: true, sessionOk: true, room: true }
  answers = false
  ranSids = new Set()
  spawnThrows = false
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('idsOf: every id of a run comes from (home, routine, slot)', () => {
  it('the same slot always gives the same ids; another slot, routine or Walnut never does', () => {
    const cs = createClockHostStart(deps())
    const a = cs.idsOf(HOME, 'job-nightly', SLOT)
    expect(cs.idsOf(HOME, 'job-nightly', SLOT)).toEqual(a)
    expect(a.sid).toMatch(SID_V4)
    expect(a.taskId).toMatch(/^[a-z0-9]+-[0-9a-f]{8}$/)
    expect(a.taskId.split('-')[0]).toBe(SLOT.toString(36))
    expect(a.taskOpId).toMatch(/^routine-[0-9a-f]{16}$/)
    expect(a.sessionOpId).toBe(`${a.taskOpId}-session`)
    expect(a.messageId).toMatch(/^qm-routine-[0-9a-f]{16}$/)
    const others = [cs.idsOf(HOME, 'job-nightly', SLOT + 1), cs.idsOf(HOME, 'job-other', SLOT), cs.idsOf('/Users/other/.open-walnut', 'job-nightly', SLOT)]
    for (const o of others) {
      expect(o.sid).not.toBe(a.sid)
      expect(o.taskOpId).not.toBe(a.taskOpId)
    }
  })

  it('a run\'s task-create is the executor\'s: its title and project, never pinned', () => {
    const cs = createClockHostStart(deps())
    const ids = cs.idsOf(HOME, 'job-nightly', SLOT)
    expect(cs.taskRecordOf(spec(), ids)).toEqual({ kind: 'task-create', taskId: ids.taskId, fields: { title: 'Routine: nightly report', pinned: false }, placement: { project: 'Routines' } })
  })
})

describe('start', () => {
  it('kept on disk, then the CLI, then the task, then the session, then the marker', async () => {
    const cs = createClockHostStart(deps())
    const ids = cs.idsOf(HOME, 'job-nightly', SLOT)
    const r = await cs.start(def(), fire())
    expect(r).toEqual({ ok: true, sid: ids.sid, taskId: ids.taskId, messageId: ids.messageId })
    expect(calls).toEqual([
      `spawn ${ids.sid} ${ids.taskId} pending=1`,
      `task ${ids.taskId} ${ids.taskOpId}`,
      `session ${ids.sid} ${ids.sessionOpId}`,
      `marker ${ids.sid} ${ids.messageId} write the nightly report`,
    ])
    // Released once the records are kept.
    expect(hostStart.pendingStarts()).toEqual([])
  })

  it('a second start for the same slot (a restart, a replay) only marks the fire: never a second CLI', async () => {
    const cs = createClockHostStart(deps())
    const first = await cs.start(def(), fire())
    calls = []
    const again = await createClockHostStart(deps()).start(def(), fire())
    expect(again).toEqual({ ...first, again: true })
    expect(calls).toEqual([])
  })

  it('the next slot is a new run', async () => {
    const cs = createClockHostStart(deps())
    const a = await cs.start(def(), fire(SLOT))
    const b = await cs.start(def(), fire(SLOT + 86_400_000))
    expect(a.ok && b.ok && a.sid !== b.sid).toBe(true)
    expect(calls.filter((c) => c.startsWith('spawn'))).toHaveLength(2)
  })

  it('a server that answers this Walnut takes the run: nothing is tried, and it is not held back', async () => {
    answers = true
    const r = await createClockHostStart(deps()).start(def(), fire())
    expect(r).toMatchObject({ ok: false, code: 'leader_answers', wait: true })
    expect(calls).toEqual([])
    expect(logs).toEqual([])
  })

  it('a session that ran here with no record kept is spent: the run is the Mac\'s', async () => {
    const cs = createClockHostStart(deps())
    ranSids.add(cs.idsOf(HOME, 'job-nightly', SLOT).sid)
    expect(await cs.start(def(), fire())).toMatchObject({ ok: false, code: 'start_failed' })
    expect(calls).toEqual([])
  })

  it('an older Mac (no routine-run in its drains) or a full journal: nothing starts', async () => {
    journal.room = false
    expect(await createClockHostStart(deps()).start(def(), fire())).toMatchObject({ ok: false, code: 'needs_leader' })
    expect(calls).toEqual([])
    expect(await createClockHostStart(deps({ ownsDir: () => false })).start(def(), fire())).toMatchObject({ ok: false, code: 'journal_unwritable' })
  })

  it('a refusal by the template (a folder missing here, a mode the Mac did not allow) is logged once per run and reason', async () => {
    const cs = createClockHostStart(deps())
    const gone = def({ cwd: path.join(dir, 'gone') })
    expect(await cs.start(gone, fire())).toMatchObject({ ok: false, code: 'cwd_missing' })
    expect(await cs.start(gone, fire())).toMatchObject({ ok: false, code: 'cwd_missing' })
    expect(logs.filter((l) => l.msg.includes('not started'))).toHaveLength(1)
    expect(logs[0].data).toMatchObject({ id: 'job-nightly', slotMs: SLOT, code: 'cwd_missing' })
    expect(await cs.start(def({ mode: 'plan' }), fire())).toMatchObject({ ok: false, code: 'mode_not_allowed' })
    expect(logs.filter((l) => l.msg.includes('not started'))).toHaveLength(2)
    expect(calls).toEqual([])
    expect(hostStart.pendingStarts()).toEqual([])
  })

  it('a CLI that does not start leaves nothing: no records, no kept start', async () => {
    spawnThrows = true
    const r = await createClockHostStart(deps()).start(def(), fire())
    expect(r).toMatchObject({ ok: false, code: 'spawn_failed' })
    expect(calls.filter((c) => !c.startsWith('spawn'))).toEqual([])
    expect(hostStart.pendingStarts()).toEqual([])
  })

  it('records that cannot be kept stop the CLI (nothing would tell the Mac about it)', async () => {
    journal.taskOk = false
    const cs = createClockHostStart(deps())
    const sid = cs.idsOf(HOME, 'job-nightly', SLOT).sid
    expect(await cs.start(def(), fire())).toMatchObject({ ok: false, code: 'journal_full' })
    expect(calls.some((c) => c.startsWith('session'))).toBe(false)
    expect(calls).toContain(`stop ${sid}`)
    expect(hostStart.pendingStarts()).toEqual([])
    // Its sid is spent now: a retry leaves the run to the Mac.
    calls = []
    journal.taskOk = true
    expect(await cs.start(def(), fire())).toMatchObject({ ok: false, code: 'start_failed' })
    expect(calls).toEqual([])
  })

  it('a refused session record stops the CLI too', async () => {
    journal.sessionOk = false
    const cs = createClockHostStart(deps())
    expect(await cs.start(def(), fire())).toMatchObject({ ok: false, code: 'journal_full' })
    expect(calls).toContain(`stop ${cs.idsOf(HOME, 'job-nightly', SLOT).sid}`)
  })

  it('a daemon death between the CLI and the records leaves the start on disk with its task, for the boot recovery', async () => {
    const cs = createClockHostStart(deps({ afterSpawn: () => { throw new Error('SIGKILL') } }))
    const ids = cs.idsOf(HOME, 'job-nightly', SLOT)
    expect(await cs.start(def(), fire())).toMatchObject({ ok: false, code: 'internal' })
    const kept = hostStart.pendingStarts()
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({
      home: HOME, sid: ids.sid, opId: ids.sessionOpId,
      record: { kind: 'session', sid: ids.sid, taskId: ids.taskId, routine: { id: 'job-nightly', slotMs: SLOT } },
      task: { opId: ids.taskOpId, jobId: 'job-nightly', record: { kind: 'task-create', taskId: ids.taskId } },
    })
  })

  it('never throws, whatever a dep does', async () => {
    const r = await createClockHostStart(deps({ primaryAnswers: () => { throw new Error('boom') } })).start(def(), fire())
    expect(r).toMatchObject({ ok: false, code: 'internal', reason: 'boom' })
  })

  it('a fire with no clock is taken by its own time', async () => {
    const cs = createClockHostStart(deps())
    const r = await cs.start(def(), { seq: 4, atMs: SLOT })
    expect(r).toMatchObject({ ok: true, sid: cs.idsOf(HOME, 'job-nightly', SLOT).sid })
  })
})

describe('startedRun: a server claim of a run this host started already', () => {
  it('names the run once its session record is here, and only that slot\'s', async () => {
    const cs = createClockHostStart(deps())
    expect(cs.startedRun(def(), fire())).toBeNull()
    await cs.start(def(), fire())
    expect(cs.startedRun(def(), fire())).toEqual(cs.idsOf(HOME, 'job-nightly', SLOT))
    expect(cs.startedRun(def(), fire(SLOT + 3_600_000))).toBeNull()
    // A CLI whose records were refused (stopped) is not a run: the server takes it.
    journal.sessionOk = false
    await cs.start(def(), fire(SLOT + 7_200_000))
    expect(cs.startedRun(def(), fire(SLOT + 7_200_000))).toBeNull()
  })
})
