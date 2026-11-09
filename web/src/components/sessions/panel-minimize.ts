import { requestMinimizeToTaskbar } from '@/utils/taskbar-minimize';

/**
 * What Minimize does on this panel, or null where it draws none (2026-11-08, the user: "this
 * should be global"). A host's own handler wins (Home's columns leave its strip); everywhere
 * else the session joins the app's taskbar and the panel closes when its host gave a close
 * (the Ask slot hides, an Org side panel closes; the Org node's chat stays, its page has no
 * other). None on a phone (no taskbar there), in a pop-out window (another window's bar), or
 * inset in a Board (it lives inside another panel). tests/web/session-taskbar.test.ts lists every place.
 */
export function minimizeHandler(o: {
  onMinimize?: (sessionId: string) => void;
  onClose?: (sessionId: string) => void;
  phone: boolean;
  viewPlace: string;
  inset: boolean;
}): ((sessionId: string) => void) | null {
  if (o.phone || o.inset || o.viewPlace === 'popout') return null;
  if (o.onMinimize) return o.onMinimize;
  const close = o.onClose;
  return (sessionId) => { requestMinimizeToTaskbar(sessionId); close?.(sessionId); };
}
