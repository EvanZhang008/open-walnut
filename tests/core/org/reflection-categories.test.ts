/**
 * One replay case per finding kind (src/core/org/reflection/judge.ts FINDING_KINDS), built from the
 * shapes the user had to point out himself on 2026-11-20 (paraphrased, invented names): each runs
 * through the real candidate stage (candidates.ts, signals.ts) and the pipeline with a fake judge,
 * and must come out a candidate of the right signal and a day record that names the rule it became
 * and the task its correction went to. The ratchet at the end fails when a kind has no case.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reflection-categories'))

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import { reflectForNode, type ReflectDeps } from '../../../src/core/org/reflection/pipeline.js'
import type { ReflectionThread } from '../../../src/core/org/reflection/candidates.js'
import { FINDING_KINDS, type FindingKind } from '../../../src/core/org/reflection/judge.js'
import { REFLECTION_SIGNALS, type ReflectionSignal } from '../../../src/core/org/reflection/signals.js'
import { readDayEntries, reflectionDayFileOf } from '../../../src/core/org/reflection/records.js'
import { localDate, updateReflectionState } from '../../../src/core/org/reflection/state.js'

const NOW = Date.parse('2026-11-20T20:00:00Z')
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()

const vp = { id: 'vp-lagoon', title: 'Lagoon VP', project: 'Lagoon', org_role: 'lead', phase: 'IN_PROGRESS', session_id: 'sess-vp' } as Task
const worker = { id: 'w-pier', title: 'Rebuild the pier page', project: 'Lagoon', phase: 'IN_PROGRESS', session_id: 'sess-pier' } as Task
const RULES = '## USER.md\n- Run the scan before every push.'
const CHINESE_SETTING = 'Talk to the user in Chinese; code, commits and UI strings stay English.'
const ENGLISH_ANSWER = 'I looked at the pier page again and the layout now loads the dock list first, then the boats, then the schedule. '
  + 'The slow part was the schedule request, which waited for the boats. I moved it to start at the same time and the page is ready about a second sooner now.'

/** Where the user said it: one of his messages to an ordinary task, a message in the VP's Threads, an ask in Needs you, or many rounds. */
interface ReplayCase {
  kind: FindingKind
  signal: ReflectionSignal
  where: 'task' | 'thread' | 'needs' | 'rounds'
  /** His message (a card answer included); the ask for 'needs'. */
  text: string
  /** What the agent said just before. */
  before: string
  sessionQuote: string
  userQuote: string
  ruleQuote?: string
}

const CASES: ReplayCase[] = [
  { kind: 'question_not_for_user', signal: 'needs_ask', where: 'needs',
    text: 'Should I write the description of the second pull request before publishing it?',
    before: 'Both pull requests are ready.', sessionQuote: 'write the description of the second pull request', userQuote: 'yes, publish both pull requests' },
  { kind: 'question_not_for_user', signal: 'not_for_user', where: 'thread',
    text: 'Answer to "Should I also turn on the nightly export?": already did, do it yourself',
    before: 'Should I also turn on the nightly export?', sessionQuote: 'turn on the nightly export', userQuote: 'already did' },
  { kind: 'unclear_ask', signal: 'unclear_ask', where: 'thread',
    text: 'Answer to "Is this place fine for the sign-in entry?": what are you talking about',
    before: 'Is this place fine for the sign-in entry?', sessionQuote: 'Is this place fine', userQuote: 'what are you talking about' },
  { kind: 'unreviewed_design', signal: 'unreviewed_design', where: 'thread',
    text: 'The design needs to be reviewed at least once, the buttons overlap the menu icon',
    before: 'Here is option A for the top bar.', sessionQuote: 'option A for the top bar', userQuote: 'reviewed at least once' },
  { kind: 'hack_to_avoid_change', signal: 'frustration', where: 'task',
    text: 'This is stupid, do not patch around it.', before: 'I added a retry around the flaky call so the test passes.',
    sessionQuote: 'I added a retry around the flaky call', userQuote: 'do not patch around it' },
  { kind: 'change_too_big_excuse', signal: 'frustration', where: 'thread',
    text: 'Why did you keep the old version? Move it properly.', before: 'Moving to the new version touches six modules, too big for now.',
    sessionQuote: 'touches six modules, too big for now', userQuote: 'Move it properly' },
  { kind: 'broke_user_rule', signal: 'frustration', where: 'task',
    text: 'I told you to run the scan first.', before: 'Pushed the branch; the scan can run later.',
    sessionQuote: 'the scan can run later', userQuote: 'run the scan first', ruleQuote: 'Run the scan before every push.' },
  { kind: 'unchecked_claim', signal: 'frustration', where: 'thread',
    text: 'wtf, it is not fixed at all, nobody looked at the page', before: 'The pier bug is fixed and deployed.',
    sessionQuote: 'The pier bug is fixed and deployed.', userQuote: 'it is not fixed at all' },
  { kind: 'decided_differently', signal: 'overruled', where: 'task',
    text: 'Answer to "Which one do you want: the old layout or the new one? I recommend the old one.": No, the new one.',
    before: 'Both layouts build.', sessionQuote: 'I recommend the old one.', userQuote: 'No, the new one.' },
  { kind: 'too_many_rounds', signal: 'many_rounds', where: 'rounds',
    text: '', before: 'The build stopped on the second host for a reason I am still reading.',
    sessionQuote: 'for a reason I am still reading', userQuote: 'what do you mean by that' },
  { kind: 'risky_retry', signal: 'frustration', where: 'task',
    text: 'Why did you try the sign-in four times on my real account?', before: 'The sign-in failed, so I tried again with the saved login.',
    sessionQuote: 'so I tried again with the saved login', userQuote: 'four times on my real account' },
  { kind: 'regression', signal: 'regression', where: 'thread',
    text: 'The reply under the card used to show, now it is gone.', before: 'Shipped the new card layout.',
    sessionQuote: 'Shipped the new card layout.', userQuote: 'The reply under the card used to show' },
  { kind: 'built_different', signal: 'built_different', where: 'thread',
    text: 'Not what I asked: I wanted one simple status, it shows two labels.', before: 'The status now has a To read label and a Known label.',
    sessionQuote: 'a To read label and a Known label', userQuote: 'I wanted one simple status' },
  { kind: 'approved_for_user', signal: 'built_different', where: 'task',
    text: 'I never approved that design, who said yes in my name?', before: 'The design was agreed, so I shipped it.',
    sessionQuote: 'The design was agreed, so I shipped it.', userQuote: 'I never approved that design' },
  { kind: 'duplicate_display', signal: 'duplicate_display', where: 'thread',
    text: 'The same lead shows three times in the member list.', before: 'The member list now groups people by team.',
    sessionQuote: 'groups people by team', userQuote: 'shows three times in the member list' },
  { kind: 'wrong_language', signal: 'wrong_language', where: 'thread',
    text: 'How is the pier page?', before: 'On it.', sessionQuote: ENGLISH_ANSWER.slice(0, 40), userQuote: '' },
]

