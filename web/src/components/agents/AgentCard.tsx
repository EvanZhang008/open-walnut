import { useState } from 'react';
import type { AgentDefinition } from '@/api/agents';

interface AgentCardProps {
  agent: AgentDefinition;
  onEdit: (agent: AgentDefinition) => void;
  onClone: (agent: AgentDefinition) => void;
  onDelete: (id: string) => void;
  onReset?: (id: string) => void;
}

function badgeInfo(agent: AgentDefinition): { label: string; className: string }[] {
  if (agent.overrides_builtin) return [
    { label: 'builtin', className: 'agent-badge agent-badge-builtin' },
    { label: 'override', className: 'agent-badge agent-badge-override' },
  ];
  if (agent.source === 'builtin') return [{ label: 'builtin', className: 'agent-badge agent-badge-builtin' }];
  return [{ label: 'config', className: 'agent-badge agent-badge-config' }];
}

function toolSummary(agent: AgentDefinition): string {
  if (agent.allowed_tools?.length) return `${agent.allowed_tools.length} tools (allow)`;
  if (agent.denied_tools?.length) return `${agent.denied_tools.length} denied`;
  return 'all tools';
}

export function AgentCard({ agent, onEdit, onClone, onDelete, onReset }: AgentCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'delete' | 'reset' | null>(null);

  const isOverride = !!agent.overrides_builtin;
  const isBuiltin = agent.source === 'builtin';
  const isConfigOnly = agent.source === 'config' && !isOverride;

  const badges = badgeInfo(agent);

  return (
    <div className="agent-card card">
      <div className="agent-card-header">
        <div className="agent-card-title-row">
          {badges.map((b) => <span key={b.label} className={b.className}>{b.label}</span>)}
          <span className="agent-card-name">{agent.name}</span>
          {isBuiltin && <span className="agent-card-lock" title="Builtin (read-only)">&#128274;</span>}
          <span className="agent-card-id text-muted font-mono">{agent.id}</span>
        </div>
        <div className="agent-card-actions">
          <div className="agent-menu-wrapper">
            <button
              className="btn btn-sm agent-menu-btn"
              onClick={() => { setMenuOpen(!menuOpen); setConfirmAction(null); }}
              title="Actions"
            >
              &#8942;
            </button>
            {menuOpen && !confirmAction && (
              <div className="agent-menu" onMouseLeave={() => setMenuOpen(false)}>
                <button className="agent-menu-item" onClick={() => { onEdit(agent); setMenuOpen(false); }}>
                  Edit
                </button>
                <button className="agent-menu-item" onClick={() => { onClone(agent); setMenuOpen(false); }}>
                  Clone
                </button>
                {isOverride && onReset && (
                  <button className="agent-menu-item" onClick={() => setConfirmAction('reset')}>
                    Reset to Default
                  </button>
                )}
                {isConfigOnly && (
                  <button className="agent-menu-item agent-menu-danger" onClick={() => setConfirmAction('delete')}>
                    Delete
                  </button>
                )}
              </div>
            )}
            {confirmAction && (
              <div className="agent-confirm-popover" onMouseLeave={() => { setConfirmAction(null); setMenuOpen(false); }}>
                <p className="agent-confirm-text">
                  {confirmAction === 'delete' ? 'Delete this agent?' : 'Reset to builtin default?'}
                </p>
                <div className="agent-confirm-actions">
                  <button className="btn btn-sm agent-confirm-cancel" onClick={() => { setConfirmAction(null); setMenuOpen(false); }}>
                    Cancel
                  </button>
                  <button
                    className={`btn btn-sm ${confirmAction === 'delete' ? 'agent-confirm-delete' : 'agent-confirm-reset'}`}
                    onClick={() => {
                      if (confirmAction === 'delete') onDelete(agent.id);
                      else if (onReset) onReset(agent.id);
                      setConfirmAction(null);
                      setMenuOpen(false);
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
        <span>{agent.runner}</span>
        <span>{agent.model ? agent.model.split('/').pop()?.slice(0, 30) : 'default model'}</span>
        <span>{agent.max_tool_rounds ?? 10} rounds</span>
        <span>{toolSummary(agent)}</span>
        {agent.skills && agent.skills.length > 0 && (
          <span>{agent.skills.length} skill{agent.skills.length !== 1 ? 's' : ''}</span>
        )}
        {agent.stateful && <span className="agent-badge-stateful">stateful</span>}
      </div>
    </div>
  );
}
