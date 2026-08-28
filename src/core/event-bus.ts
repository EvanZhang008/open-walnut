/**
 * Event Bus — reactive backbone for the Walnut web application.
 *
 * Events are routed to named subscribers based on explicit `destinations`.
 * The CoalescingQueue batches events for the main-agent to prevent
 * N events from triggering N separate AI calls.
 */

import { randomBytes } from 'node:crypto';
import { log } from '../logging/index.js';
import type { EventPayloadMap } from './event-types.js';
export type { EventPayloadMap } from './event-types.js';
export { eventData } from './event-types.js';

// ── Event name constants ──

export const EventNames = {
  // Task events
  TASK_CREATED: 'task:created',
  TASK_UPDATED: 'task:updated',
  TASK_COMPLETED: 'task:completed',
  TASK_DELETED: 'task:deleted',
  TASK_REORDERED: 'task:reordered',
  TASK_UNBLOCKED: 'task:unblocked',
  TASK_GROUPS_CHANGED: 'task:groups-changed',
  /** Emitted (beside TASK_UPDATED) only when a task's phase actually changed.
   *  Fires from ALL mutation paths — REST PATCH, agent task_update, session
   *  state machine, complete/toggle, bulk, sync pull — so hook consumers
   *  don't have to diff TASK_UPDATED payloads. */
  TASK_PHASE_CHANGED: 'task:phase-changed',

  // Calendar (external calendar events cache refreshed / event written)
  CALENDAR_UPDATED: 'calendar:updated',

  // Inline subagent streaming
  AGENT_SUBAGENT_STREAM: 'agent:subagent-stream',

  // ✦ AI task-search live progress (mini-session lines in the search panel)
  SEARCH_AGENT_PROGRESS: 'search-agent:progress',

  // Agent events (chat streaming)
  AGENT_TEXT_DELTA: 'agent:text-delta',
  AGENT_TOOL_ACTIVITY: 'agent:tool-activity',
  AGENT_TOOL_CALL: 'agent:tool-call',
  AGENT_TOOL_RESULT: 'agent:tool-result',
  AGENT_THINKING: 'agent:thinking',
  AGENT_RESPONSE: 'agent:response',
  AGENT_ERROR: 'agent:error',

  // Session events
  SESSION_START: 'session:start',
  SESSION_SEND: 'session:send',
  SESSION_INTERRUPT: 'session:interrupt',
  SESSION_STARTED: 'session:started',
  SESSION_ENDED: 'session:ended',
  SESSION_DELETED: 'session:deleted',
  SESSION_CONTENT_UPDATED: 'session:content-updated',
  SESSION_RESULT: 'session:result',
  SESSION_ERROR: 'session:error',
  /** The idle reaper is about to kill this session's CLI (≤5 min out).
   *  This is the ONE honest pre-death warning Walnut can make: it comes from
   *  SessionHealthMonitor.checkIdleTimeout, the code that actually decides an
   *  idle reap, after every exemption. It is NOT `session:ended` (a per-turn UI
   *  refresh signal) and NOT process death (the daemon's reapSession) — see
   *  docs/decision/no-session-end-gist.md before building on either. */
  SESSION_WILL_REAP: 'session:will-reap',

  // Session streaming events (from --output-format stream-json)
  SESSION_TEXT_DELTA: 'session:text-delta',
  SESSION_THINKING_DELTA: 'session:thinking-delta',
  SESSION_TOOL_USE: 'session:tool-use',
  SESSION_TOOL_RESULT: 'session:tool-result',
  SESSION_UNKNOWN_EVENT: 'session:unknown-event',
  SESSION_STATUS_CHANGED: 'session:status-changed',
  SESSION_MESSAGES_DELIVERED: 'session:messages-delivered',
  SESSION_BATCH_COMPLETED: 'session:batch-completed',
  SESSION_BATCH_FAILED: 'session:batch-failed',
  SESSION_MESSAGE_QUEUED: 'session:message-queued',
  SESSION_SYSTEM_EVENT: 'session:system-event',
  SESSION_BACKGROUND_TASKS: 'session:background-tasks',
  SESSION_USAGE_UPDATE: 'session:usage-update',
  SESSION_SETTINGS_APPLIED: 'session:settings-applied',
  SESSION_MODEL_CATALOG: 'session:model-catalog',
  SESSION_PERMISSION_REQUEST: 'session:permission-request',
  SESSION_PERMISSION_RESOLVED: 'session:permission-resolved',
  /** A CLI scheduled task (cron) fired inside a session. Deliberately in the
   *  session: family (it is always session-scoped) so the hook dispatcher's
   *  existing 'session:' bus interest covers it — no new global wake-ups. */
  SESSION_CRON_FIRED: 'session:cron-fired',

  // Side question ("/btw") — native Claude Code side_question round-trip results.
  // The drawer subscribes to these to update without polling.
  SESSION_SIDE_QUESTION_DONE: 'session:side-question-done',
  SESSION_SIDE_QUESTION_ERROR: 'session:side-question-error',

  // Team events (Claude Code Teams — parallel agents)
  SESSION_TEAM_INFO: 'session:team-info',
  SESSION_TEAM_AGENT_DELTA: 'session:team-agent-delta',

  // Chat history events
  CHAT_HISTORY_UPDATED: 'chat:history-updated',
  CHAT_COMPACTING: 'chat:compacting',
  CHAT_COMPACTED: 'chat:compacted',

  // Conversation events (multi-conversation per agent)
  CONVERSATION_CREATED: 'conversation:created',
  CONVERSATION_DELETED: 'conversation:deleted',
  CONVERSATION_UPDATED: 'conversation:updated',   // rename / pin / active-change

  // Cron events
  CRON_JOB_ADDED: 'cron:job-added',
  CRON_JOB_UPDATED: 'cron:job-updated',
  CRON_JOB_REMOVED: 'cron:job-removed',
  CRON_JOB_STARTED: 'cron:job-started',
  CRON_JOB_FINISHED: 'cron:job-finished',
  CRON_NOTIFICATION: 'cron:notification',

  // Subagent events
  SUBAGENT_START: 'subagent:start',
  SUBAGENT_SEND: 'subagent:send',
  SUBAGENT_STARTED: 'subagent:started',
  SUBAGENT_RESULT: 'subagent:result',
  SUBAGENT_ERROR: 'subagent:error',

  // Sync events
  SYNC_PULLED: 'sync:pulled',
  SYNC_CONFLICT_RESOLVED: 'sync:conflict-resolved',

  // Project registry events
  PROJECT_CREATED: 'project:created',

  // Notes events
  NOTES_UPDATED: 'notes:updated',
  NOTES_TREE_CHANGED: 'notes:tree-changed',

  // Config events
  CONFIG_CHANGED: 'config:changed',

  // Audio capture events
  AUDIO_STARTED: 'audio:started',
  AUDIO_STOPPED: 'audio:stopped',
  AUDIO_CHUNK_SAVED: 'audio:chunk-saved',
  AUDIO_ERROR: 'audio:error',
  AUDIO_TRANSCRIPTION_COMPLETE: 'audio:transcription-complete',

  // System health events
  SYSTEM_HEALTH: 'system:health',

  // Mobile client incidents (a freeze/crash line arrived in an uploaded iOS log)
  CLIENT_INCIDENT: 'client:incident',

  // Cloud-companion setup job progress (never carries the pairing code)
  CLOUD_SETUP_UPDATE: 'cloud-setup:update',

  // Human Inbox: an agent sent the human a letter, or replied in its thread.
  // Envelope only — the body stays on disk (see HumanInboxLetterEvent).
  HUMAN_INBOX_LETTER: 'human-inbox:letter',
} as const;

