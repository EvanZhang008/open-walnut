/**
 * HookDispatcher — global bus subscriber that maps bus events to hook points
 * and dispatches to registered handlers. Domain-agnostic: session lifecycle,
 * task lifecycle, and cron fires all route through here.
 *
 * Subscribes as 'session-hooks' with { global: true }. Re-emitted events
 * (reemit: true) are automatically skipped for GLOBAL subscribers by the bus
 * delivery loop — named subscribers in the destination list still receive
 * them normally. This prevents double-dispatch when main-ai re-emits enriched
 * session:result data to web-ui for browser display.
 *
 * Fast paths, in order: (1) domain gate — events whose domain has NO registered
 * hooks are dropped before any payload work; (2) filter-before-enrich — the
 * per-session context cache is only consulted after a hook point matched.
 */

import { bus, EventNames } from '../event-bus.js';
import type { BusEvent } from '../event-bus.js';
import type {
  HookPoint,
  HookDomain,
  SessionHookDefinition,
  SessionHookContext,
  HookContext,
  TaskHookContext,
  SessionHooksConfig,
} from './types.js';
import { HOOK_POINT_DOMAIN } from './types.js';
import { PayloadBuilder } from './payload.js';
import {
  deriveSessionHookPoints,
  getOrCreateSessionState,
  type SessionState,
  type DerivedHookPoint,
} from './derive/session.js';
import { deriveTaskHookPoints, buildTaskContext } from './derive/task.js';
import { log } from '../../logging/index.js';

const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
const DEFAULT_AGENT_TIMEOUT_MS = 120_000;

/** Bus events the dispatcher subscribes to.
 *  KEEP IN SYNC with domainForEvent() below (pattern: git-versioning.ts).
 *  Task names are EXPLICIT (not the 'task:' prefix) — task:starred/reordered/
 *  groups-changed/deleted/unblocked deliberately excluded: no hook points map
 *  to them, and task:updated alone already fires per sync tick. */
const HOOK_BUS_INTEREST = [
  'session:', // all session streaming — turn-start derivation needs text-delta etc.
  'task:created', 'task:updated', 'task:completed', 'task:phase-changed',
];

function domainForEvent(name: string): HookDomain | null {
  if (name.startsWith('session:')) return 'session'; // session:cron-fired handled inside session derivation → onCronFired (domain 'cron')
  if (name === EventNames.TASK_CREATED || name === EventNames.TASK_UPDATED
    || name === EventNames.TASK_COMPLETED || name === EventNames.TASK_PHASE_CHANGED) return 'task';
  return null;
}

export class HookDispatcher {
  private hooks: SessionHookDefinition[] = [];
  private sessionState = new Map<string, SessionState>();
  private payloadBuilder = new PayloadBuilder();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  /** Domains that have ≥1 registered hook — the O(1) event gate. */
  private domainsInUse = new Set<HookDomain>();
  /** Domains allowed to dispatch (cloud replica gates task/cron off). */
  private enabledDomains: Set<HookDomain> | null = null;

  constructor(_config?: SessionHooksConfig) {}

  /**
   * Register hook definitions and subscribe to the event bus.
   */
  init(hookDefs: SessionHookDefinition[], config?: SessionHooksConfig, opts?: { domains?: HookDomain[] }): void {
    // Clear existing prune timer to prevent leak if init() is called multiple times
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }

    this.enabledDomains = opts?.domains ? new Set(opts.domains) : null;
    this.setHooks(hookDefs, config);

