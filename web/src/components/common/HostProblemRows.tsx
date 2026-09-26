/**
 * One row of the home banner's host section (li.hpb-row). The sentences come
 * from the shared model (@open-walnut/host-problem) and the server verbatim;
 * the buttons are hostActionsFor(surface 'banner') and run through
 * useHostActions, the same implementation Settings and the picker use.
 *
 * DOM order is the Tab order the spec asks for (actions, then the details
 * toggle, then the row x); a grid puts the body visually first.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  autofixProgressText, autofixVerbFor, formatElapsed, isConnectingPhaseWire, joinLabels, type HostActionId,
} from '@open-walnut/host-problem';
import { connectHost } from '@/api/hosts';
import { seedHostStatus, serverNow, useAllHostStatus, useHostStatus } from '@/hooks/useHostStatus';
import { markUserRetry } from '@/utils/host-user-retrying';
import { useServerTick } from '@/hooks/useServerTick';
import { useHostActions, RETRY_FAILED_TEXT, CHECK_FAILED_TEXT, type HostActions } from '@/hooks/useHostActions';
import { HostFailureText } from '@/components/hosts/HostFailureText';
import { InlineCodeText } from '@/components/common/InlineCodeText';
import { HostCommands } from '@/components/hosts/HostCommands';
import { HostStatusDot } from '@/components/sessions/path-selector/HostStatusDot';
import { activeStepLabel } from '@/utils/host-connect';
import type { BannerRow } from '@/utils/attention-banner-model';
import { log } from '@/utils/log';

export interface HostRowProps {
  row: BannerRow;
  /** Row 1 opens expanded; the rest start behind 'Show details'. */
  defaultExpanded: boolean;
  leaving?: boolean;
  onDismiss: (row: BannerRow) => void;
  onOpenSettings: (alias?: string) => void;
}

/** Rows the user opened stay open for the page's lifetime (rows remount on reorder). */
const openedRows = new Set<string>();

/** A button whose width never changes with its text: every label it may show reserves the cell. */
export function StableButton({ label, labels, onClick, disabled, secondary, testId, ariaLabel }: {
  label: string; labels: string[]; onClick: () => void; disabled?: boolean; secondary?: boolean;
  testId?: string; ariaLabel?: string;
}) {
  const sorted = [...new Set([label, ...labels])].sort((a, b) => b.length - a.length);
  return (
    <button
      type="button"
      // WebKit only tabs to buttons with an explicit tabindex.
      tabIndex={0}
      className={`setup-step-btn hpb-btn${secondary ? ' hpb-btn-secondary' : ''}`}
      onClick={onClick}
      disabled={disabled}
      {...(testId ? { 'data-testid': testId } : {})}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
    >
      <span className="hpb-btn-stack" data-r1={sorted[0]} data-r2={sorted[1] ?? ''}>
        <span>{label}</span>
      </span>
    </button>
  );
}

/** Lock the row's height from a click until the attempt settles (the row never jumps under the pointer). */
function useHeightLock(busy: boolean): { ref: React.RefObject<HTMLLIElement | null>; minHeight?: number; lock: () => void } {
  const ref = useRef<HTMLLIElement | null>(null);
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined);
  const lock = () => { if (ref.current) setMinHeight(ref.current.getBoundingClientRect().height); };
  const wasBusy = useRef(busy);
  useLayoutEffect(() => {
    if (wasBusy.current && !busy) setMinHeight(undefined);
    wasBusy.current = busy;
  }, [busy]);
  return { ref, minHeight, lock };
}

const RETRY_LABELS = ['Retry', 'Retrying...'];
const RETRY_ALL_LABELS = ['Retry all', 'Retrying...'];
const CHECK_LABELS = ['Check again', 'Checking...', CHECK_FAILED_TEXT];
const CONNECT_NOW_LABELS = ['Connect now', 'Retrying...'];
const UPDATE_LABELS = ['Update', 'Updating...', 'Try again'];
const INSTALL_LABELS = ['Install', 'Installing...', 'Try again'];

