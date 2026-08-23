/**
 * Unified hook types — session lifecycle + task lifecycle + cron.
 *
 * Defines hook points, payloads, and registration interfaces.
 * (Not to be confused with src/hooks/ — Walnut acting as a Claude Code CLI
 * process-hook client — or tests/hooks/ — React hook tests.)
 */

import type { Task, SessionRecord, SessionMode, TaskPhase } from '../types.js';

/** All available session hook points.
 *
 * NOTE: there is deliberately NO 'onSessionEnd' / 'onSessionIdle'. The CLI is a
 * long-running process — the bus event `session:ended` fires after EVERY turn
 * (it's a UI-refresh signal from server.ts), so an "end" hook point built on it
 * would fire per-turn (that bug shipped once, as session-summary-gist).
 *
 * 'onSessionWillReap' is the properly-sourced end-of-life point that decision
 * asked for: it rides `session:will-reap`, emitted by the idle reaper itself
 * (SessionHealthMonitor.checkIdleTimeout) for a session it is ABOUT to kill —
 * once per idle episode, never per turn. It is still not process death; that
 * remains the daemon's reapSession. See docs/decision/no-session-end-gist.md. */
export type SessionHookPoint =
  | 'onSessionStart'
  | 'onMessageSend'
  | 'onTurnStart'
  | 'onToolUse'
  | 'onToolResult'
  | 'onPlanComplete'
  | 'onModeChange'
  | 'onTurnComplete'
  | 'onTurnError'
  | 'onSessionWillReap';

/** Task lifecycle hook points (fired from task: bus events). */
export type TaskHookPoint =
  | 'onTaskCreated'
  | 'onTaskUpdated'
  | 'onTaskPhaseChanged'
  | 'onTaskCompleted';

/** Cron hook points (session-scoped: fired from session:cron-fired). */
export type CronHookPoint = 'onCronFired';

/** All hook points across domains — one flat union so a single hook
 *  definition can listen across domains. */
export type HookPoint = SessionHookPoint | TaskHookPoint | CronHookPoint;

export type HookDomain = 'session' | 'task' | 'cron';

/** Which domain each hook point belongs to — drives the dispatcher's O(1)
 *  "any hooks in this domain?" gate before any payload work happens. */
export const HOOK_POINT_DOMAIN: Record<HookPoint, HookDomain> = {
  onSessionStart: 'session',
  onMessageSend: 'session',
  onTurnStart: 'session',
  onToolUse: 'session',
  onToolResult: 'session',
  onPlanComplete: 'session',
  onModeChange: 'session',
  onTurnComplete: 'session',
  onTurnError: 'session',
  onSessionWillReap: 'session',
  onTaskCreated: 'task',
  onTaskUpdated: 'task',
  onTaskPhaseChanged: 'task',
  onTaskCompleted: 'task',
  onCronFired: 'cron',
};

/** Base context shared by all hook payloads.
 *  Field shape is load-bearing: builtins cast payloads to the On*Payload
 *  interfaces below, all of which extend this. The generic fields (domain,
 *  event) are optional so pre-existing session payloads stay assignable. */
export interface SessionHookContext {
  sessionId: string;
  taskId?: string;
  task?: Task;
  session?: SessionRecord;
  timestamp: string;
  traceId: string;
  /** Discriminator for cross-domain handlers. Absent = session (legacy). */
  domain?: 'session' | 'cron';
  /** Bus event name that fired this hook. */
  event?: string;
}

/** Context for task-domain hook points. No sessionId requirement — a task
 *  event fires whether or not a session is attached. */
export interface TaskHookContext {
  domain: 'task';
  taskId: string;
  task: Task;
  /** The task's attached session, when it has one. */
  sessionId?: string;
  oldPhase?: TaskPhase;
  newPhase?: TaskPhase;
  /** Bus event source ('api' | 'agent' | 'sync' | 'hook:<id>' | …). */
  eventSource?: string;
  timestamp: string;
  traceId: string;
  event?: string;
}

export type HookContext = SessionHookContext | TaskHookContext;

/** onSessionStart payload */
export interface OnSessionStartPayload extends SessionHookContext {
  mode?: string;
  host?: string;
  project?: string;
}

/** onMessageSend payload */
export interface OnMessageSendPayload extends SessionHookContext {
  message: string;
  isResume: boolean;
  /** Bus source of the send ('ui' | 'mobile' | 'web-api' | 'cli' | 'phase-hook' | …).
   *  The dispatcher already drops 'agent'/'subagent-runner'; hooks that must act
   *  only on a HUMAN's message (e.g. auto-title) filter further on this. */
  source?: string;
}

/** onTurnStart payload — derived: first text-delta/tool-use after send */
export interface OnTurnStartPayload extends SessionHookContext {
  turnIndex: number;
}

/** onToolUse payload */
export interface OnToolUsePayload extends SessionHookContext {
  toolName: string;
  toolUseId: string;
  input?: Record<string, unknown>;
}