export type EventName = (typeof EventNames)[keyof typeof EventNames];

// ── Types ──

export interface BusEvent {
  name: string;
  data: unknown;
  destinations: string[];
  urgency: 'normal' | 'urgent';
  timestamp: number;
  source: string;
  traceId: string;
  /** Set to `true` when this event is a re-emit (e.g. enriched data forwarded to web-ui).
   *  Global subscribers automatically skip re-emitted events to prevent double-processing.
   *  Typed as `true` (not `boolean`) — `false` is meaningless; absence means "not a re-emit". */
  reemit?: true;
}

export interface EmitOptions {
  urgency?: 'normal' | 'urgent';
  source?: string;
  /** Mark this emit as a re-emit. Global subscribers will automatically skip it.
   *  Only set this when forwarding an already-processed event (e.g. enrichment pass).
   *  Typed as `true` — `false` is a no-op and should never be passed. */
  reemit?: true;
}

export type SubscriberHandler = (event: BusEvent) => void | Promise<void>;
export type SubscriberFilter = (event: BusEvent) => boolean;

interface Subscriber {
  name: string;
  handler: SubscriberHandler;
  filter?: SubscriberFilter;
  /** When true, this subscriber receives ALL events regardless of destinations. */
  global?: boolean;
  /**
   * Optional event-name prefixes this (global) subscriber actually cares about.
   * When set, the bus skips this subscriber BEFORE invoking its handler for any
   * event whose name doesn't start with one of these prefixes. This keeps a
   * global subscriber from being woken on every high-frequency streaming event
   * (session:text-delta / tool-use / …) it would only early-return on anyway.
   * Only meaningful together with `global: true`. Match is `name.startsWith(prefix)`,
   * so a full event name acts as an exact match and `'task:'` matches all task events.
   */
  interest?: string[];
}

