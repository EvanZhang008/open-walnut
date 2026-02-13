/**
 * Unit tests for buildSessionContext().
 *
 * Verifies that the session context builder:
 *   1. Assembles task metadata, subtasks, description, summary, note, sessions, and project memory
 *   2. Gracefully handles missing data (returns partial or empty context)
 *   3. Truncates sections that exceed token budgets
 *   4. Falls back to category-level memory when project memory is absent
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

// Mock constants to isolate from real data
vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, SESSIONS_DIR, PROJECTS_MEMORY_DIR } from '../../src/constants.js'
import { buildSessionContext } from '../../src/agent/session-context.js'

const tmpBase = WALNUT_HOME

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true })
  await fsp.mkdir(tmpBase, { recursive: true })

  // Seed directories
  const tasksDir = path.join(tmpBase, 'tasks')
  await fsp.mkdir(tasksDir, { recursive: true })
  await fsp.mkdir(SESSIONS_DIR, { recursive: true })
})

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
})

// ── Helpers ──

async function seedTask(task: Record<string, unknown>) {
  const tasksDir = path.join(tmpBase, 'tasks')
  await fsp.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: [task],
    }),
  )
}

async function seedSessions(sessions: Record<string, unknown>[]) {
  await fsp.writeFile(
    path.join(tmpBase, 'sessions.json'),
    JSON.stringify({ version: 2, sessions }),
  )
}

async function seedProjectMemory(projectPath: string, content: string) {
  const dirPath = path.join(PROJECTS_MEMORY_DIR, projectPath)
  await fsp.mkdir(dirPath, { recursive: true })
  await fsp.writeFile(path.join(dirPath, 'MEMORY.md'), content)
}

// ═══════════════════════════════════════════════════════════════════
//  Basic context assembly
// ═══════════════════════════════════════════════════════════════════

describe('buildSessionContext', () => {
  it('includes task metadata in the system prompt', async () => {
    await seedTask({
      id: 'ctx-001',
      title: 'Fix the login bug',
      status: 'todo',
      priority: 'immediate',
      category: 'Work',
      project: 'Auth',
      session_ids: [],
      active_session_ids: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      note: '',
    })

    const { systemPrompt } = await buildSessionContext('ctx-001')

    expect(systemPrompt).toContain('Fix the login bug')
    expect(systemPrompt).toContain('todo')
    expect(systemPrompt).toContain('immediate')
    expect(systemPrompt).toContain('Work')
    expect(systemPrompt).toContain('Auth')
    expect(systemPrompt).toContain('<task>')
    expect(systemPrompt).toContain('</task>')
  })

  // Subtask test removed — subtasks are now child tasks in the plugin system

  it('includes note, description, summary', async () => {
    await seedTask({
      id: 'ctx-003',
      title: 'Add feature',
      status: 'todo',
      priority: 'backlog',
      category: 'Work',
      project: 'Work',
      session_ids: [],
      active_session_ids: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      description: 'A detailed description of the feature',
      summary: 'Brief summary of progress so far',
      note: 'First attempt failed due to timeout\n\nNeed to check the database schema\n\nTalked to Sam about the requirements',
    })

    const { systemPrompt } = await buildSessionContext('ctx-003')

    expect(systemPrompt).toContain('<description>')
    expect(systemPrompt).toContain('A detailed description of the feature')
    expect(systemPrompt).toContain('</description>')

    expect(systemPrompt).toContain('<summary>')
    expect(systemPrompt).toContain('Brief summary of progress so far')
    expect(systemPrompt).toContain('</summary>')

    expect(systemPrompt).toContain('<note>')
    expect(systemPrompt).toContain('First attempt failed due to timeout')
    expect(systemPrompt).toContain('Need to check the database schema')
    expect(systemPrompt).toContain('Talked to Sam about the requirements')
    expect(systemPrompt).toContain('</note>')
  })

  it('includes previous session records', async () => {
    await seedTask({
      id: 'ctx-004',
      title: 'Debug crash',
      status: 'in_progress',
      priority: 'immediate',
      category: 'Work',
      project: 'Work',
      session_ids: ['sess-aaa', 'sess-bbb'],
      active_session_ids: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      note: '',
    })

    await seedSessions([
      {
        claudeSessionId: 'sess-aaa',
        taskId: 'ctx-004',
        project: 'Work',
        process_status: 'stopped',
        work_status: 'completed',
        mode: 'default',
        startedAt: '2025-01-01T10:00:00Z',
        lastActiveAt: '2025-01-01T10:30:00Z',
        messageCount: 3,
      },
      {
        claudeSessionId: 'sess-bbb',
        taskId: 'ctx-004',
        project: 'Work',
        process_status: 'stopped',
        work_status: 'agent_complete',
        mode: 'default',
        startedAt: '2025-01-02T14:00:00Z',
        lastActiveAt: '2025-01-02T14:45:00Z',
        messageCount: 5,
        title: 'Investigated stack trace',
      },
    ])

    const { systemPrompt } = await buildSessionContext('ctx-004')

    expect(systemPrompt).toContain('<previous_sessions>')
    expect(systemPrompt).toContain('sess-aaa')
    expect(systemPrompt).toContain('sess-bbb')
    expect(systemPrompt).toContain('Investigated stack trace')
    expect(systemPrompt).toContain('</previous_sessions>')
  })

  it('includes project memory when available', async () => {
    await seedTask({
      id: 'ctx-005',
      title: 'Improve search',
      status: 'todo',
      priority: 'none',
      category: 'Work',
      project: 'SearchEngine',
      session_ids: [],
      active_session_ids: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      note: '',
    })

    await seedProjectMemory('work/searchengine', `---
name: Search Engine
description: Full-text search module
---

## 2025-01-10 14:30 — session [work/searchengine]
Implemented FTS5 indexing for memory files.
`)

    const { systemPrompt } = await buildSessionContext('ctx-005')

    expect(systemPrompt).toContain('<project_memory>')
    expect(systemPrompt).toContain('Search Engine')
    expect(systemPrompt).toContain('FTS5 indexing')
    expect(systemPrompt).toContain('</project_memory>')
  })

  // ═══════════════════════════════════════════════════════════════════
  //  Graceful degradation
  // ═══════════════════════════════════════════════════════════════════

  it('returns empty systemPrompt for non-existent task', async () => {
    // No tasks seeded — task store is empty or missing
    const tasksDir = path.join(tmpBase, 'tasks')
    await fsp.writeFile(
      path.join(tasksDir, 'tasks.json'),
      JSON.stringify({ version: 1, tasks: [] }),
    )

    const { systemPrompt } = await buildSessionContext('nonexistent-id')

    // No task-specific content, but server_safety block is always appended
    expect(systemPrompt).not.toContain('<task>')
    expect(systemPrompt).toContain('<server_safety>')
  })

  it('returns context with only task metadata when no subtasks/description/summary/note/sessions/memory exist', async () => {
    await seedTask({
      id: 'ctx-minimal',
      title: 'Minimal task',
      status: 'todo',
      priority: 'backlog',
      category: 'Inbox',
      project: 'Inbox',
      session_ids: [],
      active_session_ids: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      description: '',
      summary: '',
      note: '',
    })

    const { systemPrompt } = await buildSessionContext('ctx-minimal')

    // Has task metadata
    expect(systemPrompt).toContain('Minimal task')
    expect(systemPrompt).toContain('<task>')

    // No other sections
    expect(systemPrompt).not.toContain('<subtasks>')
    expect(systemPrompt).not.toContain('<description>')
    expect(systemPrompt).not.toContain('<summary>')
    expect(systemPrompt).not.toContain('<note>')
    expect(systemPrompt).not.toContain('<previous_sessions>')
    expect(systemPrompt).not.toContain('<project_memory>')
  })

  it('omits project field when project equals category', async () => {
    await seedTask({
      id: 'ctx-same-cat',
      title: 'Same category project',
      status: 'todo',
      priority: 'backlog',
      category: 'Inbox',
      project: 'Inbox',
      session_ids: [],
      active_session_ids: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      note: '',
    })

    const { systemPrompt } = await buildSessionContext('ctx-same-cat')

    expect(systemPrompt).toContain('Category: Inbox')
    expect(systemPrompt).not.toContain('Project:')
  })

  it('falls back to category-level memory when project memory is absent', async () => {
    await seedTask({
      id: 'ctx-fallback',
      title: 'Fallback test',
      status: 'todo',
      priority: 'backlog',
      category: 'Work',
      project: 'NewProject',
      session_ids: [],
      active_session_ids: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      note: '',
    })

    // No project-level memory, but category-level exists
    await seedProjectMemory('work', `---
name: Work
description: Work category memory
---

## 2025-01-15 09:00 — agent [work]
General work context and patterns.
`)

    const { systemPrompt } = await buildSessionContext('ctx-fallback')

    expect(systemPrompt).toContain('<project_memory>')
    expect(systemPrompt).toContain('Work category memory')
    expect(systemPrompt).toContain('General work context')
  })

  it('includes large note content within token budget', async () => {
    const manyLines = Array.from({ length: 10 }, (_, i) => `Note-${String(i + 1).padStart(2, '0')} content here`)

    await seedTask({
      id: 'ctx-many-notes',
      title: 'Large note task',
      status: 'todo',
      priority: 'backlog',
      category: 'Work',
      project: 'Work',
      session_ids: [],
      active_session_ids: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      note: manyLines.join('\n\n'),
    })

    const { systemPrompt } = await buildSessionContext('ctx-many-notes')

    // All notes should be present (within 500 token budget)
    expect(systemPrompt).toContain('<note>')
    expect(systemPrompt).toContain('Note-01')
    expect(systemPrompt).toContain('Note-10')
    expect(systemPrompt).toContain('</note>')
  })

  it('includes due date when present', async () => {
    await seedTask({
      id: 'ctx-due',
      title: 'Task with due date',
      status: 'todo',
      priority: 'immediate',
      category: 'Work',
      project: 'Work',
      due_date: '2025-03-15',
      session_ids: [],
      active_session_ids: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      note: '',
    })

    const { systemPrompt } = await buildSessionContext('ctx-due')

    expect(systemPrompt).toContain('Due: 2025-03-15')
  })

  // ═══════════════════════════════════════════════════════════════════
  //  Full context with all sections
  // ═══════════════════════════════════════════════════════════════════

  it('assembles all sections when task has rich data', async () => {
    await seedTask({
      id: 'ctx-full',
      title: 'Full context task',
      status: 'in_progress',
      priority: 'immediate',
      category: 'Work',
      project: 'Walnut',
      due_date: '2025-02-28',
      session_ids: ['sess-full-1'],
      active_session_ids: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-15T00:00:00Z',
      note: 'First session completed auth module\n\nNeed to add tests',
    })

    await seedSessions([{
      claudeSessionId: 'sess-full-1',
      taskId: 'ctx-full',
      project: 'Walnut',
      process_status: 'stopped',
      work_status: 'completed',
      mode: 'default',
      startedAt: '2025-01-10T10:00:00Z',
      lastActiveAt: '2025-01-10T10:30:00Z',
      messageCount: 4,
    }])

    await seedProjectMemory('work/walnut', `---
name: Walnut
description: Personal AI butler
---

## 2025-01-10 10:30 — session [work/walnut]
Implemented auth module with JWT tokens.
`)

    const { systemPrompt } = await buildSessionContext('ctx-full')

    // Wrapper
    expect(systemPrompt).toContain('You are working on a task in Walnut')

    // All 5 sections present
    expect(systemPrompt).toContain('<task>')
    expect(systemPrompt).toContain('Full context task')

    expect(systemPrompt).toContain('<note>')
    expect(systemPrompt).toContain('First session completed auth module')

    expect(systemPrompt).toContain('<previous_sessions>')
    expect(systemPrompt).toContain('sess-ful')  // truncated to 8 chars

    expect(systemPrompt).toContain('<project_memory>')
    expect(systemPrompt).toContain('Personal AI butler')
    expect(systemPrompt).toContain('JWT tokens')
  })
})
