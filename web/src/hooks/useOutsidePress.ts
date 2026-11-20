import { useEffect, type RefObject } from 'react';
import { useCommittedRef } from './useCommittedRef';

/** The press that opened the popover is still going when it mounts: listen only after it. */
const ARM_MS = 100;

/**
 * Calls `onOutside` on a mouse press outside `ref` while `open` is true: a popover's
 * outside-click closer.
 *
 * Armed ONCE per opening, never re-armed by a render. The listener reads the latest committed
 * `onOutside`, so the handler's identity is free to change. Before, the listener was re-added
 * (after the same 100 ms delay) every time the handler changed, and a parent that re-renders
 * often (an inline `onClose`) kept it unarmed most of the time: 2026-11-20, a press on the draft's
 * More, or anywhere outside, left the folder picker open with the typed folder not taken
 * (workspace-scripts.spec.ts).
 */
export function useOutsidePress(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onOutside: (e: MouseEvent) => void,
): void {
  const latest = useCommittedRef(onOutside);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) latest.current(e);
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), ARM_MS);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler); };
  }, [open, ref, latest]);
}
