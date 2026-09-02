/**
 * FileTreeContextMenu — Walnut's OWN right-click menu for the session file
 * explorer tree, replacing the browser's ("Back / Reload / View Page Source"),
 * which is useless inside an app pane.
 *
 * Actions (a superset of what the row's left-click does):
 *   file → Open (preview) · Open in Notes (vault notes only) · Open in new tab
 *          · Reveal in Finder · Open in default app · New File/Folder (in its
 *          parent) · Rename · Duplicate · Delete · Copy path(s) · Download
 *   dir  → New File/Folder · Reveal in Finder · Rename · Duplicate · Delete
 *          · Copy path(s)
 *   root → same as dir MINUS rename/duplicate/delete: a root section header (and
 *          the empty tree background) stands for the tree itself, and deleting
 *          the thing you are browsing from inside it is never what was meant.
 *
 * Anchored at the pointer; portaled to <body> so the explorer's own overflow
 * clipping can't cut it off. Reuses the .notes-context-menu skin — one menu look
 * across the app.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { parentPath } from './reveal-ancestors';
import { relativeTo } from './file-tree-edit';
import { copyTextRobust } from '@/utils/clipboard';

export interface FileTreeContextTarget {
  point: { x: number; y: number };
  path: string;
  type: 'dir' | 'file';
  /** Vault-relative note path when this file is a note (enables Open in Notes). */
  notePath?: string | null;
  /** A tree ROOT section header, or the empty tree background: it can be created
   *  into, but never renamed, duplicated or deleted. */
  isRoot?: boolean;
  /** Path of the root section containing this target — the base for "Copy
   *  relative path". Absent (or equal to `path`) → that item is hidden. */
  relativeRoot?: string;
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
  /** Mutations. `dirPath` is the directory to create IN (a file target passes its
   *  parent), so the caller never has to re-derive it. */
  onNewFile?: (dirPath: string) => void;
  onNewFolder?: (dirPath: string) => void;
  onRename?: (path: string) => void;
  onDuplicate?: (path: string) => void;
  onDelete?: (path: string, type: 'dir' | 'file') => void;
}

const MENU_MARGIN = 8;

export function FileTreeContextMenu({
  target, onClose, onOpen, onOpenInNotes, onOpenInNewTab, onDownload, onReveal, canReveal,
  onNewFile, onNewFolder, onRename, onDuplicate, onDelete,
}: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: target.point.x, top: target.point.y });
  const [copied, setCopied] = useState<'path' | 'rel' | null>(null);
  /** The "✓ Copied" dwell before the menu closes itself. Held in a ref because an
   *  UNOWNED timer outlives what armed it: right-click A → Copy path → right-click
   *  B within 600ms and A's timer closed B's menu, and its setCopied landed after
   *  A had unmounted. */
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimer = () => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  // A new right-click retargets this same instance (the component is not remounted
  // per target), so the previous target's pending close must go with it.
  useEffect(() => {
    setCopied(null);
    return clearCloseTimer;
  }, [target.path, target.point.x, target.point.y]);

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
  const canMutate = !target.isRoot;
  /** Directory a "New …" from this target creates in: a file creates beside itself. */
  const createDir = isFile ? parentPath(target.path) : target.path;
  const relRoot = target.relativeRoot;
  const showRelPath = !!relRoot && relRoot !== target.path;
  const run = (fn: () => void) => () => { fn(); onClose(); };

  // copyTextRobust, not navigator.clipboard: the Clipboard API is secure-context
  // only, and plain-HTTP LAN access (http://<lan-ip>:3456) is a normal way to
  // reach Walnut — there the direct write rejects and nothing was copied. The
  // helper falls back to the desktop bridge / execCommand path.
  const copy = (text: string, which: 'path' | 'rel') => {
    void copyTextRobust(text).then((result) => {
      if (result === 'failed') { onClose(); return; }
      setCopied(which);
      clearCloseTimer();
      closeTimerRef.current = setTimeout(() => { closeTimerRef.current = null; onClose(); }, 600);
    });
  };

  // Items are grouped, then EMPTY GROUPS ARE DROPPED before dividers are woven
  // in — a per-item `&& <divider/>` doubles up (or leads/trails) the moment a
  // group's whole content is conditional, which every group here is.
  const groups: ReactNode[][] = [];

  if (isFile) {
    groups.push([
      onOpen && <button key="open" role="menuitem" onClick={run(() => onOpen(target.path))}>Open</button>,
      target.notePath && onOpenInNotes && (
        <button key="notes" role="menuitem" onClick={run(() => onOpenInNotes(target.notePath!))}>
          Open in Notes
        </button>
      ),
      onOpenInNewTab && (
        <button key="newtab" role="menuitem" onClick={run(() => onOpenInNewTab(target.path))}>
          Open in new tab
        </button>
      ),
    ].filter(Boolean) as ReactNode[]);
  }

  const revealGroup: ReactNode[] = [];
  if (canReveal && onReveal) {
    revealGroup.push(
      <button key="finder" role="menuitem" onClick={run(() => onReveal(target.path, 'finder'))}>
        Reveal in Finder
      </button>,
    );
    if (isFile) {
      revealGroup.push(
        <button key="defaultapp" role="menuitem" onClick={run(() => onReveal(target.path, 'app'))}>
          Open in default app
        </button>,
      );
    }
  }

  const createGroup: ReactNode[] = [];
  if (onNewFile) {
    createGroup.push(
      <button key="newfile" role="menuitem" onClick={run(() => onNewFile(createDir))}>New File…</button>,
    );
  }
  if (onNewFolder) {
    createGroup.push(
      <button key="newfolder" role="menuitem" onClick={run(() => onNewFolder(createDir))}>New Folder…</button>,
    );
  }

  // Directories lead with creation (that's what a folder's menu is mostly for);
  // a file leads with its open actions and gets creation lower down.
  if (!isFile) groups.push(createGroup);
  groups.push(revealGroup);
  if (isFile) groups.push(createGroup);

  const mutateGroup: ReactNode[] = [];
  if (canMutate) {
    if (onRename) {
      mutateGroup.push(
        <button key="rename" role="menuitem" onClick={run(() => onRename(target.path))}>Rename…</button>,
      );
    }
    if (onDuplicate) {
      mutateGroup.push(
        <button key="duplicate" role="menuitem" onClick={run(() => onDuplicate(target.path))}>Duplicate</button>,
      );
    }
    if (onDelete) {
      mutateGroup.push(
        <button key="delete" role="menuitem" className="danger" onClick={run(() => onDelete(target.path, target.type))}>
          Delete
        </button>,
      );
    }
  }
  groups.push(mutateGroup);

  groups.push([
    <button key="copypath" role="menuitem" onClick={() => copy(target.path, 'path')}>
      {copied === 'path' ? '✓ Copied' : 'Copy path'}
    </button>,
    showRelPath && (
      <button key="copyrel" role="menuitem" onClick={() => copy(relativeTo(relRoot!, target.path), 'rel')}>
        {copied === 'rel' ? '✓ Copied' : 'Copy relative path'}
      </button>
    ),
    isFile && onDownload && (
      <button key="download" role="menuitem" onClick={run(() => onDownload(target.path))}>Download</button>
    ),
  ].filter(Boolean) as ReactNode[]);

  const rendered = groups.filter((g) => g.length > 0);

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
        {rendered.map((group, i) => (
          <Fragment key={i}>
            {i > 0 && <div className="notes-context-menu-divider" />}
            {group}
          </Fragment>
        ))}
      </div>
    </>,
    document.body,
  );
}
