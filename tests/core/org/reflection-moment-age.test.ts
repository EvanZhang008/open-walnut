/**
 * Old words in a correction (src/core/org/reflection/moment-age.ts, candidates.ts roundsStep).
 *
 * 2026-11-26, Walnut VP: corrections replayed the user's words of days before without their date, and
 * the session took them as a new ask. One lead's reflection judged on 11-26 01:12 a talk of 11-23
 * 01:06 to 01:16 (the tail after its 72-hour floor made a "new" many-rounds window), and another lead
 * got one on 11-26 03:07 about his 11-23 03:11 words; both asks were done days before. Guards: no
 * window that began before the floor is judged; every correction says when he wrote what it quotes;
 * one about words hours old is checked against what happened since, and not sent when it was done.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reflection-moment-age'))

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import { reflectForNode, type ReflectDeps } from '../../../src/core/org/reflection/pipeline.js'
import { collectCandidates, MOMENT_MAX_AGE_MS, type ReflectionThread } from '../../../src/core/org/reflection/candidates.js'
import { readDayEntries } from '../../../src/core/org/reflection/records.js'
import { localDate, readReflectionState, updateReflectionState } from '../../../src/core/org/reflection/state.js'
import { heldPoint, heldText } from '../../../src/core/org/reflection/held-corrections.js'
import { STALE_MOMENT_MS, TAKEN_UP_SYSTEM, quoteTimeOf } from '../../../src/core/org/reflection/moment-age.js'

const NOW = Date.parse('2026-11-26T03:07:00Z')
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()
const vp = { id: 'vp-marina', title: 'Marina VP', project: 'Marina', org_role: 'lead', phase: 'IN_PROGRESS', session_id: 'sess-vp' } as Task
const BEFORE = 'Shipped the new card layout.'

const finding = JSON.stringify({ verdict: 'bad_decision', why: 'x', finding: {
  kind: 'regression', session_quote: BEFORE, user_quote: 'used to show', rule_quote: '', what_went_wrong: 'The card lost its reply.',
  correct_action: 'Bring the reply back.', already_fixed: false, correction: 'Bring the reply back under the card.',
  guidance: '', same_as: 0, skill: null,
} })

function deps(threads: ReflectionThread[], takenUp: string | (() => never) = '{"done":[]}', over: Partial<ReflectDeps> = {}) {
  const sent: Array<{ task: string; text: string }> = []
  const checks: string[] = []
  const d: ReflectDeps = {
    readTranscript: async () => [] as never,
    readMessages: async () => [],
    readThreads: async (id) => (id === vp.id ? threads : []),
    callModel: async (system, user) => {
      if (system === TAKEN_UP_SYSTEM) { checks.push(user); return typeof takenUp === 'string' ? takenUp : takenUp() }
      return finding
    },
    send: async (task, text) => { sent.push({ task: task.id, text }); return true },
    confirmSend: async () => true,
    rulesText: async () => '',
    replyLanguage: async () => null,
    nowMs: () => NOW,
    ...over,
  }
  return { d, sent, checks }
}

/** One message of his that says the card broke, `minAgo` minutes ago, with the node's answer before it. */
const oneMoment = (minAgo: number, extra: Partial<ReflectionThread> = {}, after: ReflectionThread['messages'] = []): ReflectionThread[] => [{
  id: 'th-aa0001', title: 'Pier page', ...extra, messages: [
    { id: 'tm-aa0000', at: iso(minAgo + 5), text: 'ship the card layout', sid: 'sess-vp', answer: { text: BEFORE, at: iso(minAgo + 4) } },
    { id: 'tm-aa0010', at: iso(minAgo), text: 'The reply under the card used to show.', sid: 'sess-vp', answer: { text: BEFORE, at: iso(minAgo - 1) } },
    ...after,
  ],
}]

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await updateReflectionState(vp.id, (s) => { s.since = iso(6 * 24 * 60) }, NOW)
})