/** The row's buttons, in spec order; the secondary Open Settings is quieter and last. */
function ActionButtons({ ids, actions, alias, many, fixFailed, onOpenSettings, onLock }: {
  ids: HostActionId[]; actions: HostActions; alias: string; many?: boolean; fixFailed?: boolean;
  onOpenSettings: (alias?: string) => void; onLock: () => void;
}) {
  const { pending, failed } = actions;
  const run = (fn: () => Promise<void>) => () => { onLock(); void fn(); };
  const out: ReactNode[] = [];
  for (const id of ids) {
    if (id === 'retry') {
      const labels = many ? RETRY_ALL_LABELS : RETRY_LABELS;
      out.push(<StableButton key={id} label={pending === 'retry' ? 'Retrying...' : labels[0]} labels={labels}
        disabled={pending !== null} onClick={run(actions.retry)} testId="hpb-retry" />);
    } else if (id === 'connectNow') {
      out.push(<StableButton key={id} label={pending === 'retry' ? 'Retrying...' : 'Connect now'} labels={CONNECT_NOW_LABELS}
        disabled={pending !== null} onClick={run(actions.connectNow)} testId="hpb-connect-now" />);
    } else if (id === 'checkAgain') {
      const label = pending === 'check' ? 'Checking...' : failed === 'check' ? CHECK_FAILED_TEXT : 'Check again';
      out.push(<StableButton key={id} label={label} labels={CHECK_LABELS}
        disabled={pending !== null} onClick={run(actions.checkAgain)} testId="hpb-check" />);
    } else if ((id === 'update' || id === 'install') && pending !== 'fix') {
      const labels = id === 'update' ? UPDATE_LABELS : INSTALL_LABELS;
      out.push(<StableButton key={id} label={fixFailed ? 'Try again' : labels[0]} labels={labels}
        disabled={pending !== null} onClick={run(() => actions.update(id))} testId="hpb-fix" />);
    } else if (id === 'openSettings') {
      out.push(<StableButton key={id} label="Open Settings" labels={['Open Settings']} secondary
        onClick={() => onOpenSettings(alias)} testId="hpb-open-settings" />);
    }
  }
  if (!out.length) return null;
  return <div className="hpb-actions">{out}</div>;
}

/** 'SSH · 4s': the step in flight, timed from the server's attempt start. */
function StepLabel({ alias }: { alias: string }) {
  const status = useHostStatus(alias);
  const now = useServerTick(true);
  const started = status?.attemptStartedAt;
  const elapsed = typeof started === 'number' ? ` · ${formatElapsed(now - started)}` : '';
  return <span className="hpb-step" aria-hidden="true">{activeStepLabel(status)}{elapsed}</span>;
}

/** Fix progress: 'Updating Claude Code on Build box... 42s', and after 3 minutes a Check again link. */
function FixProgress({ actions, label }: { actions: HostActions; label: string }) {
  const now = useServerTick(!!actions.fixing);
  if (!actions.fixing) return null;
  const p = autofixProgressText(actions.fixing.verb, label, actions.fixing.startedAt, now);
  return (
    <div className="hpb-fixing" data-testid="hpb-fixing">
      <span className="hpb-spinner" aria-hidden="true" />
      <span>{p.base}</span>
      {p.elapsed && <span className="hpb-elapsed" aria-hidden="true"> {p.elapsed}</span>}
      {p.showCheckAgain && (
        <button type="button" tabIndex={0} className="hft-details" onClick={() => { void actions.checkAgain(); }}>Check again</button>
      )}
    </div>
  );
}

/** The muted line under a settled attempt: same result, or the POST itself failed. */
function Receipts({ actions }: { actions: HostActions }) {
  return (
    <>
      {actions.receipt && <div className="hpb-receipt" data-testid="hpb-receipt">{actions.receipt}</div>}
      {actions.failed === 'retry' && <div className="host-connect-retry-msg" role="alert">{RETRY_FAILED_TEXT}</div>}
    </>
  );
}

function RowFrame({ row, lockRef, minHeight, leaving, actionsNode, body, onDismiss, dot }: {
  row: BannerRow; lockRef: React.RefObject<HTMLLIElement | null>; minHeight?: number; leaving?: boolean;
  actionsNode: ReactNode; body: ReactNode; onDismiss?: () => void; dot: ReactNode;
}) {
  const label = row.labels.join(', ');
  return (
    <li
      ref={lockRef}
      className={`hpb-row${leaving ? ' hpb-leaving' : ''}`}
      data-host={row.hosts.join(' ')}
      data-type={row.type}
      {...(row.kind ? { 'data-kind': row.kind } : {})}
      data-row-id={row.id}
      style={minHeight !== undefined ? { minHeight } : undefined}
    >
      <span className="hpb-dot">{dot}</span>
      {actionsNode}
      <div className="hpb-body">{body}</div>
      {onDismiss && (
        <button type="button" tabIndex={0} className="setup-banner-dismiss hpb-x" aria-label={`Dismiss ${label}`} onClick={onDismiss}>
          &times;
        </button>
      )}
    </li>
  );
}

