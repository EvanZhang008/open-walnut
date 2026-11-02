/**
 * Gives the content actions (utils/content-actions.ts) the app shell's toast and router, so a
 * plugin's App, the Mail page and an Inbox letter all show the same outcome the same way.
 * Renders nothing.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '@/contexts/notifications';
import { setContentActionsRuntime } from '@/utils/content-actions';

export function ContentActionsHost() {
  const { notify } = useNotifications();
  const navigate = useNavigate();
  useEffect(() => setContentActionsRuntime({
    navigate: (to) => navigate(to),
    toast: (t) => notify({
      kind: 'hint', severity: t.severity, title: t.title, ...(t.body ? { body: t.body } : {}),
      dedupKey: t.dedupKey, persistent: false,
      ...(t.action ? { action: { label: t.action.label, kind: 'callback' as const }, onAction: t.action.run } : {}),
    }),
  }), [notify, navigate]);
  return null;
}
