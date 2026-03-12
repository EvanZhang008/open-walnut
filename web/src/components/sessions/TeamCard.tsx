/**
 * TeamCard — tab-based container for viewing team agents in a session.
 *
 * Shows a tab strip with team members, and renders the active agent's
 * conversation (from polled JSONL events) or a placeholder for unloaded tabs.
 */

import { useState, useCallback, memo, useMemo } from 'react';
import { useTeamStream, type TeamMember, type TeamAgentEvent } from '@/hooks/useTeamStream';
import { wsClient } from '@/api/ws';

interface TeamCardProps {
  sessionId: string;
  teamName: string;
  /** Agent tool status map: agentName → 'calling' | 'done' | 'error' */
  agentStatuses?: Map<string, 'calling' | 'done' | 'error'>;
}

/** Extract a short model label from the full model string */
function shortModel(model: string): string {
  if (model.includes('haiku')) return 'haiku';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('opus')) return 'opus';
  // Remove provider prefix (e.g., "us.anthropic.claude-opus-4-6-v1" → "opus-4-6")
  const parts = model.split('.');
  const last = parts[parts.length - 1];
  return last.replace(/^claude-/, '').replace(/-v\d+.*$/, '');
}

/** Tab status indicator */
function StatusDot({ status }: { status?: 'calling' | 'done' | 'error' }) {
  if (!status) return <span className="team-tab-dot team-tab-dot-pending" title="Pending">{'\u23F3'}</span>;
  if (status === 'calling') return <span className="team-tab-dot team-tab-dot-running" title="Running">{'\u25CF'}</span>;
  if (status === 'done') return <span className="team-tab-dot team-tab-dot-done" title="Done">{'\u2713'}</span>;
  return <span className="team-tab-dot team-tab-dot-error" title="Error">{'\u2717'}</span>;
}

/** Render a single JSONL event for the agent conversation */
const AgentEventView = memo(function AgentEventView({ event }: { event: TeamAgentEvent }) {
  if (event.type === 'user-sent') {
    return (
      <div className="team-agent-user-sent">
        <span className="team-agent-user-sent-label">You:</span>
        {event.text}
      </div>
    );
  }
  if (event.type === 'text' && event.text) {
    return <div className="team-agent-text">{event.text}</div>;
  }
  if (event.type === 'tool_use') {
    return (
      <div className="team-agent-tool">
        <span className="team-agent-tool-icon">{'\u2699'}</span>
        <span className="team-agent-tool-name">{event.toolName}</span>
        {event.input && Object.keys(event.input).length > 0 && (
          <span className="team-agent-tool-input">
            {Object.entries(event.input).slice(0, 2).map(([k, v]) => {
              const val = typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v).slice(0, 80);
              return <span key={k} className="team-agent-tool-param">{k}: {val}</span>;
            })}
          </span>
        )}
      </div>
    );
  }
  if (event.type === 'tool_result') {
    return (
      <div className="team-agent-result">
        <span className="team-agent-result-text">{event.result?.slice(0, 500)}</span>
      </div>
    );
  }
  if (event.type === 'system' && event.subtype === 'init') {
    return null; // Don't show system init events
  }
  return null;
});

/** Chat input for sending messages to a teammate */
function TeamChatInput({ teamName, agentName, onSent }: { teamName: string; agentName: string; onSent?: (text: string) => void }) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async () => {
    if (!message.trim()) return;
    const text = message.trim();
    setSending(true);
    try {
      await wsClient.sendRpc('session:team-send', { teamName, agentName, message: text });
      setMessage('');
      // Show the sent message in the UI immediately
      onSent?.(text);
    } catch (err) {
      console.error('Failed to send team message:', err);
    } finally {
      setSending(false);
    }
  }, [teamName, agentName, message, onSent]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  return (
    <div className="team-chat-input">
      <input
        type="text"
        value={message}
        onChange={e => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={`Message ${agentName}...`}
        disabled={sending}
        className="team-chat-input-field"
      />
      <button onClick={handleSend} disabled={!message.trim() || sending} className="team-chat-send-btn">
        Send
      </button>
    </div>
  );
}

/** Agent conversation panel (rendered when a tab is active) */
function AgentPanel({
  agentName,
  events,
  loading,
  teamName,
  onSent,
}: {
  agentName: string;
  events: TeamAgentEvent[];
  loading: boolean;
  teamName: string;
  onSent?: (text: string) => void;
}) {
  // Coalesce consecutive text events into single blocks (memoized to avoid re-computing on every render)
  const coalesced = useMemo(() => {
    const result: TeamAgentEvent[] = [];
    for (const event of events) {
      if (event.type === 'text' && result.length > 0) {
        const last = result[result.length - 1];
        if (last.type === 'text') {
          result[result.length - 1] = { ...last, text: (last.text ?? '') + (event.text ?? '') };
          continue;
        }
      }
      result.push(event);
    }
    return result;
  }, [events]);

  if (loading) {
    return (
      <div className="team-agent-panel team-agent-loading">
        <div className="team-agent-loading-spinner" />
        Loading conversation...
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="team-agent-panel team-agent-empty">
        No conversation yet
      </div>
    );
  }

  return (
    <div className="team-agent-panel">
      <div className="team-agent-events">
        {coalesced.map((event, i) => (
          <AgentEventView key={i} event={event} />
        ))}
      </div>
      <TeamChatInput teamName={teamName} agentName={agentName} onSent={onSent} />
    </div>
  );
}

/**
 * Main TeamCard component — rendered inside session chat when team tools are detected.
 */
export const TeamCard = memo(function TeamCard({
  sessionId,
  teamName,
  agentStatuses,
}: TeamCardProps) {
  const {
    members,
    activeAgent,
    agentEvents,
    agentLoading,
    selectAgent,
    loaded,
    addSentMessage,
  } = useTeamStream(sessionId, teamName);

  if (!loaded || members.length === 0) {
    if (!loaded) return <div className="team-card team-card-loading">Loading team info...</div>;
    return null;
  }

  // Count completed agents
  const nonLeadMembers = members.filter(m => !m.isLead);
  const doneCount = nonLeadMembers.filter(m => agentStatuses?.get(m.name) === 'done').length;

  return (
    <div className="team-card">
      <div className="team-card-header">
        <span className="team-card-title">Team: {teamName}</span>
        <span className="team-card-count">{doneCount}/{nonLeadMembers.length}</span>
      </div>
      <div className="team-card-tabs">
        {members.filter(m => !m.isLead).map(member => (
          <button
            key={member.name}
            className={`team-tab ${activeAgent === member.name ? 'team-tab-active' : ''}`}
            onClick={() => selectAgent(member.name)}
            title={`${member.name} (${shortModel(member.model)})`}
          >
            <StatusDot status={agentStatuses?.get(member.name)} />
            <span className="team-tab-name">{member.name}</span>
          </button>
        ))}
      </div>
      {activeAgent && (
        <AgentPanel
          agentName={activeAgent}
          events={agentEvents}
          loading={agentLoading}
          teamName={teamName}
          onSent={addSentMessage}
        />
      )}
      {!activeAgent && (
        <div className="team-card-placeholder">
          Click an agent tab to view their conversation
        </div>
      )}
    </div>
  );
});
