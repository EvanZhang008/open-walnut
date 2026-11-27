/**
 * Settings > Walnut Health > Background errors: every error that is Walnut's to fix
 * (src/core/notifications/audience.ts). They never toast and never sit in the bell;
 * here they are grouped by category with how often, first and last seen, and the raw
 * details behind each row, for whoever investigates. Live: the notification provider
 * keeps the list current from the same store and events as the bell.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { navigateToTarget } from '@/utils/open-session';
import { fetchSelfRepair } from '@/api/config';
import { useLocalAgentBlocked } from '@/utils/local-agent-runnable';
import { startNotificationFix } from '@/api/notifications';
import { log } from '@/utils/log';
import { operationErrorWords } from '@/utils/operation-error-words';
import { formatRelative, useNotifications } from '@/contexts/notifications';
import { taskPath } from '@/utils/task-path';
import { NoticeStatus } from '@/components/common/NoticeCard';
import { SectionCard } from '../inputs/SectionCard';
import { EmptyState, LoadingState } from '../../common/EmptyState';
import { SettingsButton } from '../inputs/SettingsButton';
import { groupHealthErrors, type HealthErrorGroup, type HealthErrorRow } from './health-error-log-model';
import { HealthHostProblems, useHealthProblemHosts } from './HealthHostProblems';
import '@/styles/health-monitor.css';
import { pointInTime } from '@/utils/time';

export const HEALTH_ERRORS_BLURB = 'Errors Walnut retries or fixes on its own. They never pop up or fill the bell; they are kept here, grouped by kind, for anyone who wants to look into them. Walnut looks into the ones that keep happening by itself. Only an error you have to act on (sign in, free disk space, an action of yours that failed) reaches you.';

const STATE_LABEL: Record<HealthErrorRow['state'], string> = { open: 'Happening', recovered: 'Recovered', stale: 'Ended' };

function times(n: number): string {
  return n === 1 ? 'once' : `${n} times`;
}

export function HealthErrorLog() {
  const { healthFeed, dismissFeed, loaded } = useNotifications();
  // "Fix with agent" only where Walnut's source can be worked on (not a cloud replica, not a
  // git-less install), as on the bell's cards.
  // Not while Claude Code cannot run on this computer: a repair session would fail like the error.
  const [repairable, setRepairable] = useState(false);
  useEffect(() => { void fetchSelfRepair().then((info) => setRepairable(info?.available === true)); }, []);
  const agentBlocked = useLocalAgentBlocked();
  const canFix = repairable && !agentBlocked;
  const groups = useMemo(() => groupHealthErrors(healthFeed), [healthFeed]);
  const hosts = useHealthProblemHosts();
  const settled = useMemo(() => groups.flatMap(g => g.rows.filter(r => r.state !== 'open').map(r => r.dedupKey)), [groups]);
  const actions = settled.length > 0
    ? <SettingsButton onClick={() => dismissFeed(settled)}>{`Clear ${settled.length} ended`}</SettingsButton>
    : undefined;
  return (
    <SectionCard id="walnut-health-errors" title="Background errors" description={HEALTH_ERRORS_BLURB} actions={actions}>
      <div className="health-errors" data-testid="health-errors">
        <HealthHostProblems hosts={hosts} />
        {groups.length === 0 && hosts.length === 0
          ? loaded
            ? <EmptyState title="No background errors" testId="health-errors-empty" />
            : <LoadingState title="Reading background errors…" testId="health-errors-empty" />
          : groups.map(g => <ErrorGroup key={g.category} group={g} canFix={canFix} onClear={(key) => dismissFeed([key])} />)}
      </div>
    </SectionCard>
  );
}

function ErrorGroup({ group, canFix, onClear }: { group: HealthErrorGroup; canFix: boolean; onClear: (dedupKey: string) => void }) {
  const [open, setOpen] = useState(group.open > 0);
  // A group that held only ended errors opens when one starts happening again.
  const happening = group.open > 0;
  useEffect(() => { if (happening) setOpen(true); }, [happening]);
  return (
    <div className="health-errors-group" data-testid="health-errors-group" data-category={group.category}>
      <button type="button" className="health-errors-group-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span className="health-errors-cat">{group.category}</span>
        <span className="health-errors-meta">
          {group.open > 0 && <span className="health-count-ALARM">{group.open} happening · </span>}
          {group.rows.length} {group.rows.length === 1 ? 'error' : 'errors'} · {times(group.times)} · last {formatRelative(group.lastSeen)}
        </span>
      </button>
      {open && (
        <ul className="health-errors-rows">
          {group.rows.map(r => <ErrorRow key={r.dedupKey} row={r} canFix={canFix} onClear={() => onClear(r.dedupKey)} />)}
        </ul>
      )}
    </div>
  );
}

function ErrorRow({ row, canFix, onClear }: { row: HealthErrorRow; canFix: boolean; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const navigate = useNavigate();
  const go = (to: string) => navigateToTarget(to, navigate);
  const fixTarget = row.fix ? (row.fix.sessionId ? `/sessions?id=${encodeURIComponent(row.fix.sessionId)}` : taskPath(row.fix.taskId)) : null;
  const startFix = async () => {
    setBusy(true);
    setFixError(null);
    try {
      const result = await startNotificationFix(row.dedupKey);
      go(result.sessionId ? `/sessions?id=${encodeURIComponent(result.sessionId)}` : taskPath(result.taskId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('health', 'repair session failed to start', { dedupKey: row.dedupKey, error: message });
      setFixError(operationErrorWords(message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`health-errors-row health-errors-${row.state}`} data-testid="health-errors-row" data-key={row.dedupKey}>
      <button type="button" className="health-errors-row-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <NoticeStatus className="health-pill" tone={row.state === 'open' ? 'error' : 'ok'}>{STATE_LABEL[row.state]}</NoticeStatus>
        <span className="health-errors-title">{row.title}</span>
        <span className="health-errors-times">{times(row.times)}</span>
        <span className="health-when">{formatRelative(row.lastSeen)}</span>
      </button>
      {open && (
        <div className="health-errors-detail" data-testid="health-errors-detail">
          {row.body && <p className="health-detail-desc">{row.body}</p>}
          <p className="health-detail-desc">First seen {pointInTime(row.firstSeen)} · last seen {pointInTime(row.lastSeen)} · {times(row.times)}</p>
          {row.detail && <pre className="health-sample">{row.detail}</pre>}
          <div className="health-detail-actions">
            {row.sessionId && <SettingsButton onClick={() => go(`/sessions?id=${encodeURIComponent(row.sessionId!)}`)}>Open the session</SettingsButton>}
            {!row.sessionId && row.taskId && <SettingsButton onClick={() => go(taskPath(row.taskId!))}>Open the task</SettingsButton>}
            {fixTarget
              ? <SettingsButton data-testid="health-fix-open" onClick={() => go(fixTarget)}>Open its fix session</SettingsButton>
              : canFix && row.state === 'open' && <SettingsButton data-testid="health-fix-start" busy={busy} busyLabel="Starting..." onClick={() => void startFix()}>Fix with agent</SettingsButton>}
            {/* Only an ended one: clearing a live one would hide it until it recovers (dismissed-conditions.ts). */}
            {row.state !== 'open' && <SettingsButton onClick={onClear}>Clear</SettingsButton>}
            {fixError && <span className="health-failed">{fixError}</span>}
          </div>
        </div>
      )}
    </li>
  );
}
