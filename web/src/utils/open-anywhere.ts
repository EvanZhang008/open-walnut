/**
 * Open a path or a letter from ANY surface that renders agent text.
 *
 * A path in agent text renders as `a.file-link` and a letter id as
 * `a.letter-link` (utils/markdown.ts, utils/letter-links.ts) on every surface
 * that runs the shared renderer: chat, Thread cards and their answers, the
 * Brief, letters, cards, drawers. Only the surfaces that wired a file opener
 * of their own used to open them; everywhere else the link was drawn and a
 * click did nothing (2026-11-02, the user on a Thread card: "I can't seem to
 * click the mp4 why?").
 *
 * So the opener is the app's, not the surface's: `openFileAnywhere` shows the
 * one FileViewer overlay `AnywhereFileViewer` keeps at the app root (a video
 * plays, an image shows, anything else opens in the file viewer), and
 * `openLetterAnywhere` opens the letter in the notification center's reader.
 * A surface with its own opener (a session's chat, which knows its host and
 * cwd) still opens there: useEntityClickHandler claims the click, and
 * `useAgentLinkClickFallback` opens only what no surface claimed. It listens
 * in the CAPTURE phase so a surface that stops propagation (a modal's
 * `onClick={e => e.stopPropagation()}`) cannot swallow the click, and decides
 * after the dispatch, when every surface has had its turn.
 */
import { useEffect } from 'react';
import { locatePath } from '@/api/files';
import { isPopoutPath } from '@/popout/openPopout';

export const OPEN_FILE_EVENT = 'walnut:open-file';
/** Sidebar opens the notification center on it; the center opens `detail.letterId`. */
export const OPEN_CENTER_EVENT = 'notification:open-center';
/** A pop-out has no notification center: it asks the app's window to open the letter. */
export const OPEN_LETTER_CHANNEL = 'walnut-open-letter';

export interface OpenFileRequest {
  path: string;
  line?: number;
  endLine?: number;
  host?: string;
}

export function openFileAnywhere(req: OpenFileRequest): void {
  window.dispatchEvent(new CustomEvent<OpenFileRequest>(OPEN_FILE_EVENT, { detail: req }));
}

export function openLetterAnywhere(letterId: string): void {
  if (isPopoutPath(window.location.pathname) && typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(OPEN_LETTER_CHANNEL);
    channel.postMessage({ letterId });
    channel.close();
    return;
  }
  window.dispatchEvent(new CustomEvent(OPEN_CENTER_EVENT, { detail: { letterId } }));
}

const claimed = new WeakSet<Event>();

/** A surface opened this click itself: the app-level fallback leaves it alone. */
export function claimAgentLinkClick(e: Event): void {
  claimed.add(e);
}

const LINK_SELECTOR = 'a.file-link, a.letter-link';

/** The link's own request, read from the anchor the renderer drew. */
export function openAgentLink(anchor: HTMLAnchorElement): void {
  const letterId = anchor.dataset.letterId;
  if (anchor.classList.contains('letter-link')) {
    if (letterId) openLetterAnywhere(letterId);
    return;
  }
  const lineAttr = anchor.dataset.fileLine;
  const line = lineAttr ? parseInt(lineAttr, 10) : undefined;
  const endAttr = anchor.dataset.fileEndLine;
  const endLine = line && endAttr ? parseInt(endAttr, 10) : undefined;
  const pos = { ...(line ? { line } : {}), ...(endLine ? { endLine } : {}) };
  const path = anchor.dataset.filePath;
  if (path) { openFileAnywhere({ path, ...pos }); return; }
  const rel = anchor.dataset.relPath;
  const cwd = anchor.dataset.cwd;
  if (!rel || !cwd) return;
  void locatePath(rel, { cwd }).then((r) => openFileAnywhere({
    path: r.found || r.missing ? r.path : `${cwd.replace(/\/$/, '')}/${rel.replace(/^\.\//, '')}`,
    ...(r.host && r.host !== '__local__' ? { host: r.host } : {}),
    ...pos,
  }));
}

/** The app's window opens the letters its pop-outs ask for (mounted in App.tsx, never in a pop-out). */
export function useOpenLetterRequests(inPopout: boolean): void {
  useEffect(() => {
    if (inPopout || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(OPEN_LETTER_CHANNEL);
    channel.onmessage = (e: MessageEvent) => {
      const letterId = (e.data as { letterId?: unknown } | null)?.letterId;
      if (typeof letterId !== 'string' || !/^lt-[0-9a-z]{1,12}-[0-9a-z]{4,12}$/.test(letterId)) return;
      openLetterAnywhere(letterId);
      try { window.focus(); } catch { /* the browser decides */ }
    };
    return () => channel.close();
  }, [inPopout]);
}

/**
 * Mounted once (App.tsx). These anchors never navigate (`href="#"`), so the
 * default is prevented at once; the open waits for the end of the dispatch.
 * A modifier click is left alone, as for task pills.
 */
export function useAgentLinkClickFallback(): void {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.(LINK_SELECTOR) as HTMLAnchorElement | null;
      if (!anchor) return;
      e.preventDefault();
      setTimeout(() => { if (!claimed.has(e)) openAgentLink(anchor); }, 0);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
}
