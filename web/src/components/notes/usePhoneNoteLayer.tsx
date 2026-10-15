/**
 * One note on a phone is a layer (spec 4.3, 4.7 Notes; C23, C79):
 * `note:<path>` with the note's name in the top bar, so Back (gesture or the
 * bar's chevron) goes to the tree, and the tree is where it was. The note is
 * read only until the bar's `Edit` (not a history entry): a tap that stops a
 * scroll or lands beside a link never puts a caret in and raises the keyboard,
 * and no bubble menu fights the system's own selection menu. `Done` goes back
 * to reading.
 *
 * The page mirrors the open note into `?path=` with a REPLACE. Router's replace
 * writes a fresh history state, which would drop this layer's marker, so on a
 * phone the mirror keeps the current state (`replaceUrlKeepingState`).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePhoneOverlay } from '@/hooks/usePhoneOverlayHistory';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { log } from '@/utils/log';

export function noteTitleOf(path: string | null): string {
  if (!path) return 'Notes';
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '') || 'Note';
}

/** `?path=` / `?attachment=` on the current URL, keeping history.state. */
export function replaceUrlKeepingState(params: Record<string, string>): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('path');
  url.searchParams.delete('attachment');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (url.href === window.location.href) return;
  window.history.replaceState(window.history.state, '', url.href);
}

export interface PhoneNoteLayer {
  phone: boolean;
  readOnly: boolean;
  /** The UI close (the strip's back button): through history on a phone. */
  close: () => void;
}

export function usePhoneNoteLayer(activePath: string | null, onBack: () => void): PhoneNoteLayer {
  const phone = usePhoneLayout();
  const [editing, setEditing] = useState(false);
  useEffect(() => { setEditing(false); }, [activePath]);

  const action = useMemo(() => (
    <button
      type="button"
      className="phone-topbar-text-btn phone-note-edit"
      data-testid="phone-note-edit"
      onClick={() => setEditing((v) => !v)}
    >
      {editing ? 'Done' : 'Edit'}
    </button>
  ), [editing]);

  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const layer = usePhoneOverlay({
    id: `note:${activePath ?? ''}`,
    kind: 'note',
    open: phone && !!activePath,
    bar: { title: noteTitleOf(activePath), action },
    onClose: () => { setEditing(false); onBackRef.current(); },
  });

  // The tree keeps its scroll across a note: its pane is display:none while a
  // note shows, which zeroes the box's scroll. Remember the last scroll the
  // tree made (the pane is already hidden when the note's commit lands).
  const saved = useRef<{ el: HTMLElement; top: number } | null>(null);
  useEffect(() => {
    if (!phone || activePath) return undefined;
    const onScroll = (e: Event) => {
      const el = e.target;
      if (el instanceof HTMLElement && el.closest('.notes-tree-pane')) saved.current = { el, top: el.scrollTop };
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [phone, activePath]);
  const prevPath = useRef(activePath);
  useLayoutEffect(() => {
    const was = prevPath.current;
    prevPath.current = activePath;
    if (!phone || !was || activePath || !saved.current) return;
    const { el, top } = saved.current;
    if (!el.isConnected) return;
    el.scrollTop = top;
    requestAnimationFrame(() => { el.scrollTop = top; });
    log.info('phone-notes', 'tree scroll restored', { top });
  }, [activePath, phone]);

  return { phone, readOnly: phone && !editing, close: layer.close };
}
