/**
 * Open the Transfer dialog for a task from anywhere (a kebab row, the session
 * menu). The dialog is mounted once in AppShell (TransferDialogHost), because
 * the menu that asks for it closes, and unmounts, on the same click.
 */
export const TRANSFER_OPEN_EVENT = 'transfer:open';

let hosts = 0;

/** TransferDialogHost registers itself; a window without one (a pop-out) shows no Transfer row. */
export function registerTransferHost(): () => void {
  hosts++;
  return () => { hosts = Math.max(0, hosts - 1); };
}

export function canOpenTransfer(): boolean {
  return hosts > 0;
}

export function openTransferDialog(taskId: string): void {
  window.dispatchEvent(new CustomEvent(TRANSFER_OPEN_EVENT, { detail: { taskId } }));
}
