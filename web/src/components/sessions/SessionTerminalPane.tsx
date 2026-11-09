/**
 * SessionTerminalPane — one terminal of a session: an xterm.js view of one slot's
 * shell (its own dtach session on the host, `@open-walnut/terminal-key`).
 *
 * dtach (unlike tmux) does NOT grab the mouse or use an alternate screen, so
 * xterm.js keeps native scroll + drag-select + copy. The xterm instance lives in
 * a ref (never React state: xterm owns its canvas/DOM); the WS lifecycle is
 * useSessionTerminal's.
 *
 * Beyond the shell itself:
 * - a selection shows an "Add to chat" button beside it, which puts the text in
 *   the session's composer as a terminal block (nothing is sent);
 * - file paths and `file:line` in the output are links that open the file in the
 *   session's Files view at that line (terminal-links.ts); URLs open as before
 *   (web-links addon).
 *
 * The workspace (SessionTerminal) owns the layout and the header; a pane tells it
 * its state (status, plain mode, title) and hands it its actions (End, Retry).
 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useSessionTerminal, type TerminalEndedBy } from '@/hooks/useSessionTerminal';
import { terminalCwd, type TerminalOpenPlain } from '@/api/terminal';
import { terminalKeyFor } from '@open-walnut/terminal-key';
import { ICON_CHAT, ICON_CLOSE } from '../common/Icons';
import { TerminalEndUnconfirmedNotice, TerminalPlainBadge, TerminalPlainNotice, TerminalSshFailedCard, TerminalStatusPill } from './TerminalModeNotices';
import { pathLinksAtRow, terminalPathCandidates, type TerminalPathLink } from './terminal-links';

/**
 * What the workspace needs of a pane. Never the status code itself: the status
 * only reaches the screen through TerminalStatusPill (the focused pane portals
 * its pill into the header, `pillTarget`).
 */
export interface TerminalPaneState {
  ending: boolean;
  exited: boolean;
  plain: TerminalOpenPlain | null;
  /** The title the shell set (OSC 0/2), e.g. the running command; null until it sets one. */
  title: string | null;
}

export interface TerminalPaneHandle {
  /** End this terminal (kills its dtach session). True only when the server confirmed it. */
  kill: () => Promise<boolean>;
  /** Re-probe and reopen (a plain shell, an error, an exited shell). */
  retry: () => void;
  focus: () => void;
  /** Its shell has exited (read by the End confirm without a render). */
  exited: () => boolean;
}

/** The pane's box in its tab, fractions of the tab (terminal-layout `paneRects`). */
export interface PaneBox { x: number; y: number; w: number; h: number }

const pct = (f: number) => `${(f * 100).toFixed(4)}%`;

interface SessionTerminalPaneProps {
  sessionId: string;
  slot: number;
  box: PaneBox;
  /** "Terminal 2": the strip label in a split, and the source of an added block. */
  label: string;
  /** In a split: a slim strip above the pane with its label, status and close. */
  showStrip: boolean;
  /** The header's status place: the focused pane shows its status and plain badge there. */
  pillTarget: HTMLElement | null;
  focused: boolean;
  /** The focused pane takes the keyboard focus (not while the user moves between tabs with the keys). */
  grabFocus: boolean;
  /** Keys typed for this terminal before it mounted (New / Split): sent once it connects. */
  takeTyped?: (slot: number) => string;
  onFocus: (slot: number) => void;
  onState: (slot: number, state: TerminalPaneState) => void;
  /** Close this pane (the workspace asks first and ends its shell). */
  onClosePane: (slot: number) => void;
  /** The shell exited: take the pane away without asking (nothing runs). */
  onDismissExited: (slot: number) => void;
  /** End answer: the workspace removes the pane once its end is confirmed. */
  onEndConfirmed: (slot: number) => void;
  onAddToChat?: (text: string, slot: number) => void;
  onOpenPath?: (link: TerminalPathLink) => void;
  /** Stop Escape at the pane (the split's own Escape would close the view). */
  stopEscape: boolean;
}

/** Where the "Add to chat" button sits, relative to the pane body. */
interface SelectionAnchor { x: number; y: number }

/** How long a click on a relative path waits for the shell's directory before it uses the session's. */
const CWD_WAIT_MS = 1_500;

const ADD_BUTTON_W = 128;
const ADD_BUTTON_H = 30;

