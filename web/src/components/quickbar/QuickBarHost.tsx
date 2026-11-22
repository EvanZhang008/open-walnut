/**
 * The quick bar inside the Walnut page (experimental `quick_bar`, off by default): with the
 * experiment on, Control-Option-Command-Space opens the bar over the page and the receipts
 * collect in the top right corner. In the Mac app this page also tells the app the switch's
 * state, so the app registers the same key for every app (its floating panel,
 * QuickBarPanelPage.tsx); while the app holds the key this listener never hears it.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { taskPath } from '@/utils/task-path';
import { useExperimental } from '@/hooks/useExperimental';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { rememberSend, type QuickPerson } from './quickbar-people';
import { QuickBar, type QuickBarHandle } from './QuickBar';
import { QuickBarReceipts } from './QuickBarReceipts';
import { useQuickReceipts, type Receipt } from './useQuickReceipts';
import { isQuickBarKey, isQuickBarSearchKey, OPEN_QUICK_BAR_EVENT, postToNative, type OpenQuickBarDetail } from './quickbar-native';
import type { OpenOptions } from './QuickBar';
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
  const { receipts, send, resend, dismiss, withdraw, toggleOpen, pin } = useQuickReceipts();

  const show = useLeanCallback((opts?: OpenOptions) => {
    // Shown and focused before the next key: words typed right after the key go into the bar,
    // never into the page under it (a "?" there opened the shortcuts list).
    flushSync(() => setOpen(true));
    barRef.current?.opened(opts);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cmd-K opens the bar for typing, and on the Notes page on its notes search: it replaces
      // the Notes page's own palette and the Home task search's Cmd-K while the bar is on.
      // A Cmd-K sent to the window itself is the Notes page's "+" tab opening its own palette.
      if (isQuickBarSearchKey(e) && e.target !== window) {
        e.preventDefault();
        e.stopPropagation();
        if (open) barRef.current?.close();
        // The window's own address: an app's pane may run a router of its own (popout/AppOwnRouter.tsx).
        else show({ listen: false, ...(window.location.pathname.startsWith('/notes') ? { mode: 'notes' as const } : {}) });
        return;
      }
      if (!isQuickBarKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (open) barRef.current?.hotkey();
      else show();
    };
    // The rail's magnifier: the same as the key, but a second click while open leaves it open.
    const onOpen = (e: Event) => { if (!open) show((e as CustomEvent<OpenQuickBarDetail>).detail); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener(OPEN_QUICK_BAR_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener(OPEN_QUICK_BAR_EVENT, onOpen);
    };
  }, [open, show]);

  const onSend = useLeanCallback((person: QuickPerson, text: string, images: QuickImage[]) => {
    if (person.id) rememberSend(person);
    send(person, text, images);
    setOpen(false);
  }, [send]);

  const putBack = useLeanCallback((r: Receipt) => {
    // The words go back into the bar: their send (a waiting one too) goes out no more.
    withdraw(r.id);
    setOpen(true);
    requestAnimationFrame(() => barRef.current?.restore(r.person as QuickPerson, r.text, r.images));
  }, [withdraw]);

  const openChat = useLeanCallback((r: Receipt) => {
    if (!r.taskId) return;
    dismiss(r.id);
    navigate(taskPath(r.taskId));
  }, [dismiss, navigate]);

  return createPortal(
    <div className="qb-layer" data-open={open ? 'true' : 'false'}>
      {open && <div className="qb-scrim" onMouseDown={() => barRef.current?.close()} />}
      <div className="qb-center wn-glass-frost" hidden={!open}>
        <QuickBar ref={barRef} surface="overlay" onClose={() => setOpen(false)} onSend={onSend} onOpen={(to) => navigate(to)} />
      </div>
      <QuickBarReceipts floating receipts={receipts} onOpenChat={openChat} onPutBack={putBack} onResend={resend} onToggle={toggleOpen} onDismiss={dismiss} onPin={pin} />
    </div>,
    document.body,
  );
}
