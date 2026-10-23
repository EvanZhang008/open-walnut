/**
 * The two seams between `DaemonConnection` and the trigger layer.
 *
 * Direction matters here. daemon-connection must NOT import cron/routines code:
 * the routines side already reaches INTO the daemon pool (push, `triggers.run`,
 * `triggers.test`), and a static edge the other way closes the cycle. So this
 * module holds nothing but two setters, has zero imports of its own, and server
 * startup fills both in — the same decoupling session-cron-metadata uses in the
 * opposite direction.
 */

import type { TriggerEvent } from '../../providers/trigger-check-core.js';

/**
 * Compile the armed set for one host. null = the engine is not running (do not
 * push). `clock`: whether that daemon said it holds clock routines
 * (clock-routine-v1); the result's `applied` / `rejected` take the daemon's answer.
 */
export type TriggerPayloadProvider = (host: string, opts?: { clock?: 'yes' | 'no' | 'unknown' }) => Promise<{
  payload: { version: 1; triggers: unknown[] };
  hash: string;
  applied?: (reply: Record<string, unknown>) => Promise<void>;
  rejected?: () => Promise<void>;
} | null>;

/** Handle one `trigger.checked` / `trigger.fired` from a host. Must never throw. */
export type TriggerEventSink = (host: string, event: TriggerEvent) => void;

let payloadProvider: TriggerPayloadProvider | null = null;
let eventSink: TriggerEventSink | null = null;

export function setTriggerPayloadProvider(provider: TriggerPayloadProvider | null): void {
  payloadProvider = provider;
}

export function getTriggerPayloadProvider(): TriggerPayloadProvider | null {
  return payloadProvider;
}

export function setTriggerEventSink(sink: TriggerEventSink | null): void {
  eventSink = sink;
}

export function getTriggerEventSink(): TriggerEventSink | null {
  return eventSink;
}
