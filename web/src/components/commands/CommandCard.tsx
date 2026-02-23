import { useState } from 'react';
import type { CommandDef } from '@/api/commands';

interface CommandCardProps {
  command: CommandDef;
  onEdit: (cmd: CommandDef) => void;
  onDelete: (name: string) => void;
}

const COLLAPSED_MAX_CHARS = 200;

export function CommandCard({ command, onEdit, onDelete }: CommandCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isBuiltin = command.source === 'builtin';
  const isLong = command.content.length > COLLAPSED_MAX_CHARS;

  return (
    <div className="cmd-card card">
      <div className="cmd-card-header">
        <div className="cmd-card-info">
          <div className="cmd-card-name-row">
            <code className="cmd-card-name">/{command.name}</code>
            <span className={`cmd-source-badge ${isBuiltin ? 'builtin' : 'user'}`}>
              {command.source}
            </span>
          </div>
          {command.description && (
            <span className="cmd-card-desc text-sm text-muted">{command.description}</span>
          )}
        </div>
        {!isBuiltin && (
          <div className="cmd-card-actions">
            <div className="cmd-menu-wrapper">
              <button
                className="btn btn-sm cmd-menu-btn"
                onClick={() => { setMenuOpen(!menuOpen); setConfirmDelete(false); }}
                title="Actions"
              >
                &#8942;
              </button>
              {menuOpen && !confirmDelete && (
                <div className="cmd-menu" onMouseLeave={() => setMenuOpen(false)}>
                  <button className="cmd-menu-item" onClick={() => { onEdit(command); setMenuOpen(false); }}>
                    Edit
                  </button>
                  <button className="cmd-menu-item cmd-menu-danger" onClick={() => setConfirmDelete(true)}>
                    Delete
                  </button>
                </div>
              )}
              {confirmDelete && (
                <div className="cmd-confirm-popover" onMouseLeave={() => { setConfirmDelete(false); setMenuOpen(false); }}>
                  <p className="cmd-confirm-text">Delete /{command.name}?</p>
                  <div className="cmd-confirm-actions">
                    <button className="btn btn-sm" onClick={() => { setConfirmDelete(false); setMenuOpen(false); }}>
                      Cancel
                    </button>
                    <button className="btn btn-sm cmd-confirm-delete" onClick={() => { onDelete(command.name); setConfirmDelete(false); setMenuOpen(false); }}>
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <div className={`cmd-card-content${expanded ? ' expanded' : ''}`}>
        <pre className="cmd-card-pre">
          {expanded ? command.content : command.content.slice(0, COLLAPSED_MAX_CHARS)}{!expanded && isLong ? '...' : ''}
        </pre>
      </div>
      {isLong && (
        <button className="cmd-expand-btn" onClick={() => setExpanded(!expanded)}>
          <span className={`cmd-expand-chevron${expanded ? ' rotated' : ''}`}>&#9660;</span>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
