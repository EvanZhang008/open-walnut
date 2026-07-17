/**
 * Session Lifecycle Hook types.
 *
 * Defines hook points, payloads, and registration interfaces.
 */

import type { Task, SessionRecord, SessionMode } from '../types.js';

/** All available session hook points.
 *
 * NOTE: there is deliberately NO 'onSessionEnd' / 'onSessionIdle'. The CLI is a
 * long-running process — the bus event `session:ended` fires after EVERY turn
 * (it's a UI-refresh signal from server.ts), so an "end" hook point built on it
 * would fire per-turn (that bug shipped once, as session-summary-gist). The only
 * real end-of-life signals are the daemon's idle reap / process death, which have
 * no hook plumbing today; add a properly-sourced hook point if a need arises. */
export type SessionHookPoint =
  | 'onSessionStart'
  | 'onMessageSend'
  | 'onTurnStart'
  | 'onToolUse'
  | 'onToolResult'
  | 'onPlanComplete'
  | 'onModeChange'
  | 'onTurnComplete'
  | 'onTurnError';

/** Base context shared by all hook payloads. */
export interface SessionHookContext {
  sessionId: string;
  taskId?: string;
  task?: Task;
  session?: SessionRecord;
  timestamp: string;
  traceId: string;
}

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

/** Filter criteria for hook matching. */
export interface SessionHookFilter {
  modes?: SessionMode[];
  projects?: string[];
  categories?: string[];
}

/** A registered hook definition. */
export interface SessionHookDefinition {
  id: string;
  name: string;
  description?: string;
  /** Which hook points this handler listens to. */
  hooks: SessionHookPoint[];
  /** Inline handler function. Mutually exclusive with agentId. */
  handler?: (payload: SessionHookContext) => void | Promise<void>;
  /** Dispatch to a subagent instead of inline handler. */
  agentId?: string;
  agentModel?: string;
  /** Lower = first. Default: 100. */
  priority?: number;
  /** Timeout in ms. Default: 30_000 for handlers, 120_000 for agents. */
  timeoutMs?: number;
  /** Optional filter — only fire for matching sessions. */
  filter?: SessionHookFilter;
  source?: 'builtin' | 'config' | 'file';
  enabled?: boolean;
}

/** Config section for session hooks in config.yaml. */
export interface SessionHooksConfig {
  /** Registered hooks from config. */
  hooks?: Omit<SessionHookDefinition, 'source' | 'handler'>[];
  /** Override builtin hook settings (keyed by hook id). */
  overrides?: Record<string, { enabled?: boolean; priority?: number; timeoutMs?: number }>;
  /** @deprecated no-op — the onSessionIdle hook point was removed (never had a consumer). */
  idleTimeoutMs?: number;
}
