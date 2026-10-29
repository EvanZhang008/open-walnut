/**
 * SessionKebabSection — the "Session" half of the session-panel kebab dropdown.
 *
 * Rendered as the `extraSection` of <TaskQuickActions slot="kebab">, below a
 * divider, so a single dropdown holds Task actions (top) + Session actions
 * (bottom): three groups (KebabGroup) that open in place: Views (Inbox first), Copy &
 * open, Debug, and Restart / Terminate last. Presentational only: both session panels own the actual handlers
 * (restart / investigate / open-notes …) and pass them down.
 */
import { useState, useRef, useEffect } from 'react';
import { copyTextRobust } from '@/utils/clipboard';
import { ICON_CHAT, ICON_COPY, ICON_NOTE, ICON_REFRESH, ICON_STOP, ICON_VSCODE } from '../common/Icons';
import { openSessionInVscode } from './openSessionInVscode';
import { prefetchVscodeEmbed } from './vscodeEmbedPrefetch';
import { inboxChipTitle } from '@/components/inbox/session-letters';
import type { SessionSplitView } from './sessionSplitView';
import { sessionKebabMetaRows, shellWord } from './session-kebab-meta';
import { useBackgroundRunning } from '@/hooks/useBackgroundRunning';
import { openBackgroundPanel } from '@/stores/background-panel-store';
import { openSessionRawView } from './SessionRawView';
import { backgroundRunningLabel } from './background-ledger';
import { KebabGroup } from './KebabGroup';

const VIEWS_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M12 4v16" />
  </svg>
);
const DEBUG_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="7" y="8" width="10" height="12" rx="5" /><path d="M12 8V5m-3 1 1.5 2m5-2L14 8M4 13h3m10 0h3M5 19l2.5-1.5M19 19l-2.5-1.5" />
  </svg>
);

interface SessionKebabSectionProps {
  sessionId: string;
  cwd?: string;
  /** SSH host alias for remote sessions (absent = this machine) — the Host row. */
  host?: string;
  hostname?: string;
  archived?: boolean;
  /** Session record times — the Created / Updated rows. */
  startedAt?: string;
  lastActiveAt?: string;
  activeView: SessionSplitView | null;
  onToggleView: (view: SessionSplitView) => void;
  unreadCount: number;
  decisionCount: number;
  attentionCount: number;
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
  onOpenVscodeError: (error: unknown) => void;
  onOpenUsage?: () => void;
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
        void copyTextRobust(value).then((r) => {
          if (r === 'failed') return;
          setCopied(true);
          clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => { setCopied(false); onAfter?.(); }, 900);
        });
      }}
      title={`Copy: ${value}`}
    >
      <span className="task-kebab-icon">{ICON_COPY}</span>
      <span>{copied ? 'Copied!' : label}</span>
    </button>
  );
}

