/**
 * What the Mac app shell (desktop/WebContentWatchdog.swift) may ask the page.
 *
 * The shell replaces the page process when it is bloated and the user is idle,
 * or when the server serves a newer bundle. Before it does, it asks whether a
 * reload would throw away typed text, and it wants the SAME answer the page's
 * own stale-asset reload uses (stale-assets.ts) so the two never disagree
 * about what counts as unsaved. The shell falls back to its own DOM scan when
 * this hook is missing (an older bundle), so the hook is an upgrade, not a
 * dependency. The app also hands it the `open-walnut://` links it is asked to
 * open (`openLink`), so a link reaches an open page without a reload.
 *
 * Installed on `window` rather than exported: the shell reaches it through
 * `evaluateJavaScript`, which sees only globals.
 */
import { hasUnsavedWork } from '@/utils/stale-assets';
import { listUnsavedWork, revealUnsavedWork } from '@/utils/unsaved-work';
import { openLink } from '@/utils/open-link';

/** One thing a restart would lose in this window, for the restart notice in another one. */
export interface DesktopUnsavedItem {
  what: string;
  where: string;
}

export interface DesktopBridge {
  /** `reload`: the shell reloads this page in place; anything else (or nothing, an older
   *  shell) means the page goes away, a restart or a closing window. */
  hasUnsavedWork(scope?: string): boolean;
  /** The same answer as hasUnsavedWork, item by item; null when the check failed. */
  listUnsavedWork(): DesktopUnsavedItem[] | null;
  /** Bring the item at `index` of a fresh listUnsavedWork() into view. */
  revealUnsavedWork(index: number): boolean;
  /** An `open-walnut://` link the app was asked to open (desktop/AppLink.swift).
   *  Handled in place, never by a reload: the page may hold unsaved text. */
  openLink(link: string): boolean;
}

declare global {
  interface Window {
    __walnutDesktop?: DesktopBridge;
  }
}

export function installDesktopBridge(target: Window = window): DesktopBridge {
  const bridge: DesktopBridge = {
    hasUnsavedWork: (scope) => {
      try { return hasUnsavedWork(target.document, scope === 'reload' ? 'reload' : 'leave'); } catch { return true; }
    },
    listUnsavedWork: () => {
      try { return listUnsavedWork(target.document).map(({ what, where }) => ({ what, where })); } catch { return null; }
    },
    revealUnsavedWork: (index) => {
      try {
        const found = listUnsavedWork(target.document)[Number(index)];
        if (!found) return false;
        revealUnsavedWork(found);
        return true;
      } catch { return false; }
    },
    openLink: (link) => openLink(String(link)),
  };
  target.__walnutDesktop = bridge;
  return bridge;
}
