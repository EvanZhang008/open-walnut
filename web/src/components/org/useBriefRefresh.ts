/**
 * While the user looks at Main or a lead on the Org page and its Brief is stale, ask the server
 * for the node's one refresh turn (src/core/sessions/brief-refresh.ts, which keeps the 15 minute
 * gap and every other rule). Asked after the node has been shown LOOK_MS with the page visible, so
 * flicking through nodes asks nothing, and again when another line moves while it stays open.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { briefFreshness, type BriefFreshness } from '@open-walnut/brief-fresh';
import { apiPost } from '@/api/client';
import { log } from '@/utils/log';

export const LOOK_MS = 3_000;

function useVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

export function useBriefRefresh(contact: Task | undefined, tasks: readonly Task[]): BriefFreshness | null {
  const fresh = useMemo(() => (contact ? briefFreshness(contact, tasks) : null), [contact, tasks]);
  const visible = useVisible();
  // What moved, as one key: a new move while the node stays open is a new look.
  const key = contact && fresh?.stale
    ? `${contact.id}|${fresh.moved.map((m) => `${m.id}:${m.state}`).join(',')}|${fresh.newAsks.join(',')}` : '';
  const id = contact?.id;
  useEffect(() => {
    if (!key || !visible || !id) return;
    const timer = setTimeout(() => {
      apiPost<{ sent: boolean; why?: string }>(`/api/v1/org/nodes/${encodeURIComponent(id)}/brief-refresh`, { by: 'web' }, { background: true, quietStatuses: [404, 501] })
        .then((r) => log.info('org-brief', 'refresh asked', { taskId: id, sent: r.sent, why: r.why }))
        .catch((err) => log.warn('org-brief', 'refresh ask failed', { taskId: id, error: err instanceof Error ? err.message : String(err) }));
    }, LOOK_MS);
    return () => clearTimeout(timer);
  }, [key, visible, id]);
  return fresh;
}
