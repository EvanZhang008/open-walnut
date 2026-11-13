/**
 * A reworded ask is the same ask, never news (2026-11-09, the CEO gathering five VP reflections: a
 * blog task reworded one question four times in a day, six asks sat in front of the user three to
 * four days reading as new at every refresh, and all five "changes" of one Brief refresh were new
 * words with no new fact; the user, 11-07: "can we not ask me everyfucking day").
 *
 * Two halves:
 *  1. The corpus: rewordings in the shapes of 2026-11-08 (subjects invented, each rewording kept as
 *     it was made: a question tacked on, a time estimate added, clauses moved, synonyms) go through the
 *     report writer and then every path that tells someone an ask changed. Each must read no change.
 *     The facts that are news (another decision, a new fact named, new options, a new deadline, new
 *     evidence) must read as change on the same paths.
 *  2. The paths, enumerated from the source: every caller of a primitive that judges an ask moved is
 *     listed with the decision check it runs, every file that compares ask WORDS is listed with why
 *     words are right there, and every writer of a task's report stamps the decision. A new path, a
 *     new comparison of words, or a new writer fails here until it compares the decision.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Task } from '../../src/core/types.js'
import { deriveUserStatus, type StatusReport } from '../../src/core/user-status.js'
import { readStatusReport } from '../../src/core/session-hooks/builtins.js'
import { askDecisionQuestion, stampSaidDecision, taskDecision } from '../../src/core/ask-decision.js'
import { askNews, seenOf } from '../../src/core/sessions/status-push.js'
import { briefFreshness, briefLineMark, briefSnapshot, lineMoved } from '../../src/core/sessions/brief-fresh.js'
import { briefHintStateOf } from '../../src/core/sessions/brief-hint.js'
import { briefRefreshDue, needsChanges, refreshBody } from '../../src/core/sessions/brief-refresh.js'
import { briefNeedsAsks, briefNeedsDecisions } from '../../src/core/sessions/brief.js'
import { nextRecheckCount } from '../../src/core/sessions/needs-recheck.js'
import { clearRiding, decisionToldTo, pendingRiding, rideLine, rideNotice } from '../../src/core/sessions/status-riding.js'
import { emptyThreads, openThread, updateThread } from '../../src/core/org/threads-model.js'
import { askCheckedAtOf } from '../../src/core/user-status-sync.js'
import { reportOfChange } from '../../src/core/sessions/report-set.js'
import { askKey as SAME_KEY, answerHolds, answeredAbove, answersOf, keptAnswers, type AskAnswer } from '../../src/core/same-ask.js'

const ROOT = path.resolve(__dirname, '../..')
const NOW = Date.parse('2026-11-08T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

/** Rewordings in the shapes seen on 2026-11-08 (Main's refresh record and the asks then): every
 *  subject is invented, each rewording kept as it was made. */
