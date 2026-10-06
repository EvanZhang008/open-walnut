/**
 * The default is no letter (2026-10-05): the user's inbox had filled with
 * "Waiting:" receipts and FYIs that asked nothing of them. The ops a model reads
 * say so, and parking a task offers no letter field at all.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getOp } from '../../../src/ops/index.js'
import { triageLetterBudgetText } from '../../../src/core/triage/letter-rules.js'

describe('human_inbox_send says when NOT to send', () => {
  it('keeps the inbox for what needs the user or what they asked for', () => {
    const d = getOp('human_inbox_send')!.description
    expect(d).toContain('The inbox is only for what needs them')
    expect(d).toContain('when you are blocked on their decision')
    expect(d).toContain('or when they asked for it')
    expect(d).toContain('Never for a notification they did not ask for: progress, a finished step, a parked task, an FYI.')
    expect(d).toContain('When unsure, do not send.')
  })
})

describe('a park writes no letter', () => {
  it('task_update and task_update_bulk have no wait_report, and say a park sends no letter', () => {
    const update = getOp('task_update')!
    expect('wait_report' in update.input).toBe(false)
    expect(update.description).toContain('A park sends no letter')
    expect(z.object(update.input).strict().safeParse({ id: 't1', phase: 'WAITING', wait_report: 'x' }).success).toBe(false)
    const bulk = z.object(getOp('task_update_bulk')!.input).strict()
    expect(bulk.safeParse({ updates: [{ id: 't1', phase: 'WAITING', wait_report: 'x' }] }).success).toBe(false)
    expect(bulk.safeParse({ updates: [{ id: 't1', phase: 'WAITING', wait_until: '2d' }] }).success).toBe(true)
  })

  it('trigger_create says the park sends no letter', () => {
    const op = getOp('trigger_create')!
    expect('wait_report' in op.input).toBe(false)
    expect(op.description).toContain('off the user\'s list, no letter is sent')
    expect(op.description).not.toMatch(/receipt/)
    // A "tell me when" is the user asking for a letter, so the fire's prompt carries that ask.
    expect(op.input.prompt.description).toContain('When the user asked to be told ("tell me when X"), say so here')
  })
})

describe('an Inbox Triage run with nothing for the user sends no summary', () => {
  it('says the summary is conditional, in the budget every run is launched with', () => {
    const budget = triageLetterBudgetText()
    expect(budget).toContain('at most 1 summary letter')
    expect(budget).toContain('Send the summary only when this run has something for the user')
    expect(budget).toContain('A run that only handed items to their tasks, updated notes or')
    expect(budget).toContain('marked mail read sends no letter')
  })
})
