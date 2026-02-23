import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchTriageHistory, type ChatEntry } from '@/api/chat';
import { fetchSessionHistory, type SessionHistoryMessage } from '@/api/sessions';
import { useEvent } from '@/hooks/useWebSocket';
import { timeAgo } from '@/utils/time';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { SessionMessage } from '@/components/sessions/SessionMessage';

interface TriagePanelProps {
  onClose: () => void;
  /** When set, only show triage entries for this task */
  taskId?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
}

/** Strip internal tags (e.g. <memory_update>...</memory_update>) from triage text. */
function stripInternalTags(text: string): string {
  return text.replace(/<memory_update>[\s\S]*?<\/memory_update>/g, '').trim();
}

/**
 * Extract the triage summary from the content string.
 * Content format: "**Triage** ([taskId|label]): actual summary text..."
 */
function parseTriageContent(content: string): { taskRef: string; summary: string } {
  const match = content.match(/^\*\*Triage\*\*\s*\(([^)]+)\):\s*(.*)/s);
  if (match) {
    return { taskRef: match[1], summary: stripInternalTags(match[2]) };
  }
  return { taskRef: '', summary: stripInternalTags(content.replace(/^\*\*Triage\*\*\s*/, '')) };
}

/**
 * Filter session history for triage display:
 * - Skip the first user message (system prompt / internal context)
 * - Keep all assistant messages with text or tool calls
 */
function filterTriageMessages(msgs: SessionHistoryMessage[]): SessionHistoryMessage[] {
  if (msgs.length === 0) return msgs;
  // First message is always the user system prompt — skip it
  const filtered = msgs.slice(1);
  // Also skip any remaining user messages (all internal for triage)
  return filtered.filter((m) => m.role === 'assistant');
}

/** A single collapsible triage session section */
function TriageSessionSection({
  entry,
  index,
  defaultExpanded,
  onTaskClick,
  onSessionClick,
}: {
  entry: ChatEntry;
  index: number;
  defaultExpanded: boolean;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [messages, setMessages] = useState<SessionHistoryMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const content = typeof entry.content === 'string' ? entry.content : '';
  const { taskRef, summary } = parseTriageContent(content);
  const taskRefHtml = taskRef ? renderMarkdownWithRefs(`[${taskRef}]`) : '';
  const preview = summary.length > 200 ? summary.slice(0, 200) + '...' : summary;
  const hasSessionId = !!entry.sessionId;

  // Lazy-load session history on first expand (only if entry has a linked session)
  useEffect(() => {
    if (!expanded || loaded || !hasSessionId) return;
    setLoadingHistory(true);
    setHistoryError(null);
    fetchSessionHistory(entry.sessionId!)
      .then((msgs) => {
        setMessages(filterTriageMessages(msgs));
        setLoaded(true);
      })
      .catch((e) => setHistoryError(e.message ?? 'Failed to load'))
      .finally(() => setLoadingHistory(false));
  }, [expanded, loaded, hasSessionId, entry.sessionId]);

  const handleTaskRefClick = useCallback((e: React.MouseEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    const target = e.target as HTMLElement;
    const taskAnchor = target.closest('a.task-link') as HTMLAnchorElement | null;
    if (taskAnchor) {
      const taskId = taskAnchor.dataset.taskId;
      if (taskId) {
        e.preventDefault();
        onTaskClick ? onTaskClick(taskId) : navigate(`/tasks/${taskId}`);
      }
    }
  }, [navigate, onTaskClick]);

  const hasHistory = messages.length > 0;

  return (
    <div className={`triage-session-section${expanded ? ' triage-session-expanded' : ''}`}>
      {/* Collapsible header */}
      <button
        className="triage-session-header"
        onClick={() => setExpanded((p) => !p)}
        aria-expanded={expanded}
      >
        <span className="triage-session-chevron">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span className="triage-session-index">#{index + 1}</span>
        {entry.timestamp && (
          <span className="triage-session-time">{timeAgo(entry.timestamp)}</span>
        )}
        {taskRefHtml && (
          <span
            className="triage-session-task-ref"
            onClick={handleTaskRefClick}
            dangerouslySetInnerHTML={{ __html: taskRefHtml }}
          />
        )}
      </button>

      {/* Summary preview (always visible when collapsed) */}
      {!expanded && (
        <div className="triage-session-summary" onClick={() => setExpanded(true)}>
          {preview || 'Triage completed'}
        </div>
      )}

      {/* Expanded: full session history with tool calls, or summary fallback */}
      {expanded && (
        <div className="triage-session-body">
          {loadingHistory && (
            <div className="triage-session-loading">Loading session history...</div>
          )}
          {historyError && (
            <div className="triage-session-error">Error: {historyError}</div>
          )}

          {/* Full session history with tool calls (when JSONL data exists) */}
          {hasHistory && messages.map((msg, mi) => (
            <SessionMessage
              key={mi}
              message={msg}
              onTaskClick={onTaskClick}
              onSessionClick={onSessionClick}
            />
          ))}

          {/* Fallback: render summary as markdown when no session history available */}
          {!loadingHistory && !historyError && !hasHistory && (loaded || !hasSessionId) && (
            <div className="triage-session-summary-full markdown-body"
                 dangerouslySetInnerHTML={{ __html: renderMarkdownWithRefs(summary) }} />
          )}
        </div>
      )}
    </div>
  );
}

export function TriagePanel({ onClose, taskId, onTaskClick, onSessionClick }: TriagePanelProps) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const loadEntries = useCallback(() => {
    fetchTriageHistory(100, taskId)
      .then((resp) => {
        setEntries(resp.entries);
        setTotal(resp.total);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [taskId]);

  useEffect(() => {
    setLoading(true);
    loadEntries();
  }, [loadEntries]);

  // Listen for new triage entries in real-time
  useEvent('chat:history-updated', (data) => {
    const d = data as { entry?: { source?: string; taskId?: string } };
    if (d.entry?.source === 'triage') {
      // If filtering by task, only add matching entries
      if (taskId && d.entry.taskId !== taskId) return;
      const entry = d.entry as ChatEntry;
      setEntries((prev) => [entry, ...prev]);
      setTotal((prev) => prev + 1);
    }
  });

  const headerTitle = taskId ? 'Triage Sessions' : 'All Triage Sessions';

  return (
    <div className="triage-panel">
      <div className="triage-panel-header">
        <div className="triage-panel-title-area">
          <span className="triage-panel-title">{headerTitle}</span>
          <span className="triage-panel-count">{total}</span>
        </div>
        <button
          className="btn btn-sm"
          onClick={onClose}
          aria-label="Close triage panel"
        >
          &times;
        </button>
      </div>

      <div className="triage-panel-body">
        {loading && (
          <div className="triage-panel-empty">Loading...</div>
        )}
        {!loading && entries.length === 0 && (
          <div className="triage-panel-empty">No triage sessions yet</div>
        )}
        {entries.map((entry, i) => (
          <TriageSessionSection
            key={`${entry.timestamp}-${i}`}
            entry={entry}
            index={i}
            defaultExpanded={i === 0}
            onTaskClick={onTaskClick}
            onSessionClick={onSessionClick}
          />
        ))}
      </div>
    </div>
  );
}
