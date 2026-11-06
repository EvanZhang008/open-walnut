/**
 * The fallback engine (server: src/core/agents/fallback-engine.ts, routes/engines.ts): whether a
 * new task would start on it now, and taking a task's "started on the fallback" note off.
 */
import type { EngineFallbackNote, FallbackEngineSetting, SessionEngine } from '@open-walnut/core';
import { apiGet, apiPost } from './client';

export interface EngineFallbackNow {
  host: string;
  defaultEngine?: SessionEngine;
  setting?: FallbackEngineSetting | null;
  /** A new task that names no engine starts here now; null = on the default engine. */
  fallback: { engine: SessionEngine; model?: string; note: EngineFallbackNote } | null;
  /** The default engine's limit in force when no fallback takes it (none set, or it cannot run). */
  limit?: { window?: string; resetsAt?: string; resetsFrom?: 'event' | 'text' | 'host' };
  /** Why the fallback that is set does not take new tasks now. */
  skip?: 'needs_model' | 'not_runnable' | 'limited_too' | 'shares_limit';
}

/** The last answer per host: a launch that names no engine reads it before minting a session id. */
const lastNow = new Map<string, { at: number; now: EngineFallbackNow }>();
const FRESH_MS = 90_000;

/** `withLimit`: also the default engine's limit when no fallback takes it (Settings' line). */
export async function fetchEngineFallbackNow(host?: string | null, opts: { withLimit?: boolean } = {}): Promise<EngineFallbackNow> {
  const params: Record<string, string> = {};
  if (host) params.host = host;
  if (opts.withLimit) params.limit = '1';
  const now = await apiGet<EngineFallbackNow>('/api/engines/fallback', params, { quietStatuses: [404] });
  lastNow.set(host || '__local__', { at: Date.now(), now });
  return now;
}

/** The engine a launch that names none would start on, by the last answer for its host (a draft
 *  that shows the line read it), or undefined when none is fresh or it starts on the default. */
export function knownFallbackEngine(host?: string | null): string | undefined {
  const hit = lastNow.get(host || '__local__');
  return hit && Date.now() - hit.at < FRESH_MS ? hit.now.fallback?.engine : undefined;
}

export function dismissEngineFallback(taskId: string): Promise<{ ok: boolean; changed: boolean }> {
  return apiPost('/api/engines/fallback/dismiss', { taskId });
}
