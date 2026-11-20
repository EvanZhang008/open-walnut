/**
 * The quick bar inside the Walnut page (experimental `quick_bar`, off by default): with the
 * experiment on, Control-Option-Command-Space opens the bar over the page and the receipts
 * collect in the top right corner. In the Mac app this page also tells the app the switch's
 * state, so the app registers the same key for every app (its floating panel,
 * QuickBarPanelPage.tsx); while the app holds the key this listener never hears it.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useExperimental } from '@/hooks/useExperimental';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { rememberSend, type QuickPerson } from './quickbar-people';
import { QuickBar, type QuickBarHandle } from './QuickBar';
import { QuickBarReceipts } from './QuickBarReceipts';
import { useQuickReceipts, type Receipt } from './useQuickReceipts';
import { isQuickBarKey, postToNative } from './quickbar-native';
import type { QuickImage } from '@/api/quick';

export function QuickBarHost() {
  const on = useExperimental('quick_bar');
  // The app keeps the key only while the switch is on, and drops it the moment it goes off.
  useEffect(() => { postToNative({ type: 'flag', on }); }, [on]);
  return on ? <QuickBarOverlay /> : null;
}

function QuickBarOverlay() {
  const [open, setOpen] = useState(false);
  const barRef = useRef<QuickBarHandle | null>(null);
  const navigate = useNavigate();
  const { receipts, send, dismiss, toggleOpen, pin } = useQuickReceipts();

  const show = useLeanCallback(() => {
    setOpen(true);
    requestAnimationFrame(() => barRef.current?.opened());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isQuickBarKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (open) barRef.current?.hotkey();
      else show();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, show]);

  const onSend = useLeanCallback((person: QuickPerson, text: string, images: QuickImage[]) => {
    if (person.id) rememberSend(person);
    send(person, text, images);
    setOpen(false);
  }, [send]);

  const putBack = useLeanCallback((r: Receipt) => {
    dismiss(r.id);
    setOpen(true);
    requestAnimationFrame(() => barRef.current?.restore(r.person as QuickPerson, r.text, r.images));
  }, [dismiss]);

  const openChat = useLeanCallback((r: Receipt) => {
    if (!r.taskId) return;
    dismiss(r.id);
    navigate(`/tasks/${r.taskId}`);
  }, [dismiss, navigate]);

  return createPortal(
    <div className="qb-layer" data-open={open ? 'true' : 'false'}>
      {open && <div className="qb-scrim" onMouseDown={() => barRef.current?.close()} />}
      <div className="qb-center wn-glass" hidden={!open}>
        <QuickBar ref={barRef} surface="overlay" onClose={() => setOpen(false)} onSend={onSend} />
      </div>
      <QuickBarReceipts floating receipts={receipts} onOpenChat={openChat} onPutBack={putBack} onToggle={toggleOpen} onDismiss={dismiss} onPin={pin} />
    </div>,
    document.body,
  );
}
