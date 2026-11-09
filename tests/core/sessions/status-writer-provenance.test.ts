/**
 * Status text keeps the session that really wrote it (2026-11-07): a path named in an old status
 * line opens in the writer's session, never in whatever session the task runs now. The writer is
 * recorded only by Walnut's trusted writer paths (the status question, the report route's resolved
 * caller, the answers_ask send, the turn-end summary), never from a request body, and an old record
 * without it stays unknown.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-writer-provenance'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask, getTask, updateSummary, updateTaskRaw } from '../../../src/core/task-manager.js'
import { applyStatusAnswer } from '../../../src/core/sessions/status-question.js'
import { reportOfChange, setTaskReport } from '../../../src/core/sessions/report-set.js'
import { prepareAskAnswer } from '../../../src/core/sessions/ask-answer.js'
import { answeredAbove, answersOf, askKey } from '../../../src/core/same-ask.js'
import { deriveUserStatus, type StatusReport } from '../../../src/core/user-status.js'
import { projectTask } from '../../../src/core/task-projection.js'
import { resultWriterOf } from '../../../src/core/peers/structured-reply.js'
import { noteResultReport } from '../../../src/core/sessions/session-send-core.js'
import { trustedCallerSessionId } from '../../../src/core/sessions/session-send-core.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { askLineWriter, UNKNOWN_WRITER } from '../../../src/core/sessions/brief-source.js'

const AT = '2026-11-07T10:00:00.000Z'
const NOW = Date.parse('2026-11-07T10:05:00.000Z')

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the status writer, derived', () => {
  it('carries the report writer and its session beside now/next and on the line', () => {
    const report: StatusReport = { state: 'working', now: 'Editing src/parser.ts', next: 'Run the parser tests', at: AT, session_id: 'sid-writer' }
    const s = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'running', report }, NOW)
    expect(s.state).toBe('working')
    expect(s.reportBy).toBe('self')
    expect(s.reportSessionId).toBe('sid-writer')
    expect(s.line?.sessionId).toBe('sid-writer')
  })

  it('leaves an old report without a session as unknown, never filled in', () => {
    const report: StatusReport = { state: 'working', now: 'Editing src/parser.ts', at: AT }
    const s = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'running', report }, NOW)
    expect(s.reportBy).toBe('self')
    expect(s.reportSessionId).toBeUndefined()
    expect(s.line?.sessionId).toBeUndefined()
  })

  it('carries the waiting writer of a pure waiting report with no now/next', () => {
    const report: StatusReport = { state: 'waiting', waiting_kind: 'outside', waiting_on: 'the CI run for src/parser.ts', at: AT, session_id: 'sid-waiter' }
    const s = deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle', report, phaseChangedAt: AT }, NOW)
    expect(s.state).toBe('waiting')
    expect(s.waitingOn).toBe('the CI run for src/parser.ts')
    expect(s.waitingBy).toBe('self')
    expect(s.waitingSessionId).toBe('sid-waiter')
    // No now/next: no report writer for words that are not there.
    expect(s.reportBy).toBeUndefined()
    expect(s.reportSessionId).toBeUndefined()
  })

  it('gives a generated waitingOn no waiting writer, while now/next keep theirs', () => {
    const report: StatusReport = { state: 'working', now: 'Editing src/parser.ts', at: AT, session_id: 'sid-now' }
    const s = deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'stopped', report, phaseChangedAt: AT, waitingOnTasks: ['Parser review'] }, NOW)
    expect(s.state).toBe('waiting')
    expect(s.waitingOn).toBe('A reply from Parser review')
    expect(s.waitingBy).toBeUndefined()
    expect(s.waitingSessionId).toBeUndefined()
    expect(s.reportSessionId).toBe('sid-now')
  })

  it('marks a waiting line a person set (the trusted writer) as the person\'s, with no session', () => {
    const report = reportOfChange({ state: 'waiting', waiting_kind: 'outside', waiting_on: 'the vendor reply about docs/plan.md' }, 'human', undefined, Date.parse(AT))
    expect(report.source_host).toBe('local')
    const s = deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle', report, phaseChangedAt: AT }, NOW)
    expect(s.waitingBy).toBe('human')
    expect(s.waitingSessionId).toBeUndefined()
    expect(s.line?.by).toBe('human')
  })

  it('reads an old raw `by: human` report (maybe an unresolved session caller) as an unknown source', () => {
    // Before source_host, an unresolved caller header was stored as the person: never the primary by guess.
    const waiting: StatusReport = { state: 'waiting', waiting_kind: 'outside', waiting_on: 'the vendor reply about docs/plan.md', at: AT, by: 'human', turn_ended_at: AT }
    const w = deriveUserStatus({ phase: 'WAITING', hasSession: true, processStatus: 'idle', report: waiting, phaseChangedAt: AT }, NOW)
    expect(w.state).toBe('waiting')
    expect(w.waitingBy).toBe('unknown')
    expect(w.line?.by).toBe('unknown')
    const working: StatusReport = { state: 'working', next: 'Ship src/parser.ts', at: AT, by: 'human', turn_ended_at: AT }
    const k = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'running', report: working }, NOW)
    expect(k.reportBy).toBe('unknown')
    expect(k.line?.by).toBe('unknown')
    const needs: StatusReport = { state: 'needs', ask: 'Pick the bucket in docs/b.md', at: AT, by: 'human', turn_ended_at: AT }
    const n = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report: needs, phaseChangedAt: AT }, NOW)
    expect(n.state).toBe('needs')
    expect(n.askBy).toBe('unknown')
    expect(askLineWriter({ id: 't1', title: 'Old human', user_status: n } as Parameters<typeof askLineWriter>[0])).toEqual(UNKNOWN_WRITER)
    // With the trusted mark the same words are the person's.
    const marked = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report: { ...needs, source_host: 'local' }, phaseChangedAt: AT }, NOW)
    expect(marked.askBy).toBe('human')
    expect(marked.line?.by).toBe('human')
  })

  it('carries the writer when an answer to read quotes its waiting_on', () => {
    const report: StatusReport = { state: 'waiting', waiting_kind: 'outside', waiting_on: 'the review of src/parser.ts', answered_person: true, at: AT, session_id: 'sid-answer' }
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report, phaseChangedAt: AT }, NOW)
    expect(s.toRead).toBe('answer')
    expect(s.waitingOn).toBe('It answered your question; then it waits on: the review of src/parser.ts')
    expect(s.waitingSessionId).toBe('sid-answer')
  })

  it('gives a letter or a choice no report writer, even when its words contain the report\'s short waiting_on', () => {
    const report: StatusReport = { state: 'waiting', waiting_kind: 'outside', waiting_on: 'CI', at: AT, session_id: 'sid-report' }
    const base = { phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report, phaseChangedAt: AT } as const
    const letter = deriveUserStatus({ ...base, openLetter: 'Approve the CI change for /tmp/x' }, NOW)
    expect(letter.source).toBe('letter')
    expect(letter.reportBy).toBeUndefined()
    expect(letter.reportSessionId).toBeUndefined()
    expect(letter.waitingSessionId).toBeUndefined()
    // Written after the report, so the report does not overrule the choice.
    const choice = deriveUserStatus({ ...base, openChoice: 'Pick the CI runner', openChoiceAt: '2026-11-07T10:01:00.000Z' }, NOW)
    expect(choice.source).toBe('choice')
    expect(choice.reportBy).toBeUndefined()
    expect(choice.reportSessionId).toBeUndefined()
    expect(choice.waitingSessionId).toBeUndefined()
  })

  it('gives a held ask from an earlier close no writer, while the current report keeps now', () => {
    // B wrote only now; the ask is A's held one, whose writer Walnut never recorded.
    const report: StatusReport = { state: 'working', now: 'Writing docs/plan.md', at: AT, session_id: 'sid-b' }
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report, phaseChangedAt: AT, owedHold: { ask: 'Resubmit the form in /tmp/a.txt', at: AT } }, NOW)
    expect(s.state).toBe('needs')
    expect(s.ask).toBe('Resubmit the form in /tmp/a.txt')
    expect(s.askBy).toBeUndefined()
    expect(s.askSessionId).toBeUndefined()
    expect(s.reportSessionId).toBe('sid-b')
    expect(askLineWriter({ id: 't1', title: 'Held', user_status: s } as Parameters<typeof askLineWriter>[0])).toEqual(UNKNOWN_WRITER)
  })

  it('lets the current report\'s own ask win over a held one, with its writer', () => {
    const report: StatusReport = { state: 'needs', ask: 'Pick the bucket in docs/b.md', ask_own: { kind: 'user_own', why: 'the user owns bucket names' }, at: AT, session_id: 'sid-b' }
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report, phaseChangedAt: AT, owedHold: { ask: 'Resubmit the form in /tmp/a.txt', at: AT } }, NOW)
    expect(s.ask).toBe('Pick the bucket in docs/b.md')
    expect(s.askBy).toBe('self')
    expect(s.askSessionId).toBe('sid-b')
    expect(askLineWriter({ id: 't1', title: 'Own', user_status: s } as Parameters<typeof askLineWriter>[0])).toEqual({ by: 'task:t1', sessionId: 'sid-b' })
  })

  it('leaves an old report ask with no session as unknown', () => {
    const report: StatusReport = { state: 'needs', ask: 'Pick the bucket in docs/b.md', ask_own: { kind: 'user_own', why: 'the user owns bucket names' }, at: AT }
    const s = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report, phaseChangedAt: AT }, NOW)
    expect(s.askBy).toBe('self')
    expect(s.askSessionId).toBeUndefined()
    expect(askLineWriter({ id: 't1', title: 'Old', user_status: s } as Parameters<typeof askLineWriter>[0])).toEqual(UNKNOWN_WRITER)
  })

  it('names no writer when the status has no report words', () => {
    const s = deriveUserStatus({ phase: 'TODO', hasSession: false }, NOW)
    expect(s.reportBy).toBeUndefined()
    expect(s.reportSessionId).toBeUndefined()
  })

  it('keeps the writer when an answer above rebuilds the status, and names the answering session', () => {
    const report: StatusReport = { state: 'needs', ask: 'Pick the bucket name for the staging copy', ask_own: { kind: 'user_own', why: 'the user named the buckets himself' }, now: 'Waiting on the bucket name', at: AT, session_id: 'sid-worker' }
    const derived = deriveUserStatus({ phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', report, phaseChangedAt: AT }, NOW)
    expect(derived.state).toBe('needs')
    const out = answeredAbove(derived, [{
      key: askKey(derived.ask!), ask: derived.ask!, text: 'Use the default name', by: 'main-task', byTitle: 'Main', at: AT, sessionId: 'sid-main',
    }], NOW)
    expect(out.answeredFor?.sessionId).toBe('sid-main')
    expect(out.reportSessionId).toBe('sid-worker')
    expect(out.reportBy).toBe('self')
    // Walnut's own waiting words: no waiting writer is inherited.
    expect(out.waitingBy).toBeUndefined()
    expect(out.waitingSessionId).toBeUndefined()
  })
})

describe('a result writer', () => {
  it('is a task only when its caller resolved, unknown for an unresolved header, the person with none', () => {
    expect(resultWriterOf('sid-lead', 'lead-task', 'sid-lead')).toEqual({ by: 'task:lead-task', sessionId: 'sid-lead' })
    expect(resultWriterOf('sid-unresolved', undefined, undefined)).toEqual({ by: 'unknown' })
    expect(resultWriterOf('sid-unresolved', undefined, 'sid-forged')).toEqual({ by: 'unknown' })
    expect(resultWriterOf(undefined, undefined, undefined)).toEqual({ by: 'human', host: 'local' })
    // Only the person with no header is the primary; an unknown or a task names no host.
    expect(resultWriterOf('sid-unresolved', undefined, undefined)).not.toHaveProperty('host')
    expect(resultWriterOf('sid-lead', 'lead-task', 'sid-lead')).not.toHaveProperty('host')
  })
})

describe('the status writer, stored', () => {
  it('records the asked session on a status answer and ignores a session the answer named', async () => {
    const task = (await addTask({ title: 'Fix the parser', project: 'Garden' })).task
    await updateTaskRaw(task.id, { phase: 'IN_PROGRESS', session_id: 'sid-first' }, { source: 'test' })
    const forged = { state: 'working', now: 'Editing src/parser.ts', at: AT, session_id: 'sid-forged' } as StatusReport
    await applyStatusAnswer(task.id, 'sid-first', forged, NOW, { midTurn: true })
    expect((await getTask(task.id)).status_report?.session_id).toBe('sid-first')
    // A later session on the task never changes the writer already stored.
    await updateTaskRaw(task.id, { session_id: 'sid-second' }, { source: 'test' })
    const after = await getTask(task.id)
    expect(after.status_report?.session_id).toBe('sid-first')
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'running', report: after.status_report }, NOW).reportSessionId).toBe('sid-first')
  })

  it('never takes a session id from a report body', () => {
    const r = reportOfChange({ state: 'working', next: 'Ship it', session_id: 'sid-forged' }, 'task:lead', 'Lead', NOW)
    expect(r.session_id).toBeUndefined()
  })

  it('never takes source_host from a report body', () => {
    for (const by of ['task:lead', 'unknown', 'self'] as const) {
      expect(reportOfChange({ state: 'working', next: 'Ship it', source_host: 'local' }, by, 'Lead', NOW), by).not.toHaveProperty('source_host')
    }
    expect(reportOfChange({ state: 'working', next: 'Ship it', source_host: 'elsewhere' }, 'human', undefined, NOW).source_host).toBe('local')
  })

  it('stores source_host local for a person\'s report set, and none for an unresolved caller with a forged one', async () => {
    const worker = (await addTask({ title: 'Parser hand line', project: 'Garden' })).task
    await setTaskReport(worker.id, { state: 'working', next: 'Run the parser tests' }, null, NOW)
    const byPerson = (await getTask(worker.id)).status_report
    expect(byPerson?.by).toBe('human')
    expect(byPerson?.source_host).toBe('local')
    expect(deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'running', report: byPerson }, NOW).reportBy).toBe('human')
    await setTaskReport(worker.id, { state: 'working', next: 'Run the parser tests', source_host: 'local' }, { unknown: true }, NOW)
    const forged = (await getTask(worker.id)).status_report
    expect(forged?.by).toBe('unknown')
    expect(forged?.source_host).toBeUndefined()
  })

  it('stores the resolved caller session of a report set, never a forged one', async () => {
    const lead = (await addTask({ title: 'Parser lead', project: 'Garden' })).task
    const worker = (await addTask({ title: 'Parser worker', project: 'Garden' })).task
    await setTaskReport(worker.id, { state: 'working', next: 'Run the parser tests', session_id: 'sid-forged' }, { taskId: lead.id, title: lead.title, sessionId: 'sid-lead' }, NOW)
    const stored = (await getTask(worker.id)).status_report
    expect(stored?.by).toBe(`task:${lead.id}`)
    expect(stored?.session_id).toBe('sid-lead')
  })

  it('stores an unresolved session caller as unknown, never as the person', async () => {
    const worker = (await addTask({ title: 'Parser follower', project: 'Garden' })).task
    await setTaskReport(worker.id, { state: 'working', next: 'Run the parser tests', session_id: 'sid-forged' }, { unknown: true }, NOW)
    const stored = (await getTask(worker.id)).status_report
    expect(stored?.by).toBe('unknown')
    expect(stored?.session_id).toBeUndefined()
  })

  it('keeps Main\'s session on an answer it gave for the user, and none for a person', async () => {
    const main = (await addTask({ title: 'Main', project: 'Garden' })).task
    await updateTaskRaw(main.id, { org_role: 'main' }, { source: 'test' })
    const ask = 'Pick the bucket name for the staging copy'
    const asker = (await addTask({ title: 'Staging copy', project: 'Garden' })).task
    await updateTaskRaw(asker.id, {
      status_report: { state: 'needs', ask, at: AT, session_id: 'sid-worker' },
      user_status: { state: 'needs', source: 'session', ask },
    }, { source: 'test' })
    const byMain = await prepareAskAnswer(main.id, asker.id, 'Use the default name', undefined, 'sid-main')
    await byMain.commit()
    expect(answersOf(await getTask(asker.id))[0]?.sessionId).toBe('sid-main')

    const asker2 = (await addTask({ title: 'Staging copy two', project: 'Garden' })).task
    await updateTaskRaw(asker2.id, { user_status: { state: 'needs', source: 'session', ask } }, { source: 'test' })
    const byPerson = await prepareAskAnswer(null, asker2.id, 'Use the default name', undefined, 'sid-forged')
    await byPerson.commit()
    expect(answersOf(await getTask(asker2.id))[0]?.sessionId).toBeUndefined()
  })

  it('trusts a summary writer session only when the caller header resolves to a record', async () => {
    const task = (await addTask({ title: 'Summary route caller', project: 'Garden' })).task
    await createSessionRecord('sid-route-writer', task.id, 'Garden')
    expect(await trustedCallerSessionId('sid-route-writer')).toBe('sid-route-writer')
    expect(await trustedCallerSessionId('sid-no-such-session')).toBeUndefined()
    expect(await trustedCallerSessionId('external')).toBeUndefined()
    expect(await trustedCallerSessionId(undefined)).toBeUndefined()
  })

  it('keeps the writer when a write without a session repeats the same summary text', async () => {
    const task = (await addTask({ title: 'Summary same words', project: 'Garden' })).task
    await updateSummary(task.id, 'Parser fixed in src/parser.ts', { sessionId: 'sid-summary' })
    await updateSummary(task.id, 'Parser fixed in src/parser.ts')
    expect((await getTask(task.id)).summary_session_id).toBe('sid-summary')
    // Another session repeating the words does not become their author.
    await updateSummary(task.id, 'Parser fixed in src/parser.ts', { sessionId: 'sid-other' })
    expect((await getTask(task.id)).summary_session_id).toBe('sid-summary')
  })

  it('keeps the writer when a raw write repeats the same summary text', async () => {
    const task = (await addTask({ title: 'Summary echo', project: 'Garden' })).task
    await updateSummary(task.id, 'Parser fixed in src/parser.ts', { sessionId: 'sid-summary' })
    await updateTaskRaw(task.id, { summary: 'Parser fixed in src/parser.ts', title: 'Summary echo, renamed' }, { source: 'test' })
    expect((await getTask(task.id)).summary_session_id).toBe('sid-summary')
  })

  it('projects the stored writers of last words, summary and result, whatever session the task runs now', async () => {
    const task = (await addTask({ title: 'Projected writers', project: 'Garden' })).task
    await updateSummary(task.id, 'Parser fixed in src/parser.ts', { sessionId: 'sid-summary' })
    await updateTaskRaw(task.id, {
      phase: 'IN_PROGRESS', session_id: 'sid-old',
      last_words: { text: 'See src/parser.ts', at: AT, session_id: 'sid-old' },
    }, { source: 'test' })
    await noteResultReport(task.id, { via: 'complete', ...resultWriterOf('sid-lead', 'lead-task', 'sid-lead') }, { result: 'Fixed', not_done: ['Docs'] }, { emit: false })
    await updateTaskRaw(task.id, { session_id: 'sid-new' }, { source: 'test' })
    const p = projectTask(await getTask(task.id))
    expect(p.last_words?.session_id).toBe('sid-old')
    expect(p.summary_session_id).toBe('sid-summary')
    expect(p.result_report?.by).toBe('task:lead-task')
    expect(p.result_report?.sessionId).toBe('sid-lead')
  })

  it('marks a not_done that merges an earlier close\'s held items as unknown, keeping the new result\'s writer', async () => {
    const task = (await addTask({ title: 'Mixed not done', project: 'Garden' })).task
    await updateTaskRaw(task.id, { result_report: {
      via: 'complete', at: AT, by: 'task:writer-a', not_done: ['Resubmit the form'],
      owed: { items: ['Resubmit the form'], ask: 'Resubmit the form', at: AT, by: 'task:writer-a' },
    } }, { source: 'test' })
    await noteResultReport(task.id, { via: 'reply', request_id: 'req-1', by: 'task:writer-b', sessionId: 'sid-b' }, { result: 'Docs written', not_done: ['Add a test'] }, { emit: false })
    const r = (await getTask(task.id)).result_report!
    expect(r.by).toBe('task:writer-b')
    expect(r.sessionId).toBe('sid-b')
    expect(r.result).toBe('Docs written')
    expect(r.not_done).toEqual(['Add a test', 'Resubmit the form'])
    expect(r.not_done_by).toBe('unknown')
    expect(r.owed?.by).toBe('task:writer-a')
    expect(projectTask(await getTask(task.id)).result_report?.not_done_by).toBe('unknown')
  })

  it('keeps a person\'s result host through noteResultReport and the projection; an old raw human has none', async () => {
    const task = (await addTask({ title: 'Person result', project: 'Garden' })).task
    await noteResultReport(task.id, { via: 'complete', ...resultWriterOf(undefined, undefined, undefined) }, { result: 'Closed by hand', not_done: ['Docs'] }, { emit: false })
    const r = (await getTask(task.id)).result_report!
    expect(r.by).toBe('human')
    expect(r.host).toBe('local')
    expect(projectTask(await getTask(task.id)).result_report?.host).toBe('local')
    // An unresolved header: unknown, no host, and a later write never inherits the earlier host.
    await noteResultReport(task.id, { via: 'complete', ...resultWriterOf('sid-unresolved', undefined, undefined) }, { result: 'Closed again', not_done: ['Docs'] }, { emit: false })
    const u = (await getTask(task.id)).result_report!
    expect(u.by).toBe('unknown')
    expect(u.host).toBeUndefined()
    // An old raw `by: human` (before host) projects no host.
    const old = (await addTask({ title: 'Old person result', project: 'Garden' })).task
    await updateTaskRaw(old.id, { result_report: { via: 'complete', at: AT, by: 'human', not_done: ['Docs'] } }, { source: 'test' })
    expect(projectTask(await getTask(old.id)).result_report?.host).toBeUndefined()
  })

  it('leaves a not_done of one writer unmarked', async () => {
    const task = (await addTask({ title: 'Single not done', project: 'Garden' })).task
    await noteResultReport(task.id, { via: 'complete', by: 'task:writer-b', sessionId: 'sid-b' }, { result: 'Half done', not_done: ['Add a test'] }, { emit: false })
    expect((await getTask(task.id)).result_report?.not_done_by).toBeUndefined()
  })

  it('projects no last words for an old row that has none', async () => {
    const task = (await addTask({ title: 'No last words', project: 'Garden' })).task
    expect(projectTask(await getTask(task.id)).last_words).toBeUndefined()
  })

  it('records the summary writer and clears it on any write without one', async () => {
    const task = (await addTask({ title: 'Summary owner', project: 'Garden' })).task
    await updateSummary(task.id, 'Parser fixed in src/parser.ts', { sessionId: 'sid-summary' })
    let t = await getTask(task.id)
    expect(t.summary_session_id).toBe('sid-summary')
    expect(projectTask(t).summary_session_id).toBe('sid-summary')
    // A person's later summary never inherits the session's.
    await updateSummary(task.id, 'Edited by hand')
    t = await getTask(task.id)
    expect(t.summary_session_id).toBeUndefined()
    // A raw writer (a sync pull) replacing the text clears it too.
    await updateSummary(task.id, 'Parser fixed again', { sessionId: 'sid-summary' })
    await updateTaskRaw(task.id, { summary: 'Pulled from the outside list' }, { source: 'test' })
    t = await getTask(task.id)
    expect(t.summary_session_id).toBeUndefined()
    expect(projectTask(t).summary_session_id).toBeUndefined()
  })
})
