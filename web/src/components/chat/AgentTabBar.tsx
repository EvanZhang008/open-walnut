/**
 * AgentTabBar — ONE simple conversation dropdown, no horizontal tab strip.
 *
 * Layout:  [● Walnut ▾] | [current conversation ▾] [+]
 *
 *   - The "Walnut" tab shows the active agent; clicking it opens a small dropdown
 *     to switch agents / create a new one. Each agent row carries a ＋ that opens
 *     a NEW conversation directly under that agent.
 *   - The conversation trigger shows the ACTIVE conversation's title; clicking it
 *     opens the single dropdown: search, Main pinned at the top (undeletable),
 *     then 📌 Pinned, then Today / This week / Older. Rows switch on click and
 *     reveal pin/delete on hover. Double-click the trigger to rename (not Main).
 *   - Trailing "+" starts a new conversation.
 *
 * The dropdowns reuse the inline-style popover from the former AgentDropdown;
 * the trigger chrome is CSS-classed (see globals.css ".agent-tab-*").
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
  /** New conversation under a SPECIFIC agent (agent dropdown's per-row ＋). */
  onNewConversationForAgent?: (agentId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
  /** Pin/unpin — pinned conversations stay visible as tabs. */
  onTogglePin?: (conversationId: string) => void;
  onCreateAgent: (name: string, description: string, systemPrompt?: string) => void;
  onCreateAgentByChat: () => void;
  onToggleAgentVisibility: (agentId: string, visible: boolean) => void;
}

