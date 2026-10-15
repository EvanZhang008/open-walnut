/**
 * OperationErrorBridge — forwards TasksContext.operationError into the unified
 * notification system, then clears it so the legacy useTasks timer is a no-op
 * (the provider owns the toast lifecycle now).
 *
 * Kept as a separate component (rather than wiring TasksContext → notify
 * directly) so the dependency stays one-way: TasksProvider never imports the
 * NotificationProvider, avoiding a context cycle. Renders nothing.
 */

import { useEffect } from 'react';
import { useTasksContext } from '@/contexts/TasksContext';
import { useNotifications } from '@/contexts/notifications';
import { operationErrorWords } from '@/utils/operation-error-words';

export function OperationErrorBridge() {
  const { operationError, clearOperationError } = useTasksContext();
  const { notify } = useNotifications();

  useEffect(() => {
    if (!operationError) return;
    // A failed connection reads as words, never the browser's "Load failed" (N25).
    const body = operationErrorWords(operationError);
    notify({
      kind: 'operation-error', severity: 'error', title: 'Action failed',
      body, persistent: true,
      // Dedup on the message so a repeated identical error doesn't stack toasts.
      dedupKey: `operr:${body}`,
    });
    clearOperationError();
  }, [operationError, notify, clearOperationError]);

  return null;
}
