/**
 * Toasts a completed task's workspace cleanup as it goes, and the end of a setup
 * this page ran again (cleanup-notices.ts),
 * read from the task rows the page already has: one toast per change this page
 * saw happen, never for the state a row had when it first arrived.
 */
import { useEffect, useRef } from 'react';
import type { Task } from '@open-walnut/core';
import { useNotifications } from '@/contexts/notifications';
import { cleanupNotice, completionNotice, noteSetupStartedToast, setupNotice, takeSetupStartedToast } from './cleanup-notices';
import { workspaceOf, type TaskWorkspace } from './workspace-text';

/** Toasts each cleanup change of the given tasks as the page sees it. */
export function useCleanupNotices(tasks: readonly Task[]): void {
  const { notify, dismissToast } = useNotifications();
  const seen = useRef(new Map<string, { ws: TaskWorkspace | undefined; phase: string | undefined }>());
  // The "Running cleanup" toast of each task, taken down when its outcome shows.
  const running = useRef(new Map<string, string>());
  useEffect(() => {
    const was = seen.current;
    for (const t of tasks) {
      const ws = workspaceOf(t);
      const phase = (t as { phase?: string }).phase;
      const prev = was.get(t.id);
      if (!prev) { was.set(t.id, { ws, phase }); continue; }
      if (prev.ws === ws && prev.phase === phase) continue;
      was.set(t.id, { ws, phase });
      // Reopened before its cleanup began: the notice that it comes is taken down.
      if (prev.phase === 'COMPLETE' && phase !== 'COMPLETE') {
        const up = running.current.get(t.id);
        if (up) { dismissToast(up); running.current.delete(t.id); }
      }
      const n = completionNotice(t.id, t.title, prev.phase, phase, ws)
        ?? cleanupNotice(t.id, t.title, prev.ws, ws)
        ?? setupNotice(t.id, t.title, prev.ws, ws);
      if (!n) continue;
      const shown = running.current.get(t.id);
      if (shown && !n.key.startsWith('setup-')) { dismissToast(shown); running.current.delete(t.id); }
      if (n.key.startsWith('setup-ended:')) { const started = takeSetupStartedToast(t.id); if (started) dismissToast(started); }
      const id = `${n.key}:${Date.now()}`;
      if (n.key.startsWith('setup-started:')) noteSetupStartedToast(t.id, id);
      if (n.key.startsWith('cleanup-running:')) running.current.set(t.id, id);
      // A key per toast: the one just dismissed frees its key only once its state update runs.
      // How a setup or a cleanup ended stays in the bell's list too (this page only): a toast
      // shown while the person looked elsewhere is gone in seconds.
      const ended = n.key.startsWith('setup-ended:') || n.key.startsWith('cleanup-removed:') || n.key.startsWith('cleanup-kept:');
      notify({ id, kind: 'hint', severity: n.severity, title: n.title, body: n.body, persistent: ended, dedupKey: id });
    }
  }, [tasks, notify, dismissToast]);
}
