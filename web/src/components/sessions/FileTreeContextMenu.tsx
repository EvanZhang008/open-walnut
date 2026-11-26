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
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
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

export function FileTreeContextMenu({
  target, onClose, onOpen, onOpenInNotes, onOpenInNewTab, onDownload, onReveal, canReveal,
  onNewFile, onNewFolder, onRename, onDuplicate, onDelete,
}: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** No trigger element: the menu hangs from the pointer (anchorPoint). */
  const noTriggerRef = useRef<HTMLElement | null>(null);
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

  // Measured after mount (the height depends on which items rendered), its left
  // edge on the pointer, flipped and capped to the viewport: a fixed element in
  // no scroll container would leave items off the bottom edge unreachable.
  const placement = useMenuPlacement(true, noTriggerRef, menuRef, { anchorPoint: target.point, align: 'start' });

  // The menu is the top layer: one Escape closes it alone, never also the Files
  // popup under it (2026-11-07), and a press outside closes it and is swallowed,
  // so it cannot also act on what it landed on.
  useOverlayLayer({ open: true, onClose: () => onClose(), refs: [menuRef] });

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

  // Sections (standard.md, Big menus: at most three bare rules, the danger row last): open and
  // reveal; create, rename and duplicate; copy; then Delete alone.
  const openGroup: ReactNode[] = [];
  if (isFile) {
    openGroup.push(...[
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

  if (canReveal && onReveal) {
    openGroup.push(
      <button key="finder" role="menuitem" onClick={run(() => onReveal(target.path, 'finder'))}>
        Reveal in Finder
      </button>,
    );
    if (isFile) {
      openGroup.push(
        <button key="defaultapp" role="menuitem" onClick={run(() => onReveal(target.path, 'app'))}>
          Open in default app
        </button>,
      );
    }
  }

  const createGroup: ReactNode[] = [];
  if (onNewFile) {
    createGroup.push(
      <button key="newfile" role="menuitem" onClick={run(() => onNewFile(createDir))}>New file…</button>,
    );
  }
  if (onNewFolder) {
    createGroup.push(
      <button key="newfolder" role="menuitem" onClick={run(() => onNewFolder(createDir))}>New folder…</button>,
    );
  }

  const deleteGroup: ReactNode[] = [];
  if (canMutate) {
    if (onRename) {
      createGroup.push(
        <button key="rename" role="menuitem" onClick={run(() => onRename(target.path))}>Rename…</button>,
      );
    }
    if (onDuplicate) {
      createGroup.push(
        <button key="duplicate" role="menuitem" onClick={run(() => onDuplicate(target.path))}>Duplicate</button>,
      );
    }
    if (onDelete) {
      deleteGroup.push(
        <button key="delete" role="menuitem" className="danger" onClick={run(() => onDelete(target.path, target.type))}>
          Delete
        </button>,
      );
    }
  }
  // Directories lead with creation (that's what a folder's menu is mostly for);
  // a file leads with its open actions and gets creation lower down.
  if (isFile) groups.push(openGroup, createGroup);
  else groups.push(createGroup, openGroup);

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

  groups.push(deleteGroup);
  const rendered = groups.filter((g) => g.length > 0);

  // No backdrop: the overlay layer closes it on a press outside. A right-click
  // on another row closes this one and opens that row's.
  return createPortal(
    <div
      className="notes-context-menu file-ctx-menu wn-overlay wn-menu"
      ref={menuRef}
      // The layer is the family's (wn-overlay); a capped menu scrolls inside.
      style={{ ...menuPlacementStyle(placement), zIndex: undefined, overflowY: 'auto' }}
      role="menu"
      data-testid="file-ctx-menu"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {rendered.map((group, i) => (
        <Fragment key={i}>
          {i > 0 && <div className="notes-context-menu-divider" />}
          {group}
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}