/** onToolResult payload */
export interface OnToolResultPayload extends SessionHookContext {
  toolUseId: string;
  result: string;
}

/** onPlanComplete payload */
export interface OnPlanCompletePayload extends SessionHookContext {
  planFile?: string;
  previousMode?: SessionMode;
  newMode?: SessionMode;
}

/** onModeChange payload */
export interface OnModeChangePayload extends SessionHookContext {
  previousMode: SessionMode;
  newMode: SessionMode;
}

/** onTurnComplete payload */
export interface OnTurnCompletePayload extends SessionHookContext {
  result: string;
  totalCost?: number;
  duration?: number;
  turnIndex: number;
  isPlanSession: boolean;
}

/** onTurnError payload */
export interface OnTurnErrorPayload extends SessionHookContext {
  error: string;
  isSessionError: boolean;
}

/** onSessionWillReap payload — the idle reaper is about to kill this session's
 *  CLI process. Fires ONCE per idle episode, from the reaper's own decision
 *  point, after every exemption; `remainingMs` is 0…5 min (0 = being reaped on
 *  this tick). NOT process death, NOT per-turn — see the SessionHookPoint note. */
export interface OnSessionWillReapPayload extends SessionHookContext {
  /** Remote host alias; absent for local sessions. */
  host?: string;
  remainingMs: number;
  idleDurationMs: number;
  idleTimeoutMs: number;
  reason: 'idle_timeout';
  warnedAt: string;
}

/** onCronFired payload — a CLI scheduled task fired inside this session. */
export interface OnCronFiredPayload extends SessionHookContext {
  cronTaskId?: string;
  /** Session that created the cron (differs from sessionId on a foreign fire). */
  createdBySessionId?: string;
  /** True when the fire was adopted from another session (directory-lock adoption). */
  foreign: boolean;
}

/** Filter criteria for hook matching.
 *  Strict-deny semantics for every dimension: a specified dimension whose
 *  corresponding context data is missing DENIES rather than passing through. */
export interface SessionHookFilter {
  modes?: SessionMode[];
  /** Project names. A hook filtered on projects never fires for Inbox tasks. */
  projects?: string[];
  /** Task domain: fire only when the task lands in one of these phases. */
  phases?: TaskPhase[];
  /** Task domain: fire only when transitioning FROM one of these phases. */
  fromPhases?: TaskPhase[];
  /** Allowlist of bus event sources ('api', 'user', 'agent', 'sync', …). */
  sources?: string[];
  /** Fire only when the task has an attached session. */
  requiresSession?: boolean;
  /** Code-only escape hatch (builtin/.mjs hooks; config defs cannot supply this). */
  predicate?: (ctx: HookContext) => boolean;
}

/** Alias — the filter shape is domain-agnostic now. */
export type HookFilter = SessionHookFilter;

/** Declarative action a config-defined hook can perform (see hooks/actions.ts). */
export interface HookActionRef {
  type: string;
  [key: string]: unknown;
}

/** A registered hook definition. */
export interface SessionHookDefinition {
  id: string;
  name: string;
  description?: string;
  /** Which hook points this handler listens to. */
  hooks: HookPoint[];
  /** Inline handler function. Mutually exclusive with agentId. */
  handler?: (payload: SessionHookContext) => void | Promise<void>;
  /** Declarative action (config-defined hooks) — executed by hooks/actions.ts. */
  action?: HookActionRef;
  /** Dispatch to a subagent instead of inline handler. */
  agentId?: string;
  agentModel?: string;
  /** Lower = first. Default: 100. */
  priority?: number;
  /** Timeout in ms. Default: 30_000 for handlers, 120_000 for agents. */
  timeoutMs?: number;
  /** Optional filter — only fire for matching sessions/tasks. */
  filter?: SessionHookFilter;
  source?: 'builtin' | 'config' | 'file' | 'plugin';
  /** Where enforcement runs. Default 'walnut'. Daemon policies are inventory
   *  entries only — the dispatcher never executes them. */
  runtime?: 'walnut' | 'daemon';
  enabled?: boolean;
  /** Set when enforcement lives outside the dispatcher (inline session reader,
   *  daemon policy) — the entry exists for registry/UI visibility only. */
  enforcedElsewhere?: { where: string; note: string };
}

/** Alias for the unified system — same shape, domain-agnostic naming. */
export type HookDefinition = SessionHookDefinition;

/** Config section for session hooks in config.yaml. */
export interface SessionHooksConfig {
  /** Registered hooks from config. */
  hooks?: Omit<SessionHookDefinition, 'source' | 'handler'>[];
  /** Override builtin hook settings (keyed by hook id). */
  overrides?: Record<string, { enabled?: boolean; priority?: number; timeoutMs?: number }>;
  /** @deprecated no-op — the onSessionIdle hook point was removed (never had a consumer). */
  idleTimeoutMs?: number;
}
