/**
 * The console's view onto the mail store.
 *
 * The store is React-free by design; this adapts it. Three things: publish the snapshot through
 * `useSyncExternalStore`, start the first load, and make sure the session-scoped live wiring
 * (`mail-live.ts`) is installed even if the console is the first thing that ran.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useEvent, useWebSocket } from '@/hooks/useWebSocket';
import { runWhenVisible } from '@/utils/page-visibility';
import { openMailConsole, refreshMailAll } from './mail-actions';
import { ensureMailLive } from './mail-live';
import { getMailSnapshot, subscribeMail, type MailSnapshot } from './mail-store';

export function useMailConsole(): MailSnapshot {
  const snapshot = useSyncExternalStore(subscribeMail, getMailSnapshot, getMailSnapshot);
  const mounted = useRef(true);

  // The socket is app-wide and already connected on every other surface; this only guarantees
  // it when the console is the first thing rendered.
  useWebSocket();

  useEffect(() => {
    ensureMailLive();
    void openMailConsole();
    return () => { mounted.current = false; };
  }, []);

  // A socket gap loses every push inside it, and this console is not polled, so mail that
  // arrived while the socket was down would stay invisible until a reload. Hidden tabs defer:
  // every open tab reconnects at once and the store shares one request per key. The mounted
  // check is the deferred job's cancel: a job queued while hidden fires on the visible edge,
  // which can be long after the human left Mail, and this refresh pulls a whole page.
  useEvent('_ws:reconnected', () => {
    runWhenVisible('mail:reconnect', () => {
      if (mounted.current) void refreshMailAll();
    });
  });

  return snapshot;
}
