/**
 * Passing on the user's request: his exact words first, then only checked context, and never
 * steering the task's decision (src/core/delegate-words.ts; 2026-11-21, the user, after a VP added
 * its own approach and checklist to his words: "you can add some context, but you cannot influence
 * its decision ... update Walnut itself").
 *
 * Every reader of the rule is held here: the charter in the prompt of a worker, a lead and Main (and
 * the operating contract and persona), the live op help of every send and of task_create and
 * task_start, the `hand-on` hint on Main's and a lead's messages, and the messaging skill. A reader
 * that loses the rule fails, and so does a rule that loses the words that make it work.
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-delegate-words'))

import { DELEGATE_WORDS_HAND_ON, DELEGATE_WORDS_MARKS, DELEGATE_WORDS_RULE, DELEGATE_WORDS_SHORT } from '../../src/core/delegate-words.js'
import { MESSAGE_TEXT_HINT, TEAM_CHARTER } from '../../src/core/team-charter.js'
import { buildSessionContext, defaultInstructions } from '../../src/core/sessions/session-context.js'
import { renderSelfKnowledgeContract } from '../../src/core/self-knowledge-contract.js'
import { buildRoleSection } from '../../src/core/sessions/persona-sections.js'
import { orgHandOnHint } from '../../src/core/org/core-instructions.js'
import { dueChanges, parseInstructions, renderDue } from '../../src/core/sessions/instruction-diff.js'
import { getOp } from '../../src/ops/index.js'
import type { Task } from '../../src/core/types.js'

const REPO = path.resolve(__dirname, '../..')

function task(over: Partial<Task>): Task {
  return { id: 'mt-relay-1', title: 'Hand on the voice bug', project: 'marina', phase: 'IN_PROGRESS', ...over } as Task
}

describe('the rule', () => {
  it('words first, only checked context, never steer, the task decides, discuss at the end', () => {
    for (const text of [DELEGATE_WORDS_RULE, DELEGATE_WORDS_SHORT, DELEGATE_WORDS_HAND_ON]) {
      for (const mark of DELEGATE_WORDS_MARKS) expect(text).toContain(mark)
    }
    expect(DELEGATE_WORDS_RULE).toMatch(/quote their own words first, exactly, with every screenshot they gave/)
    expect(DELEGATE_WORDS_RULE).toMatch(/each fact with its source \(else say whose word it is\)/)
    expect(DELEGATE_WORDS_RULE).toMatch(/no plan, fix, checklist, options or pick of your own, because the task holds more context and decides/)
    expect(DELEGATE_WORDS_RULE).toMatch(/the discussion with the user comes at the end/)
    expect(DELEGATE_WORDS_RULE).toMatch(/Steps the user named \(design first, ask him before building\) pass on exactly/)
    expect(DELEGATE_WORDS_RULE).toMatch(/A summary can narrow what they asked; their words cannot\./)
    expect(DELEGATE_WORDS_SHORT).toMatch(/the task decides/)
  })

  it('is plain ASCII English with no dash punctuation', () => {
    for (const text of [DELEGATE_WORDS_RULE, DELEGATE_WORDS_SHORT, DELEGATE_WORDS_HAND_ON]) {
      expect(text).toMatch(/^[\x20-\x7e]+$/)
      expect(text).not.toMatch(/ - /)
    }
  })
})

describe('every way a session learns it', () => {
  it('a bullet of the charter', () => {
    expect(TEAM_CHARTER).toContain(`\n- ${DELEGATE_WORDS_RULE}\n`)
  })

  for (const [label, over] of [
    ['worker', {}], ['subtask of a leader', { parent_task_id: 'mt-relay-0' }],
    ['project lead', { org_role: 'lead' }], ['main agent', { org_role: 'main', project: 'Ask Walnut', walnut_agent: true }],
  ] as Array<[string, Partial<Task>]>) {
    it(`a ${label}'s session prompt`, async () => {
      expect((await buildSessionContext('mt-relay-1', '/x', 'h', { task: task(over) })).systemPrompt).toContain(DELEGATE_WORDS_RULE)
    })
  }

  it('the operating contract and the persona', () => {
    for (const text of [renderSelfKnowledgeContract(), buildRoleSection('Ada')]) expect(text).toContain(DELEGATE_WORDS_RULE)
  })

  it('the live help of every op that hands work on (a session spawned before still reads it)', () => {
    expect(MESSAGE_TEXT_HINT).toContain(DELEGATE_WORDS_SHORT)
    for (const [op, param] of [['task_send', 'text'], ['org_send', 'text'], ['board_post', 'text'], ['task_create', 'message'], ['task_start', 'message']] as const) {
      const schema = getOp(op)?.input[param]
      expect(schema, `${op}.${param}`).toBeDefined()
      expect(schema!.description, `${op}.${param}`).toContain(DELEGATE_WORDS_SHORT)
    }
  })

  it('the hand-on hint that rides Main\'s and a lead\'s messages', () => {
    for (const role of ['main', 'lead'] as const) expect(orgHandOnHint(role)).toContain(DELEGATE_WORDS_HAND_ON)
  })

  it('the messaging skill', () => {
    const skill = fs.readFileSync(path.join(REPO, 'src/data/skills/walnut-session-messaging/SKILL.md'), 'utf8')
    expect(skill).toMatch(/\*\*Pass on the user's words, not your reading of them, and never steer\.\*\*/)
    expect(skill).toMatch(/add only context you checked/)
    expect(skill).toMatch(/Never add a plan, a fix, a checklist, options or your pick: the task holds more context and decides/)
  })
})

describe('a session spawned before it hears only this line', () => {
  it('the notice carries the reworded relay bullet and no other line', () => {
    const now = defaultInstructions(task({}))
    const old = now.replace(DELEGATE_WORDS_RULE, 'When you pass on the user\'s request to another task, quote their own words first, exactly, '
      + 'with every screenshot they gave (its path or link), then your summary. A summary can narrow what they asked; their words cannot.')
    expect(old).not.toBe(now)
    const due = dueChanges(parseInstructions(now), parseInstructions(old), new Set(), {}, {})
    const bullets = (due ? renderDue(due) : '').split('\n').filter((l) => l.startsWith('- '))
    expect(bullets).toEqual([`- ${DELEGATE_WORDS_RULE}`])
  })
})