/** Options object form for {@link EventBus.subscribe}. */
export interface SubscribeOptions {
  filter?: SubscriberFilter;
  global?: boolean;
  interest?: string[];
}

// ── Event history ring buffer (for live debugging) ──

const EVENT_HISTORY_SIZE = 200;
const eventHistory: BusEvent[] = [];

/**
 * Return a read-only snapshot of the most recent events (up to 200).
 * Useful for live debugging and diagnostics.
 */
export function getEventHistory(): readonly BusEvent[] {
  return eventHistory;
}

// ── Key events that get info-level logging for end-to-end traceability ──

const KEY_BUS_EVENTS = new Set([
  'session:start', 'session:send', 'session:started', 'session:ended',
  'session:deleted', 'session:content-updated', 'session:result', 'session:error',
  'session:status-changed',
  'subagent:start', 'subagent:result', 'subagent:error',
  'task:created', 'task:updated', 'task:completed', 'task:deleted', 'task:unblocked',
  'task:phase-changed', 'session:cron-fired',
  // Rare by construction (once per session per idle episode) and the last thing
  // logged before a reap — worth an info line for post-mortems.
  'session:will-reap',
]);

// ── Subscriber-failure recovery ────────────────────────────────────────────────
//
// A throwing subscriber logs at error level, which lands a card in the
// notification center — and that card described a CONDITION ("main-ai chokes on
// session:result") that goes away the moment the same pair dispatches cleanly.
// Without a lifecycle it stayed red forever; the live feed had a bus
// `subscriber "main-ai" threw` card long after the bug behind it was gone.
//
// The bus is core and must never import server code, so the signal is injected.

type BusRecoveryPublisher = (keys: string[]) => void;
let publishBusRecovery: BusRecoveryPublisher | null = null;

/**
 * (subscriber, event) pairs that have thrown. ONLY failed pairs are inserted —
 * emit() is the hottest path in the app (tens of thousands of streaming deltas
 * per session), so the healthy branch must be a single Map.size check plus, in
 * the rare non-empty case, one Map.has. Recording every healthy dispatch would
 * mean a Map entry per (subscriber × event name) the box has ever seen.
 */
const failedBusPairs = new Set<string>();

/** `bus:<subscriber>:<eventName>` — the condition id for one failing pair. */
export function busRecoveryKey(subscriber: string, eventName: string): string {
  return `bus:${subscriber}:${eventName}`;
}

/** Wire the recovery signal (server.ts, at startup). Null clears it + the memory. */
export function setBusRecoveryPublisher(publish: BusRecoveryPublisher | null): void {
  publishBusRecovery = publish;
  failedBusPairs.clear();
}

/** Tests: clear the failed-pair memory without a server. */
export function _resetBusRecoveryForTest(): void {
  failedBusPairs.clear();
}

/** Tests: which pairs the bus currently considers failing. */
export function _failedBusPairsForTest(): string[] {
  return [...failedBusPairs];
}

function noteBusSubscriberFailure(subscriber: string, eventName: string): void {
  failedBusPairs.add(busRecoveryKey(subscriber, eventName));
}

/**
 * A dispatch of `(subscriber, eventName)` completed without throwing. Retires the
 * pair's error card if it had one, on the failing→healthy EDGE (the pair leaves
 * the set, so a steady stream of healthy dispatches signals exactly once).
 *
 * Zero cost when nothing has ever failed: `.size === 0` short-circuits before any
 * string is built.
 */
function noteBusSubscriberSuccess(subscriber: string, eventName: string): void {
  if (failedBusPairs.size === 0) return;
  const key = busRecoveryKey(subscriber, eventName);
  if (!failedBusPairs.delete(key)) return;
  // Never let the recovery signal become the reason a dispatch "failed": this is
  // called from inside emit()'s try and from a promise continuation, where a
  // throw would either be attributed to the subscriber or surface as an
  // unhandled rejection.
  try {
    publishBusRecovery?.([key]);
  } catch { /* notification bookkeeping must not break the bus */ }
}

