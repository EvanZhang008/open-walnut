/**
 * Main's quick actions in the "+" menu of Main's own composer (main-quick-plus-rows.ts), for
 * SessionPanel. Kept apart from main-quick-menus.tsx so the panel does not load ask-main.
 */
import { useMemo } from 'react';
import type { Task } from '@open-walnut/core';
import type { PlusMenuAction } from '@/components/chat/plus-menu-actions';
import { SparklesIcon } from '@/components/icons/SparklesIcon';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { log } from '@/utils/log';
import { mainQuickPlusRows } from './main-quick-plus-rows';

/**
 * The "+" rows of Main's composer (main-quick-plus-rows.ts). `send` is the composer's own send,
 * so the message shows in the chat (and fails) the way a typed one does, and the draft in the
 * box stays. While Main waits on the user's answer the rows are off.
 */
export function useMainQuickPlusActions(
  task: Pick<Task, 'id' | 'org_role'> | null | undefined,
  waitsOnUser: boolean,
  send: (text: string) => unknown,
  blocked?: string,
): PlusMenuAction[] {
  // Main lives with the primary: a replica cannot reach it.
  const replica = useIsCloudReplica();
  const mainId = task?.org_role === 'main' ? task.id : null;
  return useMemo(() => mainQuickPlusRows({
    mainId, replica, waitsOnUser, send, ...(blocked ? { blocked } : {}),
    icon: <SparklesIcon size={16} />,
    onSent: (action) => log.info('org', 'main quick action sent from its composer', { action, taskId: mainId }),
  }), [mainId, replica, waitsOnUser, send, blocked]);
}
