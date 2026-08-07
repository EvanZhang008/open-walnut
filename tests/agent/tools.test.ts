import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

// Mock constants module to redirect file paths to temp directory
vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { executeTool, getToolSchemas, tools } from '../../src/agent/tools.js';
import { bus } from '../../src/core/event-bus.js';
import {
  _resetForTesting,
  addSessionToHistory,
} from '../../src/core/task-manager.js';
import { closeDb as closeTaskDb } from '../../src/core/task-db.js';
import { closeDb as closeSessionDb } from '../../src/core/session-db.js';

/** Pre-create a project via the agent tool (task_create also auto-creates by name). */
async function ensureProject(name: string, source = 'local') {
  await executeTool('task_create', { type: 'project', name, source });
}

beforeEach(async () => {
  closeTaskDb();
  closeSessionDb();
  _resetForTesting();
  tmpDir = WALNUT_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  closeTaskDb();
  closeSessionDb();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// Full integration tests: tests/agent/files-memory-integration.test.ts (memory), tests/agent/tools/files-glob-grep.test.ts (glob/grep)
describe('tool definitions', () => {
  it('has all expected tools', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain('task_query');
    expect(names).toContain('task_get');
    expect(names).toContain('task_create');
    expect(names).toContain('task_update');
    expect(names).toContain('task_delete');
    expect(names).toContain('task_search');
    expect(names).toContain('file_read');
    expect(names).toContain('file_write');
    expect(names).toContain('file_edit');
    expect(names).toContain('file_list');
    expect(names).toContain('file_glob');
    expect(names).toContain('file_grep');
    expect(names).toContain('session_list');
    expect(names).toContain('session_summary');
    expect(names).toContain('session_update');
    expect(names).toContain('session_start');
    expect(names).toContain('config_get');
    expect(names).toContain('config_update');
  });

  it('session_start has working_directory, task_id, runner, and agent_id in input_schema', () => {
    const startSession = tools.find((t) => t.name === 'session_start')!;
    const schema = startSession.input_schema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty('working_directory');
    expect(schema.properties).toHaveProperty('task_id');
    expect(schema.properties).toHaveProperty('runner');
    expect(schema.properties).toHaveProperty('agent_id');
    // task_id is required — every session must be linked to a task
    expect(schema.required ?? []).toContain('task_id');
  });

  it('each tool has name, description, input_schema, and execute', () => {
    for (const tool of tools) {
      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.input_schema).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('getToolSchemas returns correct format', () => {
    const schemas = getToolSchemas();
    for (const schema of schemas) {
      expect(schema).toHaveProperty('name');
      expect(schema).toHaveProperty('description');
      expect(schema).toHaveProperty('input_schema');
      expect(schema).not.toHaveProperty('execute');
    }
  });
});

describe('task tools', () => {
  it('query_tasks returns empty initially', async () => {
    const result = await executeTool('task_query', {});
    expect(result).toBe('No tasks found.');
  });

  it('create_task creates a task', async () => {
    const result = await executeTool('task_create', { title: 'Test agent task' });
    expect(result).toContain('Task created:');
    expect(result).toContain('Test agent task');
  });

  // Regression: 2026-08-04 cron re-fire storm created 33 identical daily-report
  // tasks. Unattended sources (cron/triage/background/heartbeat) must dedupe an
  // exact-title same-day live duplicate; interactive chat must not.
  describe('task_create unattended same-day dedup', () => {
    it('cron source returns the existing task instead of duplicating', async () => {
      const first = await executeTool('task_create', { title: 'Daily Report — 2026-08-04' }, { source: 'cron-isolated' });
      expect(first).toContain('Task created:');
      const second = await executeTool('task_create', { title: 'Daily Report — 2026-08-04' }, { source: 'cron-isolated' });
      expect(second).toContain('Task already exists');
      const all = JSON.parse(await executeTool('task_query', {}));
      expect(all).toHaveLength(1);
    });

    it('interactive chat source may create same-titled tasks', async () => {
      await executeTool('task_create', { title: 'Buy milk' }, { source: 'chat' });
      const second = await executeTool('task_create', { title: 'Buy milk' }, { source: 'chat' });
      expect(second).toContain('Task created:');
      const all = JSON.parse(await executeTool('task_query', {}));
      expect(all).toHaveLength(2);
    });

    it('cron source still creates when the same-titled task is COMPLETE', async () => {
      const first = await executeTool('task_create', { title: 'Daily Report — done case' }, { source: 'cron-isolated' });
      const idMatch = first.match(/id="([^"]+)"/);
      const { updateTask } = await import('../../src/core/task-manager.js');
      await updateTask(idMatch![1], { phase: 'COMPLETE' });
      const second = await executeTool('task_create', { title: 'Daily Report — done case' }, { source: 'cron-isolated' });
      expect(second).toContain('Task created:');
    });
  });

  it('query_tasks returns created tasks', async () => {
    await executeTool('task_create', { title: 'Task A', priority: 'immediate', project: 'work' });
    await executeTool('task_create', { title: 'Task B', project: 'personal' });

    const result = await executeTool('task_query', {});
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].title).toBe('Task A');
    expect(parsed[0].priority).toBe('immediate');
    expect(parsed[1].title).toBe('Task B');
  });

  it('query_tasks filters by status', async () => {
    await executeTool('task_create', { title: 'Todo task' });
    const addResult = await executeTool('task_create', { title: 'Agent complete task' });
    const idMatch = addResult.match(/id="([^"]+)"/);
    if (idMatch) {
      // update_task with phase AGENT_COMPLETE (status: in_progress), not COMPLETE (status: done)
      await executeTool('task_update', { id: idMatch[1], phase: 'AGENT_COMPLETE' });
    }

    const todoResult = await executeTool('task_query', { where: { status: 'todo' } });
    const todos = JSON.parse(todoResult);
    expect(todos).toHaveLength(1);
    expect(todos[0].title).toBe('Todo task');

    // The agent-completed task is in_progress (AGENT_COMPLETE phase), not done
    const inProgressResult = await executeTool('task_query', { where: { status: 'in_progress' } });
    const inProgress = JSON.parse(inProgressResult);
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0].title).toBe('Agent complete task');
    expect(inProgress[0].phase).toBe('AGENT_COMPLETE');
  });

  it('query_tasks type=project returns distinct projects with counts', async () => {
    await executeTool('task_create', { title: 'Work task 1', project: 'Work' });
    await executeTool('task_create', { title: 'Work task 2', project: 'Work' });
    await executeTool('task_create', { title: 'Life task', project: 'Life' });
    const addResult = await executeTool('task_create', { title: 'Agent complete work', project: 'Work' });
    const idMatch = addResult.match(/id="([^"]+)"/);
    // update_task with phase AGENT_COMPLETE (status: in_progress), not done
    if (idMatch) await executeTool('task_update', { id: idMatch[1], phase: 'AGENT_COMPLETE' });

    const result = await executeTool('task_query', { type: 'project' });
    const parsed = JSON.parse(result);
    const work = parsed.find((p: { name: string }) => p.name === 'Work');
    expect(work).toMatchObject({ name: 'Work', todo: 2, active: 1, done: 0 });
    const life = parsed.find((p: { name: string }) => p.name === 'Life');
    expect(life).toMatchObject({ name: 'Life', todo: 1, active: 0, done: 0 });
  });

  it('query_tasks type=project reports Inbox as a row with an empty name', async () => {
    await executeTool('task_create', { title: 'Filed task', project: 'Work' });
    await executeTool('task_create', { title: 'Loose thought' }); // no project → Inbox

    const result = await executeTool('task_query', { type: 'project' });
    const parsed = JSON.parse(result);
    // Inbox has no registry row, so it is reported as name '' + a label.
    const inbox = parsed.find((p: { name: string }) => p.name === '');
    expect(inbox).toMatchObject({ name: '', label: 'Inbox', source: 'local', todo: 1 });
  });

  it('query_tasks type=project lists an empty project created up front', async () => {
    await ensureProject('EmptyProj');

    const result = await executeTool('task_query', { type: 'project' });
    const parsed = JSON.parse(result);
    // The registry (not the task rows) is the source of truth for existence, so
    // a project with zero tasks is still listed.
    expect(parsed.find((p: { name: string }) => p.name === 'EmptyProj'))
      .toMatchObject({ name: 'EmptyProj', source: 'local', todo: 0, active: 0, done: 0 });
  });

  it('query_tasks type=project with contains match does fuzzy find', async () => {
    await executeTool('task_create', { title: 'Test task', project: '__walnut-body-limit-test__' });

    const result = await executeTool('task_query', { type: 'project', where: { name: 'body-limit' }, match: 'contains' });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('__walnut-body-limit-test__');
  });

  it('query_tasks filters tasks by project', async () => {
    await executeTool('task_create', { title: 'HomeLab task', project: 'HomeLab' });
    await executeTool('task_create', { title: 'Taxes task', project: 'Taxes' });

    const result = await executeTool('task_query', { where: { project: 'HomeLab' } });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('HomeLab task');
  });

  it("query_tasks where.project='' returns Inbox tasks only", async () => {
    await executeTool('task_create', { title: 'Filed task', project: 'HomeLab' });
    await executeTool('task_create', { title: 'Loose thought' });

    const result = await executeTool('task_query', { where: { project: '' } });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('Loose thought');
    expect(parsed[0].project).toBe('');
  });

  it('query_tasks with a nonexistent project shows an available-projects hint', async () => {
    await executeTool('task_create', { title: 'Work task', project: 'Work' });
    await executeTool('task_create', { title: 'Life task', project: 'Life' });

    const result = await executeTool('task_query', { where: { project: 'nonexistent' } });
    expect(result).toContain('No project matching');
    expect(result).toContain('Work');
    expect(result).toContain('Life');
  });

  it('query_tasks shows completed hint when all tasks in a project are done', async () => {
    // Use update_task with phase to set a task to COMPLETE (simulating human action)
    // since update_task with AGENT_COMPLETE only sets status: in_progress
    const addResult = await executeTool('task_create', { title: 'Done task', project: 'Archive' });
    const idMatch = addResult.match(/id="([^"]+)"/);
    if (idMatch) {
      // Simulate human setting COMPLETE via core directly
      const { updateTask } = await import('../../src/core/task-manager.js');
      await updateTask(idMatch[1], { phase: 'COMPLETE' as any });
    }

    const result = await executeTool('task_query', { where: { project: 'Archive' } });
    expect(result).toContain('No active tasks');
    expect(result).toContain('1 completed');
    expect(result).toContain("where.phase='COMPLETE'");
  });

  it('query_tasks reports an empty Inbox distinctly', async () => {
    await executeTool('task_create', { title: 'Filed task', project: 'Work' });

    const result = await executeTool('task_query', { where: { project: '' } });
    expect(result).toBe('Inbox is empty.');
  });

  it('get_task returns task details', async () => {
    const addResult = await executeTool('task_create', { title: 'Detail task', priority: 'immediate' });
    const idMatch = addResult.match(/id="([^"]+)"/);
    expect(idMatch).toBeTruthy();

    const result = await executeTool('task_get', { id: idMatch![1] });
    const parsed = JSON.parse(result);
    expect(parsed.title).toBe('Detail task');
    expect(parsed.priority).toBe('immediate');
  });

  it('get_task returns error for nonexistent id', async () => {
    const result = await executeTool('task_get', { id: 'nonexistent' });
    expect(result).toContain('Error:');
  });

  it('update_task with phase AGENT_COMPLETE sets phase to AGENT_COMPLETE', async () => {
    const addResult = await executeTool('task_create', { title: 'Complete me' });
    const idMatch = addResult.match(/id="([^"]+)"/);

    const result = await executeTool('task_update', { id: idMatch![1], phase: 'AGENT_COMPLETE' });
    expect(result).toContain('Task updated:');
    expect(result).toContain('Complete me');

    // Verify the task's phase and status
    const taskResult = await executeTool('task_get', { id: idMatch![1] });
    const task = JSON.parse(taskResult);
    expect(task.phase).toBe('AGENT_COMPLETE');
    expect(task.status).toBe('in_progress');
  });

  it('update_task modifies task fields', async () => {
    const addResult = await executeTool('task_create', { title: 'Original' });
    const idMatch = addResult.match(/id="([^"]+)"/);

    const result = await executeTool('task_update', {
      id: idMatch![1],
      title: 'Updated',
      priority: 'immediate',
    });
    expect(result).toContain('Task updated:');
    expect(result).toContain('Updated');
  });

  it('update_task with append_note adds note to task', async () => {
    const addResult = await executeTool('task_create', { title: 'Note task' });
    const idMatch = addResult.match(/id="([^"]+)"/);

    const result = await executeTool('task_update', {
      id: idMatch![1],
      append_note: 'This is a note',
    });
    expect(result).toContain('Task updated');
    expect(result).toContain('note appended');
  });
});

