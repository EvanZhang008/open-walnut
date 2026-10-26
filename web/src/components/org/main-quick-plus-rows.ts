/**
 * The rows Main's quick actions add to the "+" menu of Main's own composer. Pure (the icon is
 * passed in), so who gets them and what a click sends is unit-tested.
 */
import type { ReactNode } from 'react';
import type { PlusMenuAction } from '@/components/chat/plus-menu-actions';
import { MAIN_QUICK_ACTIONS, MAIN_QUICK_ACTIONS_NOTE, quickActionMessage } from './main-quick-actions';

export const QUICK_ACTIONS_GROUP = 'Quick actions';
export const QUICK_ACTION_HELD_TITLE = 'Main is waiting on your answer. Answer it first: a new message would refuse it.';

export interface MainQuickPlusInput {
  /** The composer's task when it is Main, else null: no rows. */
  mainId: string | null;
  /** A replica cannot reach Main: no rows. */
  replica: boolean;
  /** Main waits on the user's answer: the rows are off, a message would refuse that prompt. */
  waitsOnUser: boolean;
  /** Sending is blocked for another reason (the Mac is away): the rows are off with this title. */
  blocked?: string;
  /** The composer's own send: the message shows and fails the way a typed one does. */
  send: (text: string) => unknown;
  icon?: ReactNode;
  onSent?: (actionId: string) => void;
}

export function mainQuickPlusRows({ mainId, replica, waitsOnUser, blocked, send, icon, onSent }: MainQuickPlusInput): PlusMenuAction[] {
  if (!mainId || replica) return [];
  const off = blocked || (waitsOnUser ? QUICK_ACTION_HELD_TITLE : '');
  return MAIN_QUICK_ACTIONS.map((a): PlusMenuAction => ({
    id: `main-qa-${a.id}`,
    label: a.label,
    title: off || `${a.hint}. ${MAIN_QUICK_ACTIONS_NOTE}`,
    group: QUICK_ACTIONS_GROUP,
    disabled: !!off,
    ...(icon ? { icon } : {}),
    onSelect: () => {
      onSent?.(a.id);
      void send(quickActionMessage(a.id));
    },
  }));
}
