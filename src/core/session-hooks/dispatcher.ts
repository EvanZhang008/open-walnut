/**
 * SessionHookDispatcher — global bus subscriber that maps session events
 * to hook points and dispatches to registered handlers.
 *
 * Subscribes as 'session-hooks' with { global: true } to receive all events.
 * Re-emitted events (reemit: true) are automatically skipped for GLOBAL subscribers
 * by the bus delivery loop — named subscribers in the destination list still receive
 * them normally. This prevents double-dispatch when main-ai re-emits enriched
 * session:result data to web-ui for browser display.
 * Fast path: events not starting with 'session:' are skipped immediately.
 */

import { randomBytes } from 'node:crypto';
import { bus, EventNames } from '../event-bus.js';
import type { BusEvent } from '../event-bus.js';
import type { SessionMode } from '../types.js';
import type {
  SessionHookPoint,
  SessionHookDefinition,
  SessionHookContext,
  SessionHooksConfig,
  OnSessionStartPayload,
  OnMessageSendPayload,
  OnTurnStartPayload,
  OnToolUsePayload,
  OnToolResultPayload,
  OnPlanCompletePayload,
  OnModeChangePayload,
  OnTurnCompletePayload,
  OnTurnErrorPayload,
  OnSessionEndPayload,
  OnSessionIdlePayload,
} from './types.js';
import { PayloadBuilder } from './payload.js';
import { log } from '../../logging/index.js';

// ── Per-session derived state ──

interface SessionState {
  awaitingFirstResponse: boolean;
  turnIndex: number;
  lastMode?: SessionMode;
  idleTimer?: ReturnType<typeof setTimeout>;
  lastActivityAt: number;
}

const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
const DEFAULT_AGENT_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000; // 5 min

