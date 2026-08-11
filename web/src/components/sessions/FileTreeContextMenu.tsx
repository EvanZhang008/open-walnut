/**
 * FileTreeContextMenu — Walnut's OWN right-click menu for the session file
 * explorer tree, replacing the browser's ("Back / Reload / View Page Source"),
 * which is useless inside an app pane.
 *
 * Actions (a superset of what the row's left-click does):
 *   file → Open (preview) · Open in Notes (vault notes only) · Open in new tab
 *          · Reveal in Finder · Open in default app · Copy path · Download
 *   dir  → Reveal in Finder · Copy path
 *
 * Anchored at the pointer; portaled to <body> so the explorer's own overflow
 * clipping can't cut it off. Reuses the .notes-context-menu skin — one menu look
 * across the app.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface FileTreeContextTarget {
  point: { x: number; y: number };
  path: string;
  type: 'dir' | 'file';
  /** Vault-relative note path when this file is a note (enables Open in Notes). */
  notePath?: string | null;
}

interface Props {
  target: FileTreeContextTarget;
  onClose: () => void;
  /** Left-click equivalent: select + preview in the right pane. */
  onOpen?: (path: string) => void;
  onOpenInNotes?: (notePath: string) => void;
  onOpenInNewTab?: (path: string) => void;
  onDownload?: (path: string) => void;
  /** Desktop actions — omitted (menu items hidden) when reveal isn't available. */
  onReveal?: (path: string, mode: 'finder' | 'app') => void;
  canReveal?: boolean;
}

const MENU_MARGIN = 8;

export function FileTreeContextMenu({
  target, onClose, onOpen, onOpenInNotes, onOpenInNewTab, onDownload, onReveal, canReveal,
}: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: target.point.x, top: target.point.y });
  const [copied, setCopied] = useState(false);

  // Clamp into the viewport AFTER mount — the menu's height depends on which
  // items rendered, so a pre-measure guess would hang items off the bottom edge
  // (and a fixed element in no scroll container makes them unreachable).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(MENU_MARGIN, Math.min(target.point.x, window.innerWidth - r.width - MENU_MARGIN)),
      top: Math.max(MENU_MARGIN, Math.min(target.point.y, window.innerHeight - r.height - MENU_MARGIN)),
    });
  }, [target.point.x, target.point.y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isFile = target.type === 'file';
  const run = (fn: () => void) => () => { fn(); onClose(); };

  const copyPath = () => {
    navigator.clipboard.writeText(target.path)
      .then(() => { setCopied(true); setTimeout(onClose, 600); })
      .catch(() => onClose());
  };

  return createPortal(
    <>
      {/* Backdrop swallows the next click AND the next right-click, so a
          right-click elsewhere closes this menu instead of stacking two. */}
      <div
        className="file-ctx-backdrop"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        className="notes-context-menu file-ctx-menu"
        ref={menuRef}
        style={{ left: pos.left, top: pos.top }}
        role="menu"
        data-testid="file-ctx-menu"
        onContextMenu={(e) => e.preventDefault()}
      >
        {isFile && onOpen && (
          <button role="menuitem" onClick={run(() => onOpen(target.path))}>Open</button>
        )}
        {isFile && target.notePath && onOpenInNotes && (
          <button role="menuitem" onClick={run(() => onOpenInNotes(target.notePath!))}>
            Open in Notes
          </button>
        )}
        {isFile && onOpenInNewTab && (
          <button role="menuitem" onClick={run(() => onOpenInNewTab(target.path))}>
            Open in new tab
          </button>
        )}
        {(isFile || canReveal) && <div className="notes-context-menu-divider" />}
        {canReveal && onReveal && (
          <>
            <button role="menuitem" onClick={run(() => onReveal(target.path, 'finder'))}>
              Reveal in Finder
            </button>
            {isFile && (
              <button role="menuitem" onClick={run(() => onReveal(target.path, 'app'))}>
                Open in default app
              </button>
            )}
          </>
        )}
        <button role="menuitem" onClick={copyPath}>{copied ? '✓ Copied' : 'Copy path'}</button>
        {isFile && onDownload && (
          <button role="menuitem" onClick={run(() => onDownload(target.path))}>Download</button>
        )}
      </div>
    </>,
    document.body,
  );
}