const THREAD_TITLE = 'Pier page'

function threadsOf(c: ReplayCase): ReflectionThread[] {
  if (c.where !== 'thread' && c.where !== 'needs') return []
  const messages = c.where === 'needs'
    // His yes, in his lead's thread, before the task asked again.
    ? [{ id: 'tm-aa0001', at: iso(300), text: 'yes, publish both pull requests', answer: { text: 'Publishing both.', at: iso(299) } }]
    : [
        { id: 'tm-aa0001', at: iso(40), text: 'please work on the pier page', answer: { text: c.before, at: iso(35) } },
        { id: 'tm-aa0002', at: iso(30), text: c.text, sid: 'sess-vp', answer: { text: c.kind === 'wrong_language' ? ENGLISH_ANSWER : 'Looking into it.', at: iso(28) } },
      ]
  // A needs ask reads only the threads that went to its task.
  return [{ id: 'th-aa0001', title: THREAD_TITLE, messages, ...(c.where === 'needs' ? { tasks: [worker.id] } : {}) }]
}

function deps(c: ReplayCase) {
  const calls: string[] = []
  const sent: Array<{ task: string; text: string }> = []
  const rounds = ['so where is it now', 'what do you mean by that', 'wait, which host', 'ok', 'and the logs', 'thanks']
  const messages = c.where === 'task' ? [{ id: 'm1', at: iso(30), text: c.text }]
    : c.where === 'rounds' ? rounds.map((text, i) => ({ id: `r${i}`, at: iso(200 - i * 10), text })) : []
  const d: ReflectDeps = {
    readTranscript: async () => [
      { role: 'assistant', text: c.before, timestamp: iso(c.where === 'rounds' ? 205 : 35) },
      ...messages.map((m) => ({ role: 'user', text: m.text, timestamp: m.at, sentBy: 'person' })),
      { role: 'assistant', text: 'Looking into it.', timestamp: iso(25) },
    ] as never,
    readMessages: async (taskId) => (taskId === worker.id ? messages : []),
    readThreads: async (taskId) => (taskId === vp.id ? threadsOf(c) : []),
    callModel: async (_s, user) => {
      calls.push(user)
      return JSON.stringify({ verdict: 'bad_decision', why: 'x', finding: {
        kind: c.kind, session_quote: c.sessionQuote, user_quote: c.userQuote, rule_quote: c.ruleQuote ?? '',
        what_went_wrong: `The ${c.kind} case went wrong.`, correct_action: 'Do it the right way.', already_fixed: false,
        correction: 'Do it the right way now.', guidance: `A general rule against ${c.kind.replace(/_/g, ' ')}.`, same_as: 0, skill: null,
      } })
    },
    send: async (task, text) => { sent.push({ task: task.id, text }); return true },
    confirmSend: async () => true,
    rulesText: async () => RULES,
    replyLanguage: async () => (c.kind === 'wrong_language' ? CHINESE_SETTING : null),
    nowMs: () => NOW,
  }
  return { d, calls, sent }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await updateReflectionState(vp.id, (s) => { s.since = iso(600) }, NOW)
})

