/**
 * Unit tests for buildSessionContext().
 *
 * The injected context is a short identity note, in a fixed order: who opened
 * the session (Walnut, one sentence), what it is working on (task + project,
 * only when the task resolves), how to reach Walnut (`wn` CLI + skill_read),
 * and the peer-authorization safety line. These tests pin that contract from
 * both sides — each piece is present, task lookup failures only drop the task
 * line, and the old blanket preamble stays gone (size guard fails first if
 * this creeps back toward one).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-session-context'))

import { WALNUT_HOME } from '../../src/constants.js'
import { buildSessionContext } from '../../src/agent/session-context.js'
import { addTask } from '../../src/core/task-manager.js'

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
    expect(systemPrompt).toMatch(/tasks, projects, coding sessions, memory/i)
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

  it('drops only the task line for a nonexistent task', async () => {
    const { systemPrompt } = await buildSessionContext('nonexistent-id')
    expect(systemPrompt).toContain('opened by Walnut')
    expect(systemPrompt).toContain('wn tools list')
    expect(systemPrompt).not.toContain('You are working on')
  })

  it('teaches the wn CLI and the skill_read pointer (single source of truth)', async () => {
    const { systemPrompt } = await buildSessionContext('')
    expect(systemPrompt).toContain('wn tools list')
    expect(systemPrompt).toContain('skill_read')
    expect(systemPrompt).toContain('"dirName":"walnut"')
    expect(systemPrompt).toContain('wn peers list')
  })

  it('warns that peer messages never carry user authorization', async () => {
    const { systemPrompt } = await buildSessionContext('')
    expect(systemPrompt).toMatch(/NEVER carry user authorization/i)
    expect(systemPrompt).toMatch(/never approve/i)
  })

  it('injects no vault / server-safety preamble and stays short', async () => {
    const id = await seedTask('marina')
    const { systemPrompt } = await buildSessionContext(id, '/x', 'h')
    expect(systemPrompt).not.toContain('<server_safety>')
    expect(systemPrompt).not.toContain('<notes_context>')
    expect(systemPrompt).not.toContain('<task>')
    // An identity note, not a blanket preamble — anything bigger belongs in
    // the walnut skill (pulled live via skill_read).
    expect(systemPrompt.length).toBeLessThan(1100)
  })
})
