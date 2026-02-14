import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

// Mock constants module to redirect file paths to temp directory
vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { executeTool, getToolSchemas, tools } from '../../src/agent/tools.js';
import { bus } from '../../src/core/event-bus.js';
import { _resetForTesting } from '../../src/core/task-manager.js';

/** Pre-create a category via the agent tool so strict validation passes for subsequent task creation. */
async function ensureCategory(name: string, source = 'ms-todo') {
  await executeTool('create_task', { type: 'category', name, source });
}

/** Pre-create a project via the agent tool. */
async function ensureProject(category: string, project: string) {
  await executeTool('create_task', { type: 'project', category, project });
}

beforeEach(async () => {
  _resetForTesting();
  tmpDir = WALNUT_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('tool definitions', () => {
  it('has all expected tools', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain('query_tasks');
    expect(names).toContain('get_task');
    expect(names).toContain('create_task');
    expect(names).toContain('update_task');
    expect(names).toContain('delete_task');
    expect(names).toContain('search');
    expect(names).toContain('memory');
    expect(names).toContain('list_sessions');
    expect(names).toContain('get_session_summary');
    expect(names).toContain('update_session');
    expect(names).toContain('start_session');
    expect(names).toContain('get_config');
    expect(names).toContain('update_config');
  });

  it('start_session has working_directory, task_id, runner, and agent_id in input_schema', () => {
    const startSession = tools.find((t) => t.name === 'start_session')!;
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
    const result = await executeTool('query_tasks', {});
    expect(result).toBe('No tasks found.');
  });

  it('create_task creates a task', async () => {
    const result = await executeTool('create_task', { title: 'Test agent task' });
    expect(result).toContain('Task created:');
    expect(result).toContain('Test agent task');
  });

  it('query_tasks returns created tasks', async () => {
    await ensureCategory('work');
    await ensureCategory('personal');
    await executeTool('create_task', { title: 'Task A', priority: 'immediate', category: 'work' });
    await executeTool('create_task', { title: 'Task B', category: 'personal' });

    const result = await executeTool('query_tasks', {});
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].title).toBe('Task A');
    expect(parsed[0].priority).toBe('immediate');
    expect(parsed[1].title).toBe('Task B');
  });

  it('query_tasks filters by status', async () => {
    await executeTool('create_task', { title: 'Todo task' });
    const addResult = await executeTool('create_task', { title: 'Agent complete task' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);
    if (idMatch) {
      // update_task with phase AGENT_COMPLETE (status: in_progress), not COMPLETE (status: done)
      await executeTool('update_task', { id: idMatch[1], phase: 'AGENT_COMPLETE' });
    }

    const todoResult = await executeTool('query_tasks', { where: { status: 'todo' } });
    const todos = JSON.parse(todoResult);
    expect(todos).toHaveLength(1);
    expect(todos[0].title).toBe('Todo task');

    // The agent-completed task is in_progress (AGENT_COMPLETE phase), not done
    const inProgressResult = await executeTool('query_tasks', { where: { status: 'in_progress' } });
    const inProgress = JSON.parse(inProgressResult);
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0].title).toBe('Agent complete task');
    expect(inProgress[0].phase).toBe('AGENT_COMPLETE');
  });

  it('query_tasks from category returns distinct categories with counts', async () => {
    await ensureCategory('Work');
    await ensureCategory('Life');
    await executeTool('create_task', { title: 'Work task 1', category: 'Work' });
    await executeTool('create_task', { title: 'Work task 2', category: 'Work' });
    await executeTool('create_task', { title: 'Life task', category: 'Life' });
    const addResult = await executeTool('create_task', { title: 'Agent complete work', category: 'Work' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);
    // update_task with phase AGENT_COMPLETE (status: in_progress), not done
    if (idMatch) await executeTool('update_task', { id: idMatch[1], phase: 'AGENT_COMPLETE' });

    const result = await executeTool('query_tasks', { type: 'category' });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(2);
    const work = parsed.find((c: { name: string }) => c.name === 'Work');
    expect(work).toMatchObject({ name: 'Work', todo: 2, active: 1, done: 0 });
    const life = parsed.find((c: { name: string }) => c.name === 'Life');
    expect(life).toMatchObject({ name: 'Life', todo: 1, active: 0, done: 0 });
  });

  it('query_tasks from category with contains match does fuzzy find', async () => {
    await ensureCategory('__walnut-body-limit-test__');
    await executeTool('create_task', { title: 'Test task', category: '__walnut-body-limit-test__' });

    const result = await executeTool('query_tasks', { type: 'category', where: { name: 'body-limit' }, match: 'contains' });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('__walnut-body-limit-test__');
  });

  it('query_tasks from project lists projects in a category', async () => {
    await ensureCategory('Work');
    await ensureCategory('Life');
    await ensureProject('Work', 'HomeLab');
    await ensureProject('Work', 'Taxes');
    await ensureProject('Life', 'Fitness');
    await executeTool('create_task', { title: 'HomeLab task', category: 'Work', project: 'HomeLab' });
    await executeTool('create_task', { title: 'Taxes task', category: 'Work', project: 'Taxes' });
    await executeTool('create_task', { title: 'Life task', category: 'Life', project: 'Fitness' });

    const result = await executeTool('query_tasks', { type: 'project', where: { category: 'Work' } });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((p: { name: string }) => p.name).sort()).toEqual(['HomeLab', 'Taxes']);
  });

  it('query_tasks with nonexistent category shows available categories hint', async () => {
    await ensureCategory('Work');
    await ensureCategory('Life');
    await executeTool('create_task', { title: 'Work task', category: 'Work' });
    await executeTool('create_task', { title: 'Life task', category: 'Life' });

    const result = await executeTool('query_tasks', { where: { category: 'nonexistent' } });
    expect(result).toContain('No category matching');
    expect(result).toContain('Work');
    expect(result).toContain('Life');
  });

  it('query_tasks shows completed hint when all tasks are done', async () => {
    // Use update_task with phase to set a task to COMPLETE (simulating human action)
    // since update_task with AGENT_COMPLETE only sets status: in_progress
    await ensureCategory('Archive');
    const addResult = await executeTool('create_task', { title: 'Done task', category: 'Archive' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);
    if (idMatch) {
      // Simulate human setting COMPLETE via core directly
      const { updateTask } = await import('../../src/core/task-manager.js');
      await updateTask(idMatch[1], { phase: 'COMPLETE' as any });
    }

    const result = await executeTool('query_tasks', { where: { category: 'Archive' } });
    expect(result).toContain('No active tasks');
    expect(result).toContain('1 completed');
    expect(result).toContain("where.phase='COMPLETE'");
  });

  it('get_task returns task details', async () => {
    const addResult = await executeTool('create_task', { title: 'Detail task', priority: 'immediate' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);
    expect(idMatch).toBeTruthy();

    const result = await executeTool('get_task', { id: idMatch![1] });
    const parsed = JSON.parse(result);
    expect(parsed.title).toBe('Detail task');
    expect(parsed.priority).toBe('immediate');
  });

  it('get_task returns error for nonexistent id', async () => {
    const result = await executeTool('get_task', { id: 'nonexistent' });
    expect(result).toContain('Error:');
  });

  it('update_task with phase AGENT_COMPLETE sets phase to AGENT_COMPLETE', async () => {
    const addResult = await executeTool('create_task', { title: 'Complete me' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);

    const result = await executeTool('update_task', { id: idMatch![1], phase: 'AGENT_COMPLETE' });
    expect(result).toContain('Task updated:');
    expect(result).toContain('Complete me');

    // Verify the task's phase and status
    const taskResult = await executeTool('get_task', { id: idMatch![1] });
    const task = JSON.parse(taskResult);
    expect(task.phase).toBe('AGENT_COMPLETE');
    expect(task.status).toBe('in_progress');
  });

  it('update_task modifies task fields', async () => {
    const addResult = await executeTool('create_task', { title: 'Original' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);

    const result = await executeTool('update_task', {
      id: idMatch![1],
      title: 'Updated',
      priority: 'immediate',
    });
    expect(result).toContain('Task updated:');
    expect(result).toContain('Updated');
  });

  it('update_task with append_note adds note to task', async () => {
    const addResult = await executeTool('create_task', { title: 'Note task' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);

    const result = await executeTool('update_task', {
      id: idMatch![1],
      append_note: 'This is a note',
    });
    expect(result).toContain('Task updated');
    expect(result).toContain('note appended');
  });
});

describe('search tool', () => {
  it('search returns results from tasks', async () => {
    await executeTool('create_task', { title: 'Fix authentication bug' });
    await executeTool('create_task', { title: 'Deploy to production' });

    // Use keyword mode to avoid Ollama dependency (vector search tested separately)
    const result = await executeTool('search', { query: 'authentication', mode: 'keyword' });
    const parsed = JSON.parse(result);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].title).toContain('authentication');
  });

  it('search returns no results for unmatched query', async () => {
    await executeTool('create_task', { title: 'Some task' });

    const result = await executeTool('search', { query: 'xyznonexistent', mode: 'keyword' });
    expect(result).toBe('No results found.');
  });
});

describe('memory tool', () => {
  it('append saves to daily log', async () => {
    const result = await executeTool('memory', {
      action: 'append',
      content: 'Some knowledge to remember',
    });
    expect(result).toBe('Saved to daily log.');
  });

  it('append with project_path saves to project memory and daily log', async () => {
    const result = await executeTool('memory', {
      action: 'append',
      content: 'Project-specific knowledge',
      project_path: 'work/api',
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('saved');
    expect(parsed.project).toBeDefined();
    expect(parsed.recent_entries).toBeDefined();
  });

  it('read returns global memory when no project_path', async () => {
    // Write something first
    await executeTool('memory', {
      action: 'update_global',
      content: '# Global Memory\n\nSome global knowledge.',
    });
    const result = await executeTool('memory', { action: 'read' });
    expect(result).toContain('Global Memory');
  });

  it('read returns project memory with project_path', async () => {
    await executeTool('memory', {
      action: 'append',
      content: 'API endpoint added',
      project_path: 'work/api',
    });
    const result = await executeTool('memory', {
      action: 'read',
      project_path: 'work/api',
    });
    expect(result).toContain('API endpoint added');
  });

  it('read returns not found for missing project', async () => {
    const result = await executeTool('memory', {
      action: 'read',
      project_path: 'nonexistent/project',
    });
    expect(result).toBe('No memory found for this project.');
  });

  it('update_global replaces global memory content', async () => {
    const result = await executeTool('memory', {
      action: 'update_global',
      content: 'New global content',
    });
    expect(result).toBe('Global memory updated.');
  });

  it('update_summary updates project summary', async () => {
    // Create project first
    await executeTool('memory', {
      action: 'append',
      content: 'Initial work',
      project_path: 'work/api',
    });
    const result = await executeTool('memory', {
      action: 'update_summary',
      project_path: 'work/api',
      name: 'API Service',
      description: 'REST API for the platform',
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('updated');
  });

  it('returns error for missing required params', async () => {
    const result = await executeTool('memory', {
      action: 'append',
    });
    expect(result).toContain('Error:');
  });

  it('returns error for unknown action', async () => {
    const result = await executeTool('memory', {
      action: 'invalid',
    });
    expect(result).toContain('Error: Unknown action');
  });

  it('append with target="daily" writes only daily log', async () => {
    const result = await executeTool('memory', {
      action: 'append',
      content: 'Daily-only entry',
      project_path: 'work/api',
      target: 'daily',
    });
    expect(result).toBe('Saved to daily log.');
  });

  it('append with target="project" writes only project memory', async () => {
    const result = await executeTool('memory', {
      action: 'append',
      content: 'Project-only entry',
      project_path: 'work/api',
      target: 'project',
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('saved');
    expect(parsed.written_to).toEqual(['project']);
    expect(parsed.project).toBeDefined();
    expect(parsed.recent_entries).toBeDefined();
  });

  it('append with target="project" without project_path returns error', async () => {
    const result = await executeTool('memory', {
      action: 'append',
      content: 'Will fail',
      target: 'project',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('project_path is required');
  });

  it('append with target="both" writes to both', async () => {
    const result = await executeTool('memory', {
      action: 'append',
      content: 'Both targets entry',
      project_path: 'work/api',
      target: 'both',
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('saved');
    expect(parsed.written_to).toEqual(['daily', 'project']);
  });
});

describe('session tools', () => {
  it('list_sessions returns empty initially', async () => {
    const result = await executeTool('list_sessions', {});
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
    const addResult = await executeTool('create_task', { title: 'Session cwd test' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);

    await executeTool('start_session', {
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
    const addResult = await executeTool('create_task', {
      title: 'Project session test',
      project: 'Walnut',
    });
    const idMatch = addResult.match(/\[([^\]]+)\]/);

    await executeTool('start_session', {
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
    const addResult = await executeTool('create_task', { title: 'Plan mode test' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);

    await executeTool('start_session', {
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
    const addResult = await executeTool('create_task', { title: 'Bypass mode test' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);

    await executeTool('start_session', {
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
    const addResult = await executeTool('create_task', { title: 'No mode test' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);

    await executeTool('start_session', {
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
    const addResult = await executeTool('create_task', { title: 'Done task' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);
    // Simulate human setting COMPLETE (agent can only set AGENT_COMPLETE)
    const { updateTask: coreUpdateTask } = await import('../../src/core/task-manager.js');
    await coreUpdateTask(idMatch![1], { phase: 'COMPLETE' as any });

    const result = await executeTool('start_session', {
      task_id: idMatch![1],
      working_directory: '/tmp/test',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('already complete');
  });

  it('returns error for nonexistent task', async () => {
    const result = await executeTool('start_session', {
      task_id: 'nonexistent-id',
      working_directory: '/tmp/test',
    });
    expect(result).toContain('Error:');
  });

  it('starts a taskless session when task_id is omitted', async () => {
    const result = await executeTool('start_session', {
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
    const addResult = await executeTool('create_task', { title: 'Ref tag test' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);

    const result = await executeTool('start_session', {
      task_id: idMatch![1],
      working_directory: '/tmp/test',
      prompt: 'do work',
    });

    expect(result).toContain('<session-ref id="mock-session-id-12345" label="Mock Session Title"/>');
    expect(result).toContain(`<task-ref id="${idMatch![1]}" label="Ref tag test"/>`);
  });

  it('includes session-ref in taskless session result', async () => {
    const result = await executeTool('start_session', {
      working_directory: '/tmp/taskless',
      prompt: 'taskless work',
    });

    expect(result).toContain('<session-ref id="mock-session-id-12345" label="Mock Session Title"/>');
    expect(result).not.toContain('<task-ref');
  });
});

describe('config tools', () => {
  it('get_config returns default config', async () => {
    const result = await executeTool('get_config', {});
    const parsed = JSON.parse(result);
    expect(parsed.version).toBe(1);
    expect(parsed.defaults.priority).toBe('none');
  });

  it('update_config changes config values', async () => {
    await executeTool('update_config', {
      user_name: 'TestUser',
      default_priority: 'immediate',
    });

    const result = await executeTool('get_config', {});
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
    await executeTool('create_task', { title: 'Bus event test' });
    expect(emitSpy).toHaveBeenCalledWith(
      'task:created',
      expect.objectContaining({ task: expect.objectContaining({ title: 'Bus event test' }) }),
      ['web-ui'],
      { source: 'agent' },
    );
  });

  it('update_task with phase AGENT_COMPLETE emits task:updated to web-ui', async () => {
    const addResult = await executeTool('create_task', { title: 'Complete bus test' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);
    emitSpy.mockClear();

    await executeTool('update_task', { id: idMatch![1], phase: 'AGENT_COMPLETE' });
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
    const addResult = await executeTool('create_task', { title: 'Update bus test' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);
    emitSpy.mockClear();

    await executeTool('update_task', { id: idMatch![1], title: 'Updated title' });
    expect(emitSpy).toHaveBeenCalledWith(
      'task:updated',
      expect.objectContaining({ task: expect.objectContaining({ title: 'Updated title' }) }),
      ['web-ui'],
      { source: 'agent' },
    );
  });

  it('update_task with append_note emits task:updated to web-ui', async () => {
    const addResult = await executeTool('create_task', { title: 'Note bus test' });
    const idMatch = addResult.match(/\[([^\]]+)\]/);
    emitSpy.mockClear();

    await executeTool('update_task', { id: idMatch![1], append_note: 'A note' });
    expect(emitSpy).toHaveBeenCalledWith(
      'task:updated',
      expect.objectContaining({ task: expect.objectContaining({ title: 'Note bus test' }) }),
      ['web-ui'],
      { source: 'agent' },
    );
  });

  it('rename_category emits task:updated to web-ui', async () => {
    await ensureCategory('OldCat');
    await executeTool('create_task', { title: 'Cat rename test', category: 'OldCat' });
    emitSpy.mockClear();

    await executeTool('rename_category', { old_category: 'OldCat', new_category: 'NewCat' });
    expect(emitSpy).toHaveBeenCalledWith(
      'task:updated',
      expect.objectContaining({ oldCategory: 'OldCat', newCategory: 'NewCat', count: 1 }),
      ['web-ui'],
      { source: 'agent' },
    );
  });
});