    // Subscriber name 'session-hooks' is load-bearing: tests assert
    // bus.has('session-hooks') and external teardown unsubscribes by name.
    bus.subscribe('session-hooks', (event) => {
      this.handleEvent(event).catch(err => {
        log.session.error('hook dispatcher error', {
          event: event.name,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // interest mirrors handleEvent's own domain gate: hooks genuinely need ALL
      // session: streaming (turn-start detection from text-delta, tool-use→
      // onToolUse/ExitPlanMode, tool-result→cwd-rename) plus the four explicit
      // task events; everything else (audio:/cron:/…) drops at the bus.
    }, { global: true, interest: HOOK_BUS_INTEREST });

    // Periodic cache cleanup (.unref() so it doesn't prevent Node process exit in tests)
    this.pruneTimer = setInterval(() => this.payloadBuilder.prune(), 60_000);
    (this.pruneTimer as NodeJS.Timeout).unref?.();

    log.session.info('hook dispatcher initialized', {
      hookCount: this.hooks.length,
      hookIds: this.hooks.map(h => h.id),
      domains: [...this.domainsInUse],
    });
  }

  /**
   * Recompute the merged hook list from new defs/config WITHOUT resubscribing.
   * Used by the config:changed live-reload path — the bus interest set is
   * static, so a reload is a pure in-memory swap.
   */
  reload(hookDefs: SessionHookDefinition[], config?: SessionHooksConfig): void {
    this.setHooks(hookDefs, config);
    log.session.info('hook dispatcher reloaded', {
      hookCount: this.hooks.length,
      hookIds: this.hooks.map(h => h.id),
    });
  }

  /** Live defs (post-merge, enabled only) — consumed by the hooks registry. */
  getHooks(): readonly SessionHookDefinition[] {
    return this.hooks;
  }

  private setHooks(hookDefs: SessionHookDefinition[], config?: SessionHooksConfig): void {
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

    // Recompute the domain gate. Daemon-policy / inventory-only entries never
    // dispatch, so they don't arm a domain.
    this.domainsInUse.clear();
    for (const h of this.hooks) {
      if (h.runtime === 'daemon' || h.enforcedElsewhere) continue;
      for (const p of h.hooks) {
        this.domainsInUse.add(HOOK_POINT_DOMAIN[p]);
      }
    }
  }

  /**
   * Add a hook definition at runtime.
   */
  addHook(hook: SessionHookDefinition): void {
    if (hook.enabled === false) return;
    this.hooks.push(hook);
    this.hooks.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    if (!hook.runtime || hook.runtime === 'walnut') {
      for (const p of hook.hooks) this.domainsInUse.add(HOOK_POINT_DOMAIN[p]);
    }
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
    this.sessionState.clear();
    this.payloadBuilder.clearAll();
  }

  // ── Event → Hook Point mapping ──

  private async handleEvent(event: BusEvent): Promise<void> {
    const name = event.name;

    // Fast path 1: domain gate — unknown domain, domain disabled (cloud
    // replica), or no hooks registered for it → drop before any payload work.
    // Session events always pass the domainsInUse check when session hooks
    // exist; cron rides the session prefix (session:cron-fired) and is gated
    // by its own hook-point match below.
    const domain = domainForEvent(name);
    if (!domain) return;
    if (this.enabledDomains && !this.enabledDomains.has(domain)) return;
    if (domain === 'session') {
      // session prefix carries both 'session' and 'cron' hook points
      if (!this.domainsInUse.has('session') && !this.domainsInUse.has('cron')) return;
    } else if (!this.domainsInUse.has(domain)) {
      return;
    }

    // Guard: skip session:result/session:error/session:send from embedded subagent sessions.
    // Without this, a summary subagent's session:result would re-trigger the summary
    // dispatch, creating an infinite loop. (session:send is kept in the guard defensively —
    // the summary agent no longer has a session_send tool, but a custom replacement agent
    // could, and its sends must not re-enter the hook pipeline.)
    if ((name === EventNames.SESSION_RESULT || name === EventNames.SESSION_ERROR
        || name === EventNames.SESSION_SEND)
        && event.source === 'subagent-runner') {
      return;
    }

    // Guard: task events produced by a hook action must not re-enter the
    // pipeline (hook → updateTask → task:phase-changed → hook = loop).
    if (domain === 'task' && event.source?.startsWith('hook:')) return;

    if (domain === 'task') {
      await this.handleTaskEvent(event);
      return;
    }

    const hookPoints = deriveSessionHookPoints(
      event,
      this.sessionState,
      (sid) => this.payloadBuilder.clearSession(sid),
    );
    if (hookPoints.length === 0) return;

    // Extract sessionId and taskId from event data
    const data = event.data as Record<string, unknown>;
    const sessionId = (data.sessionId ?? data.session_id ?? '') as string;
    const taskId = data.taskId as string | undefined;

    if (!sessionId) return;

    // Track activity for turn-state bookkeeping.
    getOrCreateSessionState(this.sessionState, sessionId).lastActivityAt = Date.now();

    for (const { hookPoint, extraPayload } of hookPoints) {
      const matching = this.hooks.filter(h => h.hooks.includes(hookPoint));
      if (matching.length === 0) continue;

      // Build context (cached per session)
      const context = await this.payloadBuilder.build(sessionId, taskId, event.traceId);
      const payload = { ...context, event: name, ...extraPayload };

      // Filter hooks by session criteria
      const filtered = matching.filter(h => this.matchesFilter(h, payload));

      // Dispatch all matching hooks in parallel with timeout
      await Promise.allSettled(
        filtered.map(h => this.dispatchHook(h, hookPoint, payload)),
      );
    }
  }

  private async handleTaskEvent(event: BusEvent): Promise<void> {
    const hookPoints = deriveTaskHookPoints(event);
    if (hookPoints.length === 0) return;

    // Zero-IO context — the Task rides the bus event.
    const context = buildTaskContext(event, event.traceId);
    if (!context) return;

    for (const { hookPoint, extraPayload } of hookPoints) {
      const matching = this.hooks.filter(h => h.hooks.includes(hookPoint));
      if (matching.length === 0) continue;

      const payload: TaskHookContext = { ...context, ...extraPayload };
      const filtered = matching.filter(h => this.matchesFilter(h, payload));

      await Promise.allSettled(
        filtered.map(h => this.dispatchHook(h, hookPoint, payload)),
      );
    }
  }

  // ── Hook dispatch ──

  private async dispatchHook(
    hook: SessionHookDefinition,
    hookPoint: HookPoint,
    payload: HookContext,
  ): Promise<void> {
    const timeoutMs = hook.timeoutMs
      ?? (hook.agentId ? DEFAULT_AGENT_TIMEOUT_MS : DEFAULT_HANDLER_TIMEOUT_MS);

    try {
      if (hook.handler) {
        // Inline handler with timeout (clear timer when handler resolves to prevent leak)
        let timer: ReturnType<typeof setTimeout>;
        await Promise.race([
          Promise.resolve(hook.handler(payload as SessionHookContext)).then(
            (v) => { clearTimeout(timer); return v; },
            (e) => { clearTimeout(timer); throw e; },
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Hook "${hook.id}" timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
      } else if (hook.action) {
        // Declarative action (config-defined hooks)
        const { executeHookAction } = await import('../hooks/actions.js');
        await executeHookAction(hook, payload);
      } else if (hook.agentId) {
        // Dispatch to subagent
        const sessionId = 'sessionId' in payload ? payload.sessionId : undefined;
        const taskId = 'taskId' in payload ? payload.taskId : undefined;
        const taskMessage = `[Session Hook: ${hookPoint}] Session ${sessionId}${taskId ? ` for task ${taskId}` : ''}\n\nContext:\n${JSON.stringify(payload, null, 2)}`;
        bus.emit('subagent:start', {
          agentId: hook.agentId,
          task: taskMessage,
          taskId,
          model: hook.agentModel,
        }, ['subagent-runner'], { source: `session-hook:${hook.id}` });
      }
    } catch (err) {
      log.session.warn(`hook "${hook.id}" failed on ${hookPoint}`, {
        hookId: hook.id,
        hookPoint,
        sessionId: 'sessionId' in payload ? payload.sessionId : undefined,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Helpers ──

  private matchesFilter(hook: SessionHookDefinition, context: HookContext): boolean {
    if (!hook.filter) return true;
    const { modes, projects, phases, fromPhases, sources, requiresSession, predicate } = hook.filter;

    // Strict filtering: when a filter dimension is specified but the context
    // lacks the corresponding data, deny rather than silently pass through.
    // This prevents hooks from running on unintended sessions/tasks.
    const isTask = 'domain' in context && context.domain === 'task';
    const taskCtx = isTask ? context as TaskHookContext : null;
    const sessionCtx = !isTask ? context as SessionHookContext : null;

    if (modes) {
      if (!sessionCtx?.session?.mode) return false;
      if (!modes.includes(sessionCtx.session.mode)) return false;
    }
    if (projects) {
      const project = taskCtx?.task?.project ?? sessionCtx?.task?.project;
      if (!project) return false;
      if (!projects.includes(project)) return false;
    }
    if (phases) {
      const phase = taskCtx?.newPhase ?? taskCtx?.task?.phase ?? sessionCtx?.task?.phase;
      if (!phase) return false;
      if (!phases.includes(phase)) return false;
    }
    if (fromPhases) {
      if (!taskCtx?.oldPhase) return false;
      if (!fromPhases.includes(taskCtx.oldPhase)) return false;
    }
    if (sources) {
      const source = taskCtx?.eventSource;
      if (!source) return false;
      if (!sources.includes(source)) return false;
    }
    if (requiresSession) {
      const sid = taskCtx ? (taskCtx.sessionId ?? taskCtx.task?.session_id) : sessionCtx?.sessionId;
      if (!sid) return false;
    }
    if (predicate) {
      try {
        if (!predicate(context)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }
}

/** Back-compat alias — external code and tests construct SessionHookDispatcher. */
export class SessionHookDispatcher extends HookDispatcher {}
