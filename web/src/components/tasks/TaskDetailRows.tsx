/**
 * The rows of the task details popup (TaskDetailPane): a session, a related task
 * (parent or subtask), and one fact of the rail.
 *
 * A row is ONE line you can click, with at most one quiet second line. Ids never show
 * (a session is its title, a task its title), and a row repeats nothing the popup
 * already says: the task's own phase lives in the header, not on every session.
 */
import type { ReactNode } from 'react';
import type { ProcessStatus, SessionRecord, TaskPhase } from '@open-walnut/core';
import { SessionRecapLine } from '@/components/sessions/SessionRecapTip';
import { PHASE_LABELS, PROCESS_COLORS, PROCESS_LABELS } from '@/utils/session-status';
import { timeAgo } from '@/utils/time';

const processColor = (status: ProcessStatus) => (PROCESS_COLORS as Record<ProcessStatus, string>)[status] ?? 'var(--fg-muted)';

function activate(e: React.KeyboardEvent, run: () => void) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); }
}

/** Last two path segments, "myCode/walnut": enough to tell two checkouts apart. */
function shortCwd(p: string): string {
  const segments = p.split('/').filter(Boolean);
  return segments.length > 0 ? segments.slice(-2).join('/') : p;
}

interface SessionRowProps {
  sessionId: string;
  /** Undefined while the records load: the row shows its place, not a guess. */
  record?: SessionRecord;
  processStatus: ProcessStatus;
  isPlan: boolean;
  onOpen: (sessionId: string) => void;
}

export function SessionRow({ sessionId, record, processStatus, isPlan, onOpen }: SessionRowProps) {
  const title = record ? (record.title || 'Untitled session') : 'Loading…';
  const ago = record ? timeAgo(record.lastActiveAt || record.startedAt || '') : '';
  const running = processStatus === 'running';
  const tip = [title, PROCESS_LABELS[processStatus], record?.cwd ? shortCwd(record.cwd) : '']
    .filter(Boolean).join('\n');
  return (
    <div
      className="todo-detail-session-item tdp-row"
      data-session-id={sessionId}
      title={tip}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(sessionId)}
      onKeyDown={(e) => activate(e, () => onOpen(sessionId))}
    >
      <div className="tdp-row-line">
        <span className="todo-detail-session-dot tdp-dot" style={{ background: processColor(processStatus) }} />
        {isPlan && <span className="todo-detail-plan-badge">Plan</span>}
        <span className={`tdp-row-title${record ? '' : ' is-loading'}`}>{title}</span>
        {ago && <span className="tdp-row-end">{ago}</span>}
      </div>
      {/* One quiet line: what it is doing now, or what it last did. */}
      {running && record?.activity && <div className="tdp-row-sub">{record.activity}</div>}
      {!running && record && <SessionRecapLine sessionId={sessionId} session={record} className="tdp-row-sub" />}
    </div>
  );
}

interface TaskRowProps {
  title: string;
  phase: TaskPhase | string;
  done: boolean;
  onOpen: () => void;
}

const PHASE_DOT: Partial<Record<string, string>> = {
  IN_PROGRESS: '#007aff',
  NEED_ACTION: 'var(--error)',
  COMPLETE: '#34c759',
};

export function TaskRow({ title, phase, done, onOpen }: TaskRowProps) {
  return (
    <div
      className={`tdp-row tdp-task-row${done ? ' is-done' : ''}`}
      title={title}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => activate(e, onOpen)}
    >
      <div className="tdp-row-line">
        <span className="tdp-dot" style={{ background: (done ? PHASE_DOT.COMPLETE : PHASE_DOT[phase]) ?? 'var(--fg-muted)' }} />
        <span className="tdp-row-title">{title}</span>
        <span className="tdp-row-end">{PHASE_LABELS[phase as TaskPhase] ?? phase}</span>
      </div>
    </div>
  );
}

/** One fact of the rail: a muted label, then the value (a control or plain text). */
export function Fact({ label, children, testId, title }: { label: string; children: ReactNode; testId?: string; title?: string }) {
  return (
    <div className="tdp-fact" data-testid={testId} title={title}>
      <span className="tdp-fact-k">{label}</span>
      <span className="tdp-fact-v">{children}</span>
    </div>
  );
}

/** A section of the main column: a small label (with a count), then its rows. */
export function Section({ label, count, children, className }: { label: string; count?: number; children: ReactNode; className?: string }) {
  return (
    <section className={`tdp-section${className ? ` ${className}` : ''}`}>
      <h3 className="tdp-label">
        {label}
        {count !== undefined && <span className="tdp-label-count">{count}</span>}
      </h3>
      {children}
    </section>
  );
}