/** A row for ONE host: connect failure, reconnect with a cause, readiness, or an attempt in flight. */
export function SingleHostRow({ row, defaultExpanded, leaving, onDismiss, onOpenSettings }: HostRowProps) {
  const alias = row.hosts[0];
  const label = row.labels[0];
  const status = useHostStatus(alias);
  const actions = useHostActions(alias);
  const { ref, minHeight, lock } = useHeightLock(actions.pending !== null);
  // The first row is open by position, every frame (a row promoted to the top
  // opens); the others by the user's own toggle, kept for the page's life.
  const [open, setOpen] = useState(() => openedRows.has(row.id));
  const expanded = defaultExpanded || open;
  const toggle = () => setOpen((v) => { const next = !v; if (next) openedRows.add(row.id); else openedRows.delete(row.id); return next; });
  // The user's own attempt, from this row or any other surface (Settings, the picker).
  const userRetry = actions.pending === 'retry' || row.by === 'user';
  const problem = row.problem;
  const fixFailed = problem?.fix?.state === 'failed';
  const fixing = row.type === 'readiness' && !!actions.fixing && !fixFailed;
  const ids = fixing ? row.actions.filter((a) => a !== 'update' && a !== 'install') : row.actions;
  let body: ReactNode;
  if (row.type === 'trying') {
    const mine = userRetry || actions.pending === 'fix';
    body = (
      <div className="hpb-trying" data-testid="hpb-trying">
        {mine && <span className="hpb-spinner" aria-hidden="true" />}
        <span className="hpb-trying-text">{mine ? `Connecting to ${label}...` : 'Trying again...'}</span>
        <StepLabel alias={alias} />
      </div>
    );
  } else if (row.type === 'connect') {
    body = (
      <HostFailureText
        headline={row.headline ?? ''} hint={row.hint} summary={row.summary} kind={row.kind}
        retryAt={row.retryAt} lastFrameAt={status?.serverNow ?? status?.at} collapsed={!expanded}
      />
    );
  } else if (row.type === 'reconnecting') {
    body = (
      <div className="hft">
        <div className="hft-headline" title={`Reconnecting to ${label}`}>Reconnecting to {label}</div>
        <div className="hpb-last">Last attempt: {row.headline}</div>
        {expanded && row.hint && <div className="hft-hint"><InlineCodeText text={row.hint} /></div>}
        {!defaultExpanded && row.hint && <DetailsToggle open={expanded} onToggle={toggle} />}
      </div>
    );
  } else {
    body = (
      <>
        {fixing ? <FixProgress actions={actions} label={label} /> : (
          <div className="hpb-message"><InlineCodeText text={fixFailed ? problem!.fix!.text : problem?.message ?? ''} /></div>
        )}
        {!fixing && (expanded || fixFailed) && problem && problem.commands.length > 0 && <HostCommands commands={problem.commands} />}
        {!fixing && !defaultExpanded && !fixFailed && problem && problem.commands.length > 0 && <DetailsToggle open={expanded} onToggle={toggle} />}
      </>
    );
  }
  const autofix = problem ? autofixVerbFor(problem, status?.readiness?.claude?.installMethod) : null;
  const shownIds = row.type === 'trying' ? [] : ids;
  const actionsNode = row.type === 'trying' && userRetry
    ? <div className="hpb-actions"><StableButton label="Retrying..." labels={RETRY_LABELS} disabled onClick={() => {}} testId="hpb-retry" /></div>
    : <ActionButtons ids={shownIds} actions={actions} alias={alias} fixFailed={fixFailed && !!autofix}
        onOpenSettings={onOpenSettings} onLock={lock} />;
  return (
    <RowFrame
      row={row} lockRef={ref} minHeight={minHeight} leaving={leaving} actionsNode={actionsNode}
      body={<>{body}<Receipts actions={actions} /></>}
      onDismiss={row.dismissKeys.length ? () => onDismiss(row) : undefined}
      dot={<HostStatusDot host={alias} label={label} />}
    />
  );
}

function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" tabIndex={0} className="hft-details" aria-expanded={open} onClick={onToggle}>
      {open ? 'Hide details' : 'Show details'}
    </button>
  );
}

/** A Retry all is settled when every member has a frame newer than its click-time frame that is not connecting. */
const GROUP_RETRY_CAP_MS = 6 * 60_000;

/**
 * Hosts waiting on the same login (cert_expired, agent_missing): one row,
 * 'Retry all' dials each in parallel through the same connect route. From the
 * click until every member settles the row is the user's own attempt (spec
 * 3.2): 'Connecting to Cert box and Cert box 2...' with a disabled 'Retrying...'.
 */
