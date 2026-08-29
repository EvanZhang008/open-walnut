/**
 * Multi-tab strip rendered ABOVE the editor pane (inside `.notes-editor-pane`,
 * not the tree). Obsidian/browser-style tabs: each shows the note basename + a
 * close (×); a trailing '+' opens a fresh tab (empty state / Cmd+K).
 *
 * Presentational only — all tab state (open/active/close semantics, persistence,
 * the single `useNoteContent` driven by the active path) lives in NotesPage.tsx
 * (§1.1). Tabs are keyed by `path` (not array index) so reorder/close never
 * mis-renders an inactive row.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { ICON_CLOSE } from '@/components/common/Icons';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { revealNote } from '@/api/notes-v2';
import { copyTextDeferred } from '@/utils/clipboard';
import { log } from '@/utils/log';

export type TabKind = 'note' | 'attachment';

export interface OpenTab {
  /** Vault-relative path WITH .md for notes; attachment path for attachments. Identity/dedupe key. */
  path: string;
  /** 'note' → markdown editor; 'attachment' → AttachmentPreview. Decided at open time. */
  kind: TabKind;
}

interface NotesTabStripProps {
  tabs: OpenTab[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onNewTab: () => void;
  /**
   * Right-aligned controls pinned to the END of the strip (currently the AI-pane
   * toggle). They live HERE rather than as an absolutely-positioned overlay on the
   * editor pane so they occupy real layout space and can never cover the note's
   * own header/content.
   */
  trailing?: ReactNode;
  /** Right-click menu — close the other tabs / every tab (all optional: the
   *  menu simply drops the rows whose handler wasn't supplied). */
  onCloseOthers?: (path: string) => void;
  onCloseAll?: () => void;
  /** Select + scroll the tab's note into view in the tree ("Reveal in tree"). */
  onLocate?: (path: string) => void;
  /** Pop the note out into its own window. */
  onOpenInNewWindow?: (path: string) => void;
  isFavorite?: (path: string) => boolean;
  onToggleFavorite?: (path: string) => void;
}

/** Vault-relative path → Obsidian-style tab label (basename, no .md). */
function tabLabel(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/, '');
}

export function NotesTabStrip({
  tabs, activePath, onActivate, onClose, onNewTab, trailing,
  onCloseOthers, onCloseAll, onLocate, onOpenInNewWindow, isFavorite, onToggleFavorite,
}: NotesTabStripProps) {
  const activeRef = useRef<HTMLDivElement>(null);
  const menu = useContextMenu<OpenTab>();

  // Keep the active tab visible when activated (the strip scrolls horizontally on overflow).
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activePath]);

  /**
   * "Copy full path" / "Reveal in Finder" need the ABSOLUTE path, which only the
   * server knows (the tab holds a vault-relative one). Same pattern as the tree:
   * hand the clipboard a promise minted inside the gesture (copyTextDeferred) —
   * awaiting the round trip first voids the user activation in WKWebView (the Mac
   * app) and every copy fails.
   */
  const revealTab = (path: string, mode: 'finder' | 'app' | 'vscode') => {
    revealNote(path, mode).catch((err) => {
      log.warn('notes', 'tab reveal failed', { path, mode, error: err instanceof Error ? err.message : String(err) });
    });
  };

  const buildItems = (tab: OpenTab): ContextMenuItem[] => {
    const isNote = tab.kind === 'note';
    const others = tabs.length > 1;
    return [
      { key: 'close', label: 'Close', onSelect: () => onClose(tab.path) },
      { key: 'close-others', label: 'Close others', when: !!onCloseOthers && others, onSelect: () => onCloseOthers?.(tab.path) },
      { key: 'close-all', label: 'Close all', when: !!onCloseAll, onSelect: () => onCloseAll?.() },
      { divider: true },
      { key: 'locate', label: 'Reveal in tree', when: !!onLocate, onSelect: () => onLocate?.(tab.path) },
      {
        key: 'popout', label: 'Open in new window',
        when: !!onOpenInNewWindow && isNote,
        onSelect: () => onOpenInNewWindow?.(tab.path),
      },
      {
        key: 'favorite',
        label: isFavorite?.(tab.path) ? 'Remove bookmark' : 'Bookmark',
        when: !!onToggleFavorite && isNote,
        onSelect: () => onToggleFavorite?.(tab.path),
      },
      { divider: true },
      {
        key: 'copy-vault-path', label: 'Copy vault path', title: tab.path,
        onSelect: () => { void copyTextDeferred(Promise.resolve(tab.path)); },
      },
      {
        key: 'copy-path', label: 'Copy full path',
        onSelect: () => { void copyTextDeferred(revealNote(tab.path, 'path')); },
      },
      { key: 'finder', label: 'Reveal in Finder', onSelect: () => revealTab(tab.path, 'finder') },
      { key: 'vscode', label: 'Open in VS Code', onSelect: () => revealTab(tab.path, 'vscode') },
      {
        key: 'default-app', label: 'Open in default app', when: !isNote,
        onSelect: () => revealTab(tab.path, 'app'),
      },
    ];
  };

  return (
    <div className="notes-tab-strip" role="tablist">
      {tabs.map((tab) => {
        const isActive = tab.path === activePath;
        return (
          <div
            key={tab.path}
            ref={isActive ? activeRef : undefined}
            className={`notes-tab ${isActive ? 'active' : ''} ${tab.kind === 'attachment' ? 'attachment' : ''}`}
            role="tab"
            aria-selected={isActive}
            title={tab.path}
            onClick={() => onActivate(tab.path)}
            // Middle-click closes (browser convention).
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(tab.path); } }}
            // A tab is an app object: the browser's own menu ("Back / Reload /
            // Inspect Element" in the Mac app) says nothing about this note.
            onContextMenu={(e) => menu.open(e, tab)}
          >
            <span className="notes-tab-label">{tabLabel(tab.path)}</span>
            <button
              className="notes-tab-close"
              aria-label={`Close ${tabLabel(tab.path)}`}
              title="Close tab"
              // stopPropagation so × doesn't also activate the tab.
              onClick={(e) => { e.stopPropagation(); onClose(tab.path); }}
            >
              {ICON_CLOSE}
            </button>
          </div>
        );
      })}
      <button className="notes-tab-new" aria-label="New tab" title="New tab" onClick={onNewTab}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <line x1="8" y1="3" x2="8" y2="13" />
          <line x1="3" y1="8" x2="13" y2="8" />
        </svg>
      </button>
      {trailing && <div className="notes-tab-trailing">{trailing}</div>}
      {menu.state && (
        <ContextMenu
          point={menu.state.point}
          items={buildItems(menu.state.payload)}
          onClose={menu.close}
          ariaLabel={`Tab actions for ${tabLabel(menu.state.payload.path)}`}
          testId="notes-tab-ctx-menu"
        />
      )}
    </div>
  );
}
