/**
 * Shared test factories: reusable factory functions for creating
 * test data objects with sensible defaults and override support.
 */
import type { Task, Config, SessionRecord } from '../../src/core/types.js';

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-1234',
    title: 'Test task',
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    category: 'personal',
    project: 'personal',
    session_ids: [],
    source: 'ms-todo',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    description: '',
    summary: '',
    note: '',
    ...overrides,
  };
}

export function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId: 'test-session-1234',
    taskId: 'test-1234',
    project: 'personal',
    process_status: 'stopped',
    work_status: 'agent_complete',
    mode: 'default',
    startedAt: '2026-01-01T00:00:00Z',
    lastActiveAt: '2026-01-01T00:00:00Z',
    messageCount: 1,
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    user: {},
    defaults: { priority: 'none', category: 'personal' },
    provider: { type: 'claude-code' },
    ...overrides,
  };
}
