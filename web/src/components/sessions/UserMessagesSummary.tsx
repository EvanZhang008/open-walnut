import { useState, useEffect, useRef, useCallback } from 'react';
import type { SessionHistoryMessage } from '@/types/session';

interface UserMessagesSummaryProps {
  messages: SessionHistoryMessage[];
  loading: boolean;
  /** Called when user clicks a message — passes the index in the full messages array */
  onMessageClick?: (messageIndex: number) => void;
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function UserMessagesSummary({ messages, loading, onMessageClick }: UserMessagesSummaryProps) {
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Extract user messages with their original index in the full messages array
  const userMessages = messages
    .map((m, i) => ({ message: m, originalIndex: i }))
    .filter(({ message }) => message.role === 'user' && message.text.trim());

  // Auto-scroll to bottom when new messages arrive
  const prevCount = useRef(userMessages.length);
  useEffect(() => {
    if (userMessages.length > prevCount.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevCount.current = userMessages.length;
  }, [userMessages.length]);

  const handleClick = useCallback((originalIndex: number) => {
    onMessageClick?.(originalIndex);
  }, [onMessageClick]);

  const hasMessages = !loading && userMessages.length > 0;
  const canExpand = hasMessages;

  return (
    <div className={`user-messages-summary${!canExpand ? ' user-messages-summary-muted' : ''}`}>
      <button
        className="user-messages-summary-toggle"
        onClick={() => canExpand && setCollapsed(c => !c)}
        disabled={!canExpand}
      >
        <span className="user-messages-summary-arrow">{collapsed || !canExpand ? '\u25B8' : '\u25BE'}</span>
        <span className="user-messages-summary-label">My Messages</span>
        {hasMessages && (
          <span className="user-messages-summary-count">{userMessages.length}</span>
        )}
      </button>
      {canExpand && !collapsed && (
        <div className="user-messages-summary-list" ref={scrollRef}>
          {userMessages.map(({ message, originalIndex }) => (
            <div
              key={originalIndex}
              className={`user-messages-summary-item${onMessageClick ? ' user-messages-summary-item-clickable' : ''}`}
              onClick={() => handleClick(originalIndex)}
            >
              <span className="user-messages-summary-time">
                {formatTime(message.timestamp)}
              </span>
              <span className="user-messages-summary-text">
                {message.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
