/**
 * Open one thread where it is kept, scrolled to and marked (thread-focus.ts): Main's and a lead's on
 * their node of the Org page, any other task's in its Threads view beside its chat. One way for every
 * link to a thread: a chat message's thread line (sessions/reply-thread-line.tsx).
 */
import { useNavigate } from 'react-router-dom';
import { keepsThreads } from '@open-walnut/keeps-threads';
import { useTaskStoreActions } from '@/contexts/TasksContext';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useOpenTask } from '@/hooks/useOpenTask';
import { orgNodePath } from '@/apps/mail/mail-route-model';
import { askThreadsView } from '@/components/sessions/session-threads-model';
import { askThreadFocus } from './thread-focus';

export function useOpenThread(): (node: string, thread: string) => void {
  const store = useTaskStoreActions();
  const navigate = useNavigate();
  const openTask = useOpenTask();
  return useLeanCallback((node: string, thread: string) => {
    askThreadFocus(node, thread);
    const task = store?.get(node) ?? null;
    if (task?.org_role && keepsThreads(task)) { navigate(orgNodePath(task)); return; }
    askThreadsView(node);
    openTask(node);
  }, [store, navigate, openTask]);
}
