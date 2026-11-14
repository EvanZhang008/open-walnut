/**
 * A task's tabs in the person's browser, for its Browser view (SessionBrowserCard.tsx): read once
 * when the panel mounts, again on every `browser:tabs` for the task and after a reconnect, and
 * slowly while it has tabs (a missed event costs at most that). The live pictures are the
 * card's: asked for only while the card is on screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '@/api/client';
import { wsClient } from '@/api/ws';
import { log } from '@/utils/log';
import type { BrowserViewState } from './browser-view-model';

/** While the task has tabs: a re-read now and then, in case an event went missing. */
const REREAD_MS = 20_000;

export function useBrowserView(taskId: string | undefined): { state: BrowserViewState | null; reread: () => void } {
  const [state, setState] = useState<BrowserViewState | null>(null);
  const gen = useRef(0);
  const read = useCallback(() => {
    if (!taskId) return;
    const mine = ++gen.current;
    apiGet<BrowserViewState>('/api/v1/browser/view', { task: taskId }, { priority: 'low', quietStatuses: [400, 404] })
      .then((v) => { if (gen.current === mine) setState({ tabs: v.tabs ?? [], ...(v.ended ? { ended: v.ended } : {}) }); })
      .catch((err: unknown) => {
        log.warn('session-panel', 'browser view read failed', { taskId, error: err instanceof Error ? err.message : String(err) });
      });
  }, [taskId]);

  useEffect(() => {
    setState(null);
    if (!taskId) return undefined;
    read();
    const onTabs = (data: unknown) => { if ((data as { taskId?: string } | null)?.taskId === taskId) read(); };
    const onBack = () => read();
    wsClient.onEvent('browser:tabs', onTabs);
    wsClient.onEvent('_ws:reconnected', onBack);
    return () => {
      wsClient.offEvent('browser:tabs', onTabs);
      wsClient.offEvent('_ws:reconnected', onBack);
    };
  }, [taskId, read]);

  const hasTabs = (state?.tabs.length ?? 0) > 0;
  useEffect(() => {
    if (!hasTabs) return undefined;
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') read(); }, REREAD_MS);
    return () => window.clearInterval(t);
  }, [hasTabs, read]);

  return { state, reread: read };
}
