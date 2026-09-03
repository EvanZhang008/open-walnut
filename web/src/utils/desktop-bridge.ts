/**
 * What the Mac app shell (desktop/WebContentWatchdog.swift) may ask the page.
 *
 * The shell replaces the page process when it is bloated and the user is idle,
 * or when the server serves a newer bundle. Before it does, it asks whether a
 * reload would throw away typed text, and it wants the SAME answer the page's
 * own stale-asset reload uses (stale-assets.ts) so the two never disagree
 * about what counts as unsaved. The shell falls back to its own DOM scan when
 * this hook is missing (an older bundle), so the hook is an upgrade, not a
 * dependency.
 *
 * Installed on `window` rather than exported: the shell reaches it through
 * `evaluateJavaScript`, which sees only globals.
 */
import { hasUnsavedWork } from '@/utils/stale-assets';

export interface DesktopBridge {
  hasUnsavedWork(): boolean;
}

declare global {
  interface Window {
    __walnutDesktop?: DesktopBridge;
  }
}

export function installDesktopBridge(target: Window = window): DesktopBridge {
  const bridge: DesktopBridge = {
    hasUnsavedWork: () => {
      try { return hasUnsavedWork(target.document); } catch { return true; }
    },
  };
  target.__walnutDesktop = bridge;
  return bridge;
}
