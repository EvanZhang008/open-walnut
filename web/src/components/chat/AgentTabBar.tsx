/**
 * AgentTabBar — ONE combined button + ONE "+" button (user-picked design #3).
 *
 * Layout:  [ (● agent-chip)  Conversation Title ▾ ]  [+]
 *
 *   - The single trigger shows BOTH the active agent (as a small tinted chip)
 *     and the active conversation title. Double-click renames (not Main).
 *   - Clicking it opens a two-pane dropdown: LEFT lists agents (click = switch
 *     agent; hover reveals + new-chat and eye visibility), RIGHT lists the
 *     active agent's conversations — search, Main (bold, undeletable), Pinned,
 *     then Today / This week / Older with hover pin/delete, and a
 *     "+ New conversation" row at the bottom.
 *   - "+ New agent…" lives at the bottom of the left pane; its form renders in
 *     the right pane (wider), alongside the "create by chat" alternative.
 *   - Trailing "+" starts a new conversation under the active agent.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { AgentDefinition } from '@/api/agents';
import type { ConversationMeta } from '@/api/conversations';

interface AgentTabBarProps {
  agents: AgentDefinition[];
  activeAgentId: string;
  onSwitchAgent: (agentId: string) => void;
  conversations: ConversationMeta[];
  activeConversationId: string | null;
  onSwitchConversation: (conversationId: string) => void;
  onNewConversation: () => void;
  /** New conversation under a SPECIFIC agent (left pane's per-row ＋). */
  onNewConversationForAgent?: (agentId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
  /** Pin/unpin — pinned conversations get their own dropdown section. */
  onTogglePin?: (conversationId: string) => void;
  onCreateAgent: (name: string, description: string, systemPrompt?: string) => void;
  onCreateAgentByChat: () => void;
  onToggleAgentVisibility: (agentId: string, visible: boolean) => void;
}

/** Time bucket for the conversation dropdown (by lastMessageAt). */
function historyGroup(iso: string): 'Today' | 'This week' | 'Older' {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'Older';
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= startOfDay) return 'Today';
  if (t >= startOfDay - 6 * 86_400_000) return 'This week';
  return 'Older';
}

/** Line-icon set (stroke currentColor, matching the app's SVG icons — no emoji). */
function PinIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