export function GroupRow({ row, defaultExpanded, leaving, onDismiss, onOpenSettings }: HostRowProps) {
  const statuses = useAllHostStatus();
  // Member -> the `at` of its frame when the user clicked, and whether the POSTs
  // came back; null = no Retry all running.
  const [attempt, setAttempt] = useState<{ before: Record<string, number>; posted: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const { ref, minHeight, lock } = useHeightLock(attempt !== null);
  const hostsKey = row.hosts.join(' ');
  useEffect(() => (attempt ? markUserRetry(hostsKey.split(' ')) : undefined), [attempt, hostsKey]);
  // A member the store has no frame for settles once its POST came back (nothing more will say).
  const settled = attempt !== null && row.hosts.every((h) => {
    const s = statuses.find((x) => x.host === h);
    if (!s) return attempt.posted;
    return (s.at ?? 0) > (attempt.before[h] ?? -1) && !isConnectingPhaseWire(s.phase) && s.phase !== 'idle';
  });
  useEffect(() => { if (settled) setAttempt(null); }, [settled]);
  useEffect(() => {
    if (!attempt) return;
    const t = setTimeout(() => setAttempt(null), GROUP_RETRY_CAP_MS);
    return () => clearTimeout(t);
  }, [attempt]);
  const retryAll = async () => {
    const before: Record<string, number> = {};
    for (const h of row.hosts) before[h] = statuses.find((x) => x.host === h)?.at ?? serverNow();
    const mine = { before, posted: false };
    setAttempt(mine); setFailed(false);
    const results = await Promise.allSettled(row.hosts.map((h) => connectHost(h)));
    for (const r of results) if (r.status === 'fulfilled') seedHostStatus(r.value);
    setAttempt((a) => (a === mine ? { before, posted: true } : a));
    const bad = results.filter((r) => r.status === 'rejected');
    if (bad.length) {
      log.warn('attention-banner', 'retry all: some connect requests failed', { hosts: row.hosts.join(','), failed: bad.length });
      setFailed(true);
      // Nothing was asked of any host: nothing to wait for.
      if (bad.length === results.length) setAttempt(null);
    }
  };
  const pending = attempt !== null;
  const actions: HostActions = {
    retry: retryAll, connectNow: retryAll, update: async () => {}, checkAgain: async () => {},
    pending: pending ? 'retry' : null, failed: failed ? 'retry' : null, receipt: null, fixing: null, lastTriedAt: null,
  };
  const mine = pending || row.by === 'user';
  const labels = row.hosts.length > 1 ? RETRY_ALL_LABELS : RETRY_LABELS;
  const body = row.type === 'trying'
    ? (
      <div className="hpb-trying" data-testid="hpb-trying">
        {mine && <span className="hpb-spinner" aria-hidden="true" />}
        <span className="hpb-trying-text">{mine ? `Connecting to ${joinLabels(row.labels)}...` : 'Trying again...'}</span>
        {mine && <StepLabel alias={row.hosts[0]} />}
      </div>
    )
    : (
      <HostFailureText
        headline={row.headline ?? ''} hint={row.hint} summary={row.summary} kind={row.kind}
        retryAt={row.retryAt} lastFrameAt={row.frameAt} collapsed={!defaultExpanded}
      />
    );
  const actionsNode = row.type === 'trying'
    ? (mine ? <div className="hpb-actions"><StableButton label="Retrying..." labels={labels} disabled onClick={() => {}} testId="hpb-retry" /></div> : null)
    : (
      <ActionButtons ids={row.actions} actions={actions} alias={row.hosts[0]} many={row.hosts.length > 1}
        onOpenSettings={onOpenSettings} onLock={lock} />
    );
  return (
    <RowFrame
      row={row} lockRef={ref} minHeight={minHeight} leaving={leaving}
      actionsNode={actionsNode}
      body={<>{body}<Receipts actions={actions} /></>}
      onDismiss={() => onDismiss(row)}
      dot={<HostStatusDot dot={{ kind: row.type === 'trying' ? 'connecting' : 'failed', title: row.headline ?? '' }} />}
    />
  );
}

/** '✓ Build box is ready (Claude Code 2.1.281)' for 3 seconds. */
export function ReadyRow({ row, leaving }: { row: BannerRow; leaving?: boolean }) {
  return (
    <li className={`hpb-row hpb-ready${leaving ? ' hpb-leaving' : ''}`} data-host={row.hosts.join(' ')} data-type="ready" data-row-id={row.id}>
      <span className="hpb-dot"><HostStatusDot host={row.hosts[0]} label={row.labels[0]} /></span>
      <div className="hpb-body"><span className="hpb-ready-text">{row.sentence}</span></div>
    </li>
  );
}
