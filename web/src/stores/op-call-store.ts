/**
 * Walnut's own record of a session's Walnut calls, by the Bash row that made them
 * (server: core/sessions/op-call-log.ts). An outbound card whose words the
 * transcript does not hold (`@file`, stdin, a payload built in a subshell) reads
 * them here, so a deleted temp file never leaves it blank.
 *
 * One request per session per tick for every card that asks, batched; a row that
 * has a record keeps it for the page, a row with none is asked again once its call
 * returns (the CLI records before it exits, so a card drawn mid-call finds it then).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { apiPost } from '@/api/client';
import { log } from '@/utils/log';
import type { OpCardFields } from '../../../src/core/op-cards';

export interface OpCallRecord {
  id: string;
  at: string;
  toolUseId?: string;
  op: string;
  form: string;
  path?: string;
  ok: boolean;
  error?: string;
  fields: OpCardFields;
}

const records = new Map<string, OpCallRecord[]>();
/** Rows asked and answered with nothing, keyed with the generation they were asked in. */
const asked = new Map<string, string>();
const queued = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let version = 0;

const key = (sid: string, tool: string): string => `${sid}\u0000${tool}`;

function emit(): void {
  version++;
  for (const l of listeners) l();
}

function flush(): void {
  flushTimer = null;
  const batch = [...queued];
  queued.clear();
  for (const [sid, tools] of batch) {
    const list = [...tools].slice(0, 400);
    void apiPost<{ calls?: Record<string, OpCallRecord[]> }>(
      `/api/v1/sessions/${encodeURIComponent(sid)}/op-calls/lookup`, { tools: list }, { timeoutMs: 10_000, background: true, quietStatuses: [404] },
    ).then((res) => {
      let changed = false;
      for (const [tool, calls] of Object.entries(res?.calls ?? {})) {
        if (Array.isArray(calls) && calls.length > 0) { records.set(key(sid, tool), calls); changed = true; }
      }
      if (changed) emit();
    }).catch((err) => {
      for (const t of list) asked.delete(key(sid, t));
      log.warn('session', 'op call lookup failed', { sessionId: sid, error: String(err) });
    });
  }
}

/** Ask for one row's record (no-op when it is known, or already asked in this `generation`). */
export function requestOpCalls(sessionId: string, toolUseId: string, generation: string): void {
  const k = key(sessionId, toolUseId);
  if (records.has(k) || asked.get(k) === generation) return;
  asked.set(k, generation);
  let set = queued.get(sessionId);
  if (!set) queued.set(sessionId, (set = new Set()));
  set.add(toolUseId);
  if (!flushTimer) flushTimer = setTimeout(flush, 0);
}

export function getOpCalls(sessionId: string, toolUseId: string): OpCallRecord[] | undefined {
  return records.get(key(sessionId, toolUseId));
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/**
 * The recorded calls of one Bash row. `generation` names what the card knows of
 * the call (running, returned): a new one asks again when nothing was found.
 */
export function useOpCallRecords(sessionId: string | undefined, toolUseId: string | undefined, enabled: boolean, generation: string): OpCallRecord[] | undefined {
  useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => {
    if (enabled && sessionId && toolUseId) requestOpCalls(sessionId, toolUseId, generation);
  }, [enabled, sessionId, toolUseId, generation]);
  return sessionId && toolUseId ? getOpCalls(sessionId, toolUseId) : undefined;
}

/** Test seam. */
export function _resetOpCallStore(): void {
  records.clear();
  asked.clear();
  queued.clear();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}

/** Test seam: put a row's records in place. */
export function _setOpCalls(sessionId: string, toolUseId: string, calls: OpCallRecord[]): void {
  records.set(key(sessionId, toolUseId), calls);
  emit();
}
