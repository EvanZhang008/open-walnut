/**
 * Every door an agent's ask reaches the user through runs the same clarity check
 * (src/core/org/ask-clarity.ts; 2026-11-21, the user: "I think you write it well, but the ones below
 * do not"). The explicit ops (threads, letters, task_report_set) ran it already; the doors the
 * workers use did not: their turn-end FOR_USER_ASK lines, an AskUserQuestion prompt, a new Board
 * choice. The last block is the class guard: a new door that hands agent words to the user as an
 * ask, and runs no check, fails it.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { askClarityRefusal, askUserQuestionRefusal, boardChoiceRefusal, turnEndAskRefusal } from '../../../src/core/org/ask-clarity.js'
import { unclearNewChoice } from '../../../src/core/boards/choice-same-ask.js'
import { FOR_USER_PROMPT } from '../../../src/core/session-hooks/builtins.js'
import { unclearAskRetry } from '../../../src/core/sessions/unclear-ask.js'
import { __resetUnclearAsk, askCardText, judgeAskCard, setAskJudgeOverride, turnEndAskProblem, unclearUserQuestion } from '../../../src/core/sessions/unclear-ask.js'

// The worker cards the user could not read, as test data (escaped): "Put it in this position, ok?",
// "Put it here, ship", "Go ahead with this plan? I recommend it.".
const HERE_Q = '放这个位置行吗？'
const HERE_BTN = '放这里，上线'
const BARE = '要不要按这个方案做？我建议做。'
const PIC = 'Mockup: /home/user/.local/state/walnut/tasks/t1/wifi.png'
const REVIEW = 'Reviewed: sol, function 8/10, experience 8/10, interface 7/10'

describe('the turn-end ask lines', () => {
  const needs = (ask: string, ask_more = '', labels: string[] = []) => turnEndAskRefusal({ state: 'needs', ask, ask_more, ask_options: labels.map((label) => ({ label })) })

  it('refuses the cards as they were', () => {
    expect(needs(HERE_Q, '', [HERE_BTN, 'Keep it in Settings only'])).toMatch(/only you can see/)
    expect(needs(BARE)).toMatch(/names nothing/)
    expect(needs('Ship the release notes to the blog?', '', ['OK', 'Hold them'])).toMatch(/says nothing on its own/)
    expect(needs('Approve the design? See the plan page.', '', ['Build it', 'Skip it'])).toMatch(/plan or design page with no path/)
    expect(needs('Where should the export button go?')).toMatch(/carries no picture/)
  })

  it('a picture needs its review named in the text', () => {
    const ask = 'Show the Wi-Fi sign-in entry as a row under All devices?'
    expect(needs(ask, PIC, ['Show it under All devices', 'Keep it in Settings only'])).toMatch(/no review on record/)
    expect(needs(ask, `${PIC} ${REVIEW}`, ['Show it under All devices', 'Keep it in Settings only'])).toBeNull()
    expect(needs(ask, `${PIC} small: only the label text changed`, ['Show it under All devices', 'Keep it in Settings only'])).toBeNull()
  })

  it('leaves clear asks and every other state alone', () => {
    expect(needs('Buy the yearly plan for $96?')).toBeNull()
    expect(needs('Approve testing on your real iPhone?')).toBeNull()
    expect(turnEndAskRefusal({ state: 'working', ask: HERE_Q })).toBeNull()
    expect(turnEndAskRefusal({ state: 'needs' })).toBeNull()
  })

  it('the retry names the reason and asks every line again', () => {
    const q = unclearAskRetry('PROMPT', 'Not sent to the user: X.')
    expect(q).toMatch(/^PROMPT\n\nYour FOR_USER_ASK was not shown to the user\. Not sent to the user: X\. Answer every line again/)
  })

  it('the prompt the workers answer carries the writing rules', () => {
    const line = (label: string) => FOR_USER_PROMPT.split('\n').find((l) => l.startsWith(`${label}:`)) ?? ''
    expect(line('FOR_USER_ASK')).toMatch(/read on its own to someone who never saw this task.*what the thing is and what you recommend.*never "here", "this" or "this plan"/)
    expect(line('FOR_USER_ASK_OPTIONS')).toMatch(/naming its result.*never "OK"/)
    expect(line('FOR_USER_ASK_MORE')).toMatch(/screenshot or design page by absolute path.*Reviewed: <model>, function N\/10, experience N\/10, interface N\/10/)
  })
})

describe('an AskUserQuestion prompt', () => {
  const ask = (question: string, labels: string[], description = '') => ({ questions: [{ question, header: 'Wi-Fi', multiSelect: false, options: labels.map((label) => ({ label, description })) }] })

  it('is sent back once with the reason, and asked again unchanged it goes to the user', () => {
    __resetUnclearAsk()
    expect(askUserQuestionRefusal(ask(HERE_Q, [HERE_BTN, 'Keep it in Settings only']))).toMatch(/only you can see/)
    expect(askUserQuestionRefusal(ask('Ship the notes to the blog?', ['OK', 'Hold them']))).toMatch(/says nothing/)
    expect(askUserQuestionRefusal(ask('Which retry policy: 3 tries or 5 tries?', ['3 tries', '5 tries']))).toBeNull()
    const q = ask(HERE_Q, [HERE_BTN, 'Keep it'])
    expect(unclearUserQuestion('s-1', q)).toMatch(/only you can see.*asked again, it goes to the user as it is/)
    expect(unclearUserQuestion('s-1', q)).toBeNull()
    // Reworded but still unclear: sent back once per session in ten minutes, never in a loop.
    expect(unclearUserQuestion('s-1', ask('Put it here, ok?', ['OK', 'No']))).toBeNull()
    // Another session's same question is its own first time.
    expect(unclearUserQuestion('s-2', q)).toMatch(/only you can see/)
    expect(unclearUserQuestion('s-1', ask('Which retry policy: 3 tries or 5 tries?', ['3 tries', '5 tries']))).toBeNull()
  })

  it('reads every question and a picture in an option preview', () => {
    const two = { questions: [ask('Which retry policy: 3 or 5?', ['3 tries', '5 tries']).questions[0], ask('Ship the notes?', ['Go', 'Hold them']).questions[0]] }
    expect(askUserQuestionRefusal(two)).toMatch(/"Go"/)
    expect(askUserQuestionRefusal(ask('Title bar: A or B?', ['Ship title bar A', 'Ship title bar B'], PIC))).toMatch(/no review on record/)
    expect(askUserQuestionRefusal(ask(`Title bar: A or B? ${REVIEW}`, ['Ship title bar A', 'Ship title bar B'], PIC))).toBeNull()
    expect(askUserQuestionRefusal(null)).toBeNull()
  })
})

describe('a new Board choice', () => {
  const choice = (id: string, title: string, options: string) => `<walnut-choice id="${id}" title="${title}" options="${options}"></walnut-choice>`

  it('is refused when it points, names nothing, or offers vague options', () => {
    expect(boardChoiceRefusal('Put it here, ok?', ['Ship it under All devices', 'Keep it in Settings'])).toMatch(/only you can see/)
    expect(boardChoiceRefusal(BARE, ['Build it', 'Skip it'])).toMatch(/names nothing/)
    expect(boardChoiceRefusal('Ship the notes to the blog?', ['OK', 'Hold them'])).toMatch(/says nothing/)
    expect(boardChoiceRefusal('Keep notes in the vault or beside the code?', ['In the vault', 'Beside the code'])).toBeNull()
  })

  it('only a new choice is checked: one already on the Board is never asked again', () => {
    const old = choice('c1', 'Put it here, ok?', 'a:OK|b:No')
    expect(unclearNewChoice(undefined, old)).toMatch(/^Choice "c1": /)
    expect(unclearNewChoice(old, old)).toBeNull()
    expect(unclearNewChoice(old, old + choice('c2', 'Keep notes in the vault or beside the code?', 'v:In the vault|r:Beside the code'))).toBeNull()
  })
})

describe('the explicit doors refuse the same cards (one check for all)', () => {
  it('a bare first line and a plan page with no path', () => {
    expect(askClarityRefusal(BARE, '', ['Build it', 'Skip it'])).toMatch(/names nothing/)
    expect(askClarityRefusal('Store passkeys in the extension? See the plan page.', '', ['Build it', 'Skip it'])).toMatch(/no path/)
    expect(askClarityRefusal('Store passkeys in the extension? Plan: /home/user/plan.txt', '', ['Build it', 'Skip it'])).toBeNull()
  })
})

describe('the fast model reads the ask as a newcomer (turn-end ask)', () => {
  const report = (ask: string, ask_more = '') => ({ state: 'needs' as const, at: '2026-11-21T09:00:00.000Z', ask, ask_more })
  // The worker card of 2026-11-21 the words alone let through (as test data, escaped): "In the
  // Browser view click Take over, confirm with Touch ID, then click Done, ok?"
  const GOOGLE = '\u5728 Browser \u89c6\u56fe\u70b9 Take over\uff0c\u6309 Touch ID \u5b8c\u6210 Google \u9a8c\u8bc1\uff0c\u518d\u70b9 Done\uff0c\u597d\u5417\uff1f'

  it('its fixes go back to the session; PASS, an error or an answer with no fix lines pass', async () => {
    let seen = ''
    setAskJudgeOverride(async (card) => { seen = card; return '- Say what the Browser view is and attach a screenshot of the Take over button' })
    try {
      expect(await turnEndAskProblem(report(GOOGLE, 'Google keeps 293 old passwords'))).toMatch(/could not answer it from the card\. Fix: - Say what the Browser view is/)
      expect(seen).toBe(askCardText(report(GOOGLE, 'Google keeps 293 old passwords')))
      // The same ask already stored is not judged again (a quiet turn asks the same).
      expect(await turnEndAskProblem(report(GOOGLE), GOOGLE)).toBeNull()
      setAskJudgeOverride(async () => 'PASS')
      expect(await turnEndAskProblem(report('Restart the Mac now to finish the update? It takes 5 minutes.'))).toBeNull()
      setAskJudgeOverride(async () => { throw new Error('no model') })
      expect(await judgeAskCard('Question: x')).toBeNull()
      setAskJudgeOverride(async () => 'It looks fine to me.')
      expect(await judgeAskCard('Question: x')).toBeNull()
    } finally { setAskJudgeOverride(null) }
  })

  it('the words check runs first and needs no model', async () => {
    setAskJudgeOverride(async () => { throw new Error('must not be called') })
    try { expect(await turnEndAskProblem(report(HERE_Q))).toMatch(/only you can see/) } finally { setAskJudgeOverride(null) }
  })
})

describe('ordinary asks still go (review of 2026-11-21)', () => {
  it('a bank card, an interview panel, a doc still to write, "OK." before the question, his own thread title', () => {
    for (const q of [
      'Put the $96 renewal on the Visa card ending 1234?',
      'Move the interview panel with Alex to Thursday 3pm?',
      'Which credit card should I put the hotel on?',
      'Write a design doc first, or start coding the sync fix?',
      'OK. Merge PR 12 for the sync fix?',
      'OK to merge?',
      'Should we ship v2 to the beta channel?',
      'Approve the design doc https://example.com/doc?',
    ]) expect(askClarityRefusal(q, '', ['Do the first', 'Do the second']), q).toBeNull()
    // Still refused: a screen place with no picture.
    expect(askClarityRefusal('Move the export button to the toolbar?')).toMatch(/carries no picture/)
    expect(askClarityRefusal('Go ahead?', '', [], '', { ownWords: 'Ship the sync fix to the beta channel?' })).toBeNull()
  })
})

describe('class guard: every door that hands agent words to the user as an ask runs the check', () => {
  const SRC = path.resolve(__dirname, '../../../src')
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
  })
  const all = files(SRC).map((f) => ({ f: path.relative(SRC, f), s: fs.readFileSync(f, 'utf8') }))

  it('every userKindVerdict call passes the question (subject), except the turn-end line reader', () => {
    for (const { f, s } of all) {
      for (const m of s.matchAll(/(?<!function )userKindVerdict\(/g)) {
        // The call's own arguments, to its closing parenthesis.
        let depth = 1, i = m.index! + m[0].length
        while (depth && i < s.length) { if (s[i] === '(') depth++; else if (s[i] === ')') depth--; i++ }
        const args = s.slice(m.index! + m[0].length, i - 1)
        if (f === 'core/org/user-kind.ts' && /user_kind: m\?\.\[1\]/.test(args)) continue
        expect(args, `${f}: userKindVerdict without subject`).toMatch(/\bsubject\b/)
      }
    }
  })

  it('every reader of the status lines hands what it read to the check', () => {
    for (const { f, s } of all) {
      const reads = [...s.matchAll(/=\s*(?:statusOwned \? null : )?readStatusReport\(/g)].length
      if (!reads) continue
      expect([...s.matchAll(/askAgainIfUnclear\(/g)].length, `${f}: ${reads} status read(s), each needs askAgainIfUnclear`).toBe(reads)
    }
  })

  it('every place that asks the turn-end status lines checks the ask they bring back', () => {
    const askers = all.filter(({ s }) => /requestTurnCompleteSelfReport\(/.test(s) && /FOR_USER_PROMPT/.test(s))
    expect(askers.map((a) => a.f).sort()).toEqual(['core/session-hooks/builtins.ts', 'core/sessions/status-question.ts'])
    for (const { f, s } of askers) expect(s, f).toMatch(/askAgainIfUnclear\(/)
  })

  it('every AskUserQuestion for the user reaches the check after the worker route, and every Board write does', () => {
    const session = all.find((a) => a.f === 'providers/claude-code-session.ts')!.s
    const route = session.slice(session.indexOf('private _routeQuestionOrAskUser('), session.indexOf('private _awaitUserDecision('))
    expect(route).toMatch(/if \(!routed\) \{[\s\S]*unclearUserQuestion\(sessionId, request\.input\)/)
    // The links hook stays a note: it never refuses (the leader answers a worker's question first).
    expect(all.find((a) => a.f === 'ops/link-check.ts')!.s).not.toMatch(/permissionDecision/)
    const writers = all.filter(({ s }) => /\b(?:setBoardHtml|editBoardHtml)\(/.test(s) && !/export async function (?:setBoardHtml|editBoardHtml)/.test(s)).map((a) => a.f)
    expect(writers).toEqual(['web/routes/board-v1.ts'])
    expect(all.find((a) => a.f === 'web/routes/board-v1.ts')!.s).toMatch(/unclearNewChoice\(/)
  })
})