/** Time bucket for the History dropdown (by lastMessageAt). */
function historyGroup(iso: string): 'Today' | 'This week' | 'Older' {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'Older';
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= startOfDay) return 'Today';
  if (t >= startOfDay - 6 * 86_400_000) return 'This week';
  return 'Older';
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

  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentDesc, setNewAgentDesc] = useState('');
  const [newAgentPrompt, setNewAgentPrompt] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const agentWrapRef = useRef<HTMLDivElement>(null);
  const historyWrapRef = useRef<HTMLDivElement>(null);

  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const activeAgentName = activeAgent?.name ?? activeAgentId;

  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const activeConvLabel = activeConv?.isMain ? 'Main' : (activeConv?.title ?? 'Main');

  // Dropdown sections: Main pinned at the top, then 📌 Pinned, then the rest
  // time-grouped (Today / This week / Older). Search filters all of it.
  const menuSections = useMemo(() => {
    const q = historyQuery.trim().toLowerCase();
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
  }, [conversations, historyQuery]);

  // Close agent dropdown on outside click.
  useEffect(() => {
    if (!agentMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (agentWrapRef.current && !agentWrapRef.current.contains(e.target as Node)) {
        setAgentMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [agentMenuOpen]);

  // Close History dropdown on outside click; reset its search when it closes.
  useEffect(() => {
    if (!historyOpen) { setHistoryQuery(''); return; }
    const handler = (e: MouseEvent) => {
      if (historyWrapRef.current && !historyWrapRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [historyOpen]);

  // Reset the new-agent sub-form whenever the dropdown closes.
  useEffect(() => {
    if (!agentMenuOpen) {
      setShowNewAgent(false);
      setNewAgentName('');
      setNewAgentDesc('');
      setNewAgentPrompt('');
    }
  }, [agentMenuOpen]);

  const submitNewAgent = useCallback(() => {
    const name = newAgentName.trim();
    if (!name) return;
    onCreateAgent(name, newAgentDesc.trim(), newAgentPrompt.trim() || undefined);
    setShowNewAgent(false);
    setNewAgentName('');
    setNewAgentDesc('');
    setNewAgentPrompt('');
    setAgentMenuOpen(false);
  }, [newAgentName, newAgentDesc, newAgentPrompt, onCreateAgent]);

  const commitRename = useCallback((cid: string) => {
    const title = renameValue.trim();
    if (title) onRenameConversation(cid, title);
    setRenamingId(null);
    setRenameValue('');
  }, [renameValue, onRenameConversation]);

  return (
    <div className="agent-tab-bar">
      {/* ── Walnut tab — agent switcher ── */}
      <div className="agent-tab-walnut-wrap" ref={agentWrapRef}>
        <button
          className={`agent-tab agent-tab-walnut${agentMenuOpen ? ' open' : ''}`}
          onClick={() => setAgentMenuOpen((v) => !v)}
          title="Switch agent"
        >
          <span className="agent-tab-dot" />
          <span className="agent-tab-label">{activeAgentName}</span>
          <span className="agent-tab-caret">▾</span>
        </button>

        {agentMenuOpen && (
          <div style={popoverStyle}>
            <div style={sectionLabelStyle}>Agents</div>
            {agents.map((agent) => {
              const isActive = agent.id === activeAgentId;
              const visible = agent.console !== false;
              const isGeneral = agent.id === 'general';
              return (
                <div key={agent.id} style={rowStyle(isActive)} className="agent-dd-row">
                  <button
                    onClick={() => { onSwitchAgent(agent.id); setAgentMenuOpen(false); }}
                    style={rowMainBtnStyle(isActive)}
                    title={agent.description}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: isActive ? 'var(--accent)' : 'var(--fg-muted)', display: 'inline-block', flexShrink: 0 }} />
                    <span style={ellipsisStyle}>{agent.name}</span>
                  </button>
                  {/* Per-agent ＋ — jump to this agent AND open a fresh conversation. */}
                  {onNewConversationForAgent && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onNewConversationForAgent(agent.id); setAgentMenuOpen(false); }}
                      style={iconBtnStyle}
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
                      title={visible ? 'Hide from console' : 'Show in console'}
                      aria-label={visible ? 'Hide agent' : 'Show agent'}
                    >
                      {visible ? '\u{1F441}' : '\u{1F441}‍\u{1F5E8}'}{/* 👁 / 👁‍🗨 (struck) */}
                    </button>
                  )}
                </div>
              );
            })}

            {showNewAgent ? (
              <div style={{ padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
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
                  <button onClick={() => setShowNewAgent(false)} style={ghostBtnStyle}>Cancel</button>
                  <button onClick={submitNewAgent} style={primaryBtnStyle} disabled={!newAgentName.trim()}>Create</button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button onClick={() => setShowNewAgent(true)} style={{ ...addRowStyle, width: 'auto', flex: 1 }}>
                  + New Agent…
                </button>
                <button
                  onClick={() => { onCreateAgentByChat(); setAgentMenuOpen(false); }}
                  style={{ ...addRowStyle, width: 'auto', flexShrink: 0, paddingLeft: 8 }}
                  title="Design & create an agent by chatting with Walnut"
                >
                  Create by chat
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <span className="agent-tab-divider" />

      {/* ── ONE conversation dropdown — trigger shows the active conversation ── */}
      <div className="agent-tab-history-wrap" ref={historyWrapRef}>
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
            className={`agent-tab agent-tab-conv-trigger${historyOpen ? ' open' : ''}`}
            onClick={() => setHistoryOpen((v) => !v)}
            // Main is the agent's fixed thread — never renameable.
            onDoubleClick={activeConv && !activeConv.isMain
              ? () => { setHistoryOpen(false); setRenamingId(activeConv.id); setRenameValue(activeConv.title); }
              : undefined}
            title={activeConv?.isMain
              ? 'Main — receives notifications & cron. Click to switch conversation.'
              : `${activeConvLabel} — click to switch, double-click to rename`}
          >
            <span className="agent-tab-conv-title">{activeConvLabel}</span>
            <span className="agent-tab-caret">▾</span>
          </button>
        )}

        {historyOpen && (
          <div style={historyPopoverStyle}>
            <div style={{ padding: '4px 8px 6px' }}>
              <input
                autoFocus
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setHistoryOpen(false); }}
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
                    <div key={conv.id} style={rowStyle(isActive)} className="agent-dd-row">
                      <button
                        onClick={() => { onSwitchConversation(conv.id); setHistoryOpen(false); }}
                        style={rowMainBtnStyle(isActive)}
                        title={conv.isMain ? 'Main — receives notifications & cron. Can\'t be renamed or deleted.' : conv.title}
                      >
                        {conv.pinned && !conv.isMain && <span style={{ fontSize: 10, flexShrink: 0 }}>{'\u{1F4CC}'}</span>}
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
                          {'\u{1F4CC}'}{/* 📌 */}
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

// ── Inline styles for the agent dropdown popover (CSS vars, mirroring the former AgentDropdown) ──

const popoverStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  minWidth: 240,
  maxWidth: 320,
  maxHeight: 420,
  overflowY: 'auto',
  background: 'var(--bg-elevated, var(--bg))',
  border: '1px solid var(--border)',
  borderRadius: 8,
  boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
  zIndex: 1000,
  padding: '6px 0',
};

// Conversation dropdown — anchored to the trigger's left edge (the trigger sits
// right after the agent tab, well clear of the viewport's right edge).
const historyPopoverStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  minWidth: 260,
  maxWidth: 340,
  maxHeight: 420,
  overflowY: 'auto',
  background: 'var(--bg-elevated, var(--bg))',
  border: '1px solid var(--border)',
  borderRadius: 8,
  boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
  zIndex: 1000,
  padding: '6px 0',
};

const sectionLabelStyle: React.CSSProperties = {
  padding: '4px 12px',
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--fg-muted)',
};

function rowStyle(isActive: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    padding: '0 6px 0 12px',
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
