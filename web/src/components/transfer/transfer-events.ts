/**
 * Open the Transfer dialog for a task from anywhere (a kebab row, the session
 * menu). The dialog is mounted once in AppShell (TransferDialogHost), because
 * the menu that asks for it closes, and unmounts, on the same click.
 */
export const TRANSFER_OPEN_EVENT = 'transfer:open';

/** The row's label everywhere it appears (task kebab, session ⋮, composer "+"). */
export const TRANSFER_LABEL = 'Transfer harness/host…';

import { useSyncExternalStore } from 'react';

let hosts = 0;
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** TransferDialogHost registers itself; a window without one (a pop-out) shows no Transfer row. */
export function registerTransferHost(): () => void {
  hosts++;
  changed();
  return () => { hosts = Math.max(0, hosts - 1); changed(); };
}

export function canOpenTransfer(): boolean {
  return hosts > 0;
}

/** canOpenTransfer as a hook: the host registers in an effect that can run after a panel's
 *  first render, so a panel that read it once would keep a missing row. */
export function useCanOpenTransfer(): boolean {
  return useSyncExternalStore(subscribe, canOpenTransfer);
}

export function openTransferDialog(taskId: string): void {
  window.dispatchEvent(new CustomEvent(TRANSFER_OPEN_EVENT, { detail: { taskId } }));
}