export const SessionTerminalPane = forwardRef<TerminalPaneHandle, SessionTerminalPaneProps>(function SessionTerminalPane(
  { sessionId, slot, box, label, showStrip, pillTarget, focused, grabFocus, takeTyped, onFocus, onState, onClosePane, onDismissExited, onEndConfirmed, onAddToChat, onOpenPath, stopEscape },
  ref,
) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [endedBy, setEndedBy] = useState<TerminalEndedBy>(null);
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);
  const lastPointer = useRef<SelectionAnchor | null>(null);
  /**
   * Show "Add to chat" beside the selection, where the pointer let go (a drag, a
   * double click); a selection made otherwise (select all) puts it top right.
   * Runs on every selection change and on every pointer up: a drag over the same
   * text as the last selection changes nothing in xterm, yet must show it again.
   */
  const placeAddButton = useCallback(() => {
    const t = termRef.current;
    if (!t || !t.getSelection().trim()) { setAnchor(null); return; }
    const body = bodyRef.current;
    const w = body?.clientWidth ?? 0;
    const h = body?.clientHeight ?? 0;
    const p = lastPointer.current ?? { x: w - ADD_BUTTON_W - 8, y: 8 };
    const x = Math.max(4, Math.min(p.x + 8, w - ADD_BUTTON_W - 4));
    const y = Math.max(4, Math.min(p.y + 10, h - ADD_BUTTON_H - 4));
    setAnchor((a) => (a && a.x === x && a.y === y ? a : { x, y }));
  }, []);
  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const takeTypedRef = useRef(takeTyped);
  takeTypedRef.current = takeTyped;

  // A relative path opens from where the shell is now (the user may have cd'd
  // since the session started); without an answer, from the session's directory.
  const openPath = useCallback(async (link: TerminalPathLink) => {
    if (!onOpenPathRef.current) return;
    // An absolute path needs no shell directory (it is folded: `/a/b/../c`); a home path opens as it is.
    if (link.path.startsWith('/') || link.path.startsWith('~')) {
      onOpenPathRef.current({ ...link, path: terminalPathCandidates(link, { cwd: null })[0]! });
      return;
    }
    let place: { cwd: string | null; root?: string | null } = { cwd: null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([
        terminalCwd(terminalKeyFor(sessionId, slot)),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), CWD_WAIT_MS); }),
      ]);
      if (r) place = r;
    } catch { /* the session's directory then */ } finally {
      clearTimeout(timer);
    }
    const [first, ...rest] = terminalPathCandidates(link, place);
    onOpenPathRef.current?.({ ...link, path: first!, printed: link.path, ...(rest.length > 0 ? { fallbackPaths: rest } : {}) });
  }, [sessionId, slot]);
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;

  const getSize = useCallback(() => {
    const t = termRef.current;
    return t ? { cols: t.cols, rows: t.rows } : { cols: 80, rows: 24 };
  }, []);

  const { status, plain, sshFailed, errorMessage, endUnconfirmed, sendInput, sendResize, kill, retry } = useSessionTerminal({
    sessionId,
    slot,
    enabled: true,
    onData: (data) => termRef.current?.write(data),
    onExit: (code, _signal, by) => {
      setExitCode(code);
      setEndedBy(by);
      // Its own exit stays in the output (with its code); an end from outside is said by the note alone.
      if (by === null) termRef.current?.write(`\r\n\x1b[90m[process exited${code ? ` (code ${code})` : ''}]\x1b[0m\r\n`);
    },
    getSize,
  });
  const ending = status === 'ending';
  const exited = status === 'exited';
  const exitedRef = useRef(exited);
  exitedRef.current = exited;

  useEffect(() => { onState(slot, { ending, exited, plain, title }); }, [onState, slot, ending, exited, plain, title]);
  useEffect(() => { if (status === 'connecting') { setExitCode(null); setEndedBy(null); } }, [status]);

  const blocked = sshFailed !== null;

  // Create the xterm instance once. Skip while blocked.
  useEffect(() => {
    if (blocked) return;
    if (!containerRef.current || termRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { background: '#1a1b26', foreground: '#c0caf5', selectionBackground: '#3d59a1' },
      // Large native scrollback: dtach doesn't use an alternate screen, so the
      // browser keeps the full output history and the scroll wheel scrolls it
      // natively (no tmux copy-mode, no mouse grab).
      scrollback: 50000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    term.onData((d) => sendInput(d));
    const early = takeTypedRef.current?.(slot);
    if (early) sendInput(early);
    // Escape with a selection only clears it (and its Add to chat): sent to the
    // shell as well, readline would take it as Meta and eat the next key.
    term.attachCustomKeyEventHandler((e) => {
      if (e.key !== 'Escape' || !term.hasSelection()) return true;
      if (e.type === 'keydown') { term.clearSelection(); setAnchor(null); }
      return false;
    });
    term.onTitleChange((t) => setTitle(t.trim() || null));
    // File paths and file:line: open in the session's Files view.
    const links = term.registerLinkProvider({
      provideLinks(row, callback) {
        if (!onOpenPathRef.current) { callback(undefined); return; }
        const found = pathLinksAtRow(term.buffer.active, row - 1);
        callback(found.length === 0 ? undefined : found.map((l) => ({
          range: { start: l.start, end: l.end },
          text: l.text,
          decorations: { pointerCursor: true, underline: true },
          activate: (event: MouseEvent) => {
            event.preventDefault();
            void openPathRef.current(l.link);
          },
        })));
      },
    });
    const selection = term.onSelectionChange(() => placeAddButton());
    // The output moved under the selection (the wheel, new lines): Add to chat
    // follows its end, and goes while the selection is out of view.
    const scrolled = term.onScroll(() => {
      const pos = term.getSelectionPosition();
      const el = containerRef.current;
      if (!pos || !el || !term.getSelection().trim()) { setAnchor(null); return; }
      const row = pos.end.y - term.buffer.active.viewportY;
      if (pos.start.y - term.buffer.active.viewportY >= term.rows || row < 0) { setAnchor(null); return; }
      const cellW = el.clientWidth / term.cols;
      const cellH = el.clientHeight / term.rows;
      lastPointer.current = { x: Math.min(pos.end.x, term.cols) * cellW, y: (Math.min(row, term.rows - 1) + 1) * cellH };
      placeAddButton();
    });
    const textarea = term.textarea;
    // Another window may have sized the shell since: this one's size again, so its lines wrap right.
    const onTextFocus = () => { onFocusRef.current(slot); sendResize(term.cols, term.rows); };
    textarea?.addEventListener('focus', onTextFocus);

    termRef.current = term;
    fitRef.current = fit;

    return () => {
      textarea?.removeEventListener('focus', onTextFocus);
      links.dispose();
      selection.dispose();
      scrolled.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [blocked, sendInput, sendResize, slot, placeAddButton]);

  // Refit on container resize; push the new size to the pty (debounced).
  useEffect(() => {
    if (blocked || !containerRef.current) return;
    let raf = 0;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // A hidden pane (another tab) measures 0: keep its size for when it shows.
        const el = containerRef.current;
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
        fitRef.current?.fit();
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          const t = termRef.current;
          if (t) sendResize(t.cols, t.rows);
        }, 100);
      });
    });
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      if (debounce) clearTimeout(debounce);
    };
  }, [blocked, sendResize]);

  // Fit and push the size once ready; take the focus if this pane has it.
  useEffect(() => {
    if (status !== 'ready') return;
    const el = containerRef.current;
    if (el && el.clientWidth > 0) fitRef.current?.fit();
    const t = termRef.current;
    if (t) {
      if (focused && grabFocus) t.focus();
      sendResize(t.cols, t.rows);
    }
    // `focused` is read, not watched: the effect below moves the focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, sendResize]);

  useEffect(() => {
    if (focused && grabFocus) termRef.current?.focus();
  }, [focused, grabFocus]);

  // ESC is a real terminal key (vim/less/etc.), but this terminal lives INSIDE the
  // fullscreen split whose useFullscreen() registers a document-level ESC listener
  // that closes the split. xterm sends ESC to the shell during its own keydown on
  // the helper textarea (bubble phase, at the target), so by stopping propagation
  // at the xterm container we let the shell receive ESC yet keep it from
  // useFullscreen; otherwise every ESC would tear the terminal down. Escape with
  // a selection clears it (and its button).
  useEffect(() => {
    if (!stopEscape) return;
    const el = containerRef.current;
    if (!el) return;
    const stopEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') e.stopPropagation(); };
    el.addEventListener('keydown', stopEsc);
    return () => el.removeEventListener('keydown', stopEsc);
  }, [stopEscape, blocked]);

  const handleKill = useCallback(async () => {
    const ok = await kill();
    if (ok) onEndConfirmed(slot);
    return ok;
  }, [kill, onEndConfirmed, slot]);

  useImperativeHandle(ref, () => ({
    kill: handleKill,
    retry,
    focus: () => termRef.current?.focus(),
    exited: () => exitedRef.current,
  }), [handleKill, retry]);

  const addSelection = useCallback(() => {
    const t = termRef.current;
    const text = t?.getSelection() ?? '';
    if (text.trim() && onAddToChat) onAddToChat(text, slot);
    t?.clearSelection();
    setAnchor(null);
  }, [onAddToChat, slot]);

  return (
    <div
      className={`session-terminal-pane${focused ? ' is-focused' : ''}${box.x > 0.001 ? ' has-left' : ''}${box.y > 0.001 ? ' has-top' : ''}`}
      style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }}
      data-terminal-slot={slot}
      data-testid="terminal-pane"
      onMouseDownCapture={() => { if (!focused) onFocus(slot); }}
    >
      {pillTarget && createPortal(
        <>
          <TerminalStatusPill status={status} />
          {plain && <TerminalPlainBadge plain={plain} />}
        </>,
        pillTarget,
      )}
      {showStrip && (
        <div className="session-terminal-pane-strip">
          <span className="session-terminal-pane-label" title={title ?? label}>{title ? `${label} · ${title}` : label}</span>
          {/* Only what needs a look: a connected pane says nothing. */}
          {status !== 'ready' && <TerminalStatusPill status={status} />}
          <button
            type="button"
            className="session-terminal-pane-close"
            onClick={() => onClosePane(slot)}
            title={`Close ${label} (ends its shell)`}
            aria-label={`Close ${label}`}
          >{ICON_CLOSE}</button>
        </div>
      )}

      {!blocked && plain && (
        <TerminalPlainNotice plain={plain} retrying={status === 'connecting'} disabled={ending} onRetry={retry} />
      )}

      {!blocked && endUnconfirmed && (
        <TerminalEndUnconfirmedNotice reason={endUnconfirmed} ending={ending} onRetry={() => { void handleKill(); }} />
      )}

      {sshFailed ? (
        <TerminalSshFailedCard failed={sshFailed} onRetry={retry} />
      ) : (
        <div
          className="session-terminal-body"
          ref={bodyRef}
          onPointerUp={(e) => {
            const r = bodyRef.current?.getBoundingClientRect();
            if (r) lastPointer.current = { x: e.clientX - r.left, y: e.clientY - r.top };
            // After xterm's own mouseup has settled the selection (a double click selects then).
            requestAnimationFrame(placeAddButton);
            // A drag that selected output gives this terminal the keys (Escape, copy), as
            // a click does: WebKit can leave them where they were (the message box).
            const t = termRef.current;
            if (t?.textarea && t.hasSelection() && document.activeElement !== t.textarea && !(e.target as Element).closest?.('button, .session-terminal-selection-pop')) t.focus();
          }}
        >
          <div className="session-terminal-xterm" ref={containerRef} />
          {anchor && onAddToChat && (
            <div
              className="session-terminal-selection-pop"
              style={{ left: anchor.x, top: anchor.y }}
              // Keep the xterm selection: a mousedown here must not move the focus.
              onMouseDown={(e) => e.preventDefault()}
              data-testid="terminal-add-to-chat-pop"
            >
              <button type="button" className="session-terminal-selection-btn" onClick={addSelection} title="Put the selected output in the message box (nothing is sent)">
                {ICON_CHAT}<span>Add to chat</span>
              </button>
            </div>
          )}
          {status === 'exited' && exitCode !== null && (
            <div className="session-terminal-inline-note" role="status">
              <span>{endedBy === 'window' ? 'Ended in another window.' : endedBy === 'other' ? 'This terminal was ended.' : `The shell exited${exitCode ? ` (code ${exitCode})` : ''}.`}</span>
              <button type="button" className="session-terminal-btn" onClick={retry}>Restart</button>
              <button type="button" className="session-terminal-btn" onClick={() => onDismissExited(slot)}>Close</button>
            </div>
          )}
          {status === 'error' && errorMessage && (
            <div className="session-terminal-inline-error">
              {errorMessage}
              <button className="session-terminal-btn" onClick={retry}>Retry</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
