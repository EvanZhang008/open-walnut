/**
 * Tests for agent context sources system.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { loadContextSources } from '../../src/agent/context-sources.js';
import { WALNUT_HOME, TASKS_FILE, TASKS_DIR, PROJECTS_MEMORY_DIR, MEMORY_FILE, DAILY_DIR } from '../../src/constants.js';
import type { AgentDefinition, Task, ContextSourceConfig } from '../../src/core/types.js';

// ── Helpers ──

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task-1234',
    title: 'Test Task',
    status: 'in_progress',
    priority: 'important',
    category: 'Work',
    project: 'HomeLab',
    session_ids: [],
    description: 'A test task description',
    summary: 'Test summary',
    note: 'Some task notes here',
    phase: 'IN_PROGRESS',
    source: 'local',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeAgentDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    runner: 'embedded',
    source: 'config',
    ...overrides,
  };
}

async function writeTaskStore(tasks: Task[]): Promise<void> {
  await fsp.mkdir(TASKS_DIR, { recursive: true });
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 2, tasks }), 'utf-8');
}

async function writeProjectMemory(projectPath: string, content: string): Promise<void> {
  const dir = path.join(PROJECTS_MEMORY_DIR, projectPath);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'MEMORY.md'), content, 'utf-8');
}

async function writeGlobalMemory(content: string): Promise<void> {
  await fsp.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
  await fsp.writeFile(MEMORY_FILE, content, 'utf-8');
}

async function writeDailyLog(dateKey: string, content: string): Promise<void> {
  await fsp.mkdir(DAILY_DIR, { recursive: true });
  await fsp.writeFile(path.join(DAILY_DIR, `${dateKey}.md`), content, 'utf-8');
}

// ── Setup / teardown ──

beforeEach(async () => {
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── Tests ──

describe('loadContextSources', () => {
  it('returns empty string when no taskId provided', async () => {
    const agent = makeAgentDef();
    const result = await loadContextSources(agent, {});
    expect(result).toBe('');
  });

  it('returns empty string when task not found', async () => {
    await writeTaskStore([]);
    const agent = makeAgentDef();
    const result = await loadContextSources(agent, { taskId: 'nonexistent' });
    expect(result).toBe('');
  });

  it('auto-loads task_details and project_memory when taskId is present', async () => {
    const task = makeTask();
    await writeTaskStore([task]);
    await writeProjectMemory('work/homelab', '---\nname: HomeLab\ndescription: HomeLab project\n---\n');

    const agent = makeAgentDef(); // no context_sources configured
    const result = await loadContextSources(agent, { taskId: task.id });

    // Should contain both auto-inferred sources
    expect(result).toContain('<task_context>');
    expect(result).toContain('</task_context>');
    expect(result).toContain('<project_memory>');
    expect(result).toContain('</project_memory>');

    // Task details content
    expect(result).toContain('Test Task');
    expect(result).toContain('IN_PROGRESS');
    expect(result).toContain('A test task description');

    // Subtasks removed from context (now child tasks)

    // Project memory content
    expect(result).toContain('HomeLab');
  });

  it('loads additional enabled sources from context_sources config', async () => {
    const task = makeTask();
    await writeTaskStore([task]);
    await writeProjectMemory('work/homelab', '---\nname: HomeLab\ndescription: test\n---\n');
    await writeGlobalMemory('Global memory content here');

    const agent = makeAgentDef({
      context_sources: [
        { id: 'global_memory', enabled: true },
      ],
    });

    const result = await loadContextSources(agent, { taskId: task.id });

    expect(result).toContain('<global_memory>');
    expect(result).toContain('Global memory content here');
    expect(result).toContain('</global_memory>');

    // Auto-inferred should still be there
    expect(result).toContain('<task_context>');
    expect(result).toContain('<project_memory>');
  });

  it('does not load disabled sources', async () => {
    const task = makeTask();
    await writeTaskStore([task]);
    await writeProjectMemory('work/homelab', '---\nname: HomeLab\ndescription: test\n---\n');

    const agent = makeAgentDef({
      context_sources: [
        { id: 'global_memory', enabled: false },
        { id: 'daily_log', enabled: false },
      ],
    });

    const result = await loadContextSources(agent, { taskId: task.id });

    expect(result).not.toContain('<global_memory>');
    expect(result).not.toContain('<daily_log>');
  });

  it('loads project_task_list when enabled', async () => {
    const task1 = makeTask({ id: 'task-1111', title: 'Primary Focus Task' });
    const task2 = makeTask({ id: 'task-2222', title: 'Other Task in HomeLab', status: 'todo' });
    const task3 = makeTask({ id: 'task-3333', title: 'Done Task', status: 'done' });
    await writeTaskStore([task1, task2, task3]);
    await writeProjectMemory('work/homelab', '---\nname: HomeLab\ndescription: test\n---\n');

    const agent = makeAgentDef({
      context_sources: [
        { id: 'project_task_list', enabled: true },
      ],
    });

    const result = await loadContextSources(agent, { taskId: task1.id });

    expect(result).toContain('<project_tasks>');
    expect(result).toContain('Other Task in HomeLab');
    // The project_tasks section should not include done tasks
    // (the current task appears in task_context, not project_tasks)
    const projectTasksMatch = result.match(/<project_tasks>([\s\S]*?)<\/project_tasks>/);
    expect(projectTasksMatch).toBeTruthy();
    const projectTasksContent = projectTasksMatch![1];
    expect(projectTasksContent).not.toContain('Primary Focus Task');
    expect(projectTasksContent).not.toContain('Done Task');
  });

  it('loads conversation_log when enabled', async () => {
    const task = makeTask({
      conversation_log: '### 2026-01-01\n**User:** Hello\n**AI:** Hi there',
    });
    await writeTaskStore([task]);
    await writeProjectMemory('work/homelab', '---\nname: HomeLab\ndescription: test\n---\n');

    const agent = makeAgentDef({
      context_sources: [
        { id: 'conversation_log', enabled: true },
      ],
    });

    const result = await loadContextSources(agent, { taskId: task.id });

    expect(result).toContain('<conversation_log>');
    expect(result).toContain('Hello');
    expect(result).toContain('Hi there');
  });

  it('respects custom token budgets', async () => {
    // Create a very long description
    const longDescription = 'A '.repeat(5000);
    const task = makeTask({ description: longDescription });
    await writeTaskStore([task]);
    await writeProjectMemory('work/homelab', '---\nname: HomeLab\ndescription: test\n---\n');

    const agent = makeAgentDef({
      context_sources: [
        // Override task_details to a very small budget
        { id: 'task_details', enabled: true, token_budget: 50 },
      ],
    });

    const result = await loadContextSources(agent, { taskId: task.id });

    // Should be truncated
    expect(result).toContain('[...truncated]');
  });

  it('handles missing project memory gracefully', async () => {
    const task = makeTask();
    await writeTaskStore([task]);
    // Don't create project memory

    const agent = makeAgentDef();
    const result = await loadContextSources(agent, { taskId: task.id });

    expect(result).toContain('<project_memory>');
    expect(result).toContain('no project memory yet');
  });

  it('handles session_history without sessionId', async () => {
    const task = makeTask();
    await writeTaskStore([task]);
    await writeProjectMemory('work/homelab', '---\nname: HomeLab\ndescription: test\n---\n');

    const agent = makeAgentDef({
      context_sources: [
        { id: 'session_history', enabled: true },
      ],
    });

    const result = await loadContextSources(agent, { taskId: task.id });

    expect(result).toContain('<session_history>');
    expect(result).toContain('no session ID provided');
  });

  it('loads daily_log when enabled', async () => {
    const task = makeTask();
    await writeTaskStore([task]);
    await writeProjectMemory('work/homelab', '---\nname: HomeLab\ndescription: test\n---\n');

    // Write a daily log for today
    const today = new Date();
    const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await writeDailyLog(dateKey, `# Daily Log: ${dateKey}\n\n## 10:00 — session [work/homelab]\nSome daily log content\n`);

    const agent = makeAgentDef({
      context_sources: [
        { id: 'daily_log', enabled: true },
      ],
    });

    const result = await loadContextSources(agent, { taskId: task.id });

    expect(result).toContain('<daily_log>');
    expect(result).toContain('Some daily log content');
  });
});
