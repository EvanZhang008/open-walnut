/**
 * Unit tests for isAgentTask() — the split rule that separates background AGENTS
 * (Agent-tool subagents / teammates) from plain background TASKS (local_bash
 * shell commands etc.) in the WorkflowProgress panel's legacy mode.
 *
 * Rules under test:
 *   1. taskType present → membership in AGENT_TASK_TYPES decides (authoritative).
 *   2. taskType absent (recovered-from-disk tasks) → subagentType presence decides
 *      (only the Agent tool stamps subagent_type on task_started).
 */

import { describe, it, expect } from 'vitest';
import { isAgentTask } from '@/components/sessions/workflow-layout';
import type { BackgroundTask } from '@/hooks/useBackgroundTasks';

function task(p: Partial<BackgroundTask>): BackgroundTask {
  return { taskId: 't1', status: 'running', ...p };
}

describe('isAgentTask — taskType is authoritative when present', () => {
  it('local_agent / remote_agent / in_process_teammate → agent section', () => {
    expect(isAgentTask(task({ taskType: 'local_agent' }))).toBe(true);
    expect(isAgentTask(task({ taskType: 'remote_agent' }))).toBe(true);
    expect(isAgentTask(task({ taskType: 'in_process_teammate' }))).toBe(true);
  });

  it('local_bash / dream / unknown types → plain task section', () => {
    expect(isAgentTask(task({ taskType: 'local_bash' }))).toBe(false);
    expect(isAgentTask(task({ taskType: 'dream' }))).toBe(false);
    expect(isAgentTask(task({ taskType: 'monitor_mcp' }))).toBe(false);
  });

  it('taskType wins over subagentType (a bash task never becomes an agent)', () => {
    // Defensive: if a future CLI ever stamps subagent_type on a shell task,
    // the explicit type still routes it to the Tasks section.
    expect(isAgentTask(task({ taskType: 'local_bash', subagentType: 'Explore' }))).toBe(false);
  });
});

describe('isAgentTask — fallback for recovered tasks without taskType', () => {
  it('subagentType present → agent (only the Agent tool sets it)', () => {
    expect(isAgentTask(task({ subagentType: 'Explore' }))).toBe(true);
  });

  it('neither field → plain task', () => {
    expect(isAgentTask(task({ description: 'mystery recovered task' }))).toBe(false);
  });
});
