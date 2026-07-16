/**
 * SessionKebabSection — the "Session" half of the session-panel kebab dropdown.
 *
 * Rendered as the `extraSection` of <TaskQuickActions slot="kebab">, below a
 * divider, so a single dropdown holds Task actions (top) + Session actions
 * (bottom). Presentational only: both session panels own the actual handlers
 * (restart / investigate / open-notes …) and pass them down.
 */
import { useState, useRef, useEffect } from 'react';
import { ICON_SEARCH, ICON_REFRESH, ICON_STOP } from '../common/Icons';

interface SessionKebabSectionProps {
  sessionId: string;
  cwd?: string;
  /** SSH host alias for remote sessions — shown as a read-only info line. */
  host?: string;
  hostname?: string;
  archived?: boolean;
  // Notes / Msgs toggles (owned by the panel)
  notesOpen: boolean;
  onToggleNotes: () => void;
  messagesOpen: boolean;
  onToggleMessages: () => void;
  msgCount?: number;
  // Restart
  onRestart: () => void;
  restartBusy: boolean;
  // Terminate — close the CLI process (no respawn)
  onTerminate: () => void;
  terminateBusy: boolean;
  // Investigate
  onInvestigate: () => void;
  investigating: boolean;
  investigateResult: { kind: 'ok'; id: string } | { kind: 'error' } | null;
  /** Called after any item runs so the parent can close the dropdown. */
  onAfterAction?: () => void;
}

/** A single copy-to-clipboard kebab item with a transient "Copied!" label. */
function CopyItem({ label, value, onAfter }: { label: string; value: string; onAfter?: () => void }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return (
    <button
      className="task-kebab-item"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => { setCopied(false); onAfter?.(); }, 900);
        }).catch(() => {});
      }}
      title={`Copy: ${value}`}
    >
      <span className="task-kebab-icon">⧉</span>
      <span>{copied ? 'Copied!' : label}</span>
    </button>
  );
}

export function SessionKebabSection({
  sessionId, cwd, host, hostname, archived,
  notesOpen, onToggleNotes, messagesOpen, onToggleMessages, msgCount,
  onRestart, restartBusy,
  onTerminate, terminateBusy,
  onInvestigate, investigating, investigateResult,
  onAfterAction,
}: SessionKebabSectionProps) {
  const cdPrefix = cwd ? `cd ${cwd} && ` : '';
  const cwdLabel = cwd ? (cwd.split('/').filter(Boolean).pop() || 'CWD') : null;

  return (
    <div className="task-kebab-section">
      <div className="task-kebab-section-label">Session</div>

      <button
        className={`task-kebab-item${notesOpen ? ' task-kebab-item-active' : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggleNotes(); onAfterAction?.(); }}
      >
        <span className="task-kebab-icon">📝</span>
        <span>Notes</span>
      </button>

      <button
        className={`task-kebab-item${messagesOpen ? ' task-kebab-item-active' : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggleMessages(); onAfterAction?.(); }}
      >
        <span className="task-kebab-icon">💬</span>
        <span>Msgs{msgCount && msgCount > 0 ? ` (${msgCount})` : ''}</span>
      </button>

      <div className="task-kebab-divider" />

      {cwdLabel && <CopyItem label={`Copy dir (${cwdLabel})`} value={cwd!} onAfter={onAfterAction} />}
      <CopyItem label="Copy session ID" value={sessionId} onAfter={onAfterAction} />
      <CopyItem label="Copy resume cmd" value={`${cdPrefix}claude -r ${sessionId}`} onAfter={onAfterAction} />

      <div className="task-kebab-divider" />

      {!archived && (
        <button
          className="task-kebab-item"
          onClick={(e) => { e.stopPropagation(); onRestart(); }}
          disabled={restartBusy}
          title="Respawn the CLI so it re-reads settings (CLAUDE.md, .claude, skills, MCP) and re-runs the SessionStart hook — no message sent, conversation preserved"
        >
          <span className="task-kebab-icon">{ICON_REFRESH}</span>
          <span>{restartBusy ? 'Restarting…' : 'Restart'}</span>
        </button>
      )}

      {!archived && (
        <button
          className="task-kebab-item"
          onClick={(e) => { e.stopPropagation(); onTerminate(); }}
          disabled={terminateBusy}
          title="Close the CLI process — does not respawn. The session goes stopped; your next message resumes it."
        >
          <span className="task-kebab-icon">{ICON_STOP}</span>
          <span>{terminateBusy ? 'Terminating…' : 'Terminate'}</span>
        </button>
      )}

      <button
        className="task-kebab-item"
        onClick={(e) => { e.stopPropagation(); onInvestigate(); }}
        disabled={investigating}
        title="Capture a debug snapshot — evidence bundle (logs + CLI stream + daemon), open an incident, and copy all related ids to the clipboard"
      >
        <span className="task-kebab-icon">{ICON_SEARCH}</span>
        <span>
          {investigating
            ? 'Capturing…'
            : investigateResult?.kind === 'ok'
              ? `Copied — ${investigateResult.id} ✓`
              : investigateResult?.kind === 'error'
                ? 'Capture failed'
                : 'Debug snapshot'}
        </span>
      </button>

      {/* SSH host — read-only info line for remote sessions. */}
      {host && (
        <>
          <div className="task-kebab-divider" />
          <div className="task-kebab-item task-kebab-info" title={hostname || host}>
            <span className="task-kebab-icon">🖥️</span>
            <span>SSH: {host}</span>
          </div>
        </>
      )}
    </div>
  );
}