export function SessionKebabSection({
  sessionId, cwd, host, hostname, archived, startedAt, lastActiveAt, activeView, onToggleView,
  unreadCount, decisionCount, attentionCount,
  notesOpen, onToggleNotes, messagesOpen, onToggleMessages, msgCount,
  onRestart, restartBusy,
  onTerminate, terminateBusy,
  onInvestigate, investigating, investigateResult,
  onOpenVscodeError, onOpenUsage, onAfterAction,
}: SessionKebabSectionProps) {
  const codeHoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(codeHoverTimer.current), [sessionId]);
  // Computed per render: the menu mounts when opened, so "2m ago" is fresh each time.
  const metaRows = sessionKebabMetaRows({ startedAt, lastActiveAt, host, hostname });
  const { tasks: backgroundTasks, running: bgRunning } = useBackgroundRunning(sessionId);
  const cdPrefix = cwd ? `cd ${shellWord(cwd)} && ` : '';
  const cwdLabel = cwd ? (cwd.split('/').filter(Boolean).pop() || 'CWD') : null;
  const inboxCount = attentionCount > 0 ? (
    <span className={`session-action-chip-count${decisionCount > 0 ? ' session-action-chip-count-warn' : ''}`}
      title={inboxChipTitle(attentionCount, unreadCount, decisionCount)}>
      {attentionCount > 99 ? '99+' : attentionCount}
    </span>
  ) : null;
  const viewsBadge = attentionCount > 0 || bgRunning.total > 0 ? (
    <>
      {inboxCount}
      {bgRunning.total > 0 && <span className="session-action-chip-count" title={`${backgroundRunningLabel(bgRunning)} running`}>{bgRunning.total}</span>}
    </>
  ) : undefined;

  return (
    <div className="task-kebab-section">
      <div className="task-kebab-section-label">Session</div>

      {/* Views: what opens beside or over the chat, the Inbox tab first. Letters that
          need the user and work still running in the background show their counts on
          the closed row. */}
      <KebabGroup
        label="Views"
        hint="inbox · code · web · notes"
        icon={VIEWS_ICON}
        testId="session-kebab-views"
        badge={viewsBadge}
      >
        <button
          className={`task-kebab-item${activeView === 'inbox' ? ' task-kebab-item-active' : ''}`}
          aria-pressed={activeView === 'inbox'}
          onClick={(e) => { e.stopPropagation(); onToggleView('inbox'); onAfterAction?.(); }}
          title={inboxChipTitle(attentionCount, unreadCount, decisionCount)}
        >
          <span className="task-kebab-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4h16l2 10v6H2v-6L4 4Z" />
              <path d="M2 14h6l2 3h4l2-3h6" />
            </svg>
          </span>
          <span>Inbox</span>
          {inboxCount}
        </button>

        <button
          className={`task-kebab-item${activeView === 'code' ? ' task-kebab-item-active' : ''}`}
          aria-pressed={activeView === 'code'}
          onClick={(e) => { e.stopPropagation(); onToggleView('code'); onAfterAction?.(); }}
          onMouseEnter={() => {
            clearTimeout(codeHoverTimer.current);
            codeHoverTimer.current = setTimeout(() => prefetchVscodeEmbed(sessionId), 400);
          }}
          onMouseLeave={() => clearTimeout(codeHoverTimer.current)}
          title="Embedded VS Code in the session working directory"
        >
          <span className="task-kebab-icon">{ICON_VSCODE}</span>
          <span>Code</span>
        </button>

        <button
          className={`task-kebab-item${activeView === 'web' ? ' task-kebab-item-active' : ''}`}
          aria-pressed={activeView === 'web'}
          onClick={(e) => { e.stopPropagation(); onToggleView('web'); onAfterAction?.(); }}
          title="Open a localhost or host:port service this session started, next to the chat"
        >
          <span className="task-kebab-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18" />
              <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z" />
            </svg>
          </span>
          <span>Web preview</span>
        </button>

        <button
          className={`task-kebab-item${notesOpen ? ' task-kebab-item-active' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggleNotes(); onAfterAction?.(); }}
        >
          <span className="task-kebab-icon">{ICON_NOTE}</span>
          <span>Notes</span>
        </button>

        <button
          className={`task-kebab-item${messagesOpen ? ' task-kebab-item-active' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggleMessages(); onAfterAction?.(); }}
        >
          <span className="task-kebab-icon">{ICON_CHAT}</span>
          <span>Msgs{msgCount && msgCount > 0 ? ` (${msgCount})` : ''}</span>
        </button>

        {onOpenUsage && (
          <button type="button" className="task-kebab-item" onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onAfterAction?.(); onOpenUsage(); }}>
            <span className="task-kebab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M7 16v-3m5 3V8m5 8v-5" /></svg>
            </span>
            <span>Usage &amp; Budget</span>
          </button>
        )}

        {/* The session's background commands and agents, finished ones too: the list the old
            Background bar's "View all" opened (2026-10-26). Only once there has been some. */}
        {backgroundTasks.length > 0 && (
          <button
            type="button"
            className="task-kebab-item"
            data-testid="session-kebab-background"
            onClick={(e) => { e.stopPropagation(); onAfterAction?.(); openBackgroundPanel(sessionId); }}
          >
            <span className="task-kebab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2.5" />
                <path d="M7 9l3 3-3 3M12.5 15H17" />
              </svg>
            </span>
            <span>Background tasks</span>
            {bgRunning.total > 0 && <span className="session-action-chip-count" title={`${backgroundRunningLabel(bgRunning)} running`}>{bgRunning.total}</span>}
          </button>
        )}

      </KebabGroup>

      {/* Copy & open: take the session somewhere else (an editor, a terminal, the
          clipboard), and the facts that go with it. */}
      <KebabGroup label="Copy & open" hint="VS Code · folder · ID" icon={ICON_COPY} testId="session-kebab-copy-open">
        <button
          className="task-kebab-item"
          onClick={(e) => {
            e.stopPropagation();
            void openSessionInVscode(sessionId).then(onAfterAction).catch(onOpenVscodeError);
          }}
          title="Open in VS Code"
        >
          <span className="task-kebab-icon">{ICON_VSCODE}</span>
          <span>Open in VS Code</span>
        </button>
        {cwdLabel && <CopyItem label={`Copy folder path (${cwdLabel})`} value={cwd!} onAfter={onAfterAction} />}
        <CopyItem label="Copy session ID" value={sessionId} onAfter={onAfterAction} />
        <CopyItem label="Copy resume command" value={`${cdPrefix}claude -r ${sessionId}`} onAfter={onAfterAction} />
        {/* Read-only: the session's created / updated time and its host, one quiet line. */}
        <div className="task-kebab-meta-line" data-testid="session-kebab-meta" title={metaRows.map((row) => `${row.label}: ${row.title}`).join('\n')}>
          {metaRows.map((row, i) => (
            <span key={row.key} data-meta={row.key} title={row.title}>
              {i > 0 ? ' · ' : ''}{row.key === 'host' ? row.value : `${row.label} ${row.value}`}
            </span>
          ))}
        </div>
      </KebabGroup>

      {/* Debug: only what is for finding out what went wrong. */}
      <KebabGroup label="Debug" hint="raw I/O · snapshot" icon={DEBUG_ICON} testId="session-kebab-debug">
        {/* Every turn's full input (Walnut's hints included) and output, as the model saw them. */}
        <button
          type="button"
          className="task-kebab-item"
          data-testid="session-kebab-raw-view"
          onClick={(e) => { e.stopPropagation(); onAfterAction?.(); openSessionRawView(sessionId); }}
          title="Show every turn's input exactly as the model received it (Walnut's hints included) and its output"
        >
          <span className="task-kebab-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 6l-5 6 5 6M16 6l5 6-5 6" />
            </svg>
          </span>
          <span>Raw input &amp; output</span>
        </button>
        {/* It captures the evidence bundle, then copies every related id. */}
        <button
          className="task-kebab-item"
          data-testid="session-kebab-debug-snapshot"
          onClick={(e) => { e.stopPropagation(); onInvestigate(); }}
          disabled={investigating}
          title="Capture a debug snapshot: an evidence bundle (logs, CLI stream, daemon), an incident, and every related id copied to the clipboard"
        >
          <span className="task-kebab-icon">{ICON_COPY}</span>
          <span>
            {investigating
              ? 'Capturing…'
              : investigateResult?.kind === 'ok'
                ? `Copied — ${investigateResult.id} ✓`
                : investigateResult?.kind === 'error'
                  ? 'Capture failed'
                  : 'Capture debug snapshot'}
          </span>
        </button>
      </KebabGroup>

      {!archived && (
        <>
          <div className="task-kebab-divider" />
          <button
            className="task-kebab-item"
            onClick={(e) => { e.stopPropagation(); onRestart(); }}
            disabled={restartBusy}
            title="Respawn the CLI so it re-reads settings (CLAUDE.md, .claude, skills, MCP) and re-runs the SessionStart hook — no message sent, conversation preserved"
          >
            <span className="task-kebab-icon">{ICON_REFRESH}</span>
            <span>{restartBusy ? 'Restarting…' : 'Restart'}</span>
          </button>
          <button
            className="task-kebab-item"
            onClick={(e) => { e.stopPropagation(); onTerminate(); }}
            disabled={terminateBusy}
            title="Close the CLI process — does not respawn. The session goes stopped; your next message resumes it."
          >
            <span className="task-kebab-icon">{ICON_STOP}</span>
            <span>{terminateBusy ? 'Terminating…' : 'Terminate'}</span>
          </button>
        </>
      )}

    </div>
  );
}
