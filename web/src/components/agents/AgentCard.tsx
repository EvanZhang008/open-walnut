import { useRef, useState } from 'react';
import type { AgentDefinition } from '@/api/agents';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';

interface AgentCardProps {
  agent: AgentDefinition;
  onEdit: (agent: AgentDefinition) => void;
  onClone: (agent: AgentDefinition) => void;
  onDelete: (id: string) => void;
  onReset?: (id: string) => void;
}

function badgeInfo(agent: AgentDefinition): { label: string; className: string }[] {
  // Home chat vs background kind, visible even in the "All" filter. 'general' is always a home chat agent.
  const isConsole = agent.id === 'general' || agent.console === true;
  const kindBadge = isConsole
    ? { label: 'home chat', className: 'badge agent-badge agent-badge-console' }
    : { label: 'background', className: 'badge agent-badge agent-badge-background' };
  if (agent.overrides_builtin) return [
    kindBadge,
    { label: 'built-in', className: 'badge agent-badge agent-badge-builtin' },
    { label: 'edited', className: 'badge badge-accent agent-badge agent-badge-override' },
  ];
  if (agent.source === 'builtin') return [kindBadge, { label: 'built-in', className: 'badge agent-badge agent-badge-builtin' }];
  return [kindBadge, { label: 'custom', className: 'badge agent-badge agent-badge-config' }];
}

export function AgentCard({ agent, onEdit, onClone, onDelete, onReset }: AgentCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'delete' | 'reset' | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = () => { setConfirmAction(null); setMenuOpen(false); };
  // The menu and its confirm close as every menu does: Escape (focus back on ⋮) or a press outside.
  useOverlayLayer({
    open: menuOpen || confirmAction !== null, refs: [wrapRef], passOutsideClick: true,
    onClose: (reason) => { close(); if (reason === 'escape') btnRef.current?.focus({ preventScroll: true }); },
  });

  const isOverride = !!agent.overrides_builtin;
  const isBuiltin = agent.source === 'builtin';
  const isConfigOnly = agent.source === 'config' && !isOverride;

  const badges = badgeInfo(agent);

  return (
    <div className="agent-card card" data-agent-id={agent.id}>
      <div className="agent-card-header">
        <div className="agent-card-title-row">
          {badges.map((b) => <span key={b.label} className={b.className}>{b.label}</span>)}
          {/* The id is for an agent (its config key), never visible text; the hover keeps it findable. */}
          <span className="agent-card-name" title={`Agent id: ${agent.id}`}>{agent.name}</span>
          {isBuiltin && <span className="agent-card-lock" title="Built-in: editing saves your own version, and Reset to Default brings the original back">&#128274;</span>}
        </div>
        <div className="agent-card-actions">
          <div className="agent-menu-wrapper" ref={wrapRef}>
            <button
              ref={btnRef}
              className="btn btn-sm btn-icon btn-ghost agent-menu-btn"
              onClick={() => { setMenuOpen(!menuOpen); setConfirmAction(null); }}
              title="Actions"
              aria-label="Actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen || confirmAction !== null}
            >
              &#8942;
            </button>
            {menuOpen && !confirmAction && (
              <div className="agent-menu wn-overlay wn-menu" role="menu">
                <button className="agent-menu-item" role="menuitem" onClick={() => { onEdit(agent); setMenuOpen(false); }}>
                  Edit
                </button>
                <button className="agent-menu-item" role="menuitem" onClick={() => { onClone(agent); setMenuOpen(false); }}>
                  Clone
                </button>
                {isOverride && onReset && (
                  <button className="agent-menu-item" role="menuitem" onClick={() => setConfirmAction('reset')}>
                    Reset to Default
                  </button>
                )}
                {isConfigOnly && (
                  <button className="agent-menu-item agent-menu-danger" role="menuitem" onClick={() => setConfirmAction('delete')}>
                    Delete
                  </button>
                )}
              </div>
            )}
            {confirmAction && (
              <div className="agent-confirm-popover wn-overlay" role="dialog" aria-label={confirmAction === 'delete' ? 'Delete this agent?' : 'Reset to the built-in version?'}>
                <p className="agent-confirm-text">
                  {confirmAction === 'delete' ? 'Delete this agent?' : 'Reset to the built-in version?'}
                </p>
                <div className="agent-confirm-actions">
                  <button className="btn btn-sm" onClick={close}>
                    Cancel
                  </button>
                  <button
                    className={`btn btn-sm ${confirmAction === 'delete' ? 'agent-confirm-delete' : 'agent-confirm-reset'}`}
                    onClick={() => {
                      if (confirmAction === 'delete') onDelete(agent.id);
                      else if (onReset) onReset(agent.id);
                      close();
                    }}
                  >
                    {confirmAction === 'delete' ? 'Delete' : 'Reset'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {agent.description && (
        <div className="agent-card-desc text-sm text-muted">{agent.description}</div>
      )}
      <div className="agent-card-meta text-xs text-muted">
        <span>{agent.system_prompt?.trim() ? 'custom prompt' : 'default prompt'}</span>
        {(() => {
          const n = (agent.context_sources ?? []).filter((c) => c.enabled).length;
          return n > 0 ? <span>{n} context source{n !== 1 ? 's' : ''}</span> : null;
        })()}
      </div>
    </div>
  );
}