describe('search tool', () => {
  it('search resolves an exact session ID without invoking QMD', async () => {
    const created = await executeTool('task_create', {
      title: 'Fix authentication bug',
    });
    const taskId = created.match(/id="([^"]+)"/)?.[1];
    expect(taskId).toBeTruthy();
    const sessionId = 'agent-search-session-reference-12345678';
    await addSessionToHistory(taskId!, sessionId);
    const memorySearch = await import('../../src/core/memory-search.js');
    const qmdSearch = vi.spyOn(memorySearch, 'memoryNotesSearch')
      .mockRejectedValue(new Error('QMD must not run for an exact reference'));

    const result = await executeTool('task_search', {
      queries: [sessionId],
    });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].task_id).toBe(taskId);
    expect(parsed[0].title).toContain('authentication');
    expect(qmdSearch).not.toHaveBeenCalled();
    qmdSearch.mockRestore();
  });

  it('search rejects the removed singular-query contract', async () => {
    const result = await executeTool('task_search', {
      query: 'authentication',
      mode: 'keyword',
    });
    expect(result).toContain('queries is required');
  });
});

describe('session tools', () => {
  it('list_sessions returns empty initially', async () => {
    const result = await executeTool('session_list', {});
    expect(result).toBe('No sessions found.');
  });
});

