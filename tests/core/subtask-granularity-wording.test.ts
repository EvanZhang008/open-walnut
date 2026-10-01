/**
 * What a Walnut subtask IS, in the two places a session reads before it files
 * one: the task_create description and the walnut skill.
 *
 * 2026-10-01: asked for one quiet mitigation "with a subtask", a session filed
 * one task per sentence of the brief, then a fourth for the third one's
 * follow-up (in the second one's area), then a fifth for a write-up. The old
 * words invited it: "want to talk to or steer each part" and "one task per unit
 * of work". A subtask is a teammate that owns an area, one per ask, and more
 * work in its area goes to it. The session prompt half is pinned in
 * tests/core/sessions/session-context.test.ts.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { listOps } from '../../src/ops/index.js'

const SKILL = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'data', 'skills', 'walnut', 'SKILL.md'), 'utf-8')

describe('task_create description', () => {
  const desc = listOps().find((op) => op.name === 'task_create')!.description

  it('says a task is a teammate owning one area, one per ask, its follow-ups sent to it', () => {
    expect(desc).toMatch(/a task is a teammate that owns one area with a clear goal, never a step/i)
    expect(desc).toMatch(/one task per ask \(ask the user before splitting\)/i)
    expect(desc).toMatch(/more work in an area goes to the task that owns it \(task_send/i)
    expect(desc).toMatch(/the result lists the other open subtasks you lead/i)
  })

  it('no longer reads "talk to or steer each part" as a reason to split', () => {
    expect(desc).not.toMatch(/each part/i)
    expect(desc).toMatch(/name the parts they want as separate tasks/i)
  })
})

describe('walnut skill', () => {
  it('has the teammate rules next to the "Your tools or a Walnut task" table', () => {
    const table = SKILL.indexOf('## Your tools or a Walnut task')
    const rules = SKILL.indexOf('**A subtask is a teammate, not a step.**')
    expect(table).toBeGreaterThan(-1)
    expect(rules).toBeGreaterThan(table)
    expect(rules).toBeLessThan(SKILL.indexOf('## Recording and starting work'))
    expect(SKILL).toMatch(/One ask, one task\./)
    expect(SKILL).toMatch(/propose the split to the user and wait for their answer/)
    expect(SKILL).toMatch(/More work in an area goes to the task that owns it/)
    expect(SKILL).toMatch(/"Use subtasks" covers the ask it came with/)
    expect(SKILL).toMatch(/placement\.open_subtasks/)
  })

  it('splits per part only when the user named the parts', () => {
    expect(SKILL).toContain('| asks for a task, a ticket, or something on their board | ONE Walnut task that owns the whole ask |')
    expect(SKILL).toContain('| one Walnut task per part they named |')
    expect(SKILL).not.toMatch(/wants to talk to, review or steer each part/)
    expect(SKILL).not.toMatch(/One task per unit of work/)
  })
})