// ── EventBus ──

export class EventBus {
  private subscribers = new Map<string, Subscriber>();

  /**
   * Register a named subscriber.
   * Events are delivered only when the subscriber's name is in the event's destinations
   * (or destinations includes "*"), unless `global: true` is set — then the subscriber
   * receives ALL events regardless of destinations.
   */
  subscribe(name: string, handler: SubscriberHandler, filter?: SubscriberFilter | SubscribeOptions): void {
    if (filter && typeof filter === 'object' && ('global' in filter || 'interest' in filter || 'filter' in filter)) {
      this.subscribers.set(name, { name, handler, filter: filter.filter, global: filter.global, interest: filter.interest });
    } else {
      this.subscribers.set(name, { name, handler, filter: filter as SubscriberFilter | undefined });
    }
  }

  /**
   * Remove a subscriber by name.
   */
  unsubscribe(name: string): void {
    this.subscribers.delete(name);
  }

  /**
   * Emit a typed event to matching subscribers.
   * Overload 1: known event name from EventPayloadMap → data type is enforced.
   * Overload 2: arbitrary string → data is unknown (backward compat for dynamic forwarding).
   */
  emit<E extends keyof EventPayloadMap>(name: E, data: EventPayloadMap[E], destinations: string[], options?: EmitOptions): void;
  emit(name: string, data: unknown, destinations: string[], options?: EmitOptions): void;
  emit(name: string, data: unknown, destinations: string[], options?: EmitOptions): void {
    const event: BusEvent = {
      name,
      data,
      destinations,
      urgency: options?.urgency ?? 'normal',
      timestamp: Date.now(),
      source: options?.source ?? 'unknown',
      traceId: randomBytes(4).toString('hex'),
      ...(options?.reemit ? { reemit: true } : {}),
    };

    // Ring buffer for live debugging
    eventHistory.push(event);
    if (eventHistory.length > EVENT_HISTORY_SIZE) {
      eventHistory.shift();
    }

    // debug (not trace) — emit() is on the hot path; trace would log on every single event
    log.bus.debug(`emit ${name}`, { traceId: event.traceId, destinations, source: options?.source });

    // Upgrade key events to info for end-to-end traceability
    if (KEY_BUS_EVENTS.has(name)) {
      log.bus.info(`emit ${name}`, { traceId: event.traceId, destinations, source: options?.source });
    }

    for (const [, subscriber] of this.subscribers) {
      // Global subscribers skip re-emitted events (they already saw the original)
      if (subscriber.global && event.reemit) continue;
      // Global subscribers receive all events regardless of destinations
      // Normal subscribers must be in the event's destinations (or destinations includes "*")
      if (!subscriber.global && !destinations.includes('*') && !destinations.includes(subscriber.name)) {
        continue;
      }

      // Interest filter (global subscribers only): skip BEFORE invoking the handler
      // when the event name doesn't match any declared prefix. This is the hot-path
      // optimization — a high-frequency streaming event (session:text-delta, …) no
      // longer wakes every global subscriber that would just early-return on it.
      // Guard on `global`: a non-global subscriber is already gated by destinations
      // above, and interest is only ever set via the options-object path, but the
      // explicit check keeps the intent clear and prevents future misuse.
      if (subscriber.global && subscriber.interest && !subscriber.interest.some(p => name.startsWith(p))) {
        continue;
      }

      // Apply subscriber filter if present
      if (subscriber.filter && !subscriber.filter(event)) {
        continue;
      }

      try {
        log.bus.debug('event delivered', { name, subscriber: subscriber.name, traceId: event.traceId });
        const result = subscriber.handler(event);
        // If handler returns a promise, catch async errors too
        if (result && typeof result.then === 'function') {
          result.then(
            () => { noteBusSubscriberSuccess(subscriber.name, name); },
            (err: unknown) => {
              noteBusSubscriberFailure(subscriber.name, name);
              log.bus.error(`subscriber "${subscriber.name}" threw on event "${name}" (async)`, {
                eventName: name,
                traceId: event.traceId,
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
                // The condition, so the next clean dispatch of this exact pair
                // retires the card instead of it staying red forever.
                recoveryKey: busRecoveryKey(subscriber.name, name),
              });
            },
          );
        } else {
          // Sync handler that returned: the dispatch is already complete here.
          // (An async one is NOT — its success is the .then above; calling this
          // now would retire the card while the promise is still in flight.)
          noteBusSubscriberSuccess(subscriber.name, name);
        }
      } catch (err) {
        noteBusSubscriberFailure(subscriber.name, name);
        log.bus.error(`subscriber "${subscriber.name}" threw on event "${name}"`, {
          eventName: name,
          traceId: event.traceId,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          recoveryKey: busRecoveryKey(subscriber.name, name),
        });
      }
    }
  }

