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

  it('says a leader adopts with task_update, and that worker and subtask are one word', () => {
    expect(SKILL).toMatch(/task_update\s+\{"id": "<it>", "parent_task_id": "<your id>"\}/)
    expect(SKILL).toMatch(/`""` releases it/)
    expect(SKILL).toMatch(/\*\*Worker\*\* pill and its parent a \*\*Leader\*\* pill/)
  })

  it('points a leader at the Board and the walnut-board skill', () => {
    const section = SKILL.indexOf('## The Board (a leader\'s standing surface)')
    expect(section).toBeGreaterThan(SKILL.indexOf('**A subtask is a teammate, not a step.**'))
    expect(section).toBeLessThan(SKILL.indexOf('## Recording and starting work'))
    expect(SKILL).toMatch(/board_get.*board_set.*board_edit.*board_post/s)
    expect(SKILL).toContain('walnut tools call skill_read \'{"dirName":"walnut-board"}\'')
  })
})

describe('walnut-board skill', () => {
  const BOARD = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'data', 'skills', 'walnut-board', 'SKILL.md'), 'utf-8')

  it('names the four ops, the five components and the template', () => {
    for (const op of ['board_get', 'board_set', 'board_edit', 'board_post']) expect(BOARD).toContain(`\`${op}`)
    for (const el of ['walnut-task', 'walnut-thread', 'walnut-mark', 'walnut-strip', 'walnut-unread']) {
      expect(BOARD).toContain(`<${el}`)
    }
    expect(BOARD).toMatch(/```html\n<!doctype html>/)
    expect(BOARD).toMatch(/data-status="decide"/)
  })

  it('carries the lessons: sections are areas, re-pull live state, a question is three writes, a worker owns its area', () => {
    expect(BOARD).toMatch(/Sections are areas of work, not buckets/)
    expect(BOARD).toMatch(/re-pull the live state/i)
    expect(BOARD).toMatch(/A user's question in a thread is three writes/)
    expect(BOARD).toMatch(/A worker's area belongs to the worker/)
    expect(BOARD).toMatch(/a thread at the bottom of the page is useless/i)
  })

  it('ships with the ops registered', () => {
    const names = listOps().map((op) => op.name)
    for (const op of ['board_get', 'board_set', 'board_edit', 'board_post', 'board_project_set', 'board_remind']) expect(names).toContain(op)
  })

  it('round two: projects, points, choices, reminders, and one board per team', () => {
    for (const op of ['board_project_set', 'board_remind', 'board_post_delete']) expect(BOARD).toContain(`\`${op}`)
    for (const el of ['walnut-project', 'walnut-check', 'walnut-choice']) expect(BOARD).toContain(`<${el}`)
    expect(BOARD).toContain('data-project="')
    expect(BOARD).toContain('data-choice="')
    // A board project is an area of the board, never a Walnut project.
    expect(BOARD).toMatch(/A \*\*board project\*\* is one area on this board: one cause or one ticket\. It is NOT a\s+Walnut project/)
    expect(BOARD).toMatch(/\*\*A team shares one board\*\*: the nearest ancestor that has a board, else the root\s+leader's/)
    expect(BOARD).not.toMatch(/A worker updating its leader's board passes the leader's id/)
  })

  it('carries the user\'s board-writing rules', () => {
    expect(BOARD).toMatch(/Ask the user as little as possible/)
    expect(BOARD).toMatch(/Never ask the user to resolve or close something whose work is not finished/)
    expect(BOARD).toMatch(/Every ask and every point explains itself in plain words/)
    expect(BOARD).toMatch(/Every reference is a link with a plain label/)
    expect(BOARD).toMatch(/never a bundle\. There is no "all new items" and no "other" project/)
    expect(BOARD).toMatch(/An overview first/)
    expect(BOARD).toMatch(/No side-by-side grids unless the content really is a comparison/)
    expect(BOARD).toMatch(/Every fact, cause, fix and to-do is its own `<walnut-check>` point/)
    expect(BOARD).toMatch(/Project status lives in Walnut/)
    expect(BOARD).toMatch(/One message per post: never paste a history as one blob/)
    expect(BOARD).toMatch(/When the user says "later", set a reminder/)
    expect(BOARD).toMatch(/Put the user's mark in the overview row or at the bottom of a section/)
    expect(BOARD).toMatch(/A section you changed shows the user a red dot on its own/)
    expect(BOARD).not.toMatch(/[\u2013\u2014]/)
  })
})
