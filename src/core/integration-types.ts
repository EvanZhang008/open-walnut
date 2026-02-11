/**
 * Integration Plugin System — Type Definitions
 *
 * Every integration plugin implements these interfaces.
 * Core never references specific integrations — only talks through the registry.
 */

import type { Task, TaskPhase, TaskPriority } from './types.js';
import type { SubsystemLogger } from '../logging/index.js';
import type { Router } from 'express';

// ── ExtData: plugin-specific fields written to task.ext ──

export interface ExtData {
  [key: string]: unknown;
}

// ── SyncPollContext: passed to plugins during periodic sync ──

export interface SyncPollContext {
  getTasks(): Task[];
  updateTask(id: string, updates: Partial<Task>): Promise<Task>;
  addTask(data: Omit<Task, 'id'>): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  emit(event: string, data: unknown): void;
}

// ── IntegrationSync: strict plugin sync interface ──
// Every method is REQUIRED. Plugin maps Walnut's features to platform capabilities.
// Phase is the only status concept — plugins map 7 phases to whatever the platform supports.

export interface IntegrationSync {
  // ── Task Lifecycle ──
  createTask(task: Task): Promise<ExtData | null>;
  deleteTask(task: Task): Promise<void>;

  // ── Field Updates (called individually per mutation) ──
  updateTitle(task: Task, title: string): Promise<void>;
  updateDescription(task: Task, description: string): Promise<void>;
  updateSummary(task: Task, summary: string): Promise<void>;
  updateNote(task: Task, note: string): Promise<void>;
  updateConversationLog(task: Task, log: string): Promise<void>;
  updatePriority(task: Task, priority: TaskPriority): Promise<void>;
  updatePhase(task: Task, phase: TaskPhase): Promise<void>;
  updateDueDate(task: Task, date: string | null): Promise<void>;
  updateStar(task: Task, starred: boolean): Promise<void>;
  updateCategory(task: Task, category: string, project: string): Promise<void>;
  updateDependencies(task: Task, dependsOn: string[]): Promise<void>;

  // ── Subtask Relationship (child tasks are full Tasks with parent_task_id) ──
  associateSubtask(parentTask: Task, childTask: Task): Promise<void>;
  disassociateSubtask(parentTask: Task, childTask: Task): Promise<void>;

  // ── Pull (periodic sync from remote) ──
  syncPoll(ctx: SyncPollContext): Promise<void>;
}

// ── CategoryClaimFn: determines if a plugin owns a category ──

export type CategoryClaimFn = (category: string) => boolean | Promise<boolean>;

// ── DisplayMeta: UI rendering metadata for a plugin ──

export interface DisplayMeta {
  badge: string;
  badgeColor: string;
  externalLinkLabel: string;
  getExternalUrl(task: Task): string | null;
  isSynced(task: Task): boolean;
  syncTooltip?(task: Task): string;
  /** Language hint for triage agents (e.g. 'en', 'zh'). Plugins set this so core prompts can choose the right language without hardcoding plugin IDs. */
  languageHint?: string;
}

// ── HttpRoute: plugin-registered HTTP routes ──

export interface HttpRoute {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  handler: Router;
}

// ── MigrateFn: one-time data migration function ──

export type MigrateFn = (tasks: Task[]) => Promise<Task[]> | Task[];

// ── PluginApi: the registration interface passed to plugin entry points ──

export interface PluginApi {
  id: string;
  name: string;
  config: Record<string, unknown>;
  logger: SubsystemLogger;

  registerSync(sync: IntegrationSync): void;
  registerSourceClaim(fn: CategoryClaimFn, opts?: { priority?: number }): void;
  registerDisplay(meta: DisplayMeta): void;
  registerAgentContext(snippet: string): void;
  registerMigration(fn: MigrateFn): void;
  registerHttpRoute(route: HttpRoute): void;
}

// ── RegisteredPlugin: aggregated result after plugin registration ──

export interface RegisteredPlugin {
  id: string;
  name: string;
  description?: string;
  version?: string;
  config: Record<string, unknown>;
  sync: IntegrationSync;
  claim?: { fn: CategoryClaimFn; priority: number };
  display?: DisplayMeta;
  agentContext?: string;
  migrations: MigrateFn[];
  httpRoutes: HttpRoute[];
}

// ── Manifest: plugin manifest.json schema ──

export interface PluginManifest {
  id: string;
  name: string;
  description?: string;
  version?: string;
  configSchema?: Record<string, unknown>;
  uiHints?: Record<string, { label?: string; help?: string }>;
}
