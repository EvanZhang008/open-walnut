/**
 * Toasts what went wrong in a completed task's workspace cleanup, and the end of a
 * setup this page ran again (cleanup-notices.ts),
 * read from the task rows the page already has: one toast per change this page
 * saw happen, never for the state a row had when it first arrived.
 */
import { useEffect, useRef } from 'react';
import type { Task } from '@open-walnut/core';
import { useNotifications } from '@/contexts/notifications';
import { cleanupNotice, noteSetupStartedToast, setupNotice, takeSetupStartedToast } from './cleanup-notices';
import { workspaceOf, type TaskWorkspace } from './workspace-text';

/** Toasts each cleanup change of the given tasks as the page sees it. */
export function useCleanupNotices(tasks: readonly Task[]): void {
  const { notify, dismissToast } = useNotifications();
  const seen = useRef(new Map<string, TaskWorkspace | undefined>());
  useEffect(() => {
    const was = seen.current;
    for (const t of tasks) {
      const ws = workspaceOf(t);
      if (!was.has(t.id)) { was.set(t.id, ws); continue; }
      const prev = was.get(t.id);
      if (prev === ws) continue;
      was.set(t.id, ws);
      const n = cleanupNotice(t.id, t.title, prev, ws) ?? setupNotice(t.id, t.title, prev, ws);
      if (!n) continue;
      if (n.key.startsWith('setup-ended:')) { const started = takeSetupStartedToast(t.id); if (started) dismissToast(started); }
      const id = `${n.key}:${Date.now()}`;
      if (n.key.startsWith('setup-started:')) noteSetupStartedToast(t.id, id);
      // A key per toast: the one just dismissed frees its key only once its state update runs.
      // How a setup or a cleanup ended stays in the bell's list too (this page only): a toast
      // shown while the person looked elsewhere is gone in seconds.
      const ended = n.key.startsWith('setup-ended:') || n.key.startsWith('cleanup-removed:') || n.key.startsWith('cleanup-kept:');
      notify({ id, kind: 'hint', severity: n.severity, toastReason: 'out-of-sight', title: n.title, body: n.body, persistent: ended, dedupKey: id });
    }
  }, [tasks, notify, dismissToast]);
}