  /**
   * Check if a subscriber is registered.
   */
  has(name: string): boolean {
    return this.subscribers.has(name);
  }

  /**
   * Remove all subscribers.
   */
  clear(): void {
    this.subscribers.clear();
  }
}

// ── CoalescingQueue ──

export interface CoalescingQueueOptions {
  urgentDebounceMs?: number;
  normalFlushMs?: number;
  maxItems?: number;
  onFlush: (events: BusEvent[]) => void;
}

/**
 * Buffers events and flushes them as batches.
 * Urgent events flush after a short debounce (250ms).
 * Normal events flush after a longer timer (60s) or piggyback on urgent flushes.
 */
export class CoalescingQueue {
  private urgentBuffer: BusEvent[] = [];
  private normalBuffer: BusEvent[] = [];
  private urgentTimer: ReturnType<typeof setTimeout> | null = null;
  private normalTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private readonly urgentDebounceMs: number;
  private readonly normalFlushMs: number;
  private readonly maxItems: number;
  private readonly onFlush: (events: BusEvent[]) => void;

  constructor(options: CoalescingQueueOptions) {
    this.urgentDebounceMs = options.urgentDebounceMs ?? 250;
    this.normalFlushMs = options.normalFlushMs ?? 60_000;
    this.maxItems = options.maxItems ?? 20;
    this.onFlush = options.onFlush;
  }

  /**
   * Add an event to the appropriate buffer.
   */
  enqueue(event: BusEvent): void {
    if (this.destroyed) return;

    if (event.urgency === 'urgent') {
      this.urgentBuffer.push(event);
      this.evictIfNeeded(this.urgentBuffer);
      this.scheduleUrgentFlush();
    } else {
      this.normalBuffer.push(event);
      this.evictIfNeeded(this.normalBuffer);
      this.scheduleNormalFlush();
    }
  }

  /**
   * Manually flush all buffered events. Returns the flushed events.
   */
  flush(): BusEvent[] {
    this.clearTimers();

    const events = [...this.urgentBuffer, ...this.normalBuffer];
    this.urgentBuffer = [];
    this.normalBuffer = [];

    if (events.length > 0) {
      this.onFlush(events);
    }

    return events;
  }

  /**
   * Clean up timers. Call when shutting down.
   */
  destroy(): void {
    this.destroyed = true;
    this.clearTimers();
    this.urgentBuffer = [];
    this.normalBuffer = [];
  }

  /**
   * Number of buffered events.
   */
  get size(): number {
    return this.urgentBuffer.length + this.normalBuffer.length;
  }

  // ── Private ──

  private scheduleUrgentFlush(): void {
    // Debounce: reset timer on each new urgent event
    if (this.urgentTimer !== null) {
      clearTimeout(this.urgentTimer);
    }
    this.urgentTimer = setTimeout(() => {
      this.urgentTimer = null;
      this.flush();
    }, this.urgentDebounceMs);
  }

  private scheduleNormalFlush(): void {
    // Only schedule if no timer is already running
    if (this.normalTimer !== null) return;
    this.normalTimer = setTimeout(() => {
      this.normalTimer = null;
      this.flush();
    }, this.normalFlushMs);
  }

  private evictIfNeeded(buffer: BusEvent[]): void {
    const dropped = Math.max(0, buffer.length - this.maxItems);
    if (dropped > 0) {
      const evictedNames = buffer.slice(0, dropped).map(e => e.name);
      log.bus.warn(`coalescing queue evicted ${dropped} events (max: ${this.maxItems})`, { evictedNames });
    }
    while (buffer.length > this.maxItems) {
      buffer.shift(); // FIFO eviction
    }
  }

  private clearTimers(): void {
    if (this.urgentTimer !== null) {
      clearTimeout(this.urgentTimer);
      this.urgentTimer = null;
    }
    if (this.normalTimer !== null) {
      clearTimeout(this.normalTimer);
      this.normalTimer = null;
    }
  }
}

// ── Singleton ──

export const bus = new EventBus();
