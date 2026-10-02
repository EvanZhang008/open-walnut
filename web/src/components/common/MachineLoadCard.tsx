/**
 * Machine load: what every session costs each host, in the notification panel's
 * System tab (long-running status lives there). One block per host, local
 * first: the host's totals, then its sessions sorted by memory with a short
 * memory sparkline and Stop (the panel's own terminate path, never a signal
 * from the browser). While the card is mounted it asks the hosts to sample
 * every 5s (`fresh` + `watch`), so the numbers move; the rest of the app only
 * sees the server's 30s frames. A session whose CLI is gone but whose processes
 * kept running shows as "left running", with no Stop (there is no CLI to stop;
 * the processes are listed on hover).
 */
import { memo, useEffect, useMemo, useState, useCallback, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useResourceFrames, useResourcesAvailability, hydrateResources } from '@/stores/session-resources-store';
import { rowSessionId, type HostResourceFrame, type SessionResourceRow, type ResourcePoint } from '@/api/resources';
import { visibleInterval } from '@/utils/page-visibility';
import { hostDisplayLabel, LOCAL_HOST_LABEL } from '@/utils/host-display-label';
import { formatCpu, formatMemory, formatProcCount, hostReasonText, hostTotalsText, staleReadingText } from '@/utils/resource-format';
import { getSessionSupervision, stopSupervisedSession, subscribeSessionSupervision } from '@/stores/session-supervision-store';
import { fetchSessionSupervision } from '@/api/sessions';
import { useConfirm } from '@/hooks/useConfirm';
import { log } from '@/utils/log';
import '@/styles/session-resources.css';

/** How often the open card asks for a fresh sample. */
const FRESH_MS = 5_000;
const WATCHED = { fresh: true, history: true, watch: true } as const;