function EyeIcon({ size = 12, off = false }: { size?: number; off?: boolean }) {
  return off ? (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Slugify a name into a stable agent id (lowercase, dashes, alnum only). */
export function slugifyAgentId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'agent';
}

export function AgentTabBar(props: AgentTabBarProps) {
  const {
    agents, activeAgentId, onSwitchAgent,
    conversations, activeConversationId, onSwitchConversation,
    onNewConversation, onNewConversationForAgent,
    onDeleteConversation, onRenameConversation, onTogglePin,
    onCreateAgent, onCreateAgentByChat, onToggleAgentVisibility,
  } = props;

  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentDesc, setNewAgentDesc] = useState('');
  const [newAgentPrompt, setNewAgentPrompt] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const activeAgentName = activeAgent?.name ?? activeAgentId;

  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const activeConvLabel = activeConv?.isMain ? 'Main' : (activeConv?.title ?? 'Main');

  // Right pane sections: Main pinned at the top, then Pinned, then the rest
  // time-grouped (Today / This week / Older). Search filters all of it.
  const menuSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (c: ConversationMeta) =>
      !q || (c.isMain ? 'main' : c.title.toLowerCase()).includes(q);
    const main = conversations.filter((c) => c.isMain && match(c));
    const pinned = conversations.filter((c) => !c.isMain && c.pinned && match(c));
    const rest = conversations.filter((c) => !c.isMain && !c.pinned && match(c));
    const groups: Record<string, ConversationMeta[]> = {};
    for (const c of rest) {
      const g = historyGroup(c.lastMessageAt || c.createdAt);
      (groups[g] ??= []).push(c);
    }
    const sections: Array<{ label: string | null; items: ConversationMeta[] }> = [];
    if (main.length) sections.push({ label: null, items: main });
    if (pinned.length) sections.push({ label: 'Pinned', items: pinned });
    for (const g of ['Today', 'This week', 'Older'] as const) {
      if (groups[g]?.length) sections.push({ label: g, items: groups[g] });
    }
    return sections;
  }, [conversations, query]);

  // Close the dropdown on outside click; reset search + new-agent form on close.
  useEffect(() => {
    if (!menuOpen) {
      setQuery('');
      setShowNewAgent(false);
      setNewAgentName('');
      setNewAgentDesc('');
      setNewAgentPrompt('');
      return;
    }
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const submitNewAgent = useCallback(() => {
    const name = newAgentName.trim();
    if (!name) return;
    onCreateAgent(name, newAgentDesc.trim(), newAgentPrompt.trim() || undefined);
    setShowNewAgent(false);
    setNewAgentName('');
    setNewAgentDesc('');
    setNewAgentPrompt('');
    setMenuOpen(false);
  }, [newAgentName, newAgentDesc, newAgentPrompt, onCreateAgent]);

  const commitRename = useCallback((cid: string) => {
    const title = renameValue.trim();
    if (title) onRenameConversation(cid, title);
    setRenamingId(null);
    setRenameValue('');
  }, [renameValue, onRenameConversation]);

  return (
    <div className="agent-tab-bar">
      {/* ── The ONE trigger: agent chip + conversation title ── */}
      <div className="agent-tab-combo-wrap" ref={wrapRef}>
        {renamingId && activeConv && renamingId === activeConv.id ? (
          <input
            autoFocus
            className="agent-tab-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename(renamingId);
              if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); }
            }}
            onBlur={() => commitRename(renamingId)}
          />
        ) : (
          <button
            className={`agent-tab agent-tab-combo${menuOpen ? ' open' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            // Main is the agent's fixed thread — never renameable.
            onDoubleClick={activeConv && !activeConv.isMain
              ? () => { setMenuOpen(false); setRenamingId(activeConv.id); setRenameValue(activeConv.title); }
              : undefined}
            title={activeConv?.isMain
              ? `${activeAgentName} / Main — receives notifications & cron. Click to switch.`
              : `${activeAgentName} / ${activeConvLabel} — click to switch, double-click to rename`}
          >
            <span className="agent-combo-chip">
              <span className="agent-tab-dot" />
              <span className="agent-combo-chip-name">{activeAgentName}</span>
            </span>
            <span className="agent-tab-conv-title">{activeConvLabel}</span>
            <span className="agent-tab-caret">▾</span>
          </button>
        )}

        {menuOpen && (
          <div style={comboPopoverStyle}>
            {/* ── LEFT pane: agents ── */}
            <div style={leftPaneStyle}>
              {agents.map((agent) => {
                const isActive = agent.id === activeAgentId;
                const visible = agent.console !== false;
                const isGeneral = agent.id === 'general';
                return (
                  <div key={agent.id} style={agentRowStyle(isActive)} className="agent-dd-row">
                    <button
                      onClick={() => { if (!isActive) onSwitchAgent(agent.id); setShowNewAgent(false); }}
                      style={rowMainBtnStyle(isActive)}
                      title={agent.description}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: isActive ? 'var(--accent)' : 'var(--fg-muted)', display: 'inline-block', flexShrink: 0 }} />
                      <span style={ellipsisStyle}>{agent.name}</span>
                    </button>
                    {/* Per-agent ＋ — jump to this agent AND open a fresh conversation. */}
                    {onNewConversationForAgent && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onNewConversationForAgent(agent.id); setMenuOpen(false); }}
                        style={iconBtnStyle}
                        className="agent-dd-hover-btn"
                        title={`New chat with ${agent.name}`}
                        aria-label={`New chat with ${agent.name}`}
                      >
                        +
                      </button>
                    )}
                    {/* Eye toggle — can't hide 'general' */}
                    {!isGeneral && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onToggleAgentVisibility(agent.id, !visible); }}
                        style={iconBtnStyle}
                        className="agent-dd-hover-btn"
                        title={visible ? 'Hide from console' : 'Show in console'}
                        aria-label={visible ? 'Hide agent' : 'Show agent'}
                      >
                        <EyeIcon off={visible} />
                      </button>
                    )}
                  </div>
                );
              })}
              <button onClick={() => setShowNewAgent(true)} style={addRowStyle}>
                + New agent…
              </button>
            </div>

            {/* ── RIGHT pane: the active agent's conversations (or new-agent form) ── */}
            <div style={rightPaneStyle}>
              {showNewAgent ? (
                <div style={{ padding: '6px 4px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={sectionLabelStyle}>New agent</div>
                  <input
                    autoFocus
                    value={newAgentName}
                    onChange={(e) => setNewAgentName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitNewAgent(); if (e.key === 'Escape') setShowNewAgent(false); }}
                    placeholder="Agent name"
                    style={inputStyle}
                  />
                  <input
                    value={newAgentDesc}
                    onChange={(e) => setNewAgentDesc(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitNewAgent(); if (e.key === 'Escape') setShowNewAgent(false); }}
                    placeholder="Description (optional)"
                    style={inputStyle}
                  />
                  {/* System prompt — Enter inserts a newline (multi-line field); submit via the button. */}
                  <textarea
                    value={newAgentPrompt}
                    onChange={(e) => setNewAgentPrompt(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') setShowNewAgent(false); }}
                    placeholder="System prompt (optional — blank = auto-generate)"
                    rows={3}
                    style={textareaStyle}
                  />
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button
                      onClick={() => { onCreateAgentByChat(); setMenuOpen(false); }}
                      style={{ ...ghostBtnStyle, marginRight: 'auto', border: 'none', color: 'var(--accent)' }}
                      title="Design & create an agent by chatting with Walnut"
                    >
                      Create by chat
                    </button>
                    <button onClick={() => setShowNewAgent(false)} style={ghostBtnStyle}>Cancel</button>
                    <button onClick={submitNewAgent} style={primaryBtnStyle} disabled={!newAgentName.trim()}>Create</button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ padding: '4px 4px 6px' }}>
                    <input
                      autoFocus
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Escape') setMenuOpen(false); }}
                      placeholder="Search conversations…"
                      style={inputStyle}
                    />
                  </div>
                  {menuSections.length === 0 && (
                    <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--fg-muted)' }}>
                      No matches
                    </div>
                  )}
                  {menuSections.map((group, gi) => (
                    <div key={group.label ?? `main-${gi}`}>
                      {group.label && <div style={sectionLabelStyle}>{group.label}</div>}
                      {group.items.map((conv) => {
                        const isActive = conv.id === activeConversationId;
                        return (
                          <div key={conv.id} style={convRowStyle(isActive)} className="agent-dd-row">
                            <button
                              onClick={() => { onSwitchConversation(conv.id); setMenuOpen(false); }}
                              style={rowMainBtnStyle(isActive)}
                              title={conv.isMain ? 'Main — receives notifications & cron. Can\'t be renamed or deleted.' : conv.title}
                            >
                              {conv.pinned && !conv.isMain && <span style={{ flexShrink: 0, display: 'inline-flex', color: 'var(--fg-muted)' }}><PinIcon size={11} /></span>}
                              <span style={{ ...ellipsisStyle, fontWeight: conv.isMain ? 600 : undefined }}>
                                {conv.isMain ? 'Main' : conv.title}
                              </span>
                            </button>
                            {!conv.isMain && onTogglePin && (
                              <button
                                onClick={(e) => { e.stopPropagation(); onTogglePin(conv.id); }}
                                style={iconBtnStyle}
                                className="agent-dd-hover-btn"
                                title={conv.pinned ? 'Unpin' : 'Pin'}
                                aria-label={conv.pinned ? 'Unpin conversation' : 'Pin conversation'}
                              >
                                <PinIcon />
                              </button>
                            )}
                            {/* Main conversation can't be deleted (it owns notifications & cron). */}
                            {!conv.isMain && (
                              <button
                                onClick={(e) => { e.stopPropagation(); onDeleteConversation(conv.id); }}
                                style={iconBtnStyle}
                                className="agent-dd-hover-btn"
                                title="Delete conversation"
                                aria-label="Delete conversation"
                              >
                                {'×'}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  <button
                    onClick={() => { onNewConversation(); setMenuOpen(false); }}
                    style={addRowStyle}
                  >
                    + New conversation
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <button
        className="agent-tab-new"
        onClick={onNewConversation}
        title="New conversation"
        aria-label="New conversation"
      >
        +
      </button>
    </div>
  );
}

// ── Inline styles for the two-pane popover (CSS vars, matching the app chrome) ──

const comboPopoverStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  display: 'flex',
  width: 430,
  maxWidth: 'min(430px, calc(100vw - 32px))',
  maxHeight: 420,
  background: 'var(--bg-elevated, var(--bg))',
  border: '1px solid var(--border)',
  borderRadius: 10,
  boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
  zIndex: 1000,
  overflow: 'hidden',
};

const leftPaneStyle: React.CSSProperties = {
  width: 132,
  flexShrink: 0,
  overflowY: 'auto',
  background: 'var(--bg-secondary)',
  borderRight: '1px solid var(--border)',
  padding: '6px 4px',
};

const rightPaneStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflowY: 'auto',
  padding: '6px 4px',
};

const sectionLabelStyle: React.CSSProperties = {
  padding: '4px 12px',
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--fg-muted)',
};

function agentRowStyle(isActive: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    padding: '0 2px 0 8px',
    borderRadius: 7,
    background: isActive ? 'var(--bg-elevated, var(--bg))' : 'transparent',
    boxShadow: isActive ? '0 1px 3px rgba(0,0,0,0.08)' : undefined,
  };
}

function convRowStyle(isActive: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    padding: '0 6px 0 8px',
    borderRadius: 7,
    background: isActive ? 'var(--accent-subtle)' : 'transparent',
  };
}

function rowMainBtnStyle(isActive: boolean): React.CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 2px',
    border: 'none',
    background: 'transparent',
    color: isActive ? 'var(--fg)' : 'var(--fg-secondary)',
    fontSize: 13,
    fontWeight: isActive ? 600 : undefined,
    cursor: 'pointer',
    textAlign: 'left',
  };
}

const ellipsisStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
  minWidth: 0,
};

const iconBtnStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--fg-muted)',
  fontSize: 12,
  cursor: 'pointer',
  padding: '4px 5px',
  borderRadius: 4,
  flexShrink: 0,
  lineHeight: 1,
};

const addRowStyle: React.CSSProperties = {
  width: '100%',
  textAlign: 'left',
  padding: '6px 12px',
  border: 'none',
  background: 'transparent',
  color: 'var(--accent)',
  fontSize: 12,
  cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '4px 8px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: 12,
  boxSizing: 'border-box',
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  minHeight: 44,
  fontFamily: 'inherit',
  lineHeight: 1.4,
};

const ghostBtnStyle: React.CSSProperties = {
  padding: '3px 10px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--fg-secondary)',
  fontSize: 12,
  cursor: 'pointer',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '3px 10px',
  border: 'none',
  borderRadius: 6,
  background: 'var(--accent)',
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
};
