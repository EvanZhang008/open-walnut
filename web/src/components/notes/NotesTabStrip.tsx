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
}

/** Vault-relative path → Obsidian-style tab label (basename, no .md). */
function tabLabel(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/, '');
}

export function NotesTabStrip({ tabs, activePath, onActivate, onClose, onNewTab, trailing }: NotesTabStripProps) {
  const activeRef = useRef<HTMLDivElement>(null);

  // Keep the active tab visible when activated (the strip scrolls horizontally on overflow).
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activePath]);

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
    </div>
  );
}
