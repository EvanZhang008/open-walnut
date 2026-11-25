/**
 * One master password sheet shows at a time (plugins/passwords-unlock-store.ts): a second ask
 * while one is open answers as a cancel would. A step of Walnut's own that got no unlock asks
 * here whether that was the reason, and then says so, instead of doing nothing.
 */
import { getPasswordsUnlock } from '@/plugins/passwords-unlock-store';

export const SHEET_BUSY_WORDS = 'The master password sheet is already open for another step. Finish or close it, then try again.';

/** Whether an unlock that just answered "no" met another sheet still open (not the person's cancel). */
export function unlockSheetBusy(): boolean {
  return getPasswordsUnlock() !== null;
}
