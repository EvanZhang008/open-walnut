import { timeAgo } from '@/utils/time';
import type { SessionRecord } from '@/types/session';
import { PROCESS_COLORS, PROCESS_LABELS } from '@/utils/session-status';
import { useResolvedSessionRecord } from '@/hooks/useSessionStatus';

interface SessionRowProps {
  session: SessionRecord;
  selected: boolean;
  onClick: () => void;
}


export function SessionRow({ session: sessionRecord, selected, onClick }: SessionRowProps) {
  const session = useResolvedSessionRecord(sessionRecord);
  const sessionId = session.claudeSessionId || '';
  const title = session.title || session.description || session.slug || sessionId || 'Untitled session';
  const processStatus = session.process_status || 'stopped';
  const ago = timeAgo(session.lastActiveAt || session.startedAt);

  const statusLabel = PROCESS_LABELS[processStatus] ?? processStatus;
  const isPlanSession = session.mode === 'plan' || !!session.planCompleted;
  const modeIcon = isPlanSession ? '\uD83D\uDCCB Plan' : session.mode && session.mode !== 'default' ? '\u26A1 Bypass' : null;

  return (
    <div
      className={`session-row${selected ? ' session-row-selected' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
    >
      <div className="session-row-top">
        <span
          className="session-status-dot"
          style={{ background: PROCESS_COLORS[processStatus] ?? 'var(--fg-muted)' }}
        />
        {modeIcon && (
          <span
            className="text-xs"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--fg-muted)',
              padding: '1px 5px',
              borderRadius: '4px',
              fontSize: '10px',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {modeIcon}
          </span>
        )}
        {session.engine === 'codex' && (
          <span
            className="text-xs"
            style={{
              color: 'var(--fg)',
              background: 'var(--bg-tertiary)',
              padding: '1px 5px',
              borderRadius: '4px',
              fontSize: '10px',
              fontWeight: 600,
              flexShrink: 0,
            }}
            title="Codex session (via ACP)"
          >
            Codex
          </span>
        )}
        {session.provider === 'embedded' && (
          <span
            className="text-xs"
            style={{
              color: 'var(--accent)',
              background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
              padding: '1px 5px',
              borderRadius: '4px',
              fontSize: '10px',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            🤖
          </span>
        )}
        {session.host && (
          <span
            className="text-xs"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--fg-muted)',
              padding: '1px 5px',
              borderRadius: '4px',
              fontSize: '10px',
              fontWeight: 600,
              flexShrink: 0,
            }}
            title={`Running on ${session.host}`}
          >
            SSH: {session.host}
          </span>
        )}
        <span className="session-row-title truncate">{title}</span>
        <span className="session-row-time text-xs text-muted">{ago}</span>
      </div>
      <div className="session-row-bottom" style={{ display: 'flex', alignItems: 'center', gap: '6px', paddingLeft: '18px' }}>
        <span
          className="text-xs"
          style={{ color: PROCESS_COLORS[processStatus] ?? 'var(--fg-muted)' }}
        >
          {statusLabel}
        </span>
        {session.activity && processStatus === 'running' && (
          <span className="text-xs text-muted" style={{ fontStyle: 'italic' }}>
            — {session.activity}
          </span>
        )}
      </div>
      {/* Recap tip — one line, "what just happened here" (self-report), so a user
          re-opening a long session re-orients without re-reading the transcript.
          Hidden while running: the live activity line above covers that state. */}
      {session.recap && processStatus !== 'running' && (
        <div
          className="text-xs truncate"
          style={{
            paddingLeft: '18px', marginTop: '2px', color: 'var(--fg-muted)',
            display: 'flex', alignItems: 'center', gap: '4px',
          }}
          title={session.recap}
        >
          <span style={{ flexShrink: 0 }}>💬</span>
          <span className="truncate">{session.recap}</span>
        </div>
      )}
    </div>
  );
}
