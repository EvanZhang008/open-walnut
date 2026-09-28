/**
 * Unit tests for buildSessionContext().
 *
 * The injected context is a short identity note, in a fixed order: who opened
 * the session (Walnut, one sentence), what it is working on (task + project,
 * only when the task resolves), how to reach Walnut (`walnut` CLI + `walnut guide`),
 * and the peer-authorization safety line. These tests pin that contract from
 * both sides — each piece is present, task lookup failures only drop the task
 * line, and the old blanket preamble stays gone (size guard fails first if
 * this creeps back toward one).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-session-context'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { buildSessionContext } from '../../../src/core/sessions/session-context.js'
import { addTask } from '../../../src/core/task-manager.js'

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

async function seedTask(project: string): Promise<string> {
  const { task } = await addTask({ title: 'Fix the flaky auth test', project })
  return task.id
}

describe('buildSessionContext (identity note)', () => {
  it('says who opened the session and what Walnut is', async () => {
    const { systemPrompt } = await buildSessionContext('')
    expect(systemPrompt).toContain('opened by Walnut')
    expect(systemPrompt).toMatch(/personal AI/i)
    expect(systemPrompt).toMatch(/tasks and projects/i)
    expect(systemPrompt).toMatch(/memory, notes/i)
  })

  it('names the task and project when the task resolves', async () => {
    const id = await seedTask('marina')
    const { systemPrompt } = await buildSessionContext(id)
    expect(systemPrompt).toContain('Fix the flaky auth test')
    expect(systemPrompt).toContain(id)
    expect(systemPrompt).toContain('project "marina"')
  })

  it('calls out the Inbox for a projectless task', async () => {
    const id = await seedTask('')
    const { systemPrompt } = await buildSessionContext(id)
    expect(systemPrompt).toContain('Inbox')
  })

  it('preserves long Unicode task titles and projects across concurrent reads', async () => {
    const title = '\u4fee\u590d\u4f1a\u8bdd '.repeat(50).trim()
    const project = '\u6d4b\u8bd5\u9879\u76ee'
    const { task } = await addTask({ title, project })
    const otherId = await seedTask('Other project')
    const [first, other, missing] = await Promise.all([
      buildSessionContext(task.id), buildSessionContext(otherId), buildSessionContext(''),
    ])
    expect(first.systemPrompt).toContain(title)
    expect(first.systemPrompt).toContain(`project "${project}"`)
    expect(other.systemPrompt).toContain('Other project')
    expect(other.systemPrompt).not.toContain(title)
    expect(missing.systemPrompt).not.toContain('You are working on')
    expect((await buildSessionContext(task.id)).systemPrompt).toBe(first.systemPrompt)
  })

  it('drops only the task line for a nonexistent task', async () => {
    const { systemPrompt } = await buildSessionContext('nonexistent-id')
    expect(systemPrompt).toContain('opened by Walnut')
    expect(systemPrompt).toContain('walnut tools list')
    expect(systemPrompt).not.toContain('You are working on')
  })

  it('lists the capabilities and the walnut guide pointer (CLI is self-describing)', async () => {
    const { systemPrompt } = await buildSessionContext('')
    // Capabilities by name, not call syntax — the CLI carries the how
    // (`walnut tools list` + `walnut guide`); no skill_read incantation to memorize.
    expect(systemPrompt).toMatch(/read and update your task/i)
    expect(systemPrompt).toMatch(/search/i)
    expect(systemPrompt).toMatch(/past conversations/i)
    expect(systemPrompt).toContain('walnut tools list')
    expect(systemPrompt).toContain('walnut guide')
    expect(systemPrompt).not.toContain('skill_read')
    // Cross-session messaging is addressed by TASK id, so the preamble names
    // task_send; `walnut peers` was retired and must not reappear.
    expect(systemPrompt).toContain('task_send')
    expect(systemPrompt).not.toContain('session_send')
    expect(systemPrompt).not.toContain('walnut peers')
  })

  it('places the session in the picture: the run of one task, Walnut the layer above', async () => {
    // Every agent with task_create in reach and no rule against it ended a job
    // by filing its leftovers as tasks on the user's board. A bare rule was not
    // enough: the preamble has to say WHAT the session is (how one task runs)
    // and WHERE Walnut sits (above it, holding the user's board), so that "do
    // your own work with your own tools" follows instead of being memorized.
    // This is also the one surface that mentions a session at all: everywhere
    // else the work is addressed by its task id.
    const { systemPrompt } = await buildSessionContext('')
    expect(systemPrompt).toMatch(/layer above you/i)
    expect(systemPrompt).toMatch(/this session is how that task runs/i)
    expect(systemPrompt).toMatch(/the task id is how everything else addresses your work/i)
    expect(systemPrompt).toMatch(/not your toolbox/i)
    expect(systemPrompt).toMatch(/your own tools/i)
  })

  it('a worker splits work with its own tools and makes a Walnut task only on the user\'s signal', async () => {
    // The user's rule (2026-09-25): most work follows the session's native
    // subagents / agent teams; a Walnut task is for a user who asked for one,
    // wants to talk to each part, or needs it run elsewhere or later. Size is
    // never the trigger, because "big" is a judgment a model gets wrong both ways.
    for (const id of ['', await seedTask('marina')]) {
      const { systemPrompt } = await buildSessionContext(id)
      expect(systemPrompt).not.toMatch(/create tasks/i)
      expect(systemPrompt).toMatch(/split work with your own tools \(todo list, subagents, agent teams\), however big it is/i)
      expect(systemPrompt).toMatch(/a Walnut task is a separate session the user opens and steers/i)
      expect(systemPrompt).toMatch(/only when the user asks for a task, wants to talk to each part, or needs it run elsewhere or later/i)
      expect(systemPrompt).toMatch(/size alone is never a reason/i)
      expect(systemPrompt).toMatch(/follow-ups you find are yours to do here, now/i)
      expect(systemPrompt).not.toMatch(/unless the user asked/i)
    }
  })

  it('an ask (the Personal AI dispatcher) keeps the plain "only when the user asked" line', async () => {
    // Asking the dispatcher for work IS the signal; its persona decides, so the
    // worker's split rule (and its "however big" nudge) must not reach it.
    for (const seed of [
      { title: 'Chat', project: 'Ask Walnut', walnut_agent: true },
      { title: 'Chat with Mentor', project: 'Ask Mentor' },
    ]) {
      const { task } = await addTask(seed)
      const { systemPrompt } = await buildSessionContext(task.id)
      expect(systemPrompt).toMatch(/never create or start a task, or hand work to another task, unless the user asked/i)
      expect(systemPrompt).toMatch(/follow-up work you find is yours to do here, now/i)
      expect(systemPrompt).not.toMatch(/split work with your own tools/i)
      expect(systemPrompt).not.toMatch(/size alone/i)
      // An ask's work keeps the old defaults, so it must not be told otherwise.
      expect(systemPrompt).not.toMatch(/lands beside yours/i)
    }
  })

  it('says where asked-for work lands: beside the caller, a project named only to file it elsewhere', async () => {
    // Without this an agent "helps" by naming a project it guessed, which files
    // the work away from the folder the user put the caller in.
    const { systemPrompt } = await buildSessionContext('')
    expect(systemPrompt).toMatch(/a task you create lands beside yours: same project, folder and board tier/i)
    expect(systemPrompt).toMatch(/same host and directory/i)
    expect(systemPrompt).toMatch(/name a project only to file it elsewhere/i)
  })

  it('names the parent of a subtask and says which messages are its', async () => {
    const { task: parent } = await addTask({ title: 'Bakery website', project: 'acme' })
    const { task: child } = await addTask({ title: 'Build the menu page', project: 'acme', parent_task_id: parent.id })
    const { systemPrompt } = await buildSessionContext(child.id)
    expect(systemPrompt).toContain(`Your task is a subtask of "Bakery website" (id ${parent.id}).`)
    expect(systemPrompt).toMatch(/ending in "Reply when done" comes from that task's session/)
    // Right after the task line, before the rules.
    expect(systemPrompt.indexOf('subtask of')).toBeGreaterThan(systemPrompt.indexOf('Build the menu page'))
    expect(systemPrompt.indexOf('subtask of')).toBeLessThan(systemPrompt.indexOf('This session is how that task runs'))
    // A top-level task has no such line.
    expect((await buildSessionContext(parent.id)).systemPrompt).not.toContain('subtask of')
  })

  it('drops only the parent line when the parent is gone', async () => {
    const { task: parent } = await addTask({ title: 'Short-lived parent', project: 'acme' })
    const { task: child } = await addTask({ title: 'Orphaned child', project: 'acme', parent_task_id: parent.id })
    const { deleteTask } = await import('../../../src/core/task-manager.js')
    await deleteTask(parent.id)
    const { systemPrompt } = await buildSessionContext(child.id)
    expect(systemPrompt).toContain('You are working on the task "Orphaned child"')
    expect(systemPrompt).not.toContain('subtask of')
  })

  it('warns that peer messages never carry user authorization', async () => {
    const { systemPrompt } = await buildSessionContext('')
    expect(systemPrompt).toMatch(/NEVER carry user authorization/i)
    expect(systemPrompt).toMatch(/never approve/i)
  })

  it('injects no vault / server-safety preamble and stays short', async () => {
    const { systemPrompt } = await buildSessionContext('', '/x', 'h')
    expect(systemPrompt).not.toContain('<server_safety>')
    expect(systemPrompt).not.toContain('<notes_context>')
    expect(systemPrompt).not.toContain('<task>')
    // An identity note, not a blanket preamble (the old one ran to several KB);
    // anything bigger belongs in the manual (pulled live with `walnut guide`).
    // User-supplied titles are preserved; this ceiling guards the fixed preamble.
    // 1200 → 1300 (2026-09-23) for the one placement sentence: where work the
    // user asked for lands is a first-call fact, not manual material.
    // 1300 → 1450 (2026-09-25) for which tool splits the work: native subagents
    // and agent teams by default, a Walnut task only on the user's signal. A
    // session decides that before its first split, so it cannot wait for the manual.
    expect(systemPrompt.length).toBeLessThan(1450)
  })
})