describe('a talk that began before the look-back is never judged as new (class guard)', () => {
  const floorMin = MOMENT_MAX_AGE_MS / 60_000
  // Fourteen follow-ups a minute apart, six before the floor and eight after: the shape of the 11-23 talk.
  const talk = (startMin: number, prefix: string) => Array.from({ length: 14 }, (_, i) => ({
    id: `tm-${prefix}${String(i).padStart(4, '0')}`, at: iso(startMin - i), text: `why is it still so slow ${i}`, sid: 'sess-vp',
    answer: { text: BEFORE, at: iso(startMin - i - 0.5) },
  }))

  it('the tail of a talk cut by the floor makes no many-rounds window; a talk wholly after it does', async () => {
    const threads: ReflectionThread[] = [{ id: 'th-old001', title: 'Go-live speed', messages: [...talk(floorMin + 5, 'old'), ...talk(600, 'new')] }]
    const { d } = deps(threads)
    const { candidates } = await collectCandidates(vp, [vp], iso(6 * 24 * 60), new Set(), d)
    const floor = iso(floorMin)
    // Every candidate of every kind starts after the floor.
    for (const c of candidates) expect(c.from > floor, `${c.key} from ${c.from}`).toBe(true)
    const rounds = candidates.filter((c) => c.signal === 'many_rounds')
    expect(rounds.map((c) => c.messages[0].id)).toEqual(['tm-new0000'])
  })

  it('the same for his messages to an ordinary task', async () => {
    const worker = { id: 'w-1', title: 'Dock page', project: 'Marina', phase: 'IN_PROGRESS', session_id: 'sess-1', parent_task_id: vp.id } as Task
    const msgs = [...talk(floorMin + 5, 'old'), ...talk(600, 'new')].map(({ id, at, text }) => ({ id: id.replace('tm-', 'm-'), at, text }))
    const { d } = deps([], undefined, { readMessages: async (id) => (id === worker.id ? msgs : []) })
    const { candidates } = await collectCandidates(vp, [vp, worker], iso(6 * 24 * 60), new Set(), d)
    for (const c of candidates) expect(c.from > iso(floorMin), `${c.key} from ${c.from}`).toBe(true)
    expect(candidates.filter((c) => c.signal === 'many_rounds').map((c) => c.messages[0].id)).toEqual(['m-new0000'])
  })
})

describe('every correction says when he wrote what it quotes', () => {
  it('a fresh one: his words with their time, and no check of what happened since', async () => {
    const { d, sent, checks } = deps(oneMoment(10))
    await reflectForNode(vp, 'Marina VP', [vp], d)
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain(`The user said this at ${iso(10).slice(0, 16).replace('T', ' ')} UTC (less than an hour ago): "used to show"`)
    expect(sent[0].text).not.toContain('not a new ask')
    expect(checks).toHaveLength(0)
    const [entry] = (await readDayEntries(vp.id, localDate(NOW)))!
    expect(entry.saidAt).toBe(iso(10))
  })

  it('a held one keeps his time; the held message says none is a new ask', async () => {
    expect(heldPoint({ correction: 'Fix it.', correct_action: 'Bring it back.', user_quote: 'used to show' }, '2026-11-23T01:16:49.840Z'))
      .toContain('The user said this at 2026-11-23 01:16 UTC: "used to show"')
    // A second finding for the task in one pass is held: the kept text carries the time too.
    const second = [{ id: 'tm-aa0030', at: iso(8), text: 'The list under the card used to show.', sid: 'sess-vp', answer: { text: BEFORE, at: iso(7) } }]
    const { d, sent } = deps(oneMoment(10, {}, second))
    await reflectForNode(vp, 'Marina VP', [vp], d)
    expect(sent).toHaveLength(1)
    const held = (await readReflectionState(vp.id, NOW)).held ?? []
    expect(held).toHaveLength(1)
    expect(held[0].text).toContain('The user said this at')
    expect(held[0].saidAt).toBeTruthy()
    expect(heldText(vp.id, 'Marina VP', [{ taskId: vp.id, at: iso(1), date: localDate(NOW), entryAt: iso(1), text: 'x' }])).toContain('none is a new ask')
  })

  it('the quote is dated by the message that holds it, not by the end of the talk', () => {
    const c = { to: iso(1), messages: [{ id: 'a', at: iso(30), text: 'the reply used to show' }, { id: 'b', at: iso(1), text: 'so?' }] }
    expect(quoteTimeOf(c, 'used to show')).toBe(iso(30))
    expect(quoteTimeOf(c, 'not there')).toBe(iso(1))
  })

  it('no file that builds a correction quotes him undated (source guard)', async () => {
    const dir = path.join(process.cwd(), 'src/core/org/reflection')
    const offenders: string[] = []
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith('.ts') || f === 'moment-age.ts' || f === 'records.ts') continue
      if (/The user said/.test(await fs.readFile(path.join(dir, f), 'utf-8'))) offenders.push(f)
    }
    // His words reach a session only through moment-age.ts userSaidLine (records.ts is the day record, dated by saidAt).
    expect(offenders).toEqual([])
  })
})