describe('start_session tool', () => {
  let startSessionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const { sessionRunner } = await import('../../src/providers/claude-code-session.js');
    startSessionSpy = vi.spyOn(sessionRunner, 'startSession').mockResolvedValue({
      claudeSessionId: 'mock-session-id-12345',
      title: 'Mock Session Title',
    });
  });

  afterEach(() => {
    startSessionSpy.mockRestore();
  });

  it('passes working_directory as cwd to sessionRunner.startSession', async () => {
    const addResult = await executeTool('task_create', { title: 'Session cwd test' });
    const idMatch = addResult.match(/id="([^"]+)"/);

    await executeTool('session_start', {
      task_id: idMatch![1],
      working_directory: '/tmp/my-project',
      prompt: 'do work',
    });

    expect(startSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: idMatch![1],
        message: 'do work',
        cwd: '/tmp/my-project',
      }),
    );
  });

  it('passes correct project from task to sessionRunner.startSession', async () => {
    const addResult = await executeTool('task_create', {
      title: 'Project session test',
      project: 'Walnut',
    });
    const idMatch = addResult.match(/id="([^"]+)"/);

    await executeTool('session_start', {
      task_id: idMatch![1],
      working_directory: '/home/user/code',
    });

    expect(startSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/home/user/code',
        project: 'Walnut',
      }),
    );
  });

  it('passes mode "plan" to sessionRunner.startSession', async () => {
    const addResult = await executeTool('task_create', { title: 'Plan mode test' });
    const idMatch = addResult.match(/id="([^"]+)"/);

    await executeTool('session_start', {
      task_id: idMatch![1],
      working_directory: '/tmp/test',
      prompt: 'analyze codebase',
      mode: 'plan',
    });

    expect(startSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: idMatch![1],
        message: 'analyze codebase',
        mode: 'plan',
      }),
    );
  });

  it('passes mode "bypass" to sessionRunner.startSession', async () => {
    const addResult = await executeTool('task_create', { title: 'Bypass mode test' });
    const idMatch = addResult.match(/id="([^"]+)"/);

    await executeTool('session_start', {
      task_id: idMatch![1],
      working_directory: '/tmp/test',
      mode: 'bypass',
    });

    expect(startSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: idMatch![1],
        mode: 'bypass',
      }),
    );
  });

  it('omits mode when not specified', async () => {
    const addResult = await executeTool('task_create', { title: 'No mode test' });
    const idMatch = addResult.match(/id="([^"]+)"/);

    await executeTool('session_start', {
      task_id: idMatch![1],
      working_directory: '/tmp/test',
    });

    expect(startSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: idMatch![1],
        mode: undefined,
      }),
    );
  });

  it('returns error for completed task', async () => {
    const addResult = await executeTool('task_create', { title: 'Done task' });
    const idMatch = addResult.match(/id="([^"]+)"/);
    // Simulate human setting COMPLETE (agent can only set AGENT_COMPLETE)
    const { updateTask: coreUpdateTask } = await import('../../src/core/task-manager.js');
    await coreUpdateTask(idMatch![1], { phase: 'COMPLETE' as any });

    const result = await executeTool('session_start', {
      task_id: idMatch![1],
      working_directory: '/tmp/test',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('already complete');
  });

  it('blocks start_session when task already has any session (strict 1-session-per-task)', async () => {
    const addResult = await executeTool('task_create', { title: 'Already has session' });
    const idMatch = addResult.match(/id="([^"]+)"/);
    const taskId = idMatch![1];

    // Manually link a stopped session to the task (simulating a previous session)
    const { linkSession } = await import('../../src/core/task-manager.js');
    await linkSession(taskId, 'old-stopped-session-001');

    // Attempting to start a new session should be blocked
    const result = await executeTool('session_start', {
      task_id: taskId,
      working_directory: '/tmp/test',
      prompt: 'new work',
    });

    const parsed = JSON.parse(result);
    expect(parsed.blocked).toBe(true);
    expect(parsed.reason).toContain('Task already has a session');
    expect(parsed.session_ids).toContain('old-stopped-session-001');
    expect(parsed.hint).toContain('session_send');
    expect(parsed.hint).toContain('task_create');
    // sessionRunner.startSession should NOT have been called
    expect(startSessionSpy).not.toHaveBeenCalled();
  });

  it('returns error for nonexistent task', async () => {
    const result = await executeTool('session_start', {
      task_id: 'nonexistent-id',
      working_directory: '/tmp/test',
    });
    expect(result).toContain('Error:');
  });

  it('starts a taskless session when task_id is omitted', async () => {
    const result = await executeTool('session_start', {
      working_directory: '/tmp/taskless',
      prompt: 'taskless work',
    });

    expect(result).toContain('Taskless CLI session');
    expect(startSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: '',
        message: 'taskless work',
        cwd: '/tmp/taskless',
        project: '',
      }),
    );
  });

  it('includes session-ref and task-ref XML tags in result', async () => {
    const addResult = await executeTool('task_create', { title: 'Ref tag test' });
    const idMatch = addResult.match(/id="([^"]+)"/);

    const result = await executeTool('session_start', {
      task_id: idMatch![1],
      working_directory: '/tmp/test',
      prompt: 'do work',
    });

    expect(result).toContain('<session-ref id="mock-session-id-12345" label="Mock Session Title"/>');
    expect(result).toContain(`<task-ref id="${idMatch![1]}" label="Ref tag test"/>`);
  });

  it('includes session-ref in taskless session result', async () => {
    const result = await executeTool('session_start', {
      working_directory: '/tmp/taskless',
      prompt: 'taskless work',
    });

    expect(result).toContain('<session-ref id="mock-session-id-12345" label="Mock Session Title"/>');
    expect(result).not.toContain('<task-ref');
  });
});

