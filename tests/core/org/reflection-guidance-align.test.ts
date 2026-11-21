/**
 * The team guidance follows the user's standing rules (src/core/org/reflection/guidance-align.ts;
 * 2026-11-21: he wrote "ship Walnut changes without asking me" into his rules while a VP's guidance
 * still told every session a screen change waits for his yes). When his rules gain a line, the lines
 * it overrules are named to the node, which edits them; the reflection never rewrites a line itself
 * (a real model rewrote a safety line into its opposite when it did); a reworded rule is ground only
 * through what it adds; his own lines are never named; and the overruled lesson is never written back.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reflection-guidance-align'))

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import { addGuidance, guidanceFileOf, readGuidance, renderGuidance } from '../../../src/core/org/reflection/records.js'
import { alignGuidance, readAlign, ruleChanges, rulesLines, ALIGN_SYSTEM, ALIGN_CALLS_PER_DAY_MAX, type AlignDeps } from '../../../src/core/org/reflection/guidance-align.js'
import { reflectForNode, rememberDeletedGuidance, type ReflectDeps } from '../../../src/core/org/reflection/pipeline.js'
import { JUDGE_SYSTEM } from '../../../src/core/org/reflection/judge.js'
import { localDate, readReflectionState, updateReflectionState } from '../../../src/core/org/reflection/state.js'

const NOW = Date.parse('2026-11-21T20:00:00Z')
const DAY = localDate(NOW)
const vp = { id: 'vp-marina', title: 'Marina VP', project: 'Marina', org_role: 'lead', phase: 'IN_PROGRESS', session_id: 'sess-vp' } as Task
const SAFETY_RULE = 'Run logins and confirm pages on his machines yourself.'
const BEFORE = `## Standing rules\n- ${SAFETY_RULE}\n`
const GO_LIVE = 'Go-live is not his to ask: ship what passed review and tests, tell him after.'
const RULES = `${BEFORE}- ${GO_LIVE}\n`
const OLD = 'A change to a screen he uses daily ships only after he saw the design and said yes.'
const SAFETY = 'On his real accounts, stop at any security prompt and wait for his word.'
const OWN = 'Ask me before any change ships.'

async function write(lines: Array<{ text: string; from?: string; date?: string }>): Promise<void> {
  await fs.mkdir(path.dirname(guidanceFileOf(vp.id)), { recursive: true })
  await fs.writeFile(guidanceFileOf(vp.id), renderGuidance('Marina VP', lines))
}
const mine = (text: string) => ({ text, from: 'a task', date: '2026-11-20' })
function deps(answers: string[], rules = RULES) {
  const calls: Array<{ system: string; user: string }> = []
  const sent: Array<{ to: string; text: string; title: string }> = []
  const d: AlignDeps = {
    callModel: async (system, user) => { calls.push({ system, user }); return answers.shift() ?? '{"conflicts":[]}' },
    userRules: async () => rules,
    send: async (task, text, title) => { sent.push({ to: task.id, text, title }); return true },
  }
  return { d, calls, sent }
}
const conflict = (line: number, rule = 'ship what passed review and tests, tell him after') => JSON.stringify({ conflicts: [{ line, rule_quote: rule, why: 'His new rule lets agents ship.' }] })

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  // The rules the lines were written under; RULES adds the go-live line.
  await updateReflectionState(vp.id, (s) => { s.aligned = { rules: rulesLines(BEFORE) } }, NOW)
})

describe('a line his new rule overrules', () => {
  it('is named to the node with the rule and the file, and the line itself is left for the node to edit', async () => {
    await write([mine(SAFETY), mine(OLD)])
    const { d, calls, sent } = deps([conflict(2)])
    const flags = await alignGuidance(vp, 'Marina VP', d, NOW)
    expect(flags).toMatchObject([{ line: 2, text: OLD }])
    expect(calls[0].system).toBe(ALIGN_SYSTEM)
    expect(calls[0].user).toMatch(new RegExp(`^CHANGES:\\nNOW: ${GO_LIVE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`))
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe(vp.id)
    expect(sent[0].text).toContain(`line 2: "${OLD}"`)
    expect(sent[0].text).toContain(guidanceFileOf(vp.id))
    expect(sent[0].text).toContain('host_exec on __local__')
    expect((await readGuidance(vp.id)).map((l) => l.text)).toEqual([SAFETY, OLD])
    expect((await readReflectionState(vp.id, NOW)).alignLog).toMatchObject([{ line: OLD }])
  })

  it('once the node deletes it, the lesson is never written back', async () => {
    await write([mine(OLD)])
    await updateReflectionState(vp.id, (s) => { s.written.push(OLD.toLowerCase()) }, NOW)
    await alignGuidance(vp, 'Marina VP', deps([conflict(1)]).d, NOW)
    await write([])
    await rememberDeletedGuidance(vp.id, NOW)
    const s = await readReflectionState(vp.id, NOW)
    expect(await addGuidance(vp.id, 'Marina VP', mine(OLD), { removed: s.removed, addedToday: 0 })).toBe('removed')
  })

  it('a quote that is not in his new lines (an old rule, made-up words) names nothing', async () => {
    await write([mine(SAFETY)])
    const { d, sent } = deps([conflict(1, SAFETY_RULE)])
    expect(await alignGuidance(vp, 'Marina VP', d, NOW)).toEqual([])
    expect(sent).toHaveLength(0)
    expect(readAlign('not json', [OLD], new Set([1]), [{ now: GO_LIVE }])).toEqual([])
    expect(readAlign(conflict(1, 'every change waits for his yes'), [OLD], new Set([1]), [{ now: GO_LIVE }])).toEqual([])
  })

  it('a line he wrote himself is marked in the prompt and never named', async () => {
    await write([{ text: OWN }, mine(OLD)])
    const { d, calls, sent } = deps([conflict(1)])
    expect(await alignGuidance(vp, 'Marina VP', d, NOW)).toEqual([])
    expect(calls[0].user).toContain(`1. ${OWN} (the user's own: never flag)`)
    expect(sent).toHaveLength(0)
  })
})

describe('a reworded rule', () => {
  const was = 'Run logins, sudo and confirm pages on his machines yourself.'
  const now = 'Run logins, sudo, passkeys and confirm pages on his machines yourself.'
  it('is shown as WAS and NOW, and is ground only through a word it adds', () => {
    const changes = ruleChanges([was, 'Never make sound.'], [now, 'Never make sound.'])
    expect(changes).toEqual([{ now, was }])
    // The quote holds only words WAS already had: no flag. One holding "passkeys": a flag.
    expect(readAlign(conflict(1, 'Run logins, sudo'), [SAFETY], new Set([1]), changes)).toEqual([])
    expect(readAlign(conflict(1, 'sudo, passkeys and confirm pages'), [SAFETY], new Set([1]), changes)).toHaveLength(1)
  })

  it('a heading, a blank line or a bullet mark changed is no change', () => {
    expect(ruleChanges(rulesLines(BEFORE), rulesLines(`# Rules, renamed\n\n* ${SAFETY_RULE}\n`))).toEqual([])
  })
})

describe('when the guidance is looked at', () => {
  it('only when his rules change: once, and again after the next change', async () => {
    await write([mine(OLD)])
    const { d, calls } = deps([])
    await alignGuidance(vp, 'Marina VP', d, NOW)
    await alignGuidance(vp, 'Marina VP', d, NOW)
    expect(calls).toHaveLength(1)
    await alignGuidance(vp, 'Marina VP', { ...d, userRules: async () => `${RULES}- Never ping colleagues in his name.\n` }, NOW)
    expect(calls).toHaveLength(2)
    expect(calls[1].user).toMatch(/^CHANGES:\nNOW: Never ping colleagues in his name\.\n/)
  })

  it('the first look only learns his rules: the lines were written under them', async () => {
    await updateReflectionState(vp.id, (s) => { delete s.aligned }, NOW)
    await write([mine(OLD)])
    const { d, calls } = deps([conflict(1)])
    await alignGuidance(vp, 'Marina VP', d, NOW)
    expect(calls).toHaveLength(0)
    expect((await readReflectionState(vp.id, NOW)).aligned?.rules).toEqual(rulesLines(RULES))
  })

  it('a read much shorter than the last (a sync mid-write) is skipped and changes nothing', async () => {
    const long = `## Rules\n${Array.from({ length: 10 }, (_, i) => `- Rule number ${i} of his own here.`).join('\n')}\n`
    await updateReflectionState(vp.id, (s) => { s.aligned = { rules: rulesLines(long) } }, NOW)
    await write([mine(OLD)])
    const { d, calls } = deps([], '## Rules\n- Rule number 0 of his own here.\n')
    await alignGuidance(vp, 'Marina VP', d, NOW)
    expect(calls).toHaveLength(0)
    expect((await readReflectionState(vp.id, NOW)).aligned?.rules).toEqual(rulesLines(long))
    // Read the same short file again: it is his real file now, taken as it is.
    await alignGuidance(vp, 'Marina VP', d, NOW)
    expect((await readReflectionState(vp.id, NOW)).aligned?.rules).toEqual(['Rule number 0 of his own here.'])
  })

  it('names nothing when the node\'s switch went off during the pass', async () => {
    await write([mine(OLD)])
    const { d, sent } = deps([conflict(1)])
    expect(await alignGuidance(vp, 'Marina VP', { ...d, confirmSend: async () => false }, NOW)).toEqual([])
    expect(sent).toHaveLength(0)
  })

  it('a failed call or a failed send is asked again on the next pass, within the day\'s budget', async () => {
    await write([mine(OLD)])
    let n = 0
    const d: AlignDeps = { callModel: async () => { n++; throw new Error('throttled') }, userRules: async () => RULES, send: async () => true }
    await alignGuidance(vp, 'Marina VP', d, NOW)
    const noSend = deps([conflict(1)])
    await alignGuidance(vp, 'Marina VP', { ...noSend.d, send: async () => false }, NOW)
    expect((await readReflectionState(vp.id, NOW)).aligned?.rules).toEqual(rulesLines(BEFORE))
    await alignGuidance(vp, 'Marina VP', d, NOW)
    expect(n).toBe(2)
    await updateReflectionState(vp.id, (s) => { s.aligns = { date: DAY, count: ALIGN_CALLS_PER_DAY_MAX } }, NOW)
    await alignGuidance(vp, 'Marina VP', d, NOW)
    expect(n).toBe(2)
  })

  it('no rules file, or no guidance, spends no call', async () => {
    const { d, calls } = deps([], '')
    await write([mine(OLD)])
    await alignGuidance(vp, 'Marina VP', d, NOW)
    await fs.rm(guidanceFileOf(vp.id))
    const two = deps([])
    await alignGuidance(vp, 'Marina VP', two.d, NOW)
    expect(calls).toHaveLength(0)
    expect(two.calls).toHaveLength(0)
  })
})

describe('the pass', () => {
  it('ends by looking at the guidance, and the judge is told a lesson never goes against his rules', async () => {
    await write([mine(OLD)])
    const calls: string[] = []
    const sent: string[] = []
    const d: ReflectDeps = {
      readTranscript: async () => [], readMessages: async () => [], readThreads: async () => [],
      callModel: async (system) => { calls.push(system); return conflict(1) },
      send: async (_t, text) => { sent.push(text); return true }, confirmSend: async () => true, rulesText: async () => RULES, userRules: async () => RULES,
      replyLanguage: async () => null, nowMs: () => NOW,
    }
    await reflectForNode(vp, 'Marina VP', [vp], d)
    expect(calls).toEqual([ALIGN_SYSTEM])
    expect(sent).toHaveLength(1)
    expect((await readGuidance(vp.id))[0].text).toBe(OLD)
    expect(JUDGE_SYSTEM).toContain('It never contradicts his RULES')
    expect(JUDGE_SYSTEM).toContain('where they say nothing: an outward send')
  })
})
