/**
 * Shared test utilities for plugin system tests.
 * Provides factory functions for creating mock plugins, sync implementations, and tasks.
 */
import { vi } from 'vitest';
import type {
  IntegrationSync,
  RegisteredPlugin,
  PluginApi,
  PluginManifest,
  DisplayMeta,
  CategoryClaimFn,
  MigrateFn,
  HttpRoute,
  ExtData,
  SyncPollContext,
} from '../../src/core/integration-types.js';
import type { Task, TaskPhase, TaskPriority } from '../../src/core/types.js';

/**
 * Creates a minimal IntegrationSync where every method is an async no-op.
 * createTask returns null; all others return undefined.
 */
export function createNoopSync(): IntegrationSync {
  return {
    createTask: async () => null,
    deleteTask: async () => {},
    updateTitle: async () => {},
    updateDescription: async () => {},
    updateSummary: async () => {},
    updateNote: async () => {},
    updateConversationLog: async () => {},
    updatePriority: async () => {},
    updatePhase: async () => {},
    updateDueDate: async () => {},
    updateStar: async () => {},
    updateCategory: async () => {},
    updateDependencies: async () => {},
    associateSubtask: async () => {},
    disassociateSubtask: async () => {},
    syncPoll: async () => {},
  };
}

/**
 * Creates an IntegrationSync where every method is a vi.fn() spy.
 * createTask resolves to null; all others resolve to undefined.
 */
export function createSpySync(): IntegrationSync & Record<string, ReturnType<typeof vi.fn>> {
  return {
    createTask: vi.fn().mockResolvedValue(null),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    updateTitle: vi.fn().mockResolvedValue(undefined),
    updateDescription: vi.fn().mockResolvedValue(undefined),
    updateSummary: vi.fn().mockResolvedValue(undefined),
    updateNote: vi.fn().mockResolvedValue(undefined),
    updateConversationLog: vi.fn().mockResolvedValue(undefined),
    updatePriority: vi.fn().mockResolvedValue(undefined),
    updatePhase: vi.fn().mockResolvedValue(undefined),
    updateDueDate: vi.fn().mockResolvedValue(undefined),
    updateStar: vi.fn().mockResolvedValue(undefined),
    updateCategory: vi.fn().mockResolvedValue(undefined),
    updateDependencies: vi.fn().mockResolvedValue(undefined),
    associateSubtask: vi.fn().mockResolvedValue(undefined),
    disassociateSubtask: vi.fn().mockResolvedValue(undefined),
    syncPoll: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Creates a mock RegisteredPlugin with sensible defaults.
 * Override any field via the overrides parameter.
 */
export function createMockPlugin(overrides: Partial<RegisteredPlugin> & { id: string }): RegisteredPlugin {
  return {
    name: overrides.id,
    config: {},
    sync: createNoopSync(),
    migrations: [],
    httpRoutes: [],
    ...overrides,
  };
}

/**
 * Creates a mock PluginApi that collects registrations (mirrors loader's createPluginApiBuilder).
 * Returns both the api object and the collected registrations.
 */
export function createTestPluginApi(
  manifest?: Partial<PluginManifest>,
  config?: Record<string, unknown>,
): {
  api: PluginApi;
  collected: {
    sync: IntegrationSync | null;
    claim: { fn: CategoryClaimFn; priority: number } | null;
    display: DisplayMeta | null;
    agentContext: string | null;
    migrations: MigrateFn[];
    httpRoutes: HttpRoute[];
  };
} {
  const m = { id: 'test', name: 'Test Plugin', ...manifest };
  const collected = {
    sync: null as IntegrationSync | null,
    claim: null as { fn: CategoryClaimFn; priority: number } | null,
    display: null as DisplayMeta | null,
    agentContext: null as string | null,
    migrations: [] as MigrateFn[],
    httpRoutes: [] as HttpRoute[],
  };

  const api: PluginApi = {
    id: m.id,
    name: m.name,
    config: config ?? {},
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as any,

    registerSync(sync: IntegrationSync) {
      if (collected.sync) throw new Error(`Plugin "${m.id}" called registerSync() more than once.`);
      collected.sync = sync;
    },
    registerSourceClaim(fn: CategoryClaimFn, opts?: { priority?: number }) {
      collected.claim = { fn, priority: opts?.priority ?? 0 };
    },
    registerDisplay(meta: DisplayMeta) {
      collected.display = meta;
    },
    registerAgentContext(snippet: string) {
      collected.agentContext = snippet;
    },
    registerMigration(fn: MigrateFn) {
      collected.migrations.push(fn);
    },
    registerHttpRoute(route: HttpRoute) {
      collected.httpRoutes.push(route);
    },
  };

  return { api, collected };
}

/**
 * Creates a minimal valid Task with sensible defaults.
 * Override any field via the overrides parameter.
 */
export function createMockTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-' + Math.random().toString(36).slice(2, 8),
    title: 'Test task',
    status: 'todo' as const,
    phase: 'TODO' as TaskPhase,
    priority: 'none' as TaskPriority,
    category: 'Inbox',
    project: 'Inbox',
    source: 'local',
    session_ids: [],
    description: '',
    summary: '',
    note: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Task;
}