/** A 44x14 memory sparkline; a single point draws as a flat line. */
function Sparkline({ points }: { points: ResourcePoint[] }): ReactNode {
  if (!points || points.length === 0) return null;
  const w = 44; const h = 14;
  const max = Math.max(1, ...points.map((p) => p.rssBytes));
  const xs = points.length === 1 ? [w] : points.map((_, i) => (i / (points.length - 1)) * w);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(1)},${(h - (p.rssBytes / max) * (h - 2) - 1).toFixed(1)}`).join(' ');
  return (
    <svg className="machine-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function stopFailed(err: unknown): StopOutcome {
  return { text: 'Failed', detail: `The stop failed: ${err instanceof Error ? err.message : String(err)}` };
}

/** How a Stop ended when the CLI is still there: the host has not confirmed it, or it failed. */
export interface StopOutcome { text: string; detail: string }

/**
 * Asks first; calls `onConfirmed` only once the user said yes, then stops.
 * Resolves to null when the stop went through (the row leaves on the next
 * sample), or to what the row should say instead of its Stop button.
 */
type StopFn = (row: SessionResourceRow, onConfirmed: () => void) => Promise<StopOutcome | null>;

function SessionRow({ row, onStop }: { row: SessionResourceRow; onStop: StopFn }): ReactNode {
  const navigate = useNavigate();
  const [stopping, setStopping] = useState(false);
  const [outcome, setOutcome] = useState<StopOutcome | null>(null);
  const sid = rowSessionId(row);
  const name = row.title || (row.known ? 'Untitled session' : 'Another Walnut’s session');
  const procs = row.top.map((p) => `${p.comm} (${p.pid}) ${formatMemory(p.rssBytes)}${p.cpuPct != null ? ` ${formatCpu(p.cpuPct)}` : ''}`).join('\n');
  const stop = useCallback(async () => {
    setOutcome(null);
    try { setOutcome(await onStop(row, () => setStopping(true))); } finally { setStopping(false); }
  }, [onStop, row]);
  return (
    <li className={`machine-session${row.heavy ? ' heavy' : ''}${row.alive ? '' : ' dead'}`} data-sid={sid} data-testid="machine-session">
      <button
        type="button"
        className="machine-session-name"
        title={`${name}\n${formatProcCount(row.procCount)}\n${procs}`}
        onClick={() => { if (row.known) navigate(`/sessions?id=${encodeURIComponent(sid)}`); }}
        disabled={!row.known}
      >
        {name}
        {!row.alive && <span className="machine-session-note"> · CLI gone, left running</span>}
      </button>
      <Sparkline points={row.history ?? []} />
      <span className="machine-session-mem" data-testid="machine-session-mem">{formatMemory(row.rssBytes)}</span>
      <span className="machine-session-cpu" title="CPU over the last sample; more than 100% is more than one core">{formatCpu(row.cpuPct)}</span>
      {row.known && row.alive && !outcome && (
        <button type="button" className="machine-session-stop" onClick={stop} disabled={stopping} title="Stop this session's CLI (it resumes on the next message)">
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      )}
      {row.known && row.alive && outcome && (
        <button type="button" className="machine-session-stop-outcome" data-testid="machine-session-stop-outcome" title={`${outcome.detail}\nClick to try again.`} onClick={stop} disabled={stopping}>
          {outcome.text}
        </button>
      )}
    </li>
  );
}

function HostBlock({ frame, label, onStop }: { frame: HostResourceFrame; label: string; onStop: StopFn }): ReactNode {
  const heavy = frame.sessions.some((s) => s.heavy);
  const [open, setOpen] = useState<boolean | null>(null);
  // Open by default when something is heavy or this is the only kind of host with sessions.
  const expanded = open ?? (heavy || frame.host === '__local__');
  const machine = frame.machine
    ? `${formatMemory(frame.machine.totalMemBytes)} RAM · ${frame.machine.cpuCount} cores · ${frame.processCount} processes · load ${frame.machine.loadavg1}`
    : undefined;
  return (
    <li className={`machine-host${heavy ? ' heavy' : ''}`} data-host={frame.host} data-testid="machine-host">
      <button type="button" className="machine-host-row" onClick={() => setOpen(!expanded)} aria-expanded={expanded} title={machine}>
        <svg className={`machine-host-chevron${expanded ? ' open' : ''}`} viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 L7 5 L3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="machine-host-label">{label}</span>
        <span className={`machine-host-totals${heavy ? ' warn' : ''}`} data-testid="machine-host-totals">
          {frame.ok ? hostTotalsText(frame.totals) : hostReasonText(frame.reason, frame.error)}
          {frame.ok && frame.reason === 'error' && <span className="machine-host-note"> · {frame.stale ? staleReadingText(frame.error) : hostReasonText(frame.reason, frame.error)}</span>}
        </span>
      </button>
      {expanded && frame.sessions.length > 0 && (
        <ul className="machine-session-list">
          {frame.sessions.map((row) => <SessionRow key={row.sid} row={row} onStop={onStop} />)}
        </ul>
      )}
    </li>
  );
}

export interface MachineLoadCardProps {
  /** Host alias → label, from the health poll (an alias with no entry shows as itself). */
  labels: Record<string, string | undefined>;
}

export const MachineLoadCard = memo(function MachineLoadCard({ labels }: MachineLoadCardProps) {
  const frames = useResourceFrames();
  const availability = useResourcesAvailability();
  const confirmDialog = useConfirm();

  // Mounted = someone is looking: fresh samples with history, every 5s while visible.
  useEffect(() => {
    void hydrateResources(WATCHED);
    return visibleInterval(() => { void hydrateResources(WATCHED); }, FRESH_MS);
  }, []);

  const onStop = useCallback<StopFn>(async (row, onConfirmed) => {
    const ok = await confirmDialog({
      title: `Stop ${row.title ? `“${row.title}”` : 'this session'}?`,
      message: `Its CLI (${formatMemory(row.rssBytes)} across ${formatProcCount(row.procCount)}) is stopped; the conversation is kept and resumes on the next message.`,
      confirmLabel: 'Stop session',
      cancelLabel: 'Keep running',
      danger: true,
    });
    if (!ok) return null;
    onConfirmed();
    const sid = rowSessionId(row);
    // Hold the session's supervision entry for the whole stop: with its column
    // closed nothing else subscribes, and the store drops an entry nobody holds
    // the moment the stop settles, taking the host's answer with it.
    const hold = subscribeSessionSupervision(sid, () => {});
    let outcome: StopOutcome | null = null;
    try {
      try {
        await stopSupervisedSession(sid);
      } catch (err) {
        const status = (err as { status?: number })?.status;
        // 409: the session owns scheduled crons. Same question, same words, as the column's ⋮ Terminate.
        if (status === 409 && await confirmDialog({
          title: 'Stop session and automatic recovery?',
          message: 'This stops the CLI and disables automatic recovery. Session-only crons stop with it. Directory-shared durable crons may still run in another session; stopping this session does not delete those jobs.',
          confirmLabel: 'Stop session',
          cancelLabel: 'Keep running',
          danger: true,
        })) {
          try { await stopSupervisedSession(sid, true); } catch (err2) { outcome = stopFailed(err2); }
        } else if (status !== 409) {
          outcome = stopFailed(err);
        }
        if (outcome) log.error('machine-load', 'stop failed', { sessionId: sid, error: outcome.detail });
      }
      // A stop the host has not confirmed (or refused) keeps the CLI: say so on the
      // row, with the host's reason. Read it here: the store's own follow-up read
      // is not awaited by the stop, and a read begun before it is discarded.
      if (!outcome && getSessionSupervision(sid).stopPending) {
        const reason = (await fetchSessionSupervision(sid).catch(() => null))?.stopRequest?.error;
        outcome = { text: 'Pending', detail: `Stop requested, the CLI is still running. ${reason || 'Waiting for the host to confirm the stop.'}` };
      }
    } finally {
      hold();
    }
    void hydrateResources(WATCHED);
    return outcome;
  }, [confirmDialog]);

  const anyHeavy = useMemo(() => frames.some((f) => f.sessions.some((s) => s.heavy)), [frames]);
  const tone = anyHeavy ? 'warn' : frames.some((f) => f.ok) ? 'ok' : 'neutral';

  let body: ReactNode;
  if (availability === 'off') body = <div className="notification-detail-row"><span>Not measured on this server</span></div>;
  else if (availability === 'unsupported') body = <div className="notification-detail-row"><span>Update Walnut to see what each session costs</span></div>;
  else if (frames.length === 0) body = <div className="notification-detail-row"><span>{availability === 'unknown' ? 'Reading…' : 'No connected hosts'}</span></div>;
  else {
    body = (
      <ul className="machine-host-list">
        {frames.map((f) => (
          <HostBlock
            key={f.host}
            frame={f}
            label={f.host === '__local__' ? LOCAL_HOST_LABEL : hostDisplayLabel(f.host, labels[f.host])}
            onStop={onStop}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className={`notification-card ${tone} machine-load-card`} data-testid="nfc-machine-load">
      <div className="notification-card-row">
        <span className={`notification-card-icon ${tone}`}>{tone === 'warn' ? '⚠' : tone === 'ok' ? '✓' : '○'}</span>
        <span className="notification-card-label">Machine load</span>
      </div>
      <div className="notification-card-details">{body}</div>
    </div>
  );
});
