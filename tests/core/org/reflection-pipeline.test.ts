/**
 * One node's reflection pass (src/core/org/reflection/pipeline.ts) with every effect faked: which
 * messages are looked at (only new ones, only its own team's, each once), what a finding does (the
 * correction, the guidance line, the day's record), and what holds it back (the day's budget, a
 * session that already took up the right way, a guidance line the user deleted).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reflection-pipeline'))

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import { reflectForNode, type ReflectDeps } from '../../../src/core/org/reflection/pipeline.js'
import { guidanceFileOf, readGuidance, reflectionDayFileOf } from '../../../src/core/org/reflection/records.js'
import { localDate, updateReflectionState } from '../../../src/core/org/reflection/state.js'

const NOW = Date.parse('2026-11-19T20:00:00Z')
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()

const vp = { id: 'vp-marina', title: 'Marina VP', project: 'Marina', org_role: 'lead', phase: 'IN_PROGRESS' } as Task
const worker = { id: 'w-1', title: 'Upgrade the autoscaler', project: 'Marina', phase: 'IN_PROGRESS', session_id: 'sess-1' } as Task
const other = { id: 'w-2', title: 'Other team work', project: 'Garden', phase: 'IN_PROGRESS', session_id: 'sess-2' } as Task
const otherVp = { id: 'vp-garden', title: 'Garden VP', project: 'Garden', org_role: 'lead', phase: 'IN_PROGRESS' } as Task
const ALL = [vp, worker, other, otherVp]
const NAME = 'Marina VP'

const SESSION_TURN = 'I kept the package on major version 1.4. Opening 1.8 would touch four packages, a much bigger change. My recommendation is to keep it.'
const ANGRY = 'No no no, this is completely wrong, do not do a hack.'

function finding(over: Record<string, unknown> = {}) {
  return JSON.stringify({ verdict: 'bad_decision', why: 'x', finding: {
    kind: 'change_too_big_excuse', session_quote: 'Opening 1.8 would touch four packages, a much bigger change.', user_quote: 'do not do a hack',
    rule_quote: 'Fix root causes, not symptoms.', what_went_wrong: 'It kept 1.8.1 inside 1.4 to avoid changing dependents.',
    correct_action: 'Open 1.8 and move the dependents to it.', already_fixed: false, correction: 'Open a clean 1.8 now and move every dependent.',
    guidance: 'Many dependents are no reason to keep an old version number: open the new one and move them.', same_as: 0, skill: null, ...over,
  } })
}

function deps(over: Partial<ReflectDeps> & { answer?: string; messages?: Record<string, Array<{ id: string; at: string; text: string }>> } = {}) {
  const sent: Array<{ task: string; text: string }> = []
  const calls: string[] = []
  const messages = over.messages ?? { 'w-1': [{ id: 'm1', at: iso(10), text: ANGRY }], 'w-2': [{ id: 'm2', at: iso(10), text: 'this is ridiculous' }] }
  const d: ReflectDeps = {
    readTranscript: async (sid) => (sid === 'sess-1'
      ? [{ role: 'assistant', text: SESSION_TURN, timestamp: iso(15) }, { role: 'user', text: ANGRY, timestamp: iso(10), sentBy: 'person' }]
      : [{ role: 'assistant', text: 'Done with the garden.', timestamp: iso(15) }]) as never,
    callModel: async (_s, user) => { calls.push(user); return over.answer ?? finding() },
    send: async (task, text) => { sent.push({ task: task.id, text }); return true },
    readMessages: async (taskId) => messages[taskId] ?? [],
    rulesText: async () => '## USER.md\n- Fix root causes, not symptoms.',
    replyLanguage: async () => null,
    nowMs: () => NOW,
    ...over,
  }
  return { d, sent, calls }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  // The switch went on an hour ago: messages since then are new.
  await updateReflectionState(vp.id, (s) => { s.since = iso(60) }, NOW)
})

describe('reflection pass', () => {
  it('judges its own team\'s new frustrated message, corrects the session, writes the guidance and the day', async () => {
    const { d, sent, calls } = deps()
    const r = await reflectForNode(vp, NAME, ALL, d)
    // Only its own worker: the Garden task is another VP's team.
    expect(r.candidates).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(SESSION_TURN)
    expect(sent).toEqual([expect.objectContaining({ task: 'w-1' })])
    expect(sent[0].text).toContain('Open a clean 1.8 now')
    expect(sent[0].text).toContain('do not do a hack')
    expect((await readGuidance(vp.id)).map((l) => l.text)).toEqual(['Many dependents are no reason to keep an old version number: open the new one and move them.'])
    const day = await fs.readFile(reflectionDayFileOf(vp.id, localDate(NOW)), 'utf-8')
    expect(day).toContain('Upgrade the autoscaler (w-1)')
    expect(day).toContain('sent to the session')
  })

  it('judges a message once, and never one older than the switch', async () => {
    const { d, calls } = deps({ messages: { 'w-1': [{ id: 'old', at: iso(120), text: ANGRY }, { id: 'm1', at: iso(10), text: ANGRY }] } })
    await reflectForNode(vp, NAME, ALL, d)
    await reflectForNode(vp, NAME, ALL, d)
    expect(calls).toHaveLength(1)
  })

  it('waits for the session to answer a message just sent', async () => {
    const { d, calls } = deps({ messages: { 'w-1': [{ id: 'm1', at: iso(1), text: ANGRY }] } })
    expect((await reflectForNode(vp, NAME, ALL, d)).candidates).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('sends nothing when the session already took up the right way, or there is no issue', async () => {
    const fixed = deps({ answer: finding({ already_fixed: true, correction: '' }) })
    await reflectForNode(vp, NAME, ALL, fixed.d)
    expect(fixed.sent).toHaveLength(0)
    expect(await fs.readFile(reflectionDayFileOf(vp.id, localDate(NOW)), 'utf-8')).toContain('already taken up the right way')
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await updateReflectionState(vp.id, (s) => { s.since = iso(60) }, NOW)
    const fine = deps({ answer: '{"verdict":"no_issue","why":"he is angry at the build farm"}' })
    await reflectForNode(vp, NAME, ALL, fine.d)
    expect(fine.sent).toHaveLength(0)
    expect(await readGuidance(vp.id)).toEqual([])
  })

  it('drops a finding whose quote is not in the session', async () => {
    const { d, sent } = deps({ answer: finding({ session_quote: 'I deleted the production database.' }) })
    const r = await reflectForNode(vp, NAME, ALL, d)
    expect(r.findings[0].verdict.verdict).toBe('unverified')
    expect(sent).toHaveLength(0)
  })

  it('never writes again a guidance line the user deleted', async () => {
    const first = deps()
    await reflectForNode(vp, NAME, ALL, first.d)
    // The user removes the line by hand.
    await fs.writeFile(guidanceFileOf(vp.id), '# Team guidance: Marina VP\n', 'utf-8')
    const again = deps({ messages: { 'w-1': [{ id: 'm9', at: iso(5), text: ANGRY }] } })
    await reflectForNode(vp, NAME, ALL, again.d)
    expect(again.calls).toHaveLength(1)
    expect(await readGuidance(vp.id)).toEqual([])
  })

  it('stops at the day\'s budget', async () => {
    await updateReflectionState(vp.id, (s) => { s.day = { date: localDate(NOW), calls: 40 } }, NOW)
    const { d, calls } = deps()
    const r = await reflectForNode(vp, NAME, ALL, d)
    expect(r.candidates).toBe(1)
    expect(r.judged).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('checks a decision ask before the user reads it', async () => {
    const asking = { ...worker, user_status: { state: 'needs', at: iso(8) } } as unknown as Task
    const { d, sent, calls } = deps({
      messages: {}, answer: finding({ user_quote: '' }),
      readTranscript: async () => [{ role: 'assistant', text: SESSION_TURN, timestamp: iso(9) }] as never,
    })
    const r = await reflectForNode(vp, NAME, [vp, asking], d)
    expect(r.findings[0].candidate.signal).toBe('decision_ask')
    expect(calls[0]).toContain('asking the user to decide')
    expect(sent).toHaveLength(1)
  })
})
