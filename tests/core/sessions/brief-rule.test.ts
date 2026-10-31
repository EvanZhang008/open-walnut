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
import { briefPrompt, briefSectionLines, keepsBrief, readBrief } from '../../../src/core/sessions/brief.js'
import { briefIssues, briefItemLines } from '../../../src/core/sessions/brief-rules.js'
import { buildSelfReportPrompt, extractField } from '../../../src/core/session-hooks/builtins.js'
import { BRIEF_MAX_CHARS, briefTeam } from '../../../src/core/user-status.js'
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
      /At the end of every turn Walnut asks you for it in a separate question of its own \(FOR_USER_BRIEF\)/,
      // 2026-10-29: after a compaction a lead wrote the Brief into its reply.
      /never write the Brief or that field into your replies/,
      /Rewrite it whole each time/,
      // 2026-10-30: three sections every time, each task under its own live status.
      /in three sections, always all three, in this order: "### Needs you" \(what the user must decide or do\), "### Working" \(in progress\) and "### Waiting \/ snoozed"/,
      /each task goes in the section of its own live status/,
      /One thing per line, each line starting with the <task-ref\/> of the task it is about/,
      /Main names the VP who leads it right after/,
      /Walnut checks these rules/,
      /shows each task it names with its live status/,
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
  it('is asked of Main and leads only, in its three sections, with the team\'s live lists', () => {
    const sections = { needs: ['- <task-ref id="w1" label="Fix the fence"/>: "Pick a supplier?" (checked 5 minutes ago by its session)'], working: [], waiting: [] }
    const lead = buildSelfReportPrompt('', 'Garden lead', { brief: { hadBrief: true, sections } })
    expect(lead).toContain('FOR_USER_BRIEF:')
    expect(lead).toContain('Rewrite it whole every time (never "unchanged")')
    expect(lead).toContain('"### Needs you", "### Working", "### Waiting / snoozed"')
    expect(lead).toContain(`### Needs you\n${sections.needs[0]}\n### Working\n(none now)\n### Waiting / snoozed\n(none now)`)
    expect(buildSelfReportPrompt('', 'A worker')).not.toContain('FOR_USER_BRIEF')
    expect(briefPrompt({ hadBrief: false, language: 'Chinese' })).toContain('in Chinese')
    // Every line names its task, the writer's own task for its own work.
    const own = briefPrompt({ hadBrief: true, ownId: 'lead-1' })
    expect(own).toContain('EVERY line starts with the <task-ref')
    expect(own).toContain('<task-ref id="lead-1" label="..."/>')
  })

  it('reads the letter back whole, after the FOR_USER lines, and caps it', () => {
    const report = 'FOR_USER_STATE: waiting\nFOR_USER_NEXT: I merge once the review passes.\nFOR_USER_BRIEF:\n**Needs you:** pick a supplier.\n- <task-ref id="w1" label="Fix the fence"/>: done, waits on the review.'
    expect(extractField(report, 'FOR_USER_NEXT')).toBe('I merge once the review passes.')
    const brief = readBrief(extractField(report, 'FOR_USER_BRIEF'), '2026-10-26T10:00:00.000Z')
    expect(brief).toEqual({ text: '**Needs you:** pick a supplier.\n- <task-ref id="w1" label="Fix the fence"/>: done, waits on the review.', at: '2026-10-26T10:00:00.000Z' })
    expect(readBrief('unchanged')).toBeNull()
    // A session that bolds the label ("**FOR_USER_BRIEF:**") closes the bold after the colon:
    // those stars are the label's, and the letter keeps its own bold (2026-10-26, Main's Brief
    // opened with a lone "**" line).
    const bolded = '**FOR_USER_NEXT:** I merge.\n**FOR_USER_BRIEF:**\n**Needs you:**\n- <task-ref id="w1" label="Fence"/>: pick a supplier.'
    expect(extractField(bolded, 'FOR_USER_NEXT')).toBe('I merge.')
    expect(extractField(bolded, 'FOR_USER_BRIEF')).toBe('**Needs you:**\n- <task-ref id="w1" label="Fence"/>: pick a supplier.')
    expect(extractField('FOR_USER_BRIEF: **Needs you:** nothing.', 'FOR_USER_BRIEF')).toBe('**Needs you:** nothing.')
    expect(readBrief('**\n**Needs you:** nothing.')!.text).toBe('**Needs you:** nothing.')
    expect(readBrief('')).toBeNull()
    expect(readBrief('x'.repeat(BRIEF_MAX_CHARS + 50))!.text.length).toBe(BRIEF_MAX_CHARS)
  })
})

describe('lines that name no task', () => {
  it('are the item lines with no <task-ref/>; section labels are not items', () => {
    const text = '**Needs you:**\n- Delete the six stacks?\n- <task-ref id="w1" label="Fence"/>: pick a supplier.\n\n**Work:**\n1. Login is faster now.\nA plain sentence.'
    expect(briefItemLines(text)).toEqual(['- Delete the six stacks?', '- <task-ref id="w1" label="Fence"/>: pick a supplier.', '1. Login is faster now.', 'A plain sentence.'])
    const owner = task({ id: 'lead', title: 'Lead', org_role: 'lead', project: 'Garden' })
    expect(briefIssues(text, owner, [owner]).filter((i) => i.kind === 'no_task').map((i) => i.line))
      .toEqual(['- Delete the six stacks?', '1. Login is faster now.', 'A plain sentence.'])
  })
})

describe('the team and its lists', () => {
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
    // A plugin's own task is no one's team (Task.plugin_only), also below Main.
    task({ id: 'p1', title: 'Practice partner', project: 'Garden', plugin_only: 'practice', phase_changed_at: at(9) }),
    task({ id: 'p2', title: 'Practice below Main', project: 'Tax', parent_task_id: 'main', plugin_only: 'practice' }),
  ]
  it('a lead\'s team is its projects and every task below it; Main\'s is the leads and every task below Main', () => {
    expect(briefTeam(lead, all).map((t) => t.id).sort()).toEqual(['g1', 'g2', 'old', 's1', 'x1'])
    expect(briefTeam(main, all).map((t) => t.id).sort()).toEqual(['lead', 'm1', 'm2'])
  })
  it('a lead with no project of its own never takes in the Inbox', () => {
    const loose = task({ id: 'loose', title: 'Loose lead', project: '', org_role: 'lead', org_leads: ['Seeds'] })
    expect(briefTeam(loose, all).map((t) => t.id)).toEqual(['s1'])
  })
  it('lists the team\'s open work by the section its live status puts it in', () => {
    const lists = briefSectionLines(lead, all)
    expect(lists.needs).toEqual(['- <task-ref id="g1" label="Plant the beds"/>: "Which beds?" (Walnut\'s live record)'])
    // Done work (s1) has no section; another project's task (o1) is not the team.
    const named = [...lists.needs, ...lists.working, ...lists.waiting].join('\n')
    expect(named).not.toContain('id="s1"')
    expect(named).not.toContain('id="o1"')
    expect(lists.working.length + lists.waiting.length).toBe(3)
  })
})
