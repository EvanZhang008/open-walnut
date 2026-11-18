/**
 * A task that parks itself in its turn stays parked when that turn ends, unless its report asks
 * the user something concrete (2026-11-18, the user: "if this task already ahve a trigger and just
 * wating wh not it self mark it as snoozed, waiting"). Incident: a task answered the user's letter
 * reply, armed an hourly trigger and set itself WAITING; 10 s after the turn ended its status
 * report (needs-you because the turn answered him, no ask) moved it back to NEED_ACTION, and the
 * card read Needs you with the letter's question, which he had already answered in its thread.
 *
 * Two rules, both guarded here for their whole class:
 *   - every write that may take a task out of WAITING (`leaveHeld: true`) is listed with why; the
 *     turn-end one (report-phase.ts) leaves a park only for a report that asks the user;
 *   - every check of "a decision letter still waits on the user" is the one rule in
 *     src/core/human-inbox/open-decision.ts, which counts words written back as an answer.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-own-park'))

import { WALNUT_HOME } from '../../src/constants.js'
import { applyStoredReports } from '../../src/core/sessions/report-phase.js'
import { deriveUserStatus, type StatusReport } from '../../src/core/user-status.js'
import { applyStatusAnswer } from '../../src/core/sessions/status-question.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { awaitsUserDecision, decisionAnswered } from '../../src/core/human-inbox/open-decision.js'
import { noteRestoredPark } from '../../src/core/task-wait-resume.js'

const ROOT = path.resolve(__dirname, '../..')
const iso = (ms: number) => new Date(ms).toISOString()

describe('a park of its own survives the turn end', () => {
  const SID = '1c2d3e4f-5061-4728-99aa-bbccddeeff00'
  let id = ''
  beforeAll(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    id = (await addTask({ title: 'Watch the garden lights install', project: 'Garden' })).task.id
    await createSessionRecord(SID, id, 'Garden', WALNUT_HOME)
  })
  afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

  /** The user writes, the turn answers him and parks the task itself 10 s before it ends. */
  const answerThenPark = async (turnEnd: number) => {
    await updateSessionRecord(SID, { humanInputAt: iso(turnEnd - 100_000), process_status: 'running' })
    await updateTaskRaw(id, { phase: 'IN_PROGRESS' }, { source: 'test' })
    await updateTaskRaw(id, { phase: 'WAITING', phase_changed_at: iso(turnEnd - 10_000) }, { source: 'test' })
    await updateSessionRecord(SID, { process_status: 'idle' })
  }

  it('answering the user, then parking: needs-you with no ask leaves it WAITING', async () => {
    const end = Date.now() - 60_000
    await answerThenPark(end)
    expect(await applyStatusAnswer(id, SID, { state: 'needs', now: 'The garden lights are being installed', at: iso(end + 5_000) }, end)).toBe(true)
    const t = await getTask(id)
    expect(t.status_report?.answered_person).toBe(true)
    expect(t.phase).toBe('WAITING')
  })

  it('answering the user, then parking: a waiting report leaves it WAITING', async () => {
    const end = Date.now() - 40_000
    await answerThenPark(end)
    const report = { state: 'waiting' as const, waiting_kind: 'outside' as const, waiting_on: 'the supplier\'s delivery', at: iso(end + 5_000) }
    expect(await applyStatusAnswer(id, SID, report, end)).toBe(true)
    expect((await getTask(id)).phase).toBe('WAITING')
  })

  it('a concrete ask still brings it back: something new for the user', async () => {
    const end = Date.now() - 20_000
    await answerThenPark(end)
    expect(await applyStatusAnswer(id, SID, { state: 'needs', ask: 'Order two more lamps for the north path?', at: iso(end + 5_000) }, end)).toBe(true)
    expect((await getTask(id)).phase).toBe('NEED_ACTION')
  })

  it('a park it set itself stays when its report says it works on; one Walnut restored leaves for it', async () => {
    const end = Date.now() - 15_000
    await answerThenPark(end)
    const working = { state: 'working' as const, now: 'Fixing the two failing checks', at: iso(end + 5_000) }
    expect(await applyStatusAnswer(id, SID, working, end)).toBe(true)
    expect((await getTask(id)).phase).toBe('WAITING')
    // Walnut brought the park back at the turn end (a fire into it, a message that interrupted it):
    // the turn's own word that its own work is what runs wins; a bare "working" keeps the park (its
    // outside trigger still holds it).
    for (const [report, want] of [[working, 'WAITING'], [{ state: 'waiting' as const, waiting_kind: 'own' as const, waiting_on: 'my test run' }, 'IN_PROGRESS']] as const) {
      const e = Date.now()
      await updateTaskRaw(id, { phase: 'WAITING', phase_changed_at: iso(e) }, { source: 'test' })
      noteRestoredPark(id, (await getTask(id)).phase_changed_at)
      expect(await applyStatusAnswer(id, SID, { ...report, at: iso(e + 5_000) }, e)).toBe(true)
      expect((await getTask(id)).phase, JSON.stringify(report)).toBe(want)
    }
  })

  it('a stored report with no ask moves no park at start either', async () => {
    const end = Date.now() - 10_000
    await updateTaskRaw(id, { phase: 'WAITING', phase_changed_at: iso(end - 10_000), status_report: { state: 'needs', at: iso(end + 5_000), turn_ended_at: iso(end), answered_person: true } }, { source: 'test' })
    await applyStoredReports()
    expect((await getTask(id)).phase).toBe('WAITING')
  })

  it('reads as waiting on its trigger, not Needs you', () => {
    const report: StatusReport = { state: 'needs', at: iso(Date.now()), answered_person: true }
    const s = deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle', report, triggers: ['Hourly delivery check'], phaseChangedAt: iso(Date.now() - 5_000) }, Date.now() + 1_000)
    expect(s.state).toBe('waiting')
  })
})