const REWORDINGS: Array<{ name: string; asks: string[]; numbersReplaced?: true }> = [
  // The CEO's three: a question tacked on, a time estimate added, a "go with the recommendation?" added.
  { name: 'a deadline question tacked on', asks: [
    '11 \u6708 20 \u65e5\u524d\u53bb\u8bfb\u4e66\u4f1a\u7f51\u7ad9\u770b\u5b8c\u7ea6 7 \u5206\u949f\u7684\u5165\u4f1a\u4ecb\u7ecd\u89c6\u9891\uff0c\u518d\u505a\u5b8c\u5c0f\u6d4b\u9a8c\u3002',
    '11 \u6708 20 \u65e5\u524d\u53bb\u8bfb\u4e66\u4f1a\u7f51\u7ad9\u770b\u5b8c\u7ea6 7 \u5206\u949f\u7684\u5165\u4f1a\u4ecb\u7ecd\u89c6\u9891\uff0c\u518d\u505a\u5b8c\u5c0f\u6d4b\u9a8c\u3002\u505a\u5b8c\u4e86\u5417\uff1f',
    '\u8bfb\u4e66\u4f1a\u5165\u4f1a\u4ecb\u7ecd 11 \u6708 20 \u65e5\u622a\u6b62\uff1a\u8bf7\u5728\u8bfb\u4e66\u4f1a\u7f51\u7ad9\u770b\u5b8c\u7ea6 7 \u5206\u949f\u7684\u89c6\u9891\uff0c\u518d\u505a\u5b8c\u5c0f\u6d4b\u9a8c\u3002\u505a\u5b8c\u4e86\u5417\uff1f',
  ] },
  { name: 'a time estimate added', asks: [
    '\u6309\u6211\u7ed9\u7684\u53c2\u6570\uff08\u7ba1\u7406\u5458\u662f\u4f60\uff09\u5efa\u7b2c\u4e00\u4e2a\u6837\u677f\u82b1\u56ed garden-alpha-1 \u5417\uff1f',
    '\u6309\u6211\u7ed9\u7684\u53c2\u6570\u65b0\u5efa garden-alpha-1 \u6837\u677f\u82b1\u56ed\u5417\uff1f\u7ba1\u7406\u5458\u662f\u4f60\uff0c\u5efa\u597d\u540e\u81ea\u52a8\u79cd\u597d\u4e00\u6574\u5957\u6837\u677f\u82b1\u575b\uff08\u7ea6 50 \u5206\u949f\uff09\u3002',
  ] },
  { name: 'a "go with the recommendation?" added', asks: [
    '\u63a5\u53d7\u4e09\u5904\u5c0f\u7455\u75b5\uff0c\u4f60\u4eb2\u81ea\u8bf7\u8bbe\u8ba1\u5e08\u770b\u5c01\u9762\u8349\u56fe\uff0c\u5468\u4e09\uff0811-11\uff09\u8ba8\u8bba\u4f1a\u540e\u4ea4\u7a3f\u7ed9\u51fa\u7248\u793e\u3002',
    '\u5c01\u9762\u65b9\u6848\u6309\u6211\u7684\u63a8\u8350\u529e\u5417\uff1f\u63a5\u53d7\u4e09\u5904\u5c0f\u7455\u75b5\uff0c\u4f60\u4eb2\u81ea\u8bf7\u8bbe\u8ba1\u5e08\u770b\u5c01\u9762\u8349\u56fe\uff0c\u5468\u4e09\uff0811-11\uff09\u8ba8\u8bba\u4f1a\u540e\u4ea4\u7a3f\u3002',
    '\u6309\u63a8\u8350\u529e\u5417\uff1f\u63a5\u53d7\u4e09\u5904\u5c0f\u7455\u75b5\uff0c\u4f60\u4eb2\u81ea\u8bf7\u8bbe\u8ba1\u5e08\u770b\u5c01\u9762\u8349\u56fe\uff0c\u5468\u4e09\uff0811-11\uff09\u8ba8\u8bba\u4f1a\u540e\u4ea4\u7a3f\u7ed9\u51fa\u7248\u793e\u3002',
  ] },
  // One question in four words over a day.
  { name: 'one question four times in a day', asks: [
    '\u6587\u7ae0\u7b2c\u4e00\u6761\u610f\u89c1\uff1a\u53ea\u5728\u5f00\u5934\u548c\u7ed3\u5c3e\u5404\u52a0\u4e00\u6bb5\u201c\u6211\u201d\u7684\u56ed\u4e01\u89c6\u89d2\u3001\u5176\u4f59\u4fdd\u6301 we\uff0c\u8fd9\u4e2a\u5ea6\u53ef\u4ee5\u5417\uff1f',
    '\u6587\u7ae0\u7b2c\u4e00\u6761\u610f\u89c1\uff08\u56ed\u4e01\u7b2c\u4e00\u4eba\u79f0\uff09\uff1a\u53ea\u5728\u5f00\u5934\u548c\u7ed3\u5c3e\u5404\u52a0\u4e00\u6bb5\u201c\u6211\u201d\uff0c\u5176\u4f59\u4fdd\u6301 we\uff0c\u8fd9\u4e2a\u5ea6\u53ef\u4ee5\u5417\uff1f',
    '\u7b2c\u4e00\u6761\u4fee\u6539\u610f\u89c1\uff1a\u5f00\u5934\u548c\u7ed3\u5c3e\u7528\u201c\u6211\u201d\u5199\u56ed\u4e01\u89c6\u89d2\uff0c\u6b63\u6587\u7ee7\u7eed\u7528 we\uff0c\u53ef\u4ee5\u5417\uff1f',
    '\u6587\u7ae0\u7684\u7b2c\u4e00\u4eba\u79f0\u6539\u6cd5\uff1a\u53ea\u6539\u5f00\u5934\u548c\u7ed3\u5c3e\u4e24\u6bb5\uff0c\u5176\u4f59\u4fdd\u6301 we\uff0c\u6309\u8fd9\u4e2a\u6539\u5417\uff1f',
  ] },
  // Other numbers ("1 to 2" became "2 and 4"): kept only when the session names the decision.
  { name: 'the picks spelled out', numbersReplaced: true, asks: [
    '\u4eca\u5929\u7684 10 \u6761\u83dc\u8c31\u8349\u7a3f\u91cc\uff0c\u6311 1 \u5230 2 \u6761\u70b9\u94fe\u63a5\u53d1\u51fa\u53bb\uff0c\u597d\u5417\uff1f',
    '\u4eca\u5929\u7684 10 \u6761\u83dc\u8c31\u8349\u7a3f\u5728\u63a8\u5e7f\u804a\u5929\u91cc\uff0c\u5148\u53d1\u6700\u63a8\u8350\u7684\u7b2c 2 \u6761\u548c\u7b2c 4 \u6761\u5417\uff1f\u70b9\u94fe\u63a5\u540e\u6309 Post \u5c31\u53d1\u51fa\u53bb\u4e86\u3002',
  ] },
  { name: 'the same trial, said another way', asks: [
    '\u53ef\u4ee5\u5728\u4f60\u7684\u6d4b\u8bd5\u7f51\u7ad9\u4e0a\u8bd5\u65b0\u7684\u56fe\u7247\u538b\u7f29\u529e\u6cd5\u5417\uff1f\u4f1a\u5148\u5907\u4efd\u5f53\u524d\u8bbe\u7f6e\uff0c\u8bd5\u5b8c\u518d\u63d0\u4ea4\u8bc4\u5ba1\u3002\uff08\u63a8\u8350\u53ef\u4ee5\uff09',
    '\u5728\u4f60\u7684\u6d4b\u8bd5\u7f51\u7ad9\u4e0a\u8bd5\u201c\u53bb\u6389\u91cd\u590d\u7f29\u7565\u56fe\u201d\u7684\u529e\u6cd5\u5417\uff1f\u53ea\u6539\u6d4b\u8bd5\u7ad9\u7684\u56fe\u7247\u8bbe\u7f6e\uff0c\u6539\u524d\u5148\u5907\u4efd\u3002\uff08\u63a8\u8350\u8bd5\uff09',
  ] },
  { name: 'clauses dropped and merged', asks: [
    '\u4e09\u4e2a\u63d2\u4ef6\u7684\u4ee3\u7801\u8bc4\u5ba1\u90fd\u5ba1\u5b8c\u4e86\uff0c\u6ca1\u6709\u8981\u6539\u7684\u5730\u65b9\uff0c\u53ea\u5dee\u4f60\u6279\u51c6\u3002\u4f60\u73b0\u5728\u53bb\u6279\u5417\uff1f',
    '\u63d2\u4ef6\u7684\u4e09\u4efd\u4ee3\u7801\u8bc4\u5ba1\u90fd\u5ba1\u5b8c\u4e86\uff0c\u6ca1\u6709\u8981\u6539\u7684\u5730\u65b9\uff0c\u4f60\u6765\u6279\u51c6\u5417\uff1f',
  ] },
  { name: 'one word added', asks: [
    '\u80fd\u628a\u793e\u533a\u82b1\u56ed\u95e8\u7981\u5361\u7533\u8bf7\u7684\u786e\u8ba4\u6570\u5b57\u53d1\u7ed9\u6211\u5417\uff1f\u6279\u4e00\u6b21\u5c31\u80fd\u6838\u5bf9\u5269\u4e0b 7 \u4e2a\u8f66\u4f4d\u3002',
    '\u80fd\u628a\u793e\u533a\u82b1\u56ed\u95e8\u7981\u5361\u7533\u8bf7\u7684\u786e\u8ba4\u6570\u5b57\u53d1\u7ed9\u6211\u5417\uff1f\u6279\u8fd9\u4e00\u6b21\uff0c\u5c31\u80fd\u6838\u5bf9\u5269\u4e0b 7 \u4e2a\u8f66\u4f4d\u3002',
  ] },
  { name: 'the detail moved out of the ask', asks: [
    '\u83dc\u8c31\u6587\u7ae0\u91cc\u201c\u6bcf\u76d8\u7ea6 33 \u4e2a\u997a\u5b50\u201d\u5199\u9519\u4e86\uff0c\u5e94\u4e3a\u7ea6 24 \u4e2a\u3002\u66f4\u6b63\u7248\u548c\u8bfb\u8005\u7559\u8a00\u7684\u56de\u590d\u6309\u8349\u7a3f\u53d1\u5417\uff1f\uff08\u63a8\u8350\u53d1\uff09',
    '\u83dc\u8c31\u6587\u7ae0\u7684\u66f4\u6b63\u548c\u7ed9\u8bfb\u8005\u7559\u8a00\u7684\u56de\u590d\uff0c\u6309\u8349\u7a3f\u53d1\u5417\uff1f\uff08\u63a8\u8350\u53d1\uff09',
  ] },
  { name: 'a pronoun added', asks: [
    '\u8981\u4e0d\u8981\u73b0\u5728\u4ee5\u4f60\u7684\u540d\u4e49\u7ed9\u82b1\u5e97\u53d1\u50ac\u5355\u90ae\u4ef6,\u8981\u6c42 11/13 \u524d\u4e66\u9762\u7ed9\u51fa $249 \u7684\u82b1\u7bee\u62a5\u4ef7?\u5efa\u8bae\u53d1\u3002',
    '\u8981\u4e0d\u8981\u73b0\u5728\u4ee5\u4f60\u7684\u540d\u4e49\u7ed9\u82b1\u5e97\u53d1\u50ac\u5355\u90ae\u4ef6,\u8981\u6c42\u4ed6\u4eec 11/13 \u524d\u4e66\u9762\u7ed9\u51fa $249 \u7684\u82b1\u7bee\u62a5\u4ef7?\u5efa\u8bae\u53d1\u3002',
  ] },
  // 2026-11-10: a task's own trigger put an ask its VP had answered back on the user's list, reworded;
  // the "to" inside a Latin name with a CJK verb after it read as pointing elsewhere.
  { name: 'a Latin name with "to" in it, the CJK verb after it changed', asks: [
    '\u4f9b\u5e94\u5546\u8bc4\u5ba1\u8868\u5df2\u7ecf\u586b\u597d\u5e76\u9009\u4e86 Yes\uff0c\u4f60\u770b\u5b8c\u540e\u5728 Door to Door \u70b9\u4e00\u4e0b Submit \u5c31\u884c\u3002',
    '\u4f9b\u5e94\u5546\u8bc4\u5ba1\u8868\u5df2\u586b\u597d\u5e76\u9009\u4e86 Yes\uff0c\u8bf7\u4f60\u5728 Door to Door \u4e0a\u68c0\u67e5\u4e00\u904d\u540e\u70b9 Submit\u3002',
  ] },
  { name: 'English, reordered with a recommendation', asks: [
    'Approve testing on your real iPhone?',
    'Can I run the tests on your own iPhone? (recommended: yes)',
    'Testing needs your real iPhone for ten minutes: go ahead?',
  ] },
]

