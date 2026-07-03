/**
 * Routines — pluggable executor layer on top of the cron engine.
 *
 * A routine = trigger (cron schedule) + executor. The executor decides WHERE
 * the routine's instructions run:
 *   - main-agent:   inject into the butler's main conversation (legacy sessionTarget 'main')
 *   - walnut-agent: isolated in-process agent turn (legacy sessionTarget 'isolated')
 *   - claude-code:  start a real Claude Code session (local or remote host)
 *
 * New executor types only need an ExecutorDefinition registered in the registry —
 * the cron engine, REST API, and UI form all key off that definition.
 */

import type {
  CronJob,
  RoutineExecutorRef,
  ExecutorRunResult,
  RunExecutorFn,
} from '../cron/types.js';

export type { RoutineExecutorRef, ExecutorRunResult, RunExecutorFn };

// ── Built-in executor types ──

export const BUILTIN_EXECUTOR_TYPES = ['main-agent', 'walnut-agent', 'claude-code'] as const;
export type BuiltinExecutorType = (typeof BUILTIN_EXECUTOR_TYPES)[number];

// ── Per-type config shapes ──

export interface MainAgentExecutorConfig {
  instructions: string;
}

export interface WalnutAgentExecutorConfig {
  instructions: string;
  /** Optional model override for the isolated agent run. */
  model?: string;
  timeoutSeconds?: number;
}

export interface ClaudeCodeExecutorConfig {
  instructions: string;
  /** Working directory for the session (required). */
  cwd: string;
  /** Host alias from config.hosts; undefined or '__local__' = local machine. */
  host?: string;
  model?: string;
  /** Optional task title override; defaults to the routine name. */
  taskTitle?: string;
}

// ── Executor definition (registry entry) ──

/**
 * Field spec that drives the dynamic executor section of the routine form.
 * `optionsKey` marks fields whose options are dynamic (resolved by the
 * /api/routines/executors route: hosts from config, models from the catalog).
 */
export interface ExecutorFieldSpec {
  name: string;
  label: string;
  kind: 'text' | 'textarea' | 'select' | 'number' | 'path';
  required?: boolean;
  placeholder?: string;
  optionsKey?: 'hosts' | 'models';
}

export interface ExecutorDefinition {
  type: string;
  /** Human label for badges/forms, e.g. "Claude Code". */
  label: string;
  /** Short one-liner shown under the executor picker. */
  description: string;
  configSchema: ExecutorFieldSpec[];
  /** Validate + coerce a raw config object. */
  validate(config: unknown):
    | { ok: true; config: Record<string, unknown> }
    | { ok: false; error: string };
  /**
   * Execute the routine. `message` is the final instructions text (routine
   * instructions, with any init-processor output already prepended by the
   * cron engine) — use it instead of config.instructions.
   */
  run(job: CronJob, executor: RoutineExecutorRef, message: string): Promise<ExecutorRunResult>;
}