describe('reflection replay: one case per kind', () => {
  for (const c of CASES) {
    it(`${c.kind}: a ${c.signal} candidate whose record names its rule and task`, async () => {
      const asking = c.where === 'needs'
        ? { ...worker, user_status: { state: 'needs', source: 'session', at: iso(20), ask: c.text, askSessionId: 'sess-pier', decision: { id: 'ask-pier01', key: 'k' } } } as unknown as Task
        : worker
      const { d, calls, sent } = deps(c)
      const r = await reflectForNode(vp, 'Lagoon VP', [vp, asking], d)
      const hit = r.findings.find((f) => f.candidate.signal === c.signal)
      expect(hit, `no ${c.signal} candidate; got ${r.findings.map((f) => f.candidate.signal).join(', ')}`).toBeDefined()
      expect(hit!.verdict.verdict).toBe('bad_decision')
      expect(hit!.entry?.finding.kind).toBe(c.kind)
      // A thread message's correction goes to the task that owns the thread: the VP.
      const owner = c.where === 'thread' ? vp : worker
      expect(hit!.entry?.handedTo).toEqual({ taskId: owner.id, title: owner.title })
      expect(sent.map((s) => s.task)).toContain(owner.id)
      const entries = await readDayEntries(vp.id, localDate(NOW))
      const entry = entries?.find((e) => e.finding.kind === c.kind)
      expect(entry?.rule.kind).toBe('guidance')
      expect(entry?.rule.line).toBe(1)
      const day = await fs.readFile(reflectionDayFileOf(vp.id, localDate(NOW)), 'utf-8')
      expect(day).toContain(`Kind: ${c.kind}.`)
      expect(day).toContain(`- Handed to: ${owner.title} (${owner.id})`)
      expect(day).toMatch(/- Rule: guidance line 1: /)
      if (c.kind === 'wrong_language') {
        // Deterministic: no judge call, the fixed reply-language rule, the setting quoted.
        expect(calls).toHaveLength(0)
        expect(entry?.finding.rule_quote).toBe(CHINESE_SETTING)
        expect(entry?.thread).toEqual({ id: 'th-aa0001', title: THREAD_TITLE })
      } else {
        expect(calls.length).toBeGreaterThan(0)
        if (c.where === 'thread') expect(calls[0]).toContain(`THREAD: ${THREAD_TITLE}`)
        if (c.where === 'needs') {
          expect(calls[0]).toContain('THE ASK')
          expect(calls[0]).toContain('yes, publish both pull requests')
        }
      }
      // A defect of the product tells the task it owns the fix or hands it on.
      if (['regression', 'built_different', 'duplicate_display'].includes(c.kind)) {
        expect(sent.find((s) => s.task === owner.id)?.text).toContain('defect of the product')
      }
    })
  }
})

describe('reflection replay: what is not a candidate', () => {
  it('reads a card answer as his words only: the ask\'s words are the agent\'s', async () => {
    const c: ReplayCase = { kind: 'other', signal: 'frustration', where: 'task', text: 'Answer to "Why did the deploy break again?": yes, go ahead', before: 'x', sessionQuote: 'x', userQuote: 'x' }
    const { d, calls } = deps(c)
    const r = await reflectForNode(vp, 'Lagoon VP', [vp, worker], d)
    expect(r.candidates).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('checks no language when the reply-language setting is unset', async () => {
    const c = CASES.find((x) => x.kind === 'wrong_language')!
    const { d } = deps(c)
    d.replyLanguage = async () => null
    expect((await reflectForNode(vp, 'Lagoon VP', [vp, worker], d)).candidates).toBe(0)
  })

  it('lets Main read the threads of the leads in its team', async () => {
    const main = { id: 'main-1', title: 'Main', org_role: 'main', phase: 'IN_PROGRESS', session_id: 'sess-main' } as Task
    await updateReflectionState(main.id, (s) => { s.since = iso(600) }, NOW)
    const c = CASES.find((x) => x.kind === 'regression')!
    const { d, sent } = deps(c)
    const r = await reflectForNode(main, 'Main', [main, vp, worker], d)
    expect(r.findings.map((f) => f.candidate.signal)).toContain('regression')
    expect(sent.map((s) => s.task)).toContain(vp.id)
  })
})

describe('ratchet', () => {
  it('every finding kind but other has a replay case', () => {
    const covered = new Set(CASES.map((c) => c.kind))
    expect(FINDING_KINDS.filter((k) => k !== 'other' && !covered.has(k))).toEqual([])
  })

  it('every signal has a replay case', () => {
    const covered = new Set(CASES.map((c) => c.signal))
    expect(REFLECTION_SIGNALS.filter((s) => !covered.has(s))).toEqual([])
  })
})
