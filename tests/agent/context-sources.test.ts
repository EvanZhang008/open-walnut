/**
 * Tests for agent context sources system.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { loadContextSources } from '../../src/agent/context-sources.js';
import { closeDb } from '../../src/core/task-db.js';
import { _resetForTesting } from '../../src/core/task-manager.js';
import { WALNUT_HOME, TASKS_FILE, TASKS_DIR, PROJECTS_MEMORY_DIR, agentMemoryDir, agentDailyDir } from '../../src/constants.js';
import type { AgentDefinition, Task } from '../../src/core/types.js';

// ── Helpers ──

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task-1234',
    title: 'Test Task',
    status: 'in_progress',
    priority: 'important',
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

const AGENT_ID = 'test-agent';

function makeAgentDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: AGENT_ID,
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

// `global_memory` / `daily_log` are PER-AGENT sources — they resolve through
// agentMemoryDir(agentDef.id) / agentDailyDir(agentDef.id), not the General
// paths. (General's copies are separate sources: main_global_memory /
// main_daily_log.) Seed under the agent under test, or the loader correctly
// reports "(no global memory yet)".
async function writeGlobalMemory(content: string): Promise<void> {
  const file = path.join(agentMemoryDir(AGENT_ID), 'MEMORY.md');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf-8');
}

async function writeDailyLog(dateKey: string, content: string): Promise<void> {
  const dir = agentDailyDir(AGENT_ID);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${dateKey}.md`), content, 'utf-8');
}

// ── Setup / teardown ──

beforeEach(async () => {
  // task-manager reads tasks from tasks.sqlite, not tasks.json — the JSON is only
  // imported by the one-shot migration, which is guarded by `initialized` + an
  // in-process store cache, both module-level. Without this reset every test
  // after the first inherits test #1's already-migrated (empty) DB and every
  // `getTask` misses → loadContextSources returns ''. Failure mode: seven
  // "expected '' to contain '<task_context>'" that pass in isolation.
  closeDb();
  _resetForTesting();
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  closeDb();
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
    expect(result).toContain('no legacy project memory for this project');
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

  it('session_history includes both user and assistant messages', async () => {
    const task = makeTask();
    await writeTaskStore([task]);
    await writeProjectMemory('work/homelab', '---\nname: HomeLab\ndescription: test\n---\n');

    // Mock readSessionHistory to return a mix of user and assistant messages
    const { readSessionHistory } = await import('../../src/core/session-history.js');
    const mockMessages = [
      { role: 'user' as const, text: 'implement the Haiku model switch', timestamp: '2026-03-31T09:30:00Z' },
      { role: 'assistant' as const, text: 'I\'ll implement the Haiku model switch. Let me edit the CDK code...', timestamp: '2026-03-31T09:31:00Z', tools: [{ name: 'Edit', input: { file: 'cdk.ts' } }] },
      { role: 'user' as const, text: 'why is ingestion still slow? previous rate was 60 docs per hour', timestamp: '2026-03-31T09:41:00Z' },
      { role: 'assistant' as const, text: 'Good question. Let me break down what actually happened with the indexing rates...', timestamp: '2026-03-31T09:42:00Z' },
    ];
    vi.spyOn(await import('../../src/core/session-history.js'), 'readSessionHistory')
      .mockResolvedValue(mockMessages);

    const agent = makeAgentDef({
      context_sources: [
        { id: 'session_history', enabled: true },
      ],
    });

    const result = await loadContextSources(agent, { taskId: task.id, sessionId: 'test-session-123' });

    // User messages must be visible (this is the bug fix — previously filtered out)
    expect(result).toContain('[0] User: implement the Haiku model switch');
    expect(result).toContain('[2] User: why is ingestion still slow?');

    // Assistant messages still present with tool info
    expect(result).toContain('[1] Assistant [Edit]:');
    expect(result).toContain('[3] Assistant:');
  });

  it('suppressSources skips an agent-enabled source (session_history) entirely', async () => {
    const task = makeTask();
    await writeTaskStore([task]);
    await writeProjectMemory('work/homelab', '---\nname: HomeLab\ndescription: test\n---\n');

    // If session_history were loaded, this spy would run and inject the block.
    const spy = vi.spyOn(await import('../../src/core/session-history.js'), 'readSessionHistory')
      .mockResolvedValue([
        { role: 'user' as const, text: 'should not appear', timestamp: '2026-03-31T09:30:00Z' },
      ]);

    const agent = makeAgentDef({
      context_sources: [
        { id: 'session_history', enabled: true },
      ],
    });

    const result = await loadContextSources(agent, {
      taskId: task.id,
      sessionId: 'test-session-123',
      suppressSources: ['session_history'],
    });

    // The whole section is gone and the loader was never invoked.
    expect(result).not.toContain('<session_history>');
    expect(result).not.toContain('should not appear');
    expect(spy).not.toHaveBeenCalled();
  });

  it('session_history truncates user messages at 300 chars', async () => {
    const task = makeTask();
    await writeTaskStore([task]);
    await writeProjectMemory('work/homelab', '---\nname: HomeLab\ndescription: test\n---\n');

    const longUserMessage = 'A'.repeat(500);
    vi.spyOn(await import('../../src/core/session-history.js'), 'readSessionHistory')
      .mockResolvedValue([
        { role: 'user' as const, text: longUserMessage, timestamp: '2026-03-31T09:30:00Z' },
        { role: 'assistant' as const, text: 'OK', timestamp: '2026-03-31T09:31:00Z' },
      ]);

    const agent = makeAgentDef({
      context_sources: [
        { id: 'session_history', enabled: true },
      ],
    });

    const result = await loadContextSources(agent, { taskId: task.id, sessionId: 'test-session-123' });

    // User message should be truncated at 300 chars (not 500 like assistant)
    expect(result).toContain('[0] User: ' + 'A'.repeat(300) + '... [500 chars]');
    // Assistant message should NOT be truncated (only 2 chars)
    expect(result).toContain('[1] Assistant: OK');
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