/** A session's status answer, as the status question gets it. */
function answer(ask: string, extra: string[] = []): string {
  return ['FOR_USER_STATE: needs-you', `FOR_USER_ASK: ${ask}`, 'FOR_USER_ASK_OWN: user_own: only the user can say', ...extra, 'FOR_USER_NOW: ready', 'FOR_USER_NEXT: you decide'].join('\n')
}

let minted = 0
const mint = () => `ask-t${String(++minted).padStart(4, '0')}`

/** One turn end: the answer read and stored the way status-question.ts stores it. */
function turn(text: string, prev: StatusReport | null, atMs: number): StatusReport {
  const read = readStatusReport(text, new Date(atMs))
  expect(read, text).not.toBeNull()
  return stampSaidDecision(read!, prev, { mint })
}

/** The task as every surface reads it after that report. */
function taskOf(report: StatusReport, extra: Partial<Task> = {}): Task {
  const at = Date.parse(report.at)
  const user_status = deriveUserStatus({
    phase: 'NEED_ACTION', hasSession: true, processStatus: 'idle', phaseChangedAt: iso(at - 1_000), report,
    ...(extra.due_date ? { dueDate: extra.due_date } : {}),
  }, at)
  return {
    id: 'asker', title: 'The asking task', phase: 'NEED_ACTION', status: 'in_progress', project: 'Marina',
    status_report: report, user_status, ...extra,
  } as Task
}

const lead = (brief?: Task['brief']): Task => ({
  id: 'lead', title: 'Marina lead', phase: 'WAITING', status: 'in_progress', org_role: 'lead', project: 'Marina', ...(brief ? { brief } : {}),
}) as Task
const LETTER = '### Needs you\n- <task-ref id="asker" label="A"/>: the ask\n### Working\n### Waiting / snoozed'

/** A lead's answer in the user's place to the ask `t` shows, recorded as ask-answer.ts records it. */
function answerTo(t: Task, opts: { noId?: true } = {}): AskAnswer {
  const ask = t.status_report!.ask!
  return {
    key: SAME_KEY(ask), ask, text: 'go ahead', by: 'lead', byTitle: 'Marina lead', at: iso(NOW - 60_000),
    ...(!opts.noId && taskDecision(t) ? { askId: taskDecision(t)!.id, decisionKey: taskDecision(t)!.key } : {}),
  }
}

/** Every path that tells someone the ask changed, between two readings of the task. */
function moves(before: Task, after: Task): Record<string, boolean> {
  const owner = lead({ text: LETTER, at: before.status_report!.at, ...briefSnapshot(LETTER, lead(), [before]) })
  const was = seenOf(before)
  const is = seenOf(after)
  clearRiding()
  rideNotice('s-vp', 'asker', 'stopped', 'its turn ended', NOW, taskDecision(before)?.key)
  pendingRiding('s-vp', NOW)!.markTold()
  const thread = (() => {
    const opened = openThread(emptyThreads('lead'), { title: 'The ask', text: 'x', from: 'node', state: 'needs' }, 'human', iso(NOW - 120_000))
    const asked = updateThread(opened.file, opened.thread.id, { ask: before.status_report!.ask }, 'task:lead', iso(NOW - 60_000))
    return updateThread(asked.file, opened.thread.id, { ask: after.status_report!.ask, state: 'needs' }, 'task:lead', iso(NOW)).thread.updatedAt !== asked.thread.updatedAt
  })()
  const watched = askCheckedAtOf(
    { recheck_watch: [{ trigger: 'j1', watches: 'ask', at: iso(NOW - 60_000), key: before.status_report!.ask_id! }] } as Pick<Task, 'recheck_watch'>,
    new Map([['trigger:j1', iso(NOW - 30_000)]]), after.status_report!.ask, after.status_report!.ask_id,
  ) === null
  const refresh = briefRefreshDue(owner, [after], { now: NOW, running: false })
  return {
    'status-push (the line to the node above)': is.key !== was.key || askNews(was, is),
    'brief-fresh (a Brief line moved)': lineMoved(briefLineMark(before), after),
    'brief-fresh (the Brief reads behind)': !!briefFreshness(owner, [after])?.stale,
    'brief-hint (the node is told its Brief is behind)': !!briefHintStateOf(owner, [after])?.stale,
    'brief-refresh (the node is woken to rewrite)': refresh.due,
    'brief-refresh (a Needs you change told to the user)': needsChanges(
      briefNeedsAsks(owner, [after]), briefNeedsAsks(owner, [before]), briefNeedsDecisions(owner, [after]), briefNeedsDecisions(owner, [before]),
    ).length > 0,
    'needs-recheck (a new decision starts its own count)': nextRecheckCount({ at: iso(NOW), count: 3, ask: '', decision: taskDecision(before)?.id }, taskDecision(after)?.id) === 1,
    'org-follow (a stop still asking it is news)': decisionToldTo('s-vp', 'asker') !== taskDecision(after)?.key,
    'thread (a thread whose ask is reworded has news)': thread,
    'trigger watch (the watch of the ask stops counting)': watched,
  }
}

const none = (m: Record<string, boolean>) => Object.entries(m).filter(([, v]) => v).map(([k]) => k)

beforeEach(() => { minted = 0 })

