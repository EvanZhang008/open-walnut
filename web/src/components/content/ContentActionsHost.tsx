/**
 * Gives the content actions (utils/content-actions.ts) the app shell's toast, router and the one
 * Talk to CEO box, so a plugin's App, the Mail page and an Inbox letter all show the same box and
 * the same outcome the same way. It also notes where the last click was, so a menu's Talk to CEO
 * (which hands no anchor) opens the box where the person clicked.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '@/contexts/notifications';
import { notePointer, setContentActionsRuntime, type CeoComposerRequest } from '@/utils/content-actions';
import { CeoComposer } from './CeoComposer';

export function ContentActionsHost() {
  const { notify } = useNotifications();
  const navigate = useNavigate();
  const [composer, setComposer] = useState<{ req: CeoComposerRequest; n: number } | null>(null);
  // The open request, read outside state updaters so `done` runs once, from an event.
  const openRef = useRef<CeoComposerRequest | null>(null);
  const show = useCallback((req: CeoComposerRequest | null) => {
    const prev = openRef.current;
    openRef.current = req;
    if (prev && prev !== req) prev.done(false);
    setComposer((c) => (req ? { req, n: (c?.n ?? 0) + 1 } : null));
  }, []);
  useEffect(() => setContentActionsRuntime({
    navigate: (to) => navigate(to),
    toast: (t) => notify({
      kind: 'hint', severity: t.severity, title: t.title, ...(t.body ? { body: t.body } : {}),
      dedupKey: t.dedupKey, persistent: false,
      ...(t.action ? { action: { label: t.action.label, kind: 'callback' as const }, onAction: t.action.run } : {}),
    }),
    composer: (req) => show(req),
    closeComposer: () => show(null),
  }), [notify, navigate, show]);
  useEffect(() => () => { openRef.current?.done(false); openRef.current = null; }, []);
  useEffect(() => {
    const onDown = (e: PointerEvent) => notePointer(e.clientX, e.clientY);
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, []);
  // Bound to its own request: a send that finishes after another box replaced it closes nothing.
  const close = useCallback((req: CeoComposerRequest, sent: boolean) => {
    if (openRef.current !== req) return;
    openRef.current = null;
    req.done(sent);
    setComposer(null);
  }, []);
  if (!composer) return null;
  const { req } = composer;
  return createPortal(<CeoComposer key={composer.n} req={req} onClose={(sent) => close(req, sent)} />, document.body);
}