export class SessionHookDispatcher {
  private hooks: SessionHookDefinition[] = [];
  private sessionState = new Map<string, SessionState>();
  private payloadBuilder = new PayloadBuilder();
  private idleTimeoutMs: number;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: SessionHooksConfig) {
    this.idleTimeoutMs = config?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /**
   * Register hook definitions and subscribe to the event bus.
   */
  init(hookDefs: SessionHookDefinition[], config?: SessionHooksConfig): void {
    // Clear existing prune timer to prevent leak if init() is called multiple times
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }

    // Merge config overrides
    this.hooks = hookDefs.map(h => {
      const override = config?.overrides?.[h.id];
      if (override) {
        return {
          ...h,
          enabled: override.enabled ?? h.enabled,
          priority: override.priority ?? h.priority,
          timeoutMs: override.timeoutMs ?? h.timeoutMs,
        };
      }
      return h;
    }).filter(h => h.enabled !== false);

    // Deduplicate by hook ID (last definition wins — file overrides builtin)
    const seen = new Map<string, SessionHookDefinition>();
    for (const h of this.hooks) {
      seen.set(h.id, h);
    }
    this.hooks = [...seen.values()];

    // Sort by priority (lower = first)
    this.hooks.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

    bus.subscribe('session-hooks', (event) => {
      this.handleEvent(event).catch(err => {
        log.session.error('session hook dispatcher error', {
          event: event.name,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, { global: true });

    // Periodic cache cleanup (.unref() so it doesn't prevent Node process exit in tests)
    this.pruneTimer = setInterval(() => this.payloadBuilder.prune(), 60_000);
    (this.pruneTimer as NodeJS.Timeout).unref?.();

    log.session.info('session hook dispatcher initialized', {
      hookCount: this.hooks.length,
      hookIds: this.hooks.map(h => h.id),
    });
  }

  /**
   * Add a hook definition at runtime.
   */
  addHook(hook: SessionHookDefinition): void {
    if (hook.enabled === false) return;
    this.hooks.push(hook);
    this.hooks.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }

  /**
   * Remove a hook by ID.
   */
  removeHook(id: string): void {
    this.hooks = this.hooks.filter(h => h.id !== id);
  }

  /**
   * Destroy the dispatcher: unsubscribe and clean up.
   */
  destroy(): void {
    bus.unsubscribe('session-hooks');
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    // Clear all idle timers
    for (const [, state] of this.sessionState) {
      if (state.idleTimer) clearTimeout(state.idleTimer);
    }
    this.sessionState.clear();
    this.payloadBuilder.clearAll();
  }

  // ── Event → Hook Point mapping ──

  private async handleEvent(event: BusEvent): Promise<void> {
    const name = event.name;

    // Fast path: only process session-related events
    if (!name.startsWith('session:')) return;

    // Guard: skip session:result/session:error/session:send from embedded subagent sessions.
    // Without this, a triage subagent's session:result would re-trigger triage
    // dispatch, creating an infinite loop. session:send is also guarded to prevent
    // message-send-triage from firing when turn-complete-triage calls send_to_session.
    if ((name === EventNames.SESSION_RESULT || name === EventNames.SESSION_ERROR
        || name === EventNames.SESSION_SEND)
        && event.source === 'subagent-runner') {
      return;
    }

    const hookPoints = this.mapEventToHookPoints(event);
    if (hookPoints.length === 0) return;

    // Extract sessionId and taskId from event data
    const data = event.data as Record<string, unknown>;
    const sessionId = (data.sessionId ?? data.session_id ?? '') as string;
    const taskId = data.taskId as string | undefined;

    if (!sessionId) return;

    // Reset idle timer on any activity
    this.resetIdleTimer(sessionId, taskId, event.traceId);

    for (const { hookPoint, extraPayload } of hookPoints) {
      const matching = this.hooks.filter(h => h.hooks.includes(hookPoint));
      if (matching.length === 0) continue;

      // Build context (cached per session)
      const context = await this.payloadBuilder.build(sessionId, taskId, event.traceId);
      const payload = { ...context, ...extraPayload };

      // Filter hooks by session criteria
      const filtered = matching.filter(h => this.matchesFilter(h, context));

      // Dispatch all matching hooks in parallel with timeout
      await Promise.allSettled(
        filtered.map(h => this.dispatchHook(h, hookPoint, payload)),
      );
    }
  }

  private mapEventToHookPoints(event: BusEvent): Array<{ hookPoint: SessionHookPoint; extraPayload: Record<string, unknown> }> {
    const data = event.data as Record<string, unknown>;
    const results: Array<{ hookPoint: SessionHookPoint; extraPayload: Record<string, unknown> }> = [];
    const sessionId = (data.sessionId ?? '') as string;

    switch (event.name) {
      case EventNames.SESSION_STARTED: {
        results.push({
          hookPoint: 'onSessionStart',
          extraPayload: {
            mode: (data.mode ?? data.provider) as string | undefined,
            host: data.host as string | undefined,
            project: data.project as string | undefined,
          } satisfies Partial<OnSessionStartPayload>,
        });
        // Init session state
        this.sessionState.set(sessionId, {
          awaitingFirstResponse: false,
          turnIndex: 0,
          lastMode: data.mode as SessionMode | undefined,
          lastActivityAt: Date.now(),
        });
        break;
      }

      case EventNames.SESSION_SEND: {
        const state = this.getOrCreateState(sessionId);
        state.awaitingFirstResponse = true;
        // Skip onMessageSend for automated sources (triage send_to_session, subagent-runner).
        // User-initiated sources (web-ui, cli, web-api) fire hooks normally.
        if (event.source !== 'agent' && event.source !== 'subagent-runner') {
          results.push({
            hookPoint: 'onMessageSend',
            extraPayload: {
              message: data.message as string,
              isResume: state.turnIndex > 0,
            } satisfies Partial<OnMessageSendPayload>,
          });
        }
        break;
      }

      case EventNames.SESSION_TEXT_DELTA:
      case EventNames.SESSION_TOOL_USE: {
        const state = this.getOrCreateState(sessionId);
        state.lastActivityAt = Date.now();

        // Derived: onTurnStart fires on first response after send
        if (state.awaitingFirstResponse) {
          state.awaitingFirstResponse = false;
          state.turnIndex++;
          results.push({
            hookPoint: 'onTurnStart',
            extraPayload: {
              turnIndex: state.turnIndex,
            } satisfies Partial<OnTurnStartPayload>,
          });
        }

        // Tool use events
        if (event.name === EventNames.SESSION_TOOL_USE) {
          const toolName = (data.toolName ?? data.name ?? '') as string;
          results.push({
            hookPoint: 'onToolUse',
            extraPayload: {
              toolName,
              toolUseId: data.toolUseId as string,
              input: data.input as Record<string, unknown> | undefined,
            } satisfies Partial<OnToolUsePayload>,
          });

          // Derived: onPlanComplete when ExitPlanMode is called
          if (toolName === 'ExitPlanMode') {
            results.push({
              hookPoint: 'onPlanComplete',
              extraPayload: {
                planFile: data.planContent as string | undefined,
              } satisfies Partial<OnPlanCompletePayload>,
            });
          }
        }
        break;
      }

      case EventNames.SESSION_TOOL_RESULT: {
        results.push({
          hookPoint: 'onToolResult',
          extraPayload: {
            toolUseId: data.toolUseId as string,
            result: data.result as string,
          } satisfies Partial<OnToolResultPayload>,
        });
        break;
      }

      case EventNames.SESSION_STATUS_CHANGED: {
        const state = this.getOrCreateState(sessionId);
        const newMode = data.mode as SessionMode | undefined;
        const oldMode = state.lastMode;

        // Derived: onModeChange when mode differs
        if (newMode && oldMode && newMode !== oldMode) {
          results.push({
            hookPoint: 'onModeChange',
            extraPayload: {
              previousMode: oldMode,
              newMode,
            } satisfies Partial<OnModeChangePayload>,
          });
          state.lastMode = newMode;
        }
        break;
      }

      case EventNames.SESSION_RESULT: {
        const isError = data.isError as boolean | undefined;
        const state = this.getOrCreateState(sessionId);

        if (isError) {
          results.push({
            hookPoint: 'onTurnError',
            extraPayload: {
              error: data.result as string ?? data.error as string ?? 'unknown error',
              isSessionError: false,
            } satisfies Partial<OnTurnErrorPayload>,
          });
        } else {
          results.push({
            hookPoint: 'onTurnComplete',
            extraPayload: {
              result: data.result as string ?? '',
              totalCost: data.totalCost as number | undefined,
              duration: data.duration as number | undefined,
              turnIndex: state.turnIndex,
              isPlanSession: state.lastMode === 'plan',
            } satisfies Partial<OnTurnCompletePayload>,
          });
        }
        break;
      }

      case EventNames.SESSION_ERROR: {
        results.push({
          hookPoint: 'onTurnError',
          extraPayload: {
            error: data.error as string ?? 'unknown error',
            isSessionError: true,
          } satisfies Partial<OnTurnErrorPayload>,
        });
        break;
      }

      case EventNames.SESSION_ENDED: {
        results.push({
          hookPoint: 'onSessionEnd',
          extraPayload: {} satisfies Partial<OnSessionEndPayload>,
        });
        // Cleanup session state
        const endState = this.sessionState.get(sessionId);
        if (endState?.idleTimer) clearTimeout(endState.idleTimer);
        this.sessionState.delete(sessionId);
        this.payloadBuilder.clearSession(sessionId);
        break;
      }
    }

    return results;
  }

  // ── Idle timer ──

  private resetIdleTimer(sessionId: string, taskId: string | undefined, _traceId: string): void {
    const state = this.getOrCreateState(sessionId);
    if (state.idleTimer) clearTimeout(state.idleTimer);

    const matching = this.hooks.filter(h => h.hooks.includes('onSessionIdle'));
    if (matching.length === 0) return;

    state.idleTimer = setTimeout(async () => {
      // Generate a fresh traceId for the idle event (the original traceId from
      // the last activity event would be stale and misleading in traces)
      const idleTraceId = randomBytes(4).toString('hex');
      const context = await this.payloadBuilder.build(sessionId, taskId, idleTraceId);
      const payload: OnSessionIdlePayload = {
        ...context,
        idleSinceMs: Date.now() - state.lastActivityAt,
      };

      const filtered = matching.filter(h => this.matchesFilter(h, context));
      await Promise.allSettled(
        filtered.map(h => this.dispatchHook(h, 'onSessionIdle', payload)),
      );
    }, this.idleTimeoutMs);
  }

  // ── Hook dispatch ──

  private async dispatchHook(
    hook: SessionHookDefinition,
    hookPoint: SessionHookPoint,
    payload: SessionHookContext,
  ): Promise<void> {
    const timeoutMs = hook.timeoutMs
      ?? (hook.agentId ? DEFAULT_AGENT_TIMEOUT_MS : DEFAULT_HANDLER_TIMEOUT_MS);

    try {
      if (hook.handler) {
        // Inline handler with timeout (clear timer when handler resolves to prevent leak)
        let timer: ReturnType<typeof setTimeout>;
        await Promise.race([
          Promise.resolve(hook.handler(payload)).then(
            (v) => { clearTimeout(timer); return v; },
            (e) => { clearTimeout(timer); throw e; },
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Hook "${hook.id}" timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
      } else if (hook.agentId) {
        // Dispatch to subagent
        const taskMessage = `[Session Hook: ${hookPoint}] Session ${payload.sessionId}${payload.taskId ? ` for task ${payload.taskId}` : ''}\n\nContext:\n${JSON.stringify(payload, null, 2)}`;
        bus.emit('subagent:start', {
          agentId: hook.agentId,
          task: taskMessage,
          taskId: payload.taskId,
          model: hook.agentModel,
        }, ['subagent-runner'], { source: `session-hook:${hook.id}` });
      }
    } catch (err) {
      log.session.warn(`session hook "${hook.id}" failed on ${hookPoint}`, {
        hookId: hook.id,
        hookPoint,
        sessionId: payload.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Helpers ──

  private getOrCreateState(sessionId: string): SessionState {
    let state = this.sessionState.get(sessionId);
    if (!state) {
      state = {
        awaitingFirstResponse: false,
        turnIndex: 0,
        lastActivityAt: Date.now(),
      };
      this.sessionState.set(sessionId, state);
    }
    return state;
  }

  private matchesFilter(hook: SessionHookDefinition, context: SessionHookContext): boolean {
    if (!hook.filter) return true;
    const { modes, projects, categories } = hook.filter;

    // Strict filtering: when a filter dimension is specified but the context
    // lacks the corresponding data, deny rather than silently pass through.
    // This prevents hooks from running on unintended sessions.
    if (modes) {
      if (!context.session?.mode) return false;
      if (!modes.includes(context.session.mode)) return false;
    }
    if (projects) {
      if (!context.task?.project) return false;
      if (!projects.includes(context.task.project)) return false;
    }
    if (categories) {
      if (!context.task?.category) return false;
      if (!categories.includes(context.task.category)) return false;
    }
    return true;
  }
}
