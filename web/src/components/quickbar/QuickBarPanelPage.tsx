/**
 * /quickbar: the page inside the Mac app's floating panel (desktop/QuickBarPanel.swift), which
 * opens from any app on Control-Option-Command-Space. The app keeps the page loaded and calls
 * `window.__walnutQuickBar` (quickbar-native.ts); the page tells the app its size and mode:
 * `bar` (centered, takes the keyboard), `receipts` (the cards in the bottom left corner, which
 * never take the keyboard, so the person keeps typing where they were), `hidden`.
 * The panel draws the macOS glass behind the page, so the page itself paints no background.
 * A panel hidden for ten minutes lets its page go (releaseAfter): while a card closed with its ×
 * still has a send on its way, the page says `hidden` again every minute, which starts that clock
 * again, so the words are never let go with the page; and once such a send fails for good its card
 * shows again (the panel back to `receipts`).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { openTaskInApp } from '@/popout/openPopout';
import { rememberSend, type QuickPerson } from './quickbar-people';
import { QuickBar, type QuickBarHandle } from './QuickBar';
import { QuickBarReceipts } from './QuickBarReceipts';
import { useQuickReceipts, type Receipt } from './useQuickReceipts';
import { exposeToNative, hasNativeQuickBar, postToNative, openTaskOf } from './quickbar-native';
import type { QuickImage } from '@/api/quick';

type Mode = 'bar' | 'receipts' | 'hidden';

/** How often a hidden panel with a send on its way says so again: well inside the app's ten minutes. */
const KEEP_PAGE_EVERY_MS = 60_000;

export function QuickBarPanelPage() {
  // Opened in a plain browser tab (no app around it), the page shows the bar at once.
  const [mode, setMode] = useState<Mode>(() => (hasNativeQuickBar() ? 'hidden' : 'bar'));
  const barRef = useRef<QuickBarHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { receipts, hiddenOnItsWay, send, resend, dismiss, withdraw, toggleOpen, pin } = useQuickReceipts();

  useLayoutEffect(() => {
    document.documentElement.classList.add('qb-panel-doc');
    return () => document.documentElement.classList.remove('qb-panel-doc');
  }, []);

  const open = useLeanCallback(() => {
    setMode('bar');
    requestAnimationFrame(() => barRef.current?.opened());
  }, []);

  const closeBar = useLeanCallback(() => setMode(receipts.length > 0 ? 'receipts' : 'hidden'), [receipts.length]);

  useEffect(() => {
    exposeToNative({
      open,
      hotkey: () => (mode === 'bar' ? barRef.current?.hotkey() : open()),
      close: () => { if (mode === 'bar') barRef.current?.close(); },
      attach: (data) => {
        if (mode !== 'bar') open();
        requestAnimationFrame(() => barRef.current?.attach({ data, mediaType: 'image/png' }));
      },
    });
    return () => exposeToNative(null);
  }, [open, mode]);

  useEffect(() => { if (!hasNativeQuickBar()) barRef.current?.opened(); }, []);

  // The last receipt left: nothing is left to show. A card back (a hidden send that failed for
  // good, one a reload kept): the receipts show again.
  useEffect(() => {
    if (mode === 'receipts' && receipts.length === 0) setMode('hidden');
    else if (mode === 'hidden' && receipts.length > 0) setMode('receipts');
  }, [mode, receipts.length]);

  // The app sizes the panel to the page.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      postToNative({ type: 'layout', mode, width: Math.ceil(r.width), height: Math.ceil(r.height) });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    // Hidden with a send still on its way: said again, so the app keeps the page that sends it.
    const keep = mode === 'hidden' && hiddenOnItsWay ? setInterval(report, KEEP_PAGE_EVERY_MS) : undefined;
    return () => { ro.disconnect(); if (keep) clearInterval(keep); };
  }, [mode, hiddenOnItsWay]);

  const onSend = useLeanCallback((person: QuickPerson, text: string, images: QuickImage[]) => {
    if (person.id) rememberSend(person);
    send(person, text, images);
    setMode('receipts');
  }, [send]);

  const putBack = useLeanCallback((r: Receipt) => {
    // The words go back into the bar: their send (a waiting one too) goes out no more.
    withdraw(r.id);
    // The bar shows the words again without listening: a take would add to them.
    setMode('bar');
    requestAnimationFrame(() => barRef.current?.restore(r.person as QuickPerson, r.text, r.images));
  }, [withdraw]);

  const openChat = useLeanCallback((r: Receipt) => {
    if (!r.taskId) return;
    dismiss(r.id);
    if (!postToNative({ type: 'open', taskId: r.taskId })) openTaskInApp(r.taskId);
  }, [dismiss]);

  return (
    <div ref={rootRef} className={`qb-panel qb-panel-${mode}`}>
      <div hidden={mode !== 'bar'}>
        <QuickBar
          ref={barRef}
          surface={hasNativeQuickBar() ? 'panel' : 'overlay'}
          onClose={closeBar}
          onSend={onSend}
          onOpen={(to) => { if (!postToNative({ type: 'open', to, ...openTaskOf(to) })) window.open(to, '_blank'); }}
          onCapture={hasNativeQuickBar() ? () => postToNative({ type: 'capture' }) : undefined}
        />
      </div>
      {mode !== 'hidden' && (
        <QuickBarReceipts receipts={receipts} onOpenChat={openChat} onPutBack={putBack} onResend={resend} onToggle={toggleOpen} onDismiss={dismiss} onPin={pin} />
      )}
    </div>
  );
}
