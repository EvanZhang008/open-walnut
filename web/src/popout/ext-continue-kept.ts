/**
 * The Continue rows of the last open, kept in this browser by agent, so the side panel and the
 * popup show them while the board loads again (review R2-6: the extension's drawing showed the
 * rows, then the view replaced them with "Loading your asks…", then with the rows again). The real
 * rows replace them in place once the board answers; the frame's word that it is up no longer
 * waits for the board when it has these to show.
 */
import type { Task } from '@open-walnut/core';
import { askActivityAt } from '@open-walnut/ask-list';
import type { DrawerRow } from '@/components/chat/AskWalnutDrawer';
import { askRowDetail } from './ext-tasks-model';
import { sessionOfTask } from './useExtAsks';

/** One row as the Continue list draws it; `at` is the activity it prints ("3h ago"). */
export interface KeptAsk { id: string; title: string; line: string; needs: boolean; at?: string; sessionId?: string }

const KEY = 'walnut.ext-panel.continue';
/** As many as any surface shows (the popup 5, the panel 4). */
export const KEPT_ASKS_MAX = 6;
/** Older than this, the rows say too little of now: the loading line shows instead. */
export const KEPT_ASKS_MAX_AGE_MS = 7 * 24 * 3600_000;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const store = (): Store | null => { try { return window.localStorage; } catch { return null; } };

export function keptAskOf(row: DrawerRow): KeptAsk {
  const t = row.task as Task | undefined;
  const d = t ? askRowDetail(t) : { line: '', needs: false };
  const at = t ? askActivityAt(t) : undefined;
  const sid = sessionOfTask(t);
  return { id: row.id, title: row.title, line: d.line, needs: d.needs, ...(at ? { at } : {}), ...(sid ? { sessionId: sid } : {}) };
}

export function keepAsks(agentId: string, rows: readonly DrawerRow[], s: Store | null = store(), now = Date.now()): void {
  let all: Record<string, { at: number; rows: KeptAsk[] }> = {};
  try { const v = JSON.parse(s?.getItem(KEY) ?? '{}'); if (v && typeof v === 'object') all = v; } catch { /* unreadable: start over */ }
  all[agentId] = { at: now, rows: rows.slice(0, KEPT_ASKS_MAX).map(keptAskOf) };
  try { s?.setItem(KEY, JSON.stringify(all)); } catch { /* full or blocked: the next open waits for the board */ }
}

export function keptAsks(agentId: string, s: Store | null = store(), now = Date.now()): KeptAsk[] {
  try {
    const v = (JSON.parse(s?.getItem(KEY) ?? '{}') as Record<string, { at?: unknown; rows?: unknown }>)[agentId];
    if (!v || typeof v.at !== 'number' || now - v.at > KEPT_ASKS_MAX_AGE_MS || !Array.isArray(v.rows)) return [];
    return v.rows.filter((r): r is KeptAsk => !!r && typeof r === 'object' && typeof (r as KeptAsk).id === 'string' && typeof (r as KeptAsk).title === 'string')
      .map((r) => ({ id: r.id, title: r.title, line: typeof r.line === 'string' ? r.line : '', needs: r.needs === true, ...(typeof r.at === 'string' ? { at: r.at } : {}), ...(typeof r.sessionId === 'string' ? { sessionId: r.sessionId } : {}) }));
  } catch { return []; }
}