describe('config tools', () => {
  it('get_config returns default config', async () => {
    const result = await executeTool('config_get', {});
    const parsed = JSON.parse(result);
    expect(parsed.version).toBe(1);
    expect(parsed.defaults.priority).toBe('none');
  });

  it('update_config changes config values', async () => {
    await executeTool('config_update', {
      user_name: 'TestUser',
      default_priority: 'immediate',
    });

    const result = await executeTool('config_get', {});
    const parsed = JSON.parse(result);
    expect(parsed.user.name).toBe('TestUser');
    expect(parsed.defaults.priority).toBe('immediate');
  });
});

describe('executeTool', () => {
  it('returns error for unknown tool', async () => {
    const result = await executeTool('nonexistent_tool', {});
    expect(result).toContain('Unknown tool');
  });
});

describe('agent tool bus events', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emitSpy = vi.spyOn(bus, 'emit');
  });

  afterEach(() => {
    emitSpy.mockRestore();
  });

  it('create_task emits task:created to web-ui', async () => {
    await executeTool('task_create', { title: 'Bus event test' });
    expect(emitSpy).toHaveBeenCalledWith(
      'task:created',
      expect.objectContaining({ task: expect.objectContaining({ title: 'Bus event test' }) }),
      ['web-ui'],
      { source: 'agent' },
    );
  });

  it('update_task with phase AGENT_COMPLETE emits task:updated to web-ui', async () => {
    const addResult = await executeTool('task_create', { title: 'Complete bus test' });
    const idMatch = addResult.match(/id="([^"]+)"/);
    emitSpy.mockClear();

    await executeTool('task_update', { id: idMatch![1], phase: 'AGENT_COMPLETE' });
    expect(emitSpy).toHaveBeenCalledWith(
      'task:updated',
      expect.objectContaining({
        task: expect.objectContaining({
          phase: 'AGENT_COMPLETE',
          status: 'in_progress',
        }),
      }),
      ['web-ui'],
      { source: 'agent' },
    );
  });

  it('update_task emits task:updated to web-ui', async () => {
    const addResult = await executeTool('task_create', { title: 'Update bus test' });
    const idMatch = addResult.match(/id="([^"]+)"/);
    emitSpy.mockClear();

    await executeTool('task_update', { id: idMatch![1], title: 'Updated title' });
    expect(emitSpy).toHaveBeenCalledWith(
      'task:updated',
      expect.objectContaining({ task: expect.objectContaining({ title: 'Updated title' }) }),
      ['web-ui'],
      { source: 'agent' },
    );
  });

  it('update_task with append_note emits task:updated to web-ui', async () => {
    const addResult = await executeTool('task_create', { title: 'Note bus test' });
    const idMatch = addResult.match(/id="([^"]+)"/);
    emitSpy.mockClear();

    await executeTool('task_update', { id: idMatch![1], append_note: 'A note' });
    // addNote() is a core function that emits with source: 'internal' (not 'agent')
    expect(emitSpy).toHaveBeenCalledWith(
      'task:updated',
      expect.objectContaining({ task: expect.objectContaining({ title: 'Note bus test' }) }),
      ['web-ui'],
      { source: 'internal' },
    );
  });

  it('task_update type=project rename emits one bulk task update with affected IDs', async () => {
    const created = await executeTool('task_create', { title: 'Project rename test', project: 'OldProj' });
    const taskId = created.match(/id="([^"]+)"/)?.[1];
    emitSpy.mockClear();

    await executeTool('task_update', { type: 'project', old_name: 'OldProj', new_name: 'NewProj' });
    expect(emitSpy).toHaveBeenCalledWith(
      'task:updated',
      expect.objectContaining({
        task: null,
        taskIds: [taskId],
        oldProject: 'OldProj',
        newProject: 'NewProj',
        count: 1,
      }),
      ['web-ui', 'main-agent'],
      { source: 'task-manager' },
    );
  });
});
