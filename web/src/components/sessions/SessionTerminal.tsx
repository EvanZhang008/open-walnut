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
 * When dtach can't be provisioned on the target, useSessionTerminal returns a
 * NO_DTACH result and we render an install-hint card instead of mounting xterm.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useSessionTerminal } from '@/hooks/useSessionTerminal';
import { useConfirm } from '@/hooks/useConfirm';

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
  const [copied, setCopied] = useState(false);

  const getSize = useCallback(() => {
    const t = termRef.current;
    return t ? { cols: t.cols, rows: t.rows } : { cols: 80, rows: 24 };
  }, []);

  const { status, noDtach, errorMessage, sendInput, sendResize, kill, retry } = useSessionTerminal({
    sessionId,
    enabled: true,
    onData: (data) => termRef.current?.write(data),
    onExit: (code) => termRef.current?.write(`\r\n\x1b[90m[process exited${code ? ` (code ${code})` : ''}]\x1b[0m\r\n`),
    getSize,
  });

  // Create the xterm instance once. Skip while NO_DTACH (no terminal to mount).
  useEffect(() => {
    if (noDtach) return;
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
  }, [noDtach, sendInput]);

  // Refit on container resize; push the new size to the pty (debounced).
  useEffect(() => {
    if (noDtach || !containerRef.current) return;
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
  }, [noDtach, sendResize]);

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
  }, [embedded, noDtach]);

  const handleKill = useCallback(async () => {
    if (await confirm({ title: 'End terminal?', message: 'Ending the terminal will close the dtach session and terminate any running processes.', confirmLabel: 'End', cancelLabel: 'Cancel', danger: true })) {
      kill();
      onClose();
    }
  }, [kill, onClose, confirm]);

  const handleCopyHint = useCallback(() => {
    const cmd = noDtach?.installHint?.split(/\s+#/)[0]?.trim();
    if (!cmd) return;
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [noDtach]);

  const panel = (
    <div className={`session-terminal-panel${embedded ? ' session-terminal-panel-embedded' : ''}`}>
        <div className="session-terminal-header">
          <div className="session-terminal-title">
            <span className="session-terminal-icon">&#x2328;</span>
            <span className="session-terminal-label">{label ?? 'Terminal'}</span>
            {host && <span className="session-terminal-host">SSH: {host}</span>}
            <span className={`session-terminal-status session-terminal-status-${status}`}>{status}</span>
          </div>
          <div className="session-terminal-actions">
            {!noDtach && status !== 'no_dtach' && (
              <button className="session-terminal-btn session-terminal-btn-kill" onClick={handleKill} title="End terminal (kill dtach)">
                End terminal
              </button>
            )}
            {/* In embedded mode the split's header owns closing (Changed/Files/Terminal toggle). */}
            {!embedded && (
              <button className="session-terminal-close" onClick={onClose} title="Close (Esc) — keeps the dtach session">
                &#x2715;
              </button>
            )}
            {barRightSlot}
          </div>
        </div>

        {noDtach ? (
          <div className="session-terminal-error-card">
            <div className="session-terminal-error-icon">&#x26A0;&#xFE0F;</div>
            <div className="session-terminal-error-title">
              Can't start terminal: unable to provision dtach on the target host{noDtach.host ? ` (${noDtach.host})` : ''}
            </div>
            <p className="session-terminal-error-body">
              The terminal uses dtach so the session survives SSH disconnects. Walnut compiles it automatically, but this host appears to be missing a C compiler:
            </p>
            <div className="session-terminal-install">
              <code>{noDtach.installHint}</code>
              <button className="session-terminal-btn" onClick={handleCopyHint}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <button className="session-terminal-btn session-terminal-retry" onClick={retry}>
              Retry
            </button>
          </div>
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
