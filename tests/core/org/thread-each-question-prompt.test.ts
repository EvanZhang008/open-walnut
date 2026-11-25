/**
 * What a node is told with threads_each_question (src/core/sessions/session-context.ts threadsLine,
 * threadsKeptLine): on, the one sentence "Several asks about the same thing are one thread" is
 * replaced by the rule that each question he asks is its own thread, in every variant (Main and a
 * lead, the Brief on or off, threads_kept_by_walnut, threads_reply_tag, a task with Threads on); off,
 * every prompt is today's. A running session hears the flip as the changed sentence, and every
 * prompt stays within its caps.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-thread-each-question-prompt'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { setThreadsKept } from '../../../src/core/org/threads-kept.js'
import { setReplyTag } from '../../../src/core/org/reply-card-switch.js'
import { setBriefOff } from '../../../src/core/org/brief-off.js'
import { setEachQuestion } from '../../../src/core/org/thread-question.js'
import { defaultInstructions, orgRoleLine } from '../../../src/core/sessions/session-context.js'
import { dueChanges, parseInstructions, renderDue } from '../../../src/core/sessions/instruction-diff.js'
import { PROMPT_BUDGETS, promptBlock } from '../../../src/core/sessions/prompt-blocks.js'
import { composeRolePrompt, seedFixtureHome } from '../../helpers/prompt-size-fixture.js'

const lead = { id: 'lead-1', title: 'Garden VP', org_role: 'lead' as const }
const main = { ...lead, org_role: 'main' as const }
const task = { id: 't-1', title: 'Seed order', threads_on: true }
const plain = { id: 't-2', title: 'Fence posts' }

const SAME = 'Several asks about the same thing are one thread: put a new one under the open thread it belongs to (merge_into). '
const SAME_KEPT = 'Several asks about the same thing are one thread; '
const EACH = 'Each question he asks is its own thread, even on a subject another holds: title it by what it asks, answer it there, never merge it; a remark that asks nothing goes under its thread (merge_into). '
const EACH_KEPT = 'Each question he asks is its own thread, even on a subject another holds: title it by what it asks, answer it there, never merge it; a remark that asks nothing goes with its thread; '
const MODES = [['plain', false, false], ['kept', true, false], ['tag', true, true]] as const

beforeAll(async () => { await seedFixtureHome(WALNUT_HOME) })
afterEach(() => { setThreadsKept(false); setReplyTag(false); setBriefOff(false); setEachQuestion(false) })

function variants(): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const off of [false, true]) {
    setBriefOff(off)
    out.push([`lead, brief ${off ? 'off' : 'on'}`, orgRoleLine(lead as never)], [`main, brief ${off ? 'off' : 'on'}`, orgRoleLine(main as never)])
  }
  setBriefOff(false)
  out.push(['task with Threads', orgRoleLine(task as never)], ['task without Threads', orgRoleLine(plain as never)])
  return out
}

describe('the rule text, on and off', () => {
  for (const [mode, kept, tag] of MODES) {
    it(`${mode}: off is today's text, on replaces only the one sentence`, () => {
      setThreadsKept(kept)
      setReplyTag(tag)
      const off = new Map(variants())
      setEachQuestion(false)
      expect(new Map(variants())).toEqual(off)
      setEachQuestion(true)
      const on = new Map(variants())
      const [was, now] = kept || tag ? [SAME_KEPT, EACH_KEPT] : [SAME, EACH]
      for (const [name, text] of off) {
        if (name === 'task without Threads') { expect(on.get(name)).toBe(text); continue }
        expect(text, name).toContain(was)
        expect(on.get(name), name).toContain(now)
        expect(on.get(name), name).not.toContain('Several asks about the same thing')
        // The task's block is another version (its head names it); its rules differ by the sentence alone.
        const body = (s: string) => (name.startsWith('task') ? s.split('\n').slice(1).join('\n') : s)
        expect(body(on.get(name)!), name).toBe(body(text).replace(was, now))
        if (name.startsWith('task')) expect(on.get(name)!.split('\n')[0]).not.toBe(text.split('\n')[0])
      }
    })
  }

  it('the bytes it adds to every prompt that carries it', () => {
    expect(Buffer.byteLength(SAME)).toBe(114)
    expect(Buffer.byteLength(EACH)).toBe(196)
    expect(Buffer.byteLength(SAME_KEPT)).toBe(50)
    expect(Buffer.byteLength(EACH_KEPT)).toBe(182)
  })
})

describe('a running session hears the switch', () => {
  for (const [who, t] of [['a lead', lead], ['main', main], ['a task with Threads', task]] as const) {
    it(`${who}: the new sentence is told when it turns on, the old one when it turns off`, () => {
      setThreadsKept(true)
      const before = parseInstructions(defaultInstructions(t as never))
      setEachQuestion(true)
      const after = parseInstructions(defaultInstructions(t as never))
      const due = dueChanges(after, before, new Set(), {})
      expect(due).not.toBeNull()
      expect(renderDue(due!)).toContain('Each question he asks is its own thread')
      setEachQuestion(false)
      const back = dueChanges(parseInstructions(defaultInstructions(t as never)), after, new Set(), {})
      expect(back).not.toBeNull()
      expect(renderDue(back!)).toContain('Several asks about the same thing are one thread')
    })
  }
})

describe('the always-loaded prompt stays within its caps with the rule in it', () => {
  it.each(['main', 'lead', 'worker', 'ask'] as const)('%s: every block within its cap, the prompt within its budget, in every mode', async (role) => {
    setEachQuestion(true)
    for (const [, kept, tag] of MODES) {
      setThreadsKept(kept)
      setReplyTag(tag)
      for (const off of [false, true]) {
        setBriefOff(off)
        const p = await composeRolePrompt(role)
        for (const b of p.blocks) expect(b.chars, `${role}: block ${b.id}`).toBeLessThanOrEqual(promptBlock(b.id).cap)
        expect(p.chars, role).toBeLessThanOrEqual(PROMPT_BUDGETS[role])
      }
    }
  })
})