describe('a reworded ask is the same decision on every path', () => {
  for (const { name, asks, numbersReplaced } of REWORDINGS) {
    if (numbersReplaced) {
      it(`${name}: other numbers unsaid are another decision`, () => {
        const first = turn(answer(asks[0]!), null, NOW - 3_600_000)
        expect(turn(answer(asks[1]!), first, NOW).ask_id).not.toBe(first.ask_id)
      })
    } else it(`${name}: the session says nothing of the decision`, () => {
      let prev = turn(answer(asks[0]!), null, NOW - 4 * 3_600_000)
      const id = prev.ask_id
      expect(id).toMatch(/^ask-/)
      for (const [i, ask] of asks.slice(1).entries()) {
        const next = turn(answer(ask), prev, NOW - (3 - i) * 3_600_000)
        expect(next.ask_id, ask).toBe(id)
        expect(none(moves(taskOf(prev), taskOf(next))), `"${prev.ask}" -> "${ask}"`).toEqual([])
        prev = next
      }
    })
    it(`${name}: the session names the decision it keeps`, () => {
      let prev = turn(answer(asks[0]!), null, NOW - 4 * 3_600_000)
      for (const ask of asks.slice(1)) {
        const next = turn(answer(ask, [`FOR_USER_ASK_ID: ${prev.ask_id}`]), prev, NOW - 3_600_000)
        expect(next.ask_id).toBe(prev.ask_id)
        // A thread has no id to name: its ask is judged by its words alone.
        const quiet = none(moves(taskOf(prev), taskOf(next))).filter((k) => !(numbersReplaced && k.startsWith('thread')))
        expect(quiet).toEqual([])
        prev = next
      }
    })
  }

  it('a re-check turn between them (Working, then the same ask again) keeps the decision', () => {
    const first = turn(answer(REWORDINGS[0]!.asks[0]!), null, NOW - 5 * 3_600_000)
    const working = turn('FOR_USER_STATE: working\nFOR_USER_NOW: checking it again', first, NOW - 4 * 3_600_000)
    expect(working.last_ask?.id).toBe(first.ask_id)
    // The status question names only a decision it still asks: after the break it shows none, so a
    // session cannot be led into asking it again (2026-11-13, turn-end-ask.ts). Named by the session, or
    // asked in words that still say the same, it keeps its id.
    expect(askDecisionQuestion(working)).toBe('')
    const said = turn(answer(REWORDINGS[0]!.asks[2]!, [`FOR_USER_ASK_ID: ${first.ask_id}`]), working, NOW - 3 * 3_600_000)
    expect(said.ask_id).toBe(first.ask_id)
    // Unsaid after a break, only words that still say the same keep it (a related new decision may follow a break).
    const unsaid = turn(answer(REWORDINGS[0]!.asks[1]!), working, NOW - 3 * 3_600_000)
    expect(unsaid.ask_id).toBe(first.ask_id)
  })

  it('a task_report_set from its lead rewording the ask keeps it', () => {
    const first = turn(answer(REWORDINGS[1]!.asks[0]!), null, NOW - 3_600_000)
    const set = stampSaidDecision(reportOfChange({ state: 'needs', ask: REWORDINGS[1]!.asks[1]!, user_kind: 'user_own', user_kind_why: 'only the user owns this account' }, 'task:lead', 'Lead', NOW), first)
    expect(set.ask_id).toBe(first.ask_id)
    expect(none(moves(taskOf(first), taskOf(set)))).toEqual([])
  })

  it('the status question shows the session its decision id', () => {
    const first = turn(answer(REWORDINGS[0]!.asks[0]!), null, NOW - 3_600_000)
    const q = askDecisionQuestion(first)
    expect(q).toContain(first.ask_id!)
    expect(q).toContain('FOR_USER_ASK_ID:')
    expect(q).toContain('FOR_USER_ASK_NEW:')
    expect(askDecisionQuestion(null)).toBe('')
  })
})

describe('what is news is still news', () => {
  const base = () => turn(answer('Approve testing on your real iPhone?', ['FOR_USER_ASK_KIND: yes-no']), null, NOW - 3_600_000)
  const changed = (before: StatusReport, after: StatusReport, extra: Partial<Task> = {}, beforeExtra: Partial<Task> = {}) => {
    const m = moves(taskOf(before, beforeExtra), taskOf(after, extra))
    // The thread and the watch compare the decision id alone: the same decision with new facts keeps them.
    return none(m).filter((k) => !k.startsWith('thread') && !k.startsWith('trigger watch'))
  }
  const ALL_FACT_PATHS = [
    'status-push (the line to the node above)', 'brief-fresh (a Brief line moved)', 'brief-fresh (the Brief reads behind)',
    'brief-hint (the node is told its Brief is behind)', 'brief-refresh (the node is woken to rewrite)',
    'brief-refresh (a Needs you change told to the user)', 'org-follow (a stop still asking it is news)',
  ]

  it('another decision, said so', () => {
    const b = base()
    const next = turn(answer('Delete the old staging database now?', ['FOR_USER_ASK_ID: new']), b, NOW)
    expect(next.ask_id).not.toBe(b.ask_id)
    expect(changed(b, next).sort()).toEqual([...ALL_FACT_PATHS, 'needs-recheck (a new decision starts its own count)'].sort())
  })
  it('another decision in words that share nothing, even unsaid', () => {
    const b = base()
    const next = turn(answer('Repaint the garden fence blue before Friday?'), b, NOW)
    expect(next.ask_id).not.toBe(b.ask_id)
  })
  // 2026-11-09 review: words that overlap are not the same decision when the target, the sign, the
  // direction or a number changed.
  for (const [from, to] of [
    ['Delete the staging database?', 'Delete the production database?'],
    ['Approve the hosting plan at $20 per month?', 'Approve the hosting plan at $200 per month?'],
    ['Move the photos from the old album to the new one?', 'Move the photos from the new album to the old one?'],
    ['Publish the draft to the club newsletter?', 'Do not publish the draft to the club newsletter?'],
    ['\u5220\u9664\u6d4b\u8bd5\u5e93\u91cc\u7684\u65e7\u7167\u7247\u5417\uff1f', '\u5220\u9664\u6b63\u5f0f\u5e93\u91cc\u7684\u65e7\u7167\u7247\u5417\uff1f'],
  ] as const) {
    it(`another decision in overlapping words, unsaid: "${to}"`, () => {
      const b = turn(answer(from), null, NOW - 3_600_000)
      const next = turn(answer(to), b, NOW)
      expect(next.ask_id).not.toBe(b.ask_id)
      expect(changed(b, next)).toContain('status-push (the line to the node above)')
    })
  }
  it('"nothing new" in any of its words is no new fact', () => {
    const b = base()
    let prev = b
    for (const word of ['none', 'nothing new', 'No change.', '\u65e0\u65b0\u60c5\u51b5', '\u6ca1\u6709', '\u6682\u65e0\u65b0\u8fdb\u5c55\u3002', '\u306a\u3057']) {
      const next = turn(answer('Approve testing on your real iPhone?', ['FOR_USER_ASK_KIND: yes-no', `FOR_USER_ASK_NEW: ${word}`]), prev, NOW)
      expect(next.ask_rev, word).toBeUndefined()
      expect(changed(prev, next), word).toEqual([])
      prev = next
    }
  })
  it('a new fact the session names', () => {
    const b = base()
    const next = turn(answer('Approve testing on your real iPhone? It must happen today.', ['FOR_USER_ASK_NEW: the release moved to today']), b, NOW)
    expect(next.ask_id).toBe(b.ask_id)
    expect(next.ask_rev).toBe(1)
    expect(changed(b, next)).toEqual(ALL_FACT_PATHS)
    // Named again (the session is shown what it named last): the same fact, no second revision.
    const again = turn(answer('Approve testing on your iPhone today?', ['FOR_USER_ASK_NEW: the release has moved to today']), next, NOW + 60_000)
    expect(again.ask_rev).toBe(1)
    expect(changed(next, again)).toEqual([])
  })
  it('other options of the same count, unsaid', () => {
    const b = turn(answer('Which plan should we buy?', ['FOR_USER_ASK_KIND: single', 'FOR_USER_ASK_OPTIONS: Basic | Standard']), null, NOW - 3_600_000)
    const next = turn(answer('Which plan should we buy now?', ['FOR_USER_ASK_KIND: single', 'FOR_USER_ASK_OPTIONS: Standard | Enterprise']), b, NOW)
    expect(next.ask_id).toBe(b.ask_id)
    expect(next.ask_rev).toBe(1)
    expect(changed(b, next)).toEqual(ALL_FACT_PATHS)
    // Several may be picked now, the same two options: another way to answer.
    const multi = turn(answer('Which plan should we buy now?', ['FOR_USER_ASK_KIND: multi', 'FOR_USER_ASK_OPTIONS: Standard | Enterprise']), next, NOW + 60_000)
    expect(changed(next, multi)).toEqual(ALL_FACT_PATHS)
    // The same options in other words are no news.
    const same = turn(answer('Which plan do we buy?', ['FOR_USER_ASK_KIND: multi', 'FOR_USER_ASK_OPTIONS: the Standard plan | the Enterprise plan']), multi, NOW + 120_000)
    expect(changed(multi, same)).toEqual([])
  })
  it('new options', () => {
    const b = turn(answer('Which phone should run the tests?', ['FOR_USER_ASK_KIND: single', 'FOR_USER_ASK_OPTIONS: your iPhone (recommended) | the simulator only']), null, NOW - 3_600_000)
    const next = turn(answer('Which phone should run the tests?', [`FOR_USER_ASK_ID: ${b.ask_id}`, 'FOR_USER_ASK_KIND: single', 'FOR_USER_ASK_OPTIONS: your iPhone (recommended) | the test iPad | the simulator only']), b, NOW)
    expect(next.ask_id).toBe(b.ask_id)
    expect(changed(b, next)).toEqual(ALL_FACT_PATHS)
  })
  // 2026-11-10, the CEO's reflection: a blog ask in the same words that only gained its answers as
  // buttons read "now asks something else" at a Brief refresh.
  it('yes and no buttons put on a question he could answer freely, or buttons taken off, are no news', () => {
    const ask = 'Approve testing on the staging cluster?'
    const b = turn(answer(ask), null, NOW - 3_600_000)
    const buttons = turn(answer(ask, ['FOR_USER_ASK_KIND: single', 'FOR_USER_ASK_OPTIONS: Yes (recommended) | No']), b, NOW)
    expect(buttons.ask_id).toBe(b.ask_id)
    expect(buttons.ask_rev).toBeUndefined()
    expect(changed(b, buttons)).toEqual([])
    const free = turn(answer(ask), buttons, NOW + 60_000)
    expect(free.ask_rev).toBeUndefined()
    expect(changed(buttons, free)).toEqual([])
  })
  // Review 2026-11-11: an option with words of its own may bring a new target.
  it('buttons with words of their own are new options, even when one starts with yes', () => {
    const b = turn(answer('Approve testing on the staging cluster?'), null, NOW - 3_600_000)
    const next = turn(answer('Approve testing on the staging cluster?', ['FOR_USER_ASK_KIND: single', 'FOR_USER_ASK_OPTIONS: Yes, run tests on the production cluster | No']), b, NOW)
    expect(next.ask_id).toBe(b.ask_id)
    expect(next.ask_rev).toBe(1)
    expect(changed(b, next)).toEqual(ALL_FACT_PATHS)
  })
  it('a new deadline', () => {
    const b = base()
    const next = turn(answer('Approve testing on your real iPhone?'), b, NOW)
    expect(changed(b, next, { due_date: '2026-11-12' }, { due_date: '2026-11-20' })).toEqual(ALL_FACT_PATHS)
  })
  it('new evidence', () => {
    const b = base()
    const next = turn(answer('Approve testing on your real iPhone? Results: https://example.com/run/42'), b, NOW)
    expect(next.ask_id).toBe(b.ask_id)
    expect(changed(b, next)).toEqual(ALL_FACT_PATHS)
  })
})

