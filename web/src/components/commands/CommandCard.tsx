import { useMemo, useRef, useState } from 'react';
import type { CommandDef } from '@/api/commands';
import { stripMarkdown } from '../../../../src/core/boards/board-summary-text';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';

interface CommandCardProps {
  command: CommandDef;
  onEdit: (cmd: CommandDef) => void;
  onDelete: (name: string) => void;
}

const SUMMARY_MAX_CHARS = 240;

/**
 * The card's preview: the prompt as plain sentences (a heading reads `Heading: ...`, no `#`, `*` or
 * code fences), cut at a word near SUMMARY_MAX_CHARS. The raw markdown shows only in the opened
 * card (2026-11-22, the UI audit: the preview showed `## Instructions` as typed).
 */
export function commandSummary(content: string): { text: string; cut: boolean } {
  const plain = stripMarkdown(content);
  if (plain.length <= SUMMARY_MAX_CHARS) return { text: plain, cut: false };
  const head = plain.slice(0, SUMMARY_MAX_CHARS);
  const space = head.lastIndexOf(' ');
  return { text: `${(space > SUMMARY_MAX_CHARS / 2 ? head.slice(0, space) : head).replace(/[\s.,;:]+$/, '')}...`, cut: true };
}

/** Where a command comes from, in the words the card and the page's filter both use. */
export const COMMAND_SOURCE_LABEL: Record<CommandDef['source'], string> = {
  builtin: 'Built-in',
  user: 'Custom',
  plugin: 'Plugin',
};

export function CommandCard({ command, onEdit, onDelete }: CommandCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = () => { setConfirmDelete(false); setMenuOpen(false); };
  // The menu and its confirm close as every menu does: Escape (focus back on ⋮) or a press outside.
  useOverlayLayer({
    open: menuOpen || confirmDelete, refs: [wrapRef], passOutsideClick: true,
    onClose: (reason) => { close(); if (reason === 'escape') btnRef.current?.focus({ preventScroll: true }); },
  });
  // Built-in and plugin commands both live outside ~/.open-walnut/commands/ — the API
  // answers 403 for either, so don't offer an Edit/Delete affordance that can only fail.
  const isReadOnly = command.source === 'builtin' || command.source === 'plugin';
  const summary = useMemo(() => commandSummary(command.content), [command.content]);
  // The full prompt adds something when the preview is cut or reads differently from the source.
  const hasMore = summary.cut || summary.text !== command.content.trim();

  return (
    <div className="cmd-card card">
      <div className="cmd-card-header">
        <div className="cmd-card-info">
          <div className="cmd-card-name-row">
            <code className="cmd-card-name">/{command.name}</code>
            <span className={`cmd-source-badge ${isReadOnly ? 'badge builtin' : 'badge badge-accent user'}`}>
              <span>{COMMAND_SOURCE_LABEL[command.source] ?? command.source}</span>
            </span>
          </div>
          {command.description && (
            <span className="cmd-card-desc text-sm text-muted">{command.description}</span>
          )}
        </div>
        {!isReadOnly && (
          <div className="cmd-card-actions">
            <div className="cmd-menu-wrapper" ref={wrapRef}>
              <button
                ref={btnRef}
                className="btn btn-sm btn-icon cmd-menu-btn"
                onClick={() => { setMenuOpen(!menuOpen); setConfirmDelete(false); }}
                title="Actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen || confirmDelete}
              >
                &#8942;
              </button>
              {menuOpen && !confirmDelete && (
                <div className="cmd-menu wn-overlay wn-menu" role="menu">
                  <button className="cmd-menu-item" role="menuitem" onClick={() => { onEdit(command); setMenuOpen(false); }}>
                    Edit
                  </button>
                  <button className="cmd-menu-item cmd-menu-danger" role="menuitem" onClick={() => setConfirmDelete(true)}>
                    Delete
                  </button>
                </div>
              )}
              {confirmDelete && (
                <div className="cmd-confirm-popover wn-overlay" role="dialog" aria-label={`Delete /${command.name}?`}>
                  <p className="cmd-confirm-text">Delete /{command.name}?</p>
                  <div className="cmd-confirm-actions">
                    <button className="btn btn-sm" onClick={close}>
                      Cancel
                    </button>
                    <button className="btn btn-sm btn-primary btn-danger" onClick={() => { onDelete(command.name); close(); }}>
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {expanded ? (
        <div className="cmd-card-content expanded">
          <pre className="cmd-card-pre">{command.content}</pre>
        </div>
      ) : summary.text && (
        <p className="cmd-card-summary">{summary.text}</p>
      )}
      {hasMore && (
        <button className="btn btn-sm btn-ghost cmd-expand-btn" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          <span className={`cmd-expand-chevron${expanded ? ' rotated' : ''}`}>&#9660;</span>
          {expanded ? 'Hide the full prompt' : 'Show the full prompt'}
        </button>
      )}
    </div>
  );
}
