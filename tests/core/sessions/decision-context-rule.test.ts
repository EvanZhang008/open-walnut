/**
 * A decision never reaches the user as a bare list. 2026-10-26: Main passed on another
 * project lead's nine-item list almost word for word, and the user could not tell which task
 * each item came from, what it does, or what was being decided. The rule lives in the default
 * prompt of Main and of every lead (session-context.ts DECISION_CONTEXT_LINE), not only in a
 * memory. This ratchet keeps every part of it in both prompts and out of a worker's.
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-decision-context'))

import {
  DECISION_CONTEXT_LINE, LEAD_DECISION_LINE, MAIN_DECISION_LINE, buildSessionContext,
} from '../../../src/core/sessions/session-context.js'
import type { Task } from '../../../src/core/types.js'

function task(over: Partial<Task>): Task {
  return { id: 'mt-decide-1', title: 'Plan the move', project: 'marina', phase: 'IN_PROGRESS', ...over } as Task
}

const promptOf = async (over: Partial<Task>) =>
  (await buildSessionContext('mt-decide-1', '/x', 'h', { task: task(over) })).systemPrompt

describe('the decision-with-context rule', () => {
  it('names every part a decision for the user carries', () => {
    for (const re of [
      /never as a bare list/,
      /which task \(its <task-ref\/>\) and what that task is for, in one sentence/,
      /what happened and why it came to this/,
      /the decision itself, in one sentence/,
      /the options and what each one leads to/,
      /which one you recommend and why/,
      /direct links \(the code review, the ticket, the chat thread, the pipeline\)/,
      /No account ids, and no internal tracker codes unless you explain them/,
    ]) expect(DECISION_CONTEXT_LINE).toMatch(re)
  })

  it('Main holds a lead\'s report to it, and keeps every project\'s state through its leads', () => {
    expect(MAIN_DECISION_LINE).toMatch(/lacks any of these, ask that lead to fill it in before the user sees it/)
    expect(MAIN_DECISION_LINE).toMatch(/Your most important duty is to know where every project stands, through its lead, and to make it clear to the user/)
  })

  it('a lead reports to Main with every part', () => {
    expect(LEAD_DECISION_LINE).toMatch(/A report to the main agent that needs a decision from the user carries every one of these parts/)
  })

  it('rides the default prompt of Main and of every lead, and not a worker\'s', async () => {
    const main = await promptOf({ org_role: 'main', project: 'Ask Walnut', walnut_agent: true } as Partial<Task>)
    expect(main).toContain(DECISION_CONTEXT_LINE)
    expect(main).toContain(MAIN_DECISION_LINE)
    expect(main).not.toContain(LEAD_DECISION_LINE)
    for (const over of [{ org_role: 'lead' }, { org_role: 'lead', org_leads: ['lighthouse'] }] as Partial<Task>[]) {
      const lead = await promptOf(over)
      expect(lead).toContain(DECISION_CONTEXT_LINE)
      expect(lead).toContain(LEAD_DECISION_LINE)
      expect(lead).not.toContain(MAIN_DECISION_LINE)
    }
    const worker = await promptOf({})
    expect(worker).not.toContain(DECISION_CONTEXT_LINE)
  })
})