describe('an ask a lead answered for the user stays answered in other words', () => {
  // Hiding an ask needs more than keeping it quiet: the decision the session named itself, unchanged,
  // or the strict word rules (same-ask.ts answerHolds). An id Walnut kept from the words alone never
  // hides one.
  const held = (t: Task, a: AskAnswer) => answeredAbove(t.user_status!, [a], NOW).state !== 'needs'
  for (const { name, asks } of REWORDINGS) {
    it(`${name}: the session naming its decision keeps the answer`, () => {
      let prev = turn(answer(asks[0]!), null, NOW - 4 * 3_600_000)
      const a = answerTo(taskOf(prev))
      for (const ask of asks.slice(1)) {
        const next = turn(answer(ask, [`FOR_USER_ASK_ID: ${prev.ask_id}`]), prev, NOW - 3_600_000)
        expect(next.ask_said, ask).toBe(true)
        expect(held(taskOf(next), a), `"${asks[0]}" -> "${ask}"`).toBe(true)
        prev = next
      }
    })
  }
  it('the shape of 2026-11-10 holds by its words alone, with no id on either side', () => {
    const [was, now] = REWORDINGS.find((r) => r.name.startsWith('a Latin name'))!.asks
    const report = turn(answer(was!), null, NOW - 3_600_000)
    expect(answerHolds(answerTo(taskOf(report), { noId: true }), now, NOW)).toBe(true)
    // And as the task reads after the turn that reworded it, said nothing: its kept id is not enough
    // alone, its words are.
    const next = turn(answer(now!), report, NOW)
    expect(next.ask_said).toBeUndefined()
    expect(held(taskOf(next), answerTo(taskOf(report)))).toBe(true)
  })
  it('another ask of the same task sharing a word comes back, though Walnut kept its id', () => {
    const was = turn(answer('Should the deploy handler wait for the plugin rollout?'), null, NOW - 3_600_000)
    const now = turn(answer('Pick the alpha launch date for the plugin?'), was, NOW)
    expect(held(taskOf(now), answerTo(taskOf(was)))).toBe(false)
  })
  it('another decision is asked again: said new, or another target, number or sign', () => {
    const was = turn(answer('Delete the staging database now that the move is done?'), null, NOW - 3_600_000)
    const a = answerTo(taskOf(was))
    // Said new: the id differs (the strict word rules, the same words reworded, still hold it).
    const said = turn(answer('Delete the old staging database now, the move being finished?', ['FOR_USER_ASK_ID: new']), was, NOW)
    expect(said.ask_id).not.toBe(was.ask_id)
    for (const ask of [
      'Delete the production database now that the move is done?',
      'Do not delete the staging database now that the move is done?',
    ]) {
      expect(answerHolds(a, ask, NOW, { id: 'ask-other1' }), ask).toBe(false)
      expect(answerHolds({ ...a, askId: undefined }, ask, NOW), ask).toBe(false)
    }
    // Another number in its place.
    const pay = (n: string) => `Pay the $${n} deposit for the garden plot this week?`
    expect(answerHolds({ ...a, key: SAME_KEY(pay('20')), ask: pay('20'), askId: undefined }, pay('200'), NOW)).toBe(false)
    // Pointing elsewhere, in mixed script too.
    const to = (where: string) => `${'\u628a\u65e7\u6570\u636e\u8fc1\u5230'} ${where} ${'\u6570\u636e\u5e93\u5417\uff1f'}`
    expect(answerHolds({ ...a, key: SAME_KEY(to('staging')), ask: to('staging'), askId: undefined }, to('production'), NOW)).toBe(false)
  })
  // 2026-11-10, the review of the first version: each of these hid a new approval under an old answer.
  it('reordered clauses with another target, a mixed-script target, a direction swapped: asked again', () => {
    const was = turn(answer('Delete the staging database after checking the backup?'), null, NOW - 3_600_000)
    const now = turn(answer('After checking the backup, delete the production database?'), was, NOW)
    expect(held(taskOf(now), answerTo(taskOf(was)))).toBe(false)
    const project = (p: string) => `Transfer the approved backup to Project ${p} after validating checksum and retention policy?`
    const north = project('\u5317\u65b9\u751f\u4ea7\u5e93')
    expect(answerHolds({ ...answerTo(taskOf(was)), key: SAME_KEY(north), ask: north, askId: undefined }, project('\u5357\u65b9\u6d4b\u8bd5\u5e93').replace('validating checksum', 'verifying digest'), NOW)).toBe(false)
    const move = (a: string, b: string) => `Move the data from ${a} to ${b} tonight?`
    for (const [a, b] of [['Staging', 'Production'], ['X', 'Y']]) {
      expect(answerHolds({ ...answerTo(taskOf(was)), key: SAME_KEY(move(a!, b!)), ask: move(a!, b!), askId: undefined }, move(b!, a!), NOW), `${a} -> ${b}`).toBe(false)
    }
  })
  it('the session naming its decision with a new fact asks it again', () => {
    const was = turn(answer('Approve the $20 deposit for the garden plot this week?'), null, NOW - 3_600_000)
    const now = turn(answer('Approve the $200 deposit for the garden plot this week?', [`FOR_USER_ASK_ID: ${was.ask_id}`, 'FOR_USER_ASK_NEW: the deposit rose from $20 to $200']), was, NOW)
    expect(now).toMatchObject({ ask_id: was.ask_id, ask_said: true, ask_rev: 1 })
    expect(held(taskOf(now), answerTo(taskOf(was)))).toBe(false)
  })
  it('the same words with a new fact, option or deadline since the answer: asked again', () => {
    const was = turn(answer('Approve testing on your real iPhone?'), null, NOW - 3_600_000)
    const a = answerTo(taskOf(was))
    const fact = turn(answer('Approve testing on your real iPhone?', ['FOR_USER_ASK_NEW: the tests now erase every photo and reset the phone']), was, NOW)
    expect(fact.ask_rev).toBe(1)
    expect(held(taskOf(fact), a)).toBe(false)
    const due = turn(answer('Approve testing on your real iPhone?'), was, NOW)
    expect(held(taskOf(due, { due_date: '2026-11-12' }), a)).toBe(false)
    const picks = turn(answer('Approve testing on your real iPhone?', ['FOR_USER_ASK_KIND: single', 'FOR_USER_ASK_OPTIONS: Today | Tomorrow']), was, NOW)
    expect(held(taskOf(picks), a)).toBe(false)
    // Nothing new: still answered.
    expect(held(taskOf(turn(answer('Approve testing on your real iPhone?'), was, NOW)), a)).toBe(true)
  })
  it('past the hold the same words are a new decision', () => {
    const was = turn(answer('Approve testing on your real iPhone?'), null, NOW - 3_600_000)
    expect(answerHolds({ ...answerTo(taskOf(was)), at: iso(NOW - 8 * 24 * 3_600_000) }, was.ask, NOW, { id: was.ask_id!, said: true })).toBe(false)
  })
  it('an ask the user withdrew for good holds past the hold; another decision still comes back', () => {
    const was = turn(answer('Approve testing on your real iPhone?'), null, NOW - 3_600_000)
    const gone = { ...answerTo(taskOf(was)), at: iso(NOW - 30 * 24 * 3_600_000), withdrawn: true as const }
    expect(answerHolds(gone, 'Approve testing on your real iPhone?', NOW)).toBe(true)
    expect(answerHolds(gone, 'Can I run the tests on your own iPhone?', NOW, { ...taskDecision(taskOf(was))!, said: true })).toBe(true)
    expect(answerHolds(gone, 'Delete the staging database now that the move is done?', NOW)).toBe(false)
  })
  it('the user writing in the task after a withdrawal lifts it: past the hold the ask comes back', () => {
    const was = turn(answer('Approve testing on your real iPhone?'), null, NOW - 3_600_000)
    const gone = { ...answerTo(taskOf(was)), at: iso(NOW - 30 * 24 * 3_600_000), withdrawn: true as const }
    const status = taskOf(was).user_status!
    expect(answeredAbove(status, [gone], NOW).state).toBe('waiting')
    expect(answeredAbove(status, [gone], NOW, iso(NOW - 40 * 24 * 3_600_000)).state).toBe('waiting')
    expect(answeredAbove(status, [gone], NOW, iso(NOW - 3_600_000)).state).toBe('needs')
  })
  it('a withdrawal is never undone by a later plain answer, nor pushed out by plain ones', () => {
    const was = turn(answer('Approve testing on your real iPhone?'), null, NOW - 3_600_000)
    const gone = { ...answerTo(taskOf(was)), withdrawn: true as const }
    let list = keptAnswers([], gone)
    list = keptAnswers(list, { ...answerTo(taskOf(was)), text: 'fine, go' })
    for (let i = 0; i < 12; i++) list = keptAnswers(list, { ...gone, withdrawn: undefined, key: `other ${i}`, ask: `Other ask number ${i}?` })
    expect(list.filter((a) => a.withdrawn)).toEqual([gone])
    expect(list.filter((a) => !a.withdrawn)).toHaveLength(8)
    // Nor by other withdrawals: each one is kept.
    for (let i = 0; i < 12; i++) list = keptAnswers(list, { ...gone, key: `gone ${i}`, ask: `Withdrawn ask number ${i}?` })
    expect(list.filter((a) => a.withdrawn)).toHaveLength(13)
    expect(list.filter((a) => a.withdrawn)[0]).toEqual(gone)
    const later = { ...gone, at: iso(NOW - 40 * 24 * 3_600_000) }
    expect(answeredAbove(taskOf(was).user_status!, answersOf({ asks_answered: keptAnswers(list, later) }), NOW).state).toBe('waiting')
    // A plain answer to the same ask replaces the plain one before it, as it did.
    expect(keptAnswers([{ ...gone, withdrawn: undefined }], { ...gone, withdrawn: undefined, text: 'b' }).map((a) => a.text)).toEqual(['b'])
  })
  it('every place that judges an answer passes the decision, or says why words are enough there', () => {
    // A path judging an answer by its words alone ignores a new fact named since (2026-11-10 review:
    // the report gate refused a new revision of a withdrawn ask for good).
    const WORDS_ENOUGH: Record<string, string> = {
      'src/core/user-status-sync.ts': 'a teammate\'s ask folded under another task: its own status, judged with its decision, decides',
    }
    const callers = filesWith(/\banswerFor\(/).filter((f) => f !== 'src/core/same-ask.ts' && /\banswerFor\b[^;]*from '\.\/same-ask\.js'/.test(code(f)))
    expect(callers.sort()).toEqual(['src/core/same-ask-tree.ts', 'src/core/user-status-sync.ts'])
    for (const f of callers) if (!WORDS_ENOUGH[f]) expect(code(f), f).toMatch(/answerFor\([^\n]*decision/)
    // Every report writer that asks the gate hands it the decision the report will be stored with.
    for (const f of filesWith(/refuseSameAsk\([^\n]*'report'/)) expect(code(f), f).toMatch(/refuseSameAsk\([^\n]*'report'[^\n]*reportDecision\(/)
  })
  it('an answer records the decision it answered, and the status passes its decision in', () => {
    expect(code('src/core/sessions/ask-answer.ts')).toMatch(/askId: d\.id, decisionKey: d\.key/)
    expect(code('src/core/same-ask.ts')).toMatch(/answerFor\(.*derived\.ask, nowMs, \{ \.\.\.derived\.decision/)
  })
})

describe('what keeps the decision quiet survives', () => {
  it('a restart keeps the decisions a node was told', async () => {
    const os = await import('node:os')
    const { loadRiding, flushRidingForTest } = await import('../../src/core/sessions/status-riding.js')
    clearRiding()
    rideNotice('s-vp', 'asker', 'stopped', 'its turn ended', NOW, 'ask-keep|r0|d|')
    pendingRiding('s-vp', NOW)!.markTold()
    await flushRidingForTest()
    clearRiding()
    expect(decisionToldTo('s-vp', 'asker')).toBeUndefined()
    await loadRiding(NOW)
    expect(decisionToldTo('s-vp', 'asker')).toBe('ask-keep|r0|d|')
    expect(os.tmpdir()).toBeTruthy()
  })
  it('a watch armed on an ask before it had an id still counts after it is reworded', () => {
    const legacy = readStatusReport(answer(REWORDINGS[1]!.asks[0]!), new Date(NOW - 7_200_000))!
    const first = turn(answer(REWORDINGS[1]!.asks[0]!), legacy, NOW - 3_600_000)
    const reworded = turn(answer(REWORDINGS[1]!.asks[1]!), first, NOW)
    expect(reworded.ask_id).toBe(first.ask_id)
    const watch = { recheck_watch: [{ trigger: 'j1', watches: 'ask', at: iso(NOW - 7_000_000), key: SAME_KEY(legacy.ask) }] } as Pick<Task, 'recheck_watch'>
    expect(askCheckedAtOf(watch, new Map([['trigger:j1', iso(NOW - 30_000)]]), reworded.ask, reworded.ask_id, reworded.ask_legacy_key)).toBe(iso(NOW - 30_000))
  })
  it('a thread ask with another number is news; the same ask reworded is not', () => {
    const opened = openThread(emptyThreads('lead'), { title: 'Hosting', text: 'x', from: 'node', state: 'needs' }, 'human', iso(NOW - 120_000))
    const asked = updateThread(opened.file, opened.thread.id, { ask: 'Approve the hosting plan at $20 per month?' }, 'task:lead', iso(NOW - 60_000))
    expect(updateThread(asked.file, opened.thread.id, { ask: 'Approve the hosting plan at $200 per month?' }, 'task:lead', iso(NOW)).thread.updatedAt).toBe(iso(NOW))
    expect(updateThread(asked.file, opened.thread.id, { ask: 'The hosting plan at $20 per month: approve it?' }, 'task:lead', iso(NOW)).thread.updatedAt).toBe(asked.thread.updatedAt)
  })
})

// \u2500\u2500 The paths, from the source \u2500\u2500

function srcFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...srcFiles(rel))
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel)
  }
  return out
}
const FILES = [...srcFiles('src'), ...srcFiles('web/src')]
const code = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const filesWith = (re: RegExp) => FILES.filter((f) => re.test(code(f))).sort()

describe('every path that tells an ask changed compares the decision', () => {
  it('each caller of a "moved" primitive is listed with the decision check it runs', () => {
    // Who judges that a task's ask (or its status line) moved, and the check that makes it the decision.
    const PATHS: Record<string, RegExp> = {
      'src/core/sessions/status-push.ts': /askNews\(|statusDecision\(/,
      'src/core/sessions/brief-fresh.ts': /statusDecision\(/,
      'src/core/sessions/brief-refresh.ts': /briefNeedsDecisions\(/,
      // Read the one rule: brief-fresh.ts briefFreshness, which compares decisions.
      'src/core/sessions/brief-hint.ts': /briefFreshness\(/,
      'src/web/routes/brief-v1.ts': /briefFreshness\(/,
      'web/src/components/org/useBriefRefresh.ts': /briefFreshness\(/,
      'src/core/sessions/brief-write.ts': /briefSnapshot\(/,
      'src/core/sessions/needs-recheck.ts': /nextRecheckCount\(/,
      'src/core/sessions/org-follow.ts': /decisionToldTo\(/,
      'src/core/sessions/status-riding.ts': /noteToldDecision\(/,
      'src/core/org/threads-model.ts': /onlyAskReworded\(/,
      'src/core/routines/trigger-api.ts': /ask_id/,
      'src/core/user-status-sync.ts': /decisionId/,
    }
    const PRIMITIVES = /\b(statusMark|briefMark|briefLineMark|lineMoved|needsChanges|briefFreshness|briefSnapshot|seenOf|rideNotice|rideLine|nextRecheckCount|updateThread|askCheckedAtOf|recordWatch)\(/
    const callers = filesWith(PRIMITIVES).filter((f) => !Object.hasOwn(PATHS, f))
    const READ_ONLY: Record<string, string> = {
      'src/core/org/threads-store.ts': 'writes the threads file through updateThread, which keeps a reworded ask quiet',
      'src/core/sessions/session-request-notify.ts': 'rides a line about a handed-on request, no ask of the user',
      'src/core/sessions/reply-handoff.ts': 'rides a line about a reply that went past it, no ask of the user',
      'src/core/sessions/safeguard-switch.ts': 'rides one line telling the lead its task moved to another model, no ask of the user',
      'src/core/org/team-note.ts': 'rides the team note: the user\'s messages to the team, not a task\'s ask of the user',
      'src/core/sessions/task-watch.ts': 'a watch its watcher set: it asked for the status when it runs out, moved or not',
      'src/integrations/mail/store.ts': 'its own seenOf: a mail message\'s read flag',
    }
    const unlisted = callers.filter((f) => !Object.hasOwn(READ_ONLY, f))
    expect(unlisted, 'a new caller of a primitive that judges an ask moved: compare the decision (ask-decision.ts) and list it in PATHS, or say in READ_ONLY why it tells no ask change').toEqual([])
    for (const [f, re] of Object.entries(PATHS)) expect(code(f), f).toMatch(re)
  })

  it('every file that compares ask WORDS says why words are right there', () => {
    const WORDS = /\b(sameAskReworded|sameAskShape|askShape|sameAskText|askKey|askIsPartOf|answerHolds|findSameAsk)\(/
    const ALLOWED: Record<string, string> = {
      'src/core/same-ask.ts': 'the word tests themselves',
      'src/core/ask-decision.ts': 'keeps the id when the session said nothing and the words still say the same',
      'src/core/same-ask-tree.ts': 'two TASKS asking the same: each has its own decision, so only the words can tell (a refusal names the other task, it hides nothing)',
      'src/core/user-status-sync.ts': 'the fold between two tasks (stillAsks) and a watch armed before decisions existed',
      'src/core/sessions/ask-withdraw.ts': 'an answer taken back is found by the words it answered, and the report still asking it by the same words',
      'src/core/sessions/ask-answer.ts': 'an answer from above recorded against the words it answered',
      'src/core/sessions/report-set.ts': 'a report from before decisions existed: the decision is compared first',
      'src/core/sessions/brief-fresh.ts': 'a Brief line stored before decisions existed (the n1 mark): new marks keep the decision',
      'src/core/sessions/brief-refresh.ts': 'an ask told before decisions existed: two decisions are compared by key',
      'src/core/routines/trigger-api.ts': 'a watch armed on an ask with no decision id',
      'src/core/org/team-asks.ts': 'the user\'s and peers\' messages into a team, not a task\'s ask of the user',
      'src/core/org/team-note.ts': 'the user\'s and peers\' messages into a team, not a task\'s ask of the user',
    }
    const users = filesWith(WORDS)
    expect(users.filter((f) => !Object.hasOwn(ALLOWED, f)), 'a new comparison of ask words: compare the decision (ask-decision.ts taskDecision, decisionMoved) instead, or list it here with why the words are right').toEqual([])
  })

  it('the user\'s words since the ask are checked on any reworded ask, whatever its decision', () => {
    // 2026-11-09 review: a lead rewording "staging" into "production" after the user wrote "never
    // touch production" kept the id and skipped the check. The id only keeps a rewording quiet.
    const set = code('src/core/sessions/report-set.ts')
    const gate = set.match(/if \('ask' in open[^\n]*/)?.[0] ?? ''
    expect(gate).toMatch(/askKey\(report\.ask\) === askKey\(open\.ask\)/)
    expect(gate).not.toMatch(/ask_id|decision/i)
  })

  it('every writer of a task\'s report stamps the decision', () => {
    // The server's writers (the web's own task list merges what the server sent).
    const writers = filesWith(/[{,]\s*status_report\s*:/).filter((f) => f.startsWith('src/'))
    expect(writers).toEqual(['src/core/router/processing.ts', 'src/core/sessions/report-set.ts', 'src/core/sessions/status-question.ts'])
    for (const f of writers) expect(code(f), `${f}: run stampSaidDecision before storing`).toMatch(/stampSaidDecision\(/)
  })

  it('the status lines carry the decision both ways', () => {
    const builtins = code('src/core/session-hooks/builtins.ts')
    expect(builtins).toMatch(/'FOR_USER_ASK_ID', 'FOR_USER_ASK_NEW'/)
    expect(builtins).toMatch(/read\('FOR_USER_ASK_ID'\)/)
    // Both the status question and the summary path ask through sameAskQuestionFor, which leads with it.
    expect(code('src/core/same-ask-tree.ts')).toMatch(/export async function sameAskQuestionFor[\s\S]*?askDecisionQuestion\(/)
    expect(code('src/ops/tasks.ts')).toMatch(/ask_id: z\.string\(\)/)
  })
})

/**
 * The four asks Main's 2026-11-10 Brief refresh told as "now asks something else" (the CEO's
 * reflection that day), replayed in their shapes with invented subjects. Read at the source: one
 * only gained buttons (no news at all now), two kept their decision with a fact the session named
 * (new drafts with other picks; a deadline in the proposed message moved), one asked another question.
 * The refresh tells each as what it is: nothing, the new fact alone, or another decision.
 */
describe('the 2026-11-10 refresh, replayed', () => {
  const told = (before: StatusReport, after: StatusReport) => {
    const owner = lead()
    const was = taskOf(before)
    const is = taskOf(after)
    const changes = needsChanges(briefNeedsAsks(owner, [is]), briefNeedsAsks(owner, [was]), briefNeedsDecisions(owner, [is]), briefNeedsDecisions(owner, [was]))
    const body = refreshBody(owner, { writtenAt: iso(NOW - 3_600_000), moved: [], finished: [], newAsks: [], stale: true }, [is], NOW, changes)
    return { kinds: changes.map((c) => c.kind), body }
  }
  it('a question that gained its answers as buttons: the same ask, with its new options', () => {
    const ask = 'Blog note one (first person): add an "I" paragraph only at the start and the end, keep "we" elsewhere: is that the right amount?'
    const b = turn(answer(ask), null, NOW - 4 * 3_600_000)
    const next = turn(answer(ask, ['FOR_USER_ASK_KIND: single', 'FOR_USER_ASK_OPTIONS: yes, only two places | the whole start as "I" | none, keep "we"']), b, NOW)
    expect(next.ask_id).toBe(b.ask_id)
    const { kinds, body } = told(b, next)
    expect(kinds).toEqual(['fact'])
    expect(body).toContain('the same ask, with a new fact: "new options: yes, only two places')
    expect(body).not.toContain('now asks another decision')
  })
  // Review 2026-11-11: a fact told at an earlier revision is never told again as this change's.
  it('only the deadline moved after a fact was told: the deadline is the news, never the old fact', () => {
    const b = turn(answer('Send the reminder to the supplier?', ['FOR_USER_ASK_NEW: two new drafts are ready']), turn(answer('Send the reminder to the supplier?'), null, NOW - 5 * 3_600_000), NOW - 4 * 3_600_000)
    expect(b.ask_rev).toBe(1)
    const next = turn(answer('Send the reminder to the supplier now?'), b, NOW)
    const owner = lead()
    const was = taskOf(b, { due_date: '2026-11-13' })
    const is = taskOf(next, { due_date: '2026-11-24' })
    const changes = needsChanges(briefNeedsAsks(owner, [is]), briefNeedsAsks(owner, [was]), briefNeedsDecisions(owner, [is]), briefNeedsDecisions(owner, [was]))
    expect(changes.map((c) => c.kind)).toEqual(['fact'])
    const body = refreshBody(owner, { writtenAt: iso(NOW - 3_600_000), moved: [], finished: [], newAsks: [], stale: true }, [is], NOW, changes)
    expect(body).toContain('its deadline is now 2026-11-24')
    expect(body).not.toContain('two new drafts are ready')
  })
  it("a day's new batch with other picks, named by the session: the same ask with that fact", () => {
    const b = turn(answer('Today\'s 10 drafts are in the outreach chat: post the recommended first and sixth?'), null, NOW - 12 * 3_600_000)
    const next = turn(answer('Today\'s 10 drafts are in the outreach chat: post the recommended first (a forum comment) and second?', ['FOR_USER_ASK_NEW: a new batch of 10 today; the top picks are now the first and the second']), b, NOW)
    expect(next.ask_id).toBe(b.ask_id)
    const { kinds, body } = told(b, next)
    expect(kinds).toEqual(['fact'])
    expect(body).toContain('the same ask, with a new fact: "a new batch of 10 today; the top picks are now the first and the second"')
    expect(body).not.toContain('now asks another decision')
  })
  it('a deadline in the proposed message moved, named by the session: the same ask with that fact', () => {
    const b = turn(answer('Send the reminder to the supplier in your name, asking for a written quote by 11/13? Recommended.'), null, NOW - 12 * 3_600_000)
    const next = turn(answer('Send the reminder to the supplier in your name now, asking for a written quote by 11/24? Recommended.', [`FOR_USER_ASK_ID: ${b.ask_id}`, 'FOR_USER_ASK_NEW: the reply date moved from 11/13 to 11/24, the old one was three days out']), b, NOW)
    expect(next.ask_id).toBe(b.ask_id)
    const { kinds, body } = told(b, next)
    expect(kinds).toEqual(['fact'])
    expect(body).toContain('the reply date moved from 11/13 to 11/24')
  })
  it('another question about the same machine: another decision', () => {
    const b = turn(answer('Once home, allow the read-only chat task read, write and run rights, and click the Windows prompt once more?'), null, NOW - 12 * 3_600_000)
    const next = turn(answer('Can you see that Windows computer\'s screen right now?', ['FOR_USER_ASK_ID: new']), b, NOW)
    expect(next.ask_id).not.toBe(b.ask_id)
    const { kinds, body } = told(b, next)
    expect(kinds).toEqual(['changed'])
    expect(body).toContain('now asks another decision')
  })
  it('the same decision reworded is never told at all', () => {
    for (const { asks, numbersReplaced } of REWORDINGS) {
      if (numbersReplaced || asks.length < 2) continue
      const b = turn(answer(asks[0]!), null, NOW - 3_600_000)
      expect(told(b, turn(answer(asks[1]!), b, NOW)).kinds, asks[1]).toEqual([])
    }
  })
})
