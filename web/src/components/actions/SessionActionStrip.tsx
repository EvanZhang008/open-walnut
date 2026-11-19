/**
 * The strip under a session's title bar (experiment action_needed_everywhere; 2026-11-19, the user:
 * "我点进去之后，如果它有 needs you，它直接就能显示在……title bar，或者在下面"): its task's Action
 * needed items, the same ones as its row, answered and snoozed in place. This session's own live
 * prompt only points at its card in the chat below (ActionNeeded variant="strip").
 */
import { memo } from 'react';
import type { Task } from '@open-walnut/core';
import { useExperimental } from '@/hooks/useExperimental';
import { ActionNeeded } from './ActionNeeded';

export const SessionActionStrip = memo(function SessionActionStrip({ task, sessionId }: { task: Task | null | undefined; sessionId: string }) {
  const on = useExperimental('action_needed_everywhere');
  if (!on || !task?.user_status?.actions?.length) return null;
  return <ActionNeeded task={task} variant="strip" sessionId={sessionId} />;
});
