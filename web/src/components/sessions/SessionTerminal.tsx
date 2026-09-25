/**
 * SessionTerminal — embedded xterm.js terminal for a session.
 *
 * The shell runs under dtach on the target host (local or remote/SSH) so its
 * state survives disconnects. dtach (unlike tmux) does NOT grab the mouse or use
 * an alternate screen, so xterm.js keeps native scroll + drag-select + copy.
 * This component owns the xterm instance (in a ref — never React state, since
 * xterm manages its own canvas/DOM) and delegates the WS lifecycle to
 * useSessionTerminal.
 *
 * Two presentations (same inner content):
 * - default: a centered portal modal over a dim backdrop.
 * - `embedded`: renders inline (no portal, no backdrop) so it can fill the left
 *   column of the session full-screen split — matching Changed / Files.
 *
 * When dtach can't be provisioned on the target, the server opens a PLAIN
 * shell instead: xterm mounts as usual, the header shows a "Not persistent"
 * badge and a notice above the terminal names the fix plus a Retry (see
 * TerminalModeNotices). Only an ssh failure blocks, with a card showing ssh's
 * own error.
 */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useSessionTerminal } from '@/hooks/useSessionTerminal';
import { useConfirm } from '@/hooks/useConfirm';
import { TerminalPlainBadge, TerminalPlainNotice, TerminalSshFailedCard } from './TerminalModeNotices';

interface SessionTerminalProps {
  sessionId: string;
  /** Display label (host alias or cwd) for the header. */
  label?: string;
  host?: string;
  onClose: () => void;
  /**
   * When true, render inline (fills its parent) instead of a centered portal
   * modal — used by the session full-screen split's left column.
   */
  embedded?: boolean;
  /** Chat segment of the full-width bar (the panel's chat toggle) — see
   *  SessionFileExplorer.barRightSlot. Embedded mode only. */
  barRightSlot?: ReactNode;
}

export function SessionTerminal({ sessionId, label, host, onClose, embedded = false, barRightSlot }: SessionTerminalProps) {
  const confirm = useConfirm();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const getSize = useCallback(() => {
    const t = termRef.current;
    return t ? { cols: t.cols, rows: t.rows } : { cols: 80, rows: 24 };
  }, []);

  const { status, plain, sshFailed, errorMessage, sendInput, sendResize, kill, retry } = useSessionTerminal({
    sessionId,
    enabled: true,
    onData: (data) => termRef.current?.write(data),
    onExit: (code) => termRef.current?.write(`\r\n\x1b[90m[process exited${code ? ` (code ${code})` : ''}]\x1b[0m\r\n`),
    getSize,
  });

  // No xterm while ssh failed (nothing to mount); a plain shell mounts normally.
  const blocked = sshFailed !== null;

  // Create the xterm instance once. Skip while blocked.
  useEffect(() => {
    if (blocked) return;
    if (!containerRef.current || termRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { background: '#1a1b26', foreground: '#c0caf5' },
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

    termRef.current = term;
    fitRef.current = fit;

    return () => {
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [blocked, sendInput]);

  // Refit on container resize; push the new size to the pty (debounced).
  useEffect(() => {
    if (blocked || !containerRef.current) return;
    let raf = 0;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
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

  // Focus the terminal once ready.
  useEffect(() => {
    if (status === 'ready') {
      fitRef.current?.fit();
      const t = termRef.current;
      if (t) {
        t.focus();
        sendResize(t.cols, t.rows);
      }
    }
  }, [status, sendResize]);

  // Centered-modal mode: Escape closes (detach, dtach session kept).
  useEffect(() => {
    if (embedded) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, embedded]);

  // Embedded mode: ESC is a real terminal key (vim/less/etc.), but this terminal lives
  // INSIDE the fullscreen split whose useFullscreen() registers a document-level ESC
  // listener that closes the split. xterm sends ESC to the shell during its own keydown
  // on the helper textarea (bubble phase, at the target), so by stopping propagation at
  // the xterm container we let the shell receive ESC yet prevent it from reaching
  // useFullscreen — otherwise every ESC keypress would tear the terminal down.
  useEffect(() => {
    if (!embedded) return;
    const el = containerRef.current;
    if (!el) return;
    const stopEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') e.stopPropagation(); };
    el.addEventListener('keydown', stopEsc);
    return () => el.removeEventListener('keydown', stopEsc);
  }, [embedded, blocked]);

  const handleKill = useCallback(async () => {
    const message = plain
      ? 'Ending the terminal will terminate the shell and any running processes.'
      : 'Ending the terminal will close the dtach session and terminate any running processes.';
    if (await confirm({ title: 'End terminal?', message, confirmLabel: 'End', cancelLabel: 'Cancel', danger: true })) {
      kill();
      onClose();
    }
  }, [kill, onClose, confirm, plain]);

  const panel = (
    <div className={`session-terminal-panel${embedded ? ' session-terminal-panel-embedded' : ''}`}>
        <div className="session-terminal-header">
          <div className="session-terminal-title">
            <span className="session-terminal-icon">&#x2328;</span>
            <span className="session-terminal-label">{label ?? 'Terminal'}</span>
            {host && <span className="session-terminal-host">SSH: {host}</span>}
            <span className={`session-terminal-status session-terminal-status-${status}`}>{status}</span>
            {plain && <TerminalPlainBadge plain={plain} />}
          </div>
          <div className="session-terminal-actions">
            {!blocked && (
              <button className="session-terminal-btn session-terminal-btn-kill" onClick={handleKill} title={plain ? 'End terminal (kill the shell)' : 'End terminal (kill dtach)'}>
                End terminal
              </button>
            )}
            {/* In embedded mode the split's header owns closing (Changed/Files/Terminal toggle). */}
            {!embedded && (
              <button className="session-terminal-close" onClick={onClose} title={plain ? 'Close (Esc). Not persistent: the shell ends about 2 minutes after closing' : 'Close (Esc). The dtach session keeps running'}>
                &#x2715;
              </button>
            )}
            {barRightSlot}
          </div>
        </div>

        {!blocked && plain && (
          <TerminalPlainNotice plain={plain} retrying={status === 'connecting'} onRetry={retry} />
        )}

        {sshFailed ? (
          <TerminalSshFailedCard failed={sshFailed} onRetry={retry} />
        ) : (
          <div className="session-terminal-body">
            <div className="session-terminal-xterm" ref={containerRef} />
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

  // Embedded: render inline so it fills the split's left column.
  if (embedded) return panel;

  // Default: centered portal modal over a dim backdrop.
  return createPortal(
    <div className="session-terminal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {panel}
    </div>,
    document.body,
  );
}