describe('a letter the user wrote back in is answered', () => {
  const letter = (over: Record<string, unknown> = {}) => ({
    type: 'action_required', archived: false, sender: { taskId: 't1' },
    thread: [{ from: 'agent' }, { from: 'human' }, { from: 'agent' }], ...over,
  })
  it('words written back answer it, whatever the agent wrote after', () => {
    expect(decisionAnswered(letter())).toBe(true)
    expect(awaitsUserDecision(letter())).toBe(false)
    expect(awaitsUserDecision(letter({ thread: [{ from: 'agent' }] }))).toBe(true)
    expect(awaitsUserDecision(letter({ thread: undefined }))).toBe(true)
  })
  it('a letter only a pick settles stays open on a written reply', () => {
    expect(awaitsUserDecision(letter({ sender: { taskId: 't1', pluginId: 'p' } }))).toBe(true)
    expect(awaitsUserDecision(letter({ credentialAsk: { host: 'h' } }))).toBe(true)
    expect(awaitsUserDecision(letter({ items: [{}] }))).toBe(true)
  })
  it('a pick, a settle or the archive close it', () => {
    const open = letter({ thread: [] })
    expect(awaitsUserDecision({ ...open, answered: { actionId: 'a' } })).toBe(false)
    expect(awaitsUserDecision({ ...open, settled: { at: 1 } })).toBe(false)
    expect(awaitsUserDecision({ ...open, archived: true })).toBe(false)
    expect(awaitsUserDecision({ ...open, type: 'review' })).toBe(false)
  })
})

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fss.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) } else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}
const code = (f: string) => fss.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(?:\*|\/\/|\/\*)/.test(l))

describe('guard: every write that takes a task out of WAITING', () => {
  const SITES: Record<string, { count: number; why: string; gate?: RegExp }> = {
    'src/core/sessions/report-phase.ts': { count: 1, why: 'a turn end\'s report: leaves a park only for a concrete ask of the user, or a park Walnut restored for its own work going on', gate: /task\.phase === 'WAITING' && \(\(next === 'NEED_ACTION' && reportAsksUser\(report\)\) \|\| \(restored && next === 'IN_PROGRESS' && saysOwnWork\(report\)\)\)/ },
    'src/core/phase.ts': { count: 1, why: 'the next turn or a prompt for the user, never the turn that set it' },
    'src/core/task-wait-until.ts': { count: 2, why: 'its own wait clock ran out, or the trigger it waits on cannot run' },
    'src/core/sessions/external-session-import.ts': { count: 1, why: 'an imported session\'s own record' },
    'src/core/offline-merge/apply-fields.ts': { count: 1, why: 'a person\'s edit made offline, merged back' },
  }
  it('no unlisted leaveHeld write, and each listed one keeps its gate', () => {
    const found: Record<string, number> = {}
    for (const f of walk(path.join(ROOT, 'src'))) {
      const n = code(f).filter((l) => /\bleaveHeld:\s*true\b/.test(l)).length
      if (n) found[path.relative(ROOT, f)] = n
    }
    expect(found, 'A new write that takes a task out of WAITING: list it here with why, and keep a park its turn set (report-phase.ts reportMayMovePhase)').toEqual(
      Object.fromEntries(Object.entries(SITES).map(([f, s]) => [f, s.count])))
    for (const [f, s] of Object.entries(SITES)) if (s.gate) expect(fss.readFileSync(path.join(ROOT, f), 'utf8'), `${f}: ${s.why}`).toMatch(s.gate)
  })
})

describe('guard: one rule for an open decision letter', () => {
  // A line that reads a letter's `answered` beside its type, `archived` or `settled` is a copy of the
  // rule; these read it for something else than "does it still wait on the user".
  const ALLOWED: Record<string, string> = {
    'src/core/human-inbox/open-decision.ts': 'the rule itself',
    'src/core/human-inbox/decision-settle.ts': 'the tidy-up of letters left behind (completion, the 4-hour re-check), which also settles a replied one',
    'src/core/human-inbox/walnut-letters/sweep.ts': 'the tidy-up of Walnut\'s own letters no longer needed, a replied one too',
    'src/core/human-inbox/store.ts': 'settleLettersWhere: the store\'s settle, never over a pick',
    'src/core/human-inbox/credential-ask.ts': 'a sign-in ask, which only the credential answers',
    'src/core/hosts/exec-grants.ts': 'an approval of a command on another host, which only a pick grants',
    'src/core/private-tasks/sync-gate.ts': 'an approval to sync a private task, which only a pick grants',
    'src/core/human-inbox/duplicate-letter.ts': 'a letter its sender withdrew, not whether it waits',
    'src/core/user-status-sync.ts': 'a review letter, answered by its pick only (decisions ask open-decision.ts on the line above)',
    'web/src/components/inbox/LetterView.tsx': 'whether its option buttons can still be pressed, not whether it waits',
    'web/src/api/human-inbox.ts': 'isDecisionWithoutOptions: a decision letter on disk with no options, not whether it waits',
  }
  it('no inline copy outside open-decision.ts', () => {
    const found: string[] = []
    for (const f of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'web/src'))]) {
      const rel = path.relative(ROOT, f)
      if (ALLOWED[rel]) continue
      if (code(f).some((l) => /\.answered\b/.test(l) && /action_required|\.archived\b|\.settled\b/.test(l))) found.push(rel)
    }
    expect(found, 'Ask src/core/human-inbox/open-decision.ts (awaitsUserDecision / decisionAnswered) instead: a reply written back answers a letter').toEqual([])
  })
})
