/**
 * A task never settles another task's ask in the user's place without having seen what he wrote in
 * that task (2026-11-07, Main's reflection: "local only" after his "submit the cr", "go ahead, stop
 * asking" after his "discuss before doing").
 *
 *  1. The rule itself (user-spoke.ts): when the ask appeared, what counts as written since, and what
 *     counts as passing his words back.
 *  2. Where his words are read: a task's chat, and an Org node's Threads.
 *  3. Every path that settles an ask for the user, enumerated from the source: a NEW file that records
 *     an answer for him, or writes a task's report, fails here until it is listed with how it keeps the rule.
 *  4. What the caller reads back (the ops' outcomes).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-user-spoke-guard'))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  askSinceOf, needsSinceOf, quoteWords, userSaidIn, userSaidLine, userSaidOf, userWordsIn, wordsNotPassedBack, LAST_WORDS_SHOWN,
} from '../../../src/core/sessions/user-spoke.js'
import { fileThreadMessage } from '../../../src/core/org/threads-store.js'
import { getOp } from '../../../src/ops/registry.js'
import '../../../src/ops/work.js'
import '../../../src/ops/tasks.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
function srcFiles(dir = 'src'): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...srcFiles(rel))
    else if (/\.(ts|tsx|mjs|cjs)$/.test(e.name)) out.push(rel)
  }
  return out
}
/** Code without comments, so a mention in a doc line is no path. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const T0 = '2026-11-07T10:00:00.000Z'
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString()

beforeAll(async () => { await fsp.rm(WALNUT_HOME, { recursive: true, force: true }) })
afterAll(async () => { await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {}) })

describe('when the ask appeared', () => {
  it('is the start of its run of asks, kept while each report asks, reset by any other state', () => {
    expect(needsSinceOf({ state: 'needs', at: at(5) }, null)).toBe(at(5))
    expect(needsSinceOf({ state: 'needs', at: at(5) }, { state: 'working', at: at(1) })).toBe(at(5))
    // Asked again, in the same or other words: still the first time it asked.
    expect(needsSinceOf({ state: 'needs', at: at(9) }, { state: 'needs', at: at(5), needs_since: at(2) })).toBe(at(2))
    // A new ask counts from its turn's end when its report was read later (the status question).
    expect(needsSinceOf({ state: 'needs', at: at(5), turn_ended_at: at(4) }, { state: 'working', at: at(1) })).toBe(at(4))
    // A report an older Walnut stored has no needs_since: the earlier of its times.
    expect(needsSinceOf({ state: 'needs', at: at(9) }, { state: 'needs', at: at(5), turn_ended_at: at(4) })).toBe(at(4))
    expect(needsSinceOf({ state: 'working', at: at(9) }, { state: 'needs', at: at(5), needs_since: at(2) })).toBeUndefined()
    expect(askSinceOf({ at: at(5), turn_ended_at: at(6) })).toBe(at(5))
    expect(askSinceOf(null)).toBeNull()
  })
})

describe('what he wrote since', () => {
  const words = [
    { at: at(1), text: 'first thought' }, { at: at(2), text: 'second' }, { at: at(3), text: 'third' }, { at: at(4), text: 'fourth' },
  ]
  it('since the ask: refused until passed back; before it: his last few, shown, never refused', () => {
    const since = userSaidOf(words, at(2))
    expect(since).toMatchObject({ spokeSince: true, words: [{ text: 'third' }, { text: 'fourth' }] })
    const before = userSaidOf(words, at(10))
    expect(before.spokeSince).toBe(false)
    expect(before.words).toHaveLength(LAST_WORDS_SHOWN)
    expect(wordsNotPassedBack(before, undefined)).toEqual([])
    // Unknown ask time: nothing counts as since (shown only).
    expect(userSaidOf(words, null).spokeSince).toBe(false)
  })

  it('passing back means quoting each message, case and punctuation aside', () => {
    const said = userSaidOf([{ at: at(3), text: 'Submit the CR, tag the reviewers!' }, { at: at(4), text: 'and ping Lee' }], at(2))
    expect(wordsNotPassedBack(said, undefined)).toHaveLength(2)
    expect(wordsNotPassedBack(said, 'He said submit the cr, tag the reviewers.')).toEqual([{ at: at(4), text: 'and ping Lee' }])
    expect(wordsNotPassedBack(said, '"submit the CR tag the reviewers" then "And ping Lee"')).toEqual([])
    expect(wordsNotPassedBack(said, 'He agreed with us.')).toHaveLength(2)
    // A short message stands as whole words: "ok" is not passed back by "took".
    const ok = userSaidOf([{ at: at(3), text: 'ok' }], at(2))
    expect(wordsNotPassedBack(ok, 'It took a while')).toHaveLength(1)
    expect(wordsNotPassedBack(ok, 'He said "ok".')).toEqual([])
    // Spacing and width aside: "\u63d0\u4ea4CR" passed back as "\u63d0\u4ea4 \uff23\uff32".
    const cjk = userSaidOf([{ at: at(3), text: '\u63d0\u4ea4CR\uff0c\u6807\u6ce8\u5ba1\u9605\u4eba' }], at(2))
    expect(wordsNotPassedBack(cjk, '\u4ed6\u8bf4\uff1a\u63d0\u4ea4 \uff23\uff32\uff0c\u6807\u6ce8\u5ba1\u9605\u4eba')).toEqual([])
    expect(wordsNotPassedBack(cjk, '\u4ed6\u540c\u610f\u4e86')).toHaveLength(1)
    // A picture with no words asks nothing to quote.
    expect(wordsNotPassedBack(userSaidOf([{ at: at(3), text: '' }], at(2)), undefined)).toEqual([])
  })

  it('reads as one line each, with the time', () => {
    expect(quoteWords([{ at: at(3), text: 'submit  the\ncr' }])).toBe('2026-11-07 10:03 UTC: "submit the cr"')
    expect(userSaidLine(userSaidOf([{ at: at(3), text: 'go' }], at(2)))).toContain('since it asked')
    expect(userSaidLine(userSaidOf([{ at: at(1), text: 'go' }], at(2)))).toContain('before it asked')
    expect(userSaidLine(userSaidOf([], at(2)))).toBe('')
  })
})

describe('where his words are read', () => {
  it('an Org node: its Threads', async () => {
    await fileThreadMessage('mlead-0001', { text: 'discuss before doing', images: [], via: 'chat', newThreadId: 'th-aaaaaa000001', messageId: 'tm-aaaaaa000001', at: at(3), lang: 'en' } as never)
    expect(await userWordsIn({ id: 'mlead-0001', org_role: 'lead' })).toEqual([{ at: at(3), text: 'discuss before doing' }])
  })
  it('a task whose same ask is folded under it: its words count too', async () => {
    await fsp.mkdir(path.join(WALNUT_HOME, 'user-asks'), { recursive: true })
    await fsp.writeFile(path.join(WALNUT_HOME, 'user-asks', 'mtask-0003.json'), JSON.stringify({
      version: 1, taskId: 'mtask-0003', asks: [{ id: 'ua-00000003', at: at(6), text: 'do it after the freeze', via: 'chat', state: 'open' }],
    }))
    const holder = { id: 'mtask-0002', status_report: { state: 'needs', ask: 'Merge it?', at: at(5) } } as never
    const folded = { id: 'mtask-0003', status_report: { state: 'needs', ask: 'Merge it?', at: at(5) }, user_status: { state: 'waiting', sameAsk: { id: 'mtask-0002' } } } as never
    expect(await userSaidIn(holder)).toMatchObject({ spokeSince: false })
    expect(await userSaidIn(holder, [holder, folded])).toMatchObject({ spokeSince: true, words: [{ text: 'do it after the freeze' }] })
  })
  it('any other task: its chat (user-asks.ts); a plugin\'s own task has none', async () => {
    await fsp.mkdir(path.join(WALNUT_HOME, 'user-asks'), { recursive: true })
    await fsp.writeFile(path.join(WALNUT_HOME, 'user-asks', 'mtask-0001.json'), JSON.stringify({
      version: 1, taskId: 'mtask-0001', asks: [{ id: 'ua-00000001', at: at(3), text: 'submit the cr', via: 'chat', state: 'open' }],
    }))
    expect(await userWordsIn({ id: 'mtask-0001' })).toEqual([{ at: at(3), text: 'submit the cr' }])
    expect(await userWordsIn({ id: 'mtask-0001', plugin_only: 'x' } as never)).toEqual([])
  })
})

describe('every path that settles an ask for the user reads his words first', () => {
  // A file that records an answer in his place, or writes a task's report (which can take an ask off
  // Needs you), and how it keeps the rule. A new one fails until it is listed here.
  const SETTLES = /(?:^|[^.\w])(?:ask_answered|asks_answered|status_report)\s*[:,}]/m
  const PATHS: Record<string, (c: string) => void> = {
    // answers_ask: his words are read and checked before the answer is shaped or recorded.
    'src/core/sessions/ask-answer.ts': (c) => {
      expect(c).toMatch(/export async function prepareAskAnswer[\s\S]*?settleCheck\([\s\S]*?if \(check\?\.refusal\) throw new AskAnswerError\('user_spoke_since'[\s\S]*?askAnswerLine\([\s\S]*?ask_answered:/)
    },
    // A lead's line over the task's: checked when it takes the ask away, and stamped with when it asked.
    'src/core/sessions/report-set.ts': (c) => {
      expect(c).toMatch(/needsSinceOf\([\s\S]*?by\.startsWith\('task:'\)[\s\S]*?settleCheck\([\s\S]*?if \(check\?\.refusal\) throw new ReportChangeError\(check\.refusal, 'user_spoke_since'[\s\S]*?status_report: report/)
    },
    // The task's own report: stamped with when it began asking, so a reworded ask keeps the time.
    'src/core/sessions/status-question.ts': (c) => {
      expect(c).toMatch(/needsSinceOf\(report, prev\)[\s\S]*?needs_since: needsSince[\s\S]*?status_report: report/)
    },
    // A receiving task's own ask from its saved findings: it only adds an ask (never takes one off
    // Needs you), stamped with when it began asking.
    'src/core/router/processing.ts': (c) => {
      expect(c).toMatch(/report = reportOfChange\(\{ state: 'needs'[\s\S]*?status_report: withNeedsSince\(report, needsSinceOf\(report, current\.status_report\)\)/)
    },
  }

  it('the list is complete', () => {
    const found = srcFiles().filter((f) => SETTLES.test(code(f)))
    expect(found.sort()).toEqual(Object.keys(PATHS).sort())
  })
  for (const [file, check] of Object.entries(PATHS)) it(file, () => check(code(file)))

  it('both gates refuse with the same code and the words quoted', () => {
    expect(code('src/core/sessions/session-send-core.ts')).toContain("'user_spoke_since'")
    expect(code('src/core/sessions/user-spoke.ts')).toMatch(/export function userSpokeMessage[\s\S]*?quoteWords\(said\.words\)/)
    // The one check: his words read (folds too), and a refusal unless each is passed back.
    expect(code('src/core/sessions/user-spoke.ts')).toMatch(/export async function settleCheck[\s\S]*?openAskOf\([\s\S]*?userSaidIn\(target, everything\)[\s\S]*?wordsNotPassedBack\(said, userWords\)\.length \? \{ said, refusal: userSpokeMessage\(/)
  })

  it('every task PATCH route checks a phase write by another task', () => {
    const ROUTE = /(?:\.patch\('\/tasks\/:id',|tasksRouter\.patch\('\/:id',)/
    const routes = srcFiles('src/web/routes').filter((f) => ROUTE.test(code(f)))
    expect(routes.sort()).toEqual(['src/web/routes/api-v1.ts', 'src/web/routes/tasks.ts'])
    for (const f of routes) {
      const body = code(f).split(ROUTE)[1].split(/\n\}\)\n/)[0]
      expect(body, f).toMatch(/admitPhaseByOther\([\s\S]*?'user_spoke_since'[\s\S]*?updateTask\(/)
    }
    expect(code('src/core/sessions/user-spoke.ts')).toMatch(/export async function admitPhaseByOther[\s\S]*?settleCheck\(/)
  })

  it('every close goes through the hold, which names his words and holds again after he wrote', () => {
    expect(code('src/core/sessions/owed-to-user.ts')).toMatch(/export async function admitSessionClose[\s\S]*?userSaidIn\([\s\S]*?wroteSinceHold[\s\S]*?userSaidLine\(said\)/)
  })

  it('a plain message to a task that still asks shows his words with the ask', () => {
    expect(code('src/core/sessions/session-send-core.ts')).toMatch(/async function openAskBelow[\s\S]*?userSaidIn\(/)
  })

  it('the daemon\'s offline host never settles one: answers_ask needs the server', () => {
    expect(code('src/providers/offline-host-core.ts')).toMatch(/args\.answers_ask === true\) return needsServer\(/)
  })
})

describe('what the caller reads back', () => {
  const said = { askSince: at(2), spokeSince: true, words: [{ at: at(3), text: 'submit the cr' }] }
  it('task_send answers_ask: delivered or recorded, his words are in the outcome', () => {
    const op = getOp('task_send')!
    for (const delivery of ['queued', 'recorded']) {
      const out = op.mapResult!({ body: { delivery, notWoken: 'stopped', targetTaskId: 'mtask-0001', userSaid: said }, args: { to: 'mtask-0001', answers_ask: true } } as never) as Record<string, unknown>
      expect(String(out.outcome), delivery).toContain('"submit the cr"')
    }
  })
  it('task_report_set: his words are in the outcome', async () => {
    const op = getOp('task_report_set')!
    const call = (async () => ({ task: { id: 'mtask-0001', title: 'Pulse cost' }, phase: null, userSaid: said })) as never
    const out = await op.handler!({ id: 'mtask-0001', report: { state: 'working' } }, call) as Record<string, unknown>
    expect(String(out.outcome)).toContain('"submit the cr"')
  })
  it('both ops name the refusal and how to pass his words back', () => {
    expect(code('src/ops/work.ts')).toContain('409 user_spoke_since')
    expect(code('src/ops/tasks.ts')).toContain('user_words: z.string()')
  })
})
