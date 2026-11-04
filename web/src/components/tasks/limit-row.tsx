/**
 * The tag and the pill of a task row a usage limit holds (its words: limit-row-words.ts), shared by
 * every Home view: the Flat view's status rows (StatusSections.tsx) and the By project / In one list
 * rows (TodoPanel.tsx), so a limited task reads the same wherever it is drawn (2026-11-07: By project
 * became the default view and drew a limited task like any other).
 */
import { useEffect, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { limitRowLine, type LimitTone } from './limit-row-words';
import { useEvent } from '@/hooks/useWebSocket';
import '@/styles/status-sections.css';

type Limit = NonNullable<NonNullable<Task['user_status']>['limit']>;

/** Now, for a row a usage limit holds, renewed at its next boundary (the reset, Walnut's continue):
 *  the row turns from Limited to Continuing with the session's banner, not at the next status
 *  sync (the server's line is a minute behind at the reset). */
export function useLimitNow(limit: Limit | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  // Also at midnight, when "Thu 4:56 AM" becomes "4:56 AM".
  const midnight = limit ? new Date(now).setHours(24, 0, 0, 0) : NaN;
  const next = [limit?.resetsAt, limit?.dueAt].map((iso) => (iso ? Date.parse(iso) : NaN)).concat(midnight)
    .filter((t) => Number.isFinite(t) && t > now).sort((x, y) => x - y)[0];
  useEffect(() => {
    if (next === undefined) return;
    const id = window.setTimeout(() => setNow(Date.now()), Math.min(next - Date.now() + 250, 2_147_000_000));
    return () => window.clearTimeout(id);
  }, [next]);
  return now;
}

/** The tag of a limit row, coloured as its session banner's. */
export function LimitTag({ tag, tone }: { tag: string; tone?: LimitTone }) {
  return <span className={`status-card-limit-tag${tone ? ` is-${tone}` : ''}`}>{tag}</span>;
}

/** One task's usage-limit wait as last announced (`gone` once it closed), ahead of its stored
 *  status. Subscribes only while the task has a limit. */
export function useLimitLive(taskId: string, limit: Limit | undefined): string | undefined {
  const [live, setLive] = useState<string | undefined>(undefined);
  useEvent('session:usage-limit', (data) => {
    if (!limit) return;
    const d = data as { taskId?: string; usageLimit?: { state?: string } | null } | null;
    if (d?.taskId !== taskId || !('usageLimit' in d)) return;
    setLive(d.usageLimit?.state ?? 'gone');
  });
  // A stored limit that is gone or new (a new stop) reads from the stored words again.
  const key = limit ? `${limit.resetsAt ?? ''}|${limit.auto}` : '';
  useEffect(() => { setLive(undefined); }, [key]);
  return limit ? live : undefined;
}

/** The pill a By project / In one list row wears while a usage limit holds its task: the Flat
 *  view's tag and words, after the title like the row's other pills. */
export function TaskLimitPill({ task }: { task: Task }) {
  const limit = task.phase === 'COMPLETE' ? undefined : task.user_status?.limit;
  const now = useLimitNow(limit);
  const live = useLimitLive(task.id, limit);
  if (!limit) return null;
  const line = limitRowLine(task, task.user_status?.ask ?? '', now, live);
  if (!line) return null;
  const words = `${line.tag ? `${line.tag} ` : ''}${line.text}`;
  return (
    <span className="todo-item-limit-pill" data-testid="task-row-limit" title={`Usage limit: ${words}`}>
      {line.tag ? <LimitTag tag={line.tag} tone={line.tone} /> : null}
      <span className="todo-item-limit-pill-words">{line.text}</span>
    </span>
  );
}
