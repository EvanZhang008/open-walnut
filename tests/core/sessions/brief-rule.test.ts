/**
 * The Brief (src/core/sessions/brief.ts): Main and every lead keep a short letter for the user at
 * the top of their chat, and Walnut keeps it current. 2026-10-26, the user: "All the leader or main
 * agent, or VP need to utilize this", and it "must be up to date". This ratchet keeps the rule in
 * the default prompt of Main and of every lead (and out of a worker's), the turn-end ask in their
 * self-report, and the team model the page and the ask share.
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-brief-rule'))

import { BRIEF_LINE, buildSessionContext } from '../../../src/core/sessions/session-context.js'
import { briefMoveLines, briefPrompt, keepsBrief, readBrief } from '../../../src/core/sessions/brief.js'
import { buildSelfReportPrompt, extractField } from '../../../src/core/session-hooks/builtins.js'
import { BRIEF_MAX_CHARS, briefMoves, briefTeam } from '../../../src/core/user-status.js'
import type { Task } from '../../../src/core/types.js'

function task(over: Partial<Task>): Task {
  return { id: 'mt-brief-1', title: 'Plan the move', project: 'marina', phase: 'IN_PROGRESS', ...over } as Task
}

const promptOf = async (over: Partial<Task>) =>
  (await buildSessionContext('mt-brief-1', '/x', 'h', { task: task(over) })).systemPrompt

describe('the Brief rule', () => {
  it('names what the Brief is, when Walnut asks for it, and what it holds', () => {
    for (const re of [
      /the short letter the user reads at the top of your chat/,
      /they answer in your chat/,
      /At the end of every turn Walnut asks you for it \(FOR_USER_BRIEF\)/,
      /rewrite it whole each time/,
      /what needs the user first/,
      /one line per piece of work with its <task-ref\/>/,
      /Walnut shows each task it names with its live status/,
    ]) expect(BRIEF_LINE).toMatch(re)
  })

  it('rides the default prompt of Main and of every lead, and not a worker\'s', async () => {
    expect(await promptOf({ org_role: 'main', project: 'Ask Walnut', walnut_agent: true } as Partial<Task>)).toContain(BRIEF_LINE)
    for (const over of [{ org_role: 'lead' }, { org_role: 'lead', org_leads: ['lighthouse'] }] as Partial<Task>[]) {
      expect(await promptOf(over)).toContain(BRIEF_LINE)
    }
    expect(await promptOf({})).not.toContain(BRIEF_LINE)
    expect([keepsBrief({ org_role: 'main' }), keepsBrief({ org_role: 'lead' }), keepsBrief({})]).toEqual([true, true, false])
  })
})

describe('the turn-end ask', () => {
  it('is asked of Main and leads only, with what moved since the last Brief', () => {
    const moves = ['- <task-ref id="w1" label="Fix the fence"/>: now Needs you (Pick a supplier?)']
    const lead = buildSelfReportPrompt('', 'Garden lead', { brief: { hadBrief: true, moves } })
    expect(lead).toContain('FOR_USER_BRIEF:')
    expect(lead).toContain('Rewrite it whole every time (never "unchanged")')
    expect(lead).toContain('Since your last Brief, these moved in your team')
    expect(lead).toContain(moves[0])
    expect(buildSelfReportPrompt('', 'A worker')).not.toContain('FOR_USER_BRIEF')
    expect(briefPrompt({ hadBrief: false, moves: [], language: 'Chinese' })).toContain('in Chinese')
  })

  it('reads the letter back whole, after the FOR_USER lines, and caps it', () => {
    const report = 'FOR_USER_STATE: waiting\nFOR_USER_NEXT: I merge once the review passes.\nFOR_USER_BRIEF:\n**Needs you:** pick a supplier.\n- <task-ref id="w1" label="Fix the fence"/>: done, waits on the review.'
    expect(extractField(report, 'FOR_USER_NEXT')).toBe('I merge once the review passes.')
    const brief = readBrief(extractField(report, 'FOR_USER_BRIEF'), '2026-10-26T10:00:00.000Z')
    expect(brief).toEqual({ text: '**Needs you:** pick a supplier.\n- <task-ref id="w1" label="Fix the fence"/>: done, waits on the review.', at: '2026-10-26T10:00:00.000Z' })
    expect(readBrief('unchanged')).toBeNull()
    expect(readBrief('')).toBeNull()
    expect(readBrief('x'.repeat(BRIEF_MAX_CHARS + 50))!.text.length).toBe(BRIEF_MAX_CHARS)
  })
})

describe('the team and what moved', () => {
  const at = (min: number) => new Date(Date.parse('2026-10-26T10:00:00Z') + min * 60_000).toISOString()
  const lead = task({ id: 'lead', title: 'Garden lead', project: 'Garden', org_role: 'lead', org_leads: ['Seeds'] })
  const main = task({ id: 'main', title: 'Main', project: 'Ask Walnut', org_role: 'main' })
  const all = [
    lead, main,
    task({ id: 'g1', title: 'Plant the beds', project: 'Garden', phase_changed_at: at(5), user_status: { state: 'needs', ask: 'Which beds?' } }),
    task({ id: 's1', title: 'Label the jars', project: 'Seeds', phase: 'COMPLETE', phase_changed_at: at(10) }),
    task({ id: 'x1', title: 'Elsewhere', project: 'Tax', phase_changed_at: at(7), parent_task_id: 'lead' }),
    task({ id: 'o1', title: 'Other project', project: 'Tax', phase_changed_at: at(8) }),
    task({ id: 'old', title: 'Old news', project: 'Garden', phase_changed_at: at(-60) }),
    // Keyed as the Org tree keys projects: case and spaces do not matter.
    task({ id: 'g2', title: 'Water the beds', project: ' garden ' }),
    task({ id: 'm1', title: 'Main asked for this', project: 'Tax', parent_task_id: 'main' }),
    task({ id: 'm2', title: 'Below that', project: 'Tax', parent_task_id: 'm1' }),
    task({ id: 'in', title: 'An Inbox task', project: '' }),
  ]
  it('a lead\'s team is its projects and every task below it; Main\'s is the leads and every task below Main', () => {
    expect(briefTeam(lead, all).map((t) => t.id).sort()).toEqual(['g1', 'g2', 'old', 's1', 'x1'])
    expect(briefTeam(main, all).map((t) => t.id).sort()).toEqual(['lead', 'm1', 'm2'])
  })
  it('a lead with no project of its own never takes in the Inbox', () => {
    const loose = task({ id: 'loose', title: 'Loose lead', project: '', org_role: 'lead', org_leads: ['Seeds'] })
    expect(briefTeam(loose, all).map((t) => t.id)).toEqual(['s1'])
  })
  it('lists what moved after the Brief, newest first, in the prompt\'s words', () => {
    expect(briefMoves(lead, all, Date.parse(at(0))).map((m) => m.task.id)).toEqual(['s1', 'x1', 'g1'])
    expect(briefMoves(lead, all, NaN)).toEqual([])
    const lines = briefMoveLines({ ...lead, brief: { text: 'x', at: at(0) } }, all)
    expect(lines[0]).toBe('- <task-ref id="s1" label="Label the jars"/>: now Done')
    expect(lines[2]).toBe('- <task-ref id="g1" label="Plant the beds"/>: now Needs you (Which beds?)')
  })
})
