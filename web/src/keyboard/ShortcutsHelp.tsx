/**
 * The keyboard shortcuts sheet: `?` (outside a text box) or mod+/ from any page, or the
 * `walnut:shortcuts-help` window event (the sidebar's menu entry). Lists the same table the
 * key handlers match (shortcuts.ts), in the keys of the place it runs in (Mac app, a Mac
 * browser, elsewhere).
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { isTypingTarget } from '@/components/tasks/useHomeFilters';
import { detectKeyEnv, envNote, isHelpChord, shortcutGroups } from './shortcuts';
import { SHORTCUTS_HELP_EVENT } from './shortcuts-help-event';
import '@/styles/keyboard-shortcuts.css';


export function ShortcutsHelpHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      if (!isHelpChord(e, detectKeyEnv(), isTypingTarget(document.activeElement))) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(SHORTCUTS_HELP_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(SHORTCUTS_HELP_EVENT, onOpen);
    };
  }, []);
  const close = useCallback(() => setOpen(false), []);
  return open ? <ShortcutsHelpDialog onClose={close} /> : null;
}

function ShortcutsHelpDialog({ onClose }: { onClose: () => void }) {
  const env = useMemo(detectKeyEnv, []);
  const groups = useMemo(() => shortcutGroups(env), [env]);
  const note = envNote(env);
  const [dialogEl, setDialogEl] = useState<HTMLDivElement | null>(null);
  const labelId = useId();
  useModalOverlay(onClose);
  useDialogFocus(dialogEl, 'Keyboard shortcuts');
  return createPortal(
    <div className="app-modal-overlay shortcuts-help-overlay" onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={setDialogEl}
        className="app-modal shortcuts-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="shortcuts-help-head">
          <h2 id={labelId} className="app-modal-title">Keyboard shortcuts</h2>
          <button type="button" className="shortcuts-help-close" aria-label="Close keyboard shortcuts" onClick={onClose}>×</button>
        </header>
        <div className="shortcuts-help-groups">
          {groups.map((g) => (
            <section key={g.title} className="shortcuts-help-group" aria-label={g.title}>
              <h3 className="shortcuts-help-group-title">{g.title}</h3>
              <dl className="shortcuts-help-list">
                {g.rows.map((r) => (
                  <div key={r.id} className="shortcuts-help-row" data-shortcut={r.id}>
                    <dt className="shortcuts-help-label">{r.label}</dt>
                    <dd className="shortcuts-help-keys">
                      {r.keys.map((chord, i) => (
                        <span key={i} className="shortcuts-help-chord">
                          {i > 0 && <span className="shortcuts-help-sep">{r.sep ?? 'or'}</span>}
                          {chord.map((key, j) => <kbd key={j}>{key}</kbd>)}
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        {note && <p className="shortcuts-help-note">{note}</p>}
      </div>
    </div>,
    document.body,
  );
}