describe('one about words hours old is checked against what happened since', () => {
  const old = STALE_MOMENT_MS / 60_000 + 60

  it('a thread closed since: not sent, said in the day record', async () => {
    const { d, sent, checks } = deps(oneMoment(old, { closed: true }))
    await reflectForNode(vp, 'Marina VP', [vp], d)
    expect(sent).toHaveLength(0)
    expect(checks).toHaveLength(0)
    const [entry] = (await readDayEntries(vp.id, localDate(NOW)))!
    expect(entry.corrected).toBe('off')
    expect(entry.notSent).toBe('handled_since')
  })

  it('done since (his pick, the task it went to): not sent; the check read his later words, the card and the task', async () => {
    const after = [{ id: 'tm-aa0020', at: iso(old - 30), text: 'ok pick design 3', sid: 'sess-vp', answer: { text: 'Design 3 is live.', at: iso(old - 31) } }]
    const { d, sent, checks } = deps(oneMoment(old, { tasks: ['t-design'], reply: 'Design 3 shipped.', state: 'answered' }, after), '{"done":[1]}', {
      taskOutcome: async (id) => ({ id, title: 'Ten header designs', phase: 'COMPLETE', summary: 'He picked design 3; it is live.' }),
    })
    await reflectForNode(vp, 'Marina VP', [vp], d)
    expect(sent).toHaveLength(0)
    expect(checks).toHaveLength(1)
    expect(checks[0]).toContain('ok pick design 3')
    expect(checks[0]).toContain('Design 3 shipped.')
    expect(checks[0]).toContain('Ten header designs')
    expect((await readDayEntries(vp.id, localDate(NOW)))![0].notSent).toBe('handled_since')
  })

  it('still needed, or a check that cannot tell: sent, and it says it is about old words, not a new ask', async () => {
    const after = [{ id: 'tm-aa0020', at: iso(old - 30), text: 'and the list?', sid: 'sess-vp', answer: { text: 'Looking.', at: iso(old - 31) } }]
    for (const answer of ['{"done":[]}', 'not json']) {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true })
      await updateReflectionState(vp.id, (s) => { s.since = iso(6 * 24 * 60) }, NOW)
      const { d, sent, checks } = deps(oneMoment(old, {}, after), answer)
      await reflectForNode(vp, 'Marina VP', [vp], d)
      expect(checks).toHaveLength(1)
      expect(sent).toHaveLength(1)
      expect(sent[0].text).toContain(`This is about his words of ${iso(old).slice(0, 16).replace('T', ' ')} UTC (3 hours ago), not a new ask`)
    }
  })
})
