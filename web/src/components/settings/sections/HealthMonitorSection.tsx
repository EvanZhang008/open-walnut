/**
 * Settings > Walnut Health: Walnut's own alarms, like a CloudWatch alarm list
 * (server: src/core/health-monitor/). One row per alarm with its state, value,
 * condition and 24-hour spark; a row opens to its history and what Walnut did
 * (an auto-fix, a fix task, a card), with Mute and Turn off.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { changeAlarm, fetchAlarm, fetchHealth, type AlarmDetail, type AlarmRow, type AlarmState, type HealthView } from '@/api/health-monitor';
import { useEvent } from '@/hooks/useWebSocket';
import { SettingsNotice, SettingsLoadingRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { SectionCard } from '../inputs/SectionCard';
import '@/styles/settings-sections-addons.css';
import '@/styles/health-monitor.css';

export const HEALTH_BLURB = 'Walnut watches its own health every minute: disk, host links, stalls, slow sends, hung sessions, restarts and every kind of warning or error in its logs. An alarm first tries a safe fix, then files one fix task; only what needs you reaches you.';

const STATE_LABEL: Record<AlarmState, string> = { ALARM: 'Alarm', OK: 'OK', INSUFFICIENT_DATA: 'No data' };

function ago(ms: number, now: number): string {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function fmt(v: number | null, unit: string): string {
  if (v === null) return '-';
  const n = Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : String(Math.round(v * 10) / 10);
  return unit ? `${n} ${unit}` : n;
}

function Spark({ points, state }: { points: Array<number | null>; state: AlarmState }) {
  const vals = points.filter((p): p is number => p !== null);
  if (!vals.length) return <span className="health-spark-empty">no data</span>;
  const max = Math.max(...vals, 1e-9);
  const min = Math.min(...vals, 0);
  const w = 120;
  const h = 22;
  const step = points.length > 1 ? w / (points.length - 1) : w;
  let d = '';
  points.forEach((p, i) => {
    if (p === null) return;
    const x = i * step;
    const y = h - 2 - ((p - min) / (max - min || 1)) * (h - 4);
    d += `${d && points[i - 1] !== null ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
  });
  return (
    <svg className={`health-spark health-spark-${state}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} fill="none" strokeWidth="1.5" />
    </svg>
  );
}

function whatWalnutDid(row: AlarmRow): string {
  if (row.held) return row.override?.enabled === false ? 'Turned off: no actions' : 'Muted: no actions for now';
  const last = row.actions[row.actions.length - 1];
  if (!last) return row.state === 'ALARM' ? 'Watching' : '';
  return last.detail;
}

function AlarmDetailView({ id, now, onChanged }: { id: string; now: number; onChanged: () => void }) {
  const [detail, setDetail] = useState<AlarmDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setDetail(await fetchAlarm(id)); setError(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const change = async (body: Parameters<typeof changeAlarm>[1]) => {
    setBusy(true);
    try { await changeAlarm(id, body); await load(); onChanged(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  if (error) return <SettingsNotice kind="error" role="alert">{`Couldn't read it: ${error}`}</SettingsNotice>;
  if (!detail) return <SettingsLoadingRow>Reading the alarm...</SettingsLoadingRow>;
  const muted = detail.override?.mutedUntil !== undefined && detail.override.mutedUntil > now;
  const off = detail.override?.enabled === false;
  return (
    <div className="health-detail" data-testid="health-detail">
      <p className="health-detail-desc">{detail.description}</p>
      {detail.signature && <p className="health-detail-sig"><code>{detail.signature}</code></p>}
      {detail.sample && <p className="health-detail-sample">Latest: {detail.sample}</p>}
      <p className="health-detail-cond">Alarm when: {detail.condition}</p>
      {detail.override && (
        <p className="health-detail-by">
          Changed {ago(detail.override.at, now)} by {detail.override.by === 'human' ? 'you' : detail.override.by.startsWith('task:') ? 'an agent' : detail.override.by}
          {detail.override.threshold !== undefined ? ` (threshold ${detail.override.threshold})` : ''}
        </p>
      )}
      <div className="health-detail-actions">
        {muted
          ? <SettingsButton busy={busy} onClick={() => void change({ muted_until: null })}>Unmute</SettingsButton>
          : <SettingsButton busy={busy} onClick={() => void change({ muted_for: '24h' })}>Mute 24 hours</SettingsButton>}
        <SettingsButton busy={busy} onClick={() => void change({ enabled: off })}>{off ? 'Turn on' : 'Turn off'}</SettingsButton>
        {detail.fixTaskId && <Link className="health-task-link" to={`/tasks/${detail.fixTaskId}`}>Open its fix task</Link>}
      </div>
      {detail.actions.length > 0 && (
        <>
          <h4 className="health-detail-h">What Walnut did</h4>
          <ul className="health-list">
            {detail.actions.map((a) => (
              <li key={`${a.kind}-${a.at}`}>
                <span className="health-when">{ago(a.at, now)}</span>
                <span className={a.ok ? '' : 'health-failed'}>{a.detail}</span>
                {a.taskId && <> · <Link to={`/tasks/${a.taskId}`}>task</Link></>}
              </li>
            ))}
          </ul>
        </>
      )}
      <h4 className="health-detail-h">History</h4>
      {detail.history.length === 0
        ? <p className="health-detail-desc">No state change yet.</p>
        : (
          <ul className="health-list">
            {[...detail.history].reverse().slice(0, 12).map((e) => (
              <li key={e.at}>
                <span className="health-when">{new Date(e.at).toLocaleString()}</span>
                {STATE_LABEL[e.from]} → <b>{STATE_LABEL[e.to]}</b>: {e.reason}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

export function HealthMonitorSection() {
  const [view, setView] = useState<HealthView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setView(await fetchHealth()); setError(null); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);
  useEvent('health-monitor:changed', () => { void load(); });

  const now = view?.checkedAt ?? Date.now();
  const actions = <SettingsButton onClick={() => void load()} busy={loading} busyLabel="Refreshing...">Refresh</SettingsButton>;

  return (
    <SectionCard id="walnut-health" title="Walnut Health" description={HEALTH_BLURB} actions={actions}>
      <div className="settings-addons-contents health-monitor" data-testid="health-monitor">
        {loading && !view && <SettingsLoadingRow>Reading the alarms...</SettingsLoadingRow>}
        {error && <SettingsNotice kind="error" role="alert">{`Couldn't read it: ${error}`}</SettingsNotice>}
        {view && (
          <>
            <div className="health-summary" data-testid="health-summary">
              <span className="health-count health-count-ALARM">{view.counts.ALARM} in alarm</span>
              <span className="health-count">{view.counts.OK} OK</span>
              <span className="health-count">{view.counts.INSUFFICIENT_DATA} no data</span>
              <span className="health-count health-dim">Fix tasks today: {view.fixesToday} of {view.fixesPerDay}</span>
              {!view.actions && <span className="health-count health-dim">Actions are off on this server</span>}
            </div>
            <table className="health-table">
              <thead>
                <tr><th>State</th><th>Alarm</th><th>Now</th><th>Last 24 h</th><th>What Walnut did</th></tr>
              </thead>
              <tbody>
                {view.alarms.map((row) => (
                  <AlarmRows key={row.id} row={row} now={now} open={openId === row.id}
                    onToggle={() => setOpenId(openId === row.id ? null : row.id)} onChanged={() => void load()} />
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </SectionCard>
  );
}

function AlarmRows({ row, now, open, onToggle, onChanged }: { row: AlarmRow; now: number; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const label = row.signature ?? (row.labels ? Object.values(row.labels).join(', ') : '');
  return (
    <>
      <tr className={`health-row health-row-${row.state}${open ? ' is-open' : ''}`} data-alarm={row.id} onClick={onToggle}
        role="button" tabIndex={0} aria-expanded={open}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        <td><span className={`health-pill health-pill-${row.state}`}>{STATE_LABEL[row.state]}</span></td>
        <td className="health-name">
          <span className="health-title">{row.title}</span>
          {label && <span className="health-label" title={label}>{label}</span>}
          <span className="health-since">since {ago(row.since, now)}</span>
        </td>
        <td className="health-value">{fmt(row.value, row.unit)}</td>
        <td><Spark points={row.spark} state={row.state} /></td>
        <td className="health-did">{whatWalnutDid(row)}</td>
      </tr>
      {open && (
        <tr className="health-detail-row">
          <td colSpan={5}><AlarmDetailView id={row.id} now={now} onChanged={onChanged} /></td>
        </tr>
      )}
    </>
  );
}
