/**
 * "Transfer harness/host…" in a session composer's "+" menu, beside "Engine settings": the
 * same dialog as the task kebab's row (TransferMenuItem), for the task this
 * session belongs to. A window without the dialog host (a pop-out) has no row.
 */
import type { PlusMenuAction } from '@/components/chat/plus-menu-actions';
import { canOpenTransfer, openTransferDialog, TRANSFER_LABEL } from './transfer-events';

export const TRANSFER_PLUS_ACTION_ID = 'transfer';

export const TRANSFER_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8h13l-3-3M20 16H7l3 3" />
  </svg>
);

export function transferPlusAction(taskId: string | undefined): PlusMenuAction | null {
  if (!taskId || !canOpenTransfer()) return null;
  return {
    id: TRANSFER_PLUS_ACTION_ID,
    label: TRANSFER_LABEL,
    title: "Move this task's work to another harness (engine) or host",
    icon: TRANSFER_ICON,
    onSelect: () => openTransferDialog(taskId),
  };
}
