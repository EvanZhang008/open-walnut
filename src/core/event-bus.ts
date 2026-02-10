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
  TASK_STARRED: 'task:starred',
  TASK_DELETED: 'task:deleted',
  TASK_REORDERED: 'task:reordered',
  TASK_UNBLOCKED: 'task:unblocked',

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
  SESSION_STARTED: 'session:started',
  SESSION_ENDED: 'session:ended',
  SESSION_RESULT: 'session:result',
  SESSION_ERROR: 'session:error',

  // Session streaming events (from --output-format stream-json)
  SESSION_TEXT_DELTA: 'session:text-delta',
  SESSION_TOOL_USE: 'session:tool-use',
  SESSION_TOOL_RESULT: 'session:tool-result',
  SESSION_STATUS_CHANGED: 'session:status-changed',
  SESSION_MESSAGES_DELIVERED: 'session:messages-delivered',
  SESSION_BATCH_COMPLETED: 'session:batch-completed',
  SESSION_MESSAGE_QUEUED: 'session:message-queued',
  SESSION_SYSTEM_EVENT: 'session:system-event',

  // Chat history events
  CHAT_HISTORY_UPDATED: 'chat:history-updated',
  CHAT_COMPACTING: 'chat:compacting',
  CHAT_COMPACTED: 'chat:compacted',

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

  // Category events
  CATEGORY_CREATED: 'category:created',
  CATEGORY_UPDATED: 'category:updated',

  // Config events
  CONFIG_CHANGED: 'config:changed',
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
  'session:result', 'session:error', 'session:status-changed',
  'subagent:start', 'subagent:result', 'subagent:error',
  'task:created', 'task:updated', 'task:completed', 'task:deleted', 'task:unblocked',
]);

// ── EventBus ──

export class EventBus {
  private subscribers = new Map<string, Subscriber>();

  /**
   * Register a named subscriber.
   * Events are delivered only when the subscriber's name is in the event's destinations
   * (or destinations includes "*"), unless `global: true` is set — then the subscriber
   * receives ALL events regardless of destinations.
   */
  subscribe(name: string, handler: SubscriberHandler, filter?: SubscriberFilter | { filter?: SubscriberFilter; global?: boolean }): void {
    if (filter && typeof filter === 'object' && 'global' in filter) {
      this.subscribers.set(name, { name, handler, filter: filter.filter, global: filter.global });
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

      // Apply subscriber filter if present
      if (subscriber.filter && !subscriber.filter(event)) {
        continue;
      }

      try {
        log.bus.debug('event delivered', { name, subscriber: subscriber.name, traceId: event.traceId });
        const result = subscriber.handler(event);
        // If handler returns a promise, catch async errors too
        if (result && typeof result.then === 'function') {
          result.catch((err: unknown) => {
            log.bus.error(`subscriber "${subscriber.name}" threw on event "${name}" (async)`, {
              eventName: name,
              traceId: event.traceId,
              error: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            });
          });
        }
      } catch (err) {
        log.bus.error(`subscriber "${subscriber.name}" threw on event "${name}"`, {
          eventName: name,
          traceId: event.traceId,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
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
