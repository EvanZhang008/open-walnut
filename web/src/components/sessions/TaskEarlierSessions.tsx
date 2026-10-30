/**
 * The task's earlier sessions above its current one (core/sessions/engine-switch.ts):
 * a task that switched engines keeps each earlier session as its history. Each one
 * is a collapsed, read-only block naming its engine and model; opening it reads
 * that session's transcript (the phone's row shape, GET /api/v1/sessions/:id/transcript).
 * A divider says where the engine changed and what the new session got.
 */
import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '@/api/client';
import { fetchTaskSessions, type TaskSessionRow } from '@/api/engine-switch';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import { engineEntry } from '@/utils/engines';
import { formatModelName } from '@/hooks/useSessionUsage';
import { log } from '@/utils/log';
import { StableMarkdownBody } from './SessionMessage';
import { earlierParts, type ChatEarlierMessage } from './chat-earlier-parts';
import '@/styles/chat-earlier.css';
import '@/styles/engine-switch.css';

function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The task's sessions, fetched once per (task, current session). */
export function useTaskSessions(taskId: string | undefined, sessionId: string, enabled: boolean): TaskSessionRow[] {
  const [rows, setRows] = useState<{ key: string; rows: TaskSessionRow[] } | null>(null);
  const key = `${taskId}|${sessionId}`;
  useEffect(() => {
    if (!enabled || !taskId || rows?.key === key) return;
    let cancelled = false;
    fetchTaskSessions(taskId).then(
      (a) => { if (!cancelled) setRows({ key, rows: a.sessions }); },
      (err: unknown) => {
        log.warn('engine-switch', 'task sessions read failed', { taskId, error: err instanceof Error ? err.message : String(err) });
        if (!cancelled) setRows({ key, rows: [] });
      },
    );
    return () => { cancelled = true; };
  }, [enabled, taskId, key, rows?.key]);
  return rows?.key === key ? rows.rows : [];
}

function EarlierSessionBlock({ row, sessionCwd, onOpen }: { row: TaskSessionRow; sessionCwd?: string; onOpen?: (sid: string) => void }) {
  const catalog = useEngineCatalog();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<ChatEarlierMessage[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open || msgs) return;
    let cancelled = false;
    apiGet<{ messages?: ChatEarlierMessage[] }>(`/api/v1/sessions/${encodeURIComponent(row.session_id)}/transcript`, undefined, { priority: 'low' })
      .then((b) => { if (!cancelled) setMsgs(Array.isArray(b.messages) ? b.messages : []); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [open, msgs, row.session_id]);
  const parts = useMemo(() => earlierParts(msgs ?? []), [msgs]);
  const name = engineEntry(catalog, row.engine).displayName;
  return (
    <section className="task-earlier-session" data-testid="task-earlier-session" data-session-id={row.session_id}>
      <div className="task-earlier-head">
        <button type="button" className="task-earlier-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          {' '}{name} session{row.model ? ` · ${formatModelName(row.model)}` : ''}
          {row.message_count ? ` · ${row.message_count} messages` : ''}
          {row.started_at ? ` · ${when(row.started_at)}` : ''}
        </button>
        {onOpen && (
          <button type="button" className="engine-switch-btn" onClick={() => onOpen(row.session_id)}>Open</button>
        )}
      </div>
      {open && (
        <div className="task-earlier-body chat-earlier">
          {!msgs && !failed && <div className="chat-earlier-steps">Loading…</div>}
          {failed && <div className="chat-earlier-steps">This session could not be read.</div>}
          {parts.map((part) => part.kind === 'steps' ? (
            <div key={`steps-${part.key}`} className="chat-earlier-steps">
              {part.count === 1 ? '1 step' : `${part.count} steps`}
            </div>
          ) : part.row.kind === 'notification' ? (
            <div key={part.row.id} className="chat-earlier-steps">{part.row.text}</div>
          ) : (
            <div
              key={part.row.id}
              className={`session-msg ${part.row.role === 'user' ? 'session-msg-user' : 'session-msg-assistant'} chat-earlier-row`}
            >
              <div className="session-msg-content">
                <StableMarkdownBody text={part.row.text} cwd={sessionCwd} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** "Back on Claude Code · Codex → Claude Code · 14:20 · resumed this session with the 3 turns it missed" */
function ResumeDivider({ row }: { row: TaskSessionRow }) {
  const catalog = useEngineCatalog();
  const r = row.resumed;
  if (!r) return null;
  const from = engineEntry(catalog, r.engine).displayName;
  const to = engineEntry(catalog, row.engine).displayName;
  return (
    <div className="chat-earlier-divider task-earlier-divider" role="separator" data-testid="engine-switch-divider" data-kind="resumed">
      <span>Switched {from} → {to} · {when(r.at)} · resumed this session with the {r.carried_turns} turn{r.carried_turns === 1 ? '' : 's'} it missed</span>
    </div>
  );
}

/** "Switched Claude Code → Codex · 14:03 · carried 12 turns" */
function SwitchDivider({ row }: { row: TaskSessionRow }) {
  const catalog = useEngineCatalog();
  const s = row.switched_from;
  if (!s) return null;
  const from = engineEntry(catalog, s.engine).displayName;
  const to = engineEntry(catalog, row.engine).displayName;
  const carried = `carried ${s.compacted ? 'the summary and ' : ''}${s.carried_turns} turn${s.carried_turns === 1 ? '' : 's'}`;
  const trimmed = s.trimmed_turns > 0 ? ` (${s.trimmed_turns} older left out to fit ${to}'s window)` : '';
  return (
    <div className="chat-earlier-divider task-earlier-divider" role="separator" data-testid="engine-switch-divider">
      <span>Switched {from} → {to} · {when(s.at)} · {carried}{trimmed}</span>
    </div>
  );
}

export function TaskEarlierSessions({ taskId, sessionId, sessionCwd, onOpenSession }: {
  taskId: string;
  sessionId: string;
  sessionCwd?: string;
  onOpenSession?: (sid: string) => void;
}) {
  const rows = useTaskSessions(taskId, sessionId, true);
  const current = rows.find((r) => r.session_id === sessionId);
  // Every other session of the task, oldest first: a resumed session has later ones too.
  const others = rows.filter((r) => r.session_id !== sessionId);
  if (!current || others.length === 0) return null;
  return (
    <div className="task-earlier-sessions" data-testid="task-earlier-sessions">
      {others.map((row, i) => (
        <div key={row.session_id}>
          {i > 0 && <SwitchDivider row={row} />}
          <EarlierSessionBlock row={row} sessionCwd={sessionCwd} onOpen={onOpenSession} />
        </div>
      ))}
      {current.resumed ? <ResumeDivider row={current} /> : <SwitchDivider row={current} />}
    </div>
  );
}
