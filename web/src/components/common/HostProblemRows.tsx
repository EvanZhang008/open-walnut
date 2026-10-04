/**
 * One row of the home banner's host section (li.hpb-row), and of the
 * notification panel's System host list (`statusList`: no x). The sentences come
 * from the shared model (@open-walnut/host-problem) and the server verbatim;
 * the buttons are hostActionsFor(surface 'banner') and run through
 * useHostActions, the same implementation Settings and the picker use.
 *
 * DOM order is the reading and Tab order: the headline (it names the host),
 * the row's buttons right under it (always in view with the headline), the
 * details and their toggle, then the row x (drawn at the headline's line end).
 *
 * A row's expanded flag lives in the banner session (attention-banner-session.ts),
 * keyed by row id: the user's own Show / Hide details survives a remount in
 * another mount. Without a choice, row 1 opens by position (`defaultExpanded`).
 */
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  DETAILS_NOT_SSH_KINDS, autofixProgressText, autofixVerbFor, firstSentence, formatElapsed, joinLabels, type HostActionId,
} from '@open-walnut/host-problem';
import { useHostStatus } from '@/hooks/useHostStatus';
import { getHostActionSnapshot, runHostAction, subscribeHostActions } from '@/utils/host-action-store';
import { useServerTick } from '@/hooks/useServerTick';
import { useHostActions, RETRY_FAILED_TEXT, CHECK_FAILED_TEXT, type HostActions } from '@/hooks/useHostActions';
import { HostFailureText } from '@/components/hosts/HostFailureText';
import { InlineCodeText } from '@/components/common/InlineCodeText';
import { HostCommands } from '@/components/hosts/HostCommands';
import { HostStatusDot } from '@/components/sessions/path-selector/HostStatusDot';
import { activeStepLabel } from '@/utils/host-connect';
import type { BannerRow } from '@/utils/attention-banner-model';
import { useRowExpanded } from '@/utils/attention-banner-session';
import { log } from '@/utils/log';

export interface HostRowProps {
  row: BannerRow;
  /** Row 1 opens expanded; the rest start behind 'Show details'. */
  defaultExpanded: boolean;
  /** One line: the headline (ellipsis), the row's primary action and the x. */
  singleLine?: boolean;
  /** Several rows: until opened, the headline on one line, then the primary action and the details toggle. */
  dense?: boolean;
  leaving?: boolean;
  /** The row x. Absent: no x (the System list is a status list). */
  onDismiss?: (row: BannerRow) => void;
  /**
   * A row of the notification panel's System host list: never an x, and its
   * height is not the card's (the card's success line takes the CARD row's height).
   */
  statusList?: boolean;
  onOpenSettings: (alias?: string) => void;
}

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

/**
 * Lock the row's height from a click until the attempt settles (the row never
 * jumps under the pointer). While `exact`, the attempt's own line ('Connecting
 * to X...', which may wrap) is held to that height too: the row reads it in
 * place, same height (C62). The receipt after it may add a line (never clipped).
 */
function useHeightLock(busy: boolean, exact = false): {
  ref: React.RefObject<HTMLLIElement | null>; minHeight?: number; maxHeight?: number; lock: () => void;
} {
  const ref = useRef<HTMLLIElement | null>(null);
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined);
  const lock = () => { if (ref.current) setMinHeight(ref.current.getBoundingClientRect().height); };
  const wasBusy = useRef(busy);
  useLayoutEffect(() => {
    if (wasBusy.current && !busy) setMinHeight(undefined);
    wasBusy.current = busy;
  }, [busy]);
  return { ref, minHeight, lock, ...(exact && minHeight !== undefined ? { maxHeight: minHeight } : {}) };
}

const RETRY_LABELS = ['Retry', 'Retrying...'];
const RETRY_ALL_LABELS = ['Retry all', 'Retrying...'];
const CHECK_LABELS = ['Check again', 'Checking...', CHECK_FAILED_TEXT];
const CONNECT_NOW_LABELS = ['Connect now', 'Retrying...'];
const UPDATE_LABELS = ['Update', 'Updating...', 'Try again'];
const INSTALL_LABELS = ['Install', 'Installing...', 'Try again'];

/** The row's buttons, in spec order; the secondary Open Settings is quieter and last. */
function ActionButtons({ ids, actions, alias, name, many, fixFailed, onOpenSettings, onLock }: {
  ids: HostActionId[]; actions: HostActions; alias: string; many?: boolean; fixFailed?: boolean;
  /** The host(s) the buttons act on: the group's name, so a screen reader hears 'Key box, Retry' (N3-16). */
  name?: string;
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
  return <div className="hpb-actions" {...(name ? { role: 'group', 'aria-label': name } : {})}>{out}</div>;
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
      {actions.receipt && <div className="hpb-receipt" data-testid="hpb-receipt" title={actions.receipt}>{actions.receipt}</div>}
      {actions.failed === 'retry' && <div className="host-connect-retry-msg" role="alert">{RETRY_FAILED_TEXT}</div>}
    </>
  );
}

/** The last height of each host's problem row: its success line takes the same height (nothing below moves). */
const lastRowHeight = new Map<string, number>();

function RowFrame({ row, lockRef, minHeight, maxHeight, leaving, body, onDismiss, dot, singleLine, dense, open, receipt, statusList }: {
  row: BannerRow; lockRef: React.RefObject<HTMLLIElement | null>; minHeight?: number; maxHeight?: number; leaving?: boolean;
  body: ReactNode; onDismiss?: () => void; dot: ReactNode; singleLine?: boolean; dense?: boolean; open?: boolean; receipt?: boolean;
  statusList?: boolean;
}) {
  const label = row.labels.join(', ');
  const dismissLabel = `Dismiss ${label}`;
  // The height before any attempt (a locked row may have grown while trying).
  useLayoutEffect(() => {
    if (statusList) return;
    const h = lockRef.current?.getBoundingClientRect().height;
    if (h && !leaving && minHeight === undefined) lastRowHeight.set(row.hosts[0], h);
  });
  return (
    <li
      ref={lockRef}
      className={`hpb-row${leaving ? ' hpb-leaving' : ''}${singleLine ? ' hpb-single' : ''}${dense ? ' hpb-dense' : ''}${open ? ' hpb-open' : ''}${receipt ? ' hpb-has-receipt' : ''}${maxHeight !== undefined ? ' hpb-locked' : ''}`}
      data-host={row.hosts.join(' ')}
      data-type={row.type}
      {...(row.kind ? { 'data-kind': row.kind } : {})}
      data-row-id={row.id}
      style={minHeight !== undefined ? { minHeight, ...(maxHeight !== undefined ? { maxHeight } : {}) } : undefined}
    >
      <span className="hpb-dot">{dot}</span>
      {/* Headline first, then the row's buttons, then the details: the host is named before Retry. */}
      {/* data-label: the host's name alone, drawn by CSS in the one-line fitted and narrow forms (N3-3, N3-10). */}
      <div className="hpb-body" data-label={label}>{body}</div>
      {onDismiss && (
        <button type="button" tabIndex={0} className="setup-banner-dismiss hpb-x" aria-label={dismissLabel} title={dismissLabel} onClick={onDismiss}>
          &times;
        </button>
      )}
    </li>
  );
}

/**
 * A connect failure's words. Folded: the headline alone (and the retry time,
 * unless the row is one line); open: the hint inline and the raw output
 * behind its own toggle. The fold toggle is the row's, so its state is the
 * session's and a remount keeps it.
 */
function ConnectBody({ row, expanded, onToggle, singleLine, after, receipt }: {
  row: BannerRow; expanded: boolean; onToggle: () => void; singleLine?: boolean;
  /** The row's buttons (and its receipt), right under the headline. */
  after?: ReactNode;
  /** A receipt is showing: it stands where the hint and the countdown were (same height). */
  receipt?: boolean;
}) {
  const foldable = !!(row.hint?.trim() || row.summary?.trim());
  // A non-SSH kind's raw text is "details" too, the same word as the row's fold
  // toggle: it opens with the row instead of behind a second toggle (one toggle,
  // one state; both used to show at once, reading "Show details" and "Hide details").
  // An SSH kind keeps "Show SSH output": a different thing, often long.
  const summaryInline = !!row.kind && DETAILS_NOT_SSH_KINDS.includes(row.kind);
  // No lastFrameAt for the countdown: frames keep arriving for any reason (other hosts,
  // heartbeats), so a newer frame proves no attempt. A real attempt turns the row into
  // 'trying'; a failed row whose retryAt passed 30s ago is a stale promise and drops its line (N3-19).
  return (
    <>
      <HostFailureText
        headline={row.headline ?? ''} kind={row.kind} collapsed={!expanded} summaryInline={summaryInline}
        {...(expanded ? { hint: receipt ? undefined : row.hint, summary: row.summary } : {})}
        {...((singleLine && !expanded) || receipt ? {} : { retryAt: row.retryAt })}
        afterHeadline={after}
      />
      {foldable && <DetailsToggle open={expanded} onToggle={onToggle} />}
    </>
  );
}

/** A readiness message's first sentence is the row's bold headline; the rest is the detail under the buttons. */
export function splitReadinessMessage(message: string): { head: string; rest: string } {
  const head = firstSentence(message).trim();
  return { head, rest: message.slice(head.length).trim() };
}

/** A row for ONE host: connect failure, reconnect with a cause, readiness, or an attempt in flight. */
export function SingleHostRow({ row, defaultExpanded, singleLine, dense, leaving, onDismiss, statusList, onOpenSettings }: HostRowProps) {
  const alias = row.hosts[0];
  const label = row.labels[0];
  const status = useHostStatus(alias);
  const actions = useHostActions(alias);
  // The 5s result line ('Tried again just now: same result') stands where the hint was.
  const hasReceipt = !!actions.receipt;
  // Held from the click through the receipt: the result reads in place, the row never jumps.
  const { ref, minHeight, maxHeight, lock } = useHeightLock(actions.pending !== null || hasReceipt, actions.pending !== null);
  // Row 1 opens by position on every frame (a row promoted to the top opens)
  // until the user chooses; the choice is the session's, kept across mounts.
  const [expanded, setExpanded] = useRowExpanded(row.id, defaultExpanded);
  const toggle = () => setExpanded(!expanded);
  // The user's own attempt, from this row or any other surface (Settings, the picker).
  const userRetry = actions.pending === 'retry' || row.by === 'user';
  // A Retry reads 'Connecting to X...' the moment it lands, before the server's first frame.
  const trying = row.type === 'trying' || (actions.pending === 'retry' && (row.type === 'connect' || row.type === 'reconnecting'));
  const problem = row.problem;
  const fixFailed = problem?.fix?.state === 'failed';
  const fixing = row.type === 'readiness' && !!actions.fixing && !fixFailed;
  const allIds = fixing ? row.actions.filter((a) => a !== 'update' && a !== 'install') : row.actions;
  const ids = singleLine || (dense && !expanded) ? allIds.slice(0, 1) : allIds;
  const autofix = problem ? autofixVerbFor(problem, status?.readiness?.claude?.installMethod) : null;
  const actionsNode = trying
    ? (userRetry
      ? <div className="hpb-actions"><StableButton label="Retrying..." labels={RETRY_LABELS} disabled onClick={() => {}} testId="hpb-retry" /></div>
      : null)
    : <ActionButtons ids={ids} actions={actions} alias={alias} name={label} fixFailed={fixFailed && !!autofix}
        onOpenSettings={onOpenSettings} onLock={lock} />;
  const after = <>{actionsNode}<Receipts actions={actions} /></>;
  let body: ReactNode;
  if (trying) {
    const mine = userRetry || actions.pending === 'fix';
    body = (
      <>
        <div className="hpb-trying" data-testid="hpb-trying">
          {mine && <span className="hpb-spinner" aria-hidden="true" />}
          <span className="hpb-trying-text">{mine ? `Connecting to ${label}...` : 'Trying again...'}</span>
          <StepLabel alias={alias} />
        </div>
        {after}
      </>
    );
  } else if (row.type === 'connect') {
    body = <ConnectBody row={row} expanded={expanded} onToggle={toggle}
      singleLine={singleLine} after={after} receipt={hasReceipt} />;
  } else if (row.type === 'reconnecting') {
    body = (
      <div className="hft">
        <div className="hft-headline" title={`Reconnecting to ${label}`}>Reconnecting to {label}</div>
        {after}
        {!hasReceipt && <div className="hpb-last">Last attempt: {row.headline}</div>}
        {expanded && row.hint && <div className="hft-hint"><InlineCodeText text={row.hint} /></div>}
        {row.hint && <DetailsToggle open={expanded} onToggle={toggle} />}
      </div>
    );
  } else {
    const hasCommands = !!problem && problem.commands.length > 0;
    const { head, rest } = splitReadinessMessage(fixFailed ? problem!.fix!.text : problem?.message ?? '');
    const open = expanded || fixFailed;
    body = (
      <>
        {fixing ? <FixProgress actions={actions} label={label} /> : (
          <div className="hpb-message hpb-headline" title={head}><InlineCodeText text={head} /></div>
        )}
        {after}
        {!fixing && open && rest && !hasReceipt && <div className="hpb-rest"><InlineCodeText text={rest} /></div>}
        {!fixing && open && hasCommands && <HostCommands commands={problem!.commands} />}
        {!fixing && !fixFailed && (hasCommands || !!rest) && <DetailsToggle open={expanded} onToggle={toggle} />}
      </>
    );
  }
  return (
    <RowFrame
      row={row} lockRef={ref} minHeight={minHeight} maxHeight={maxHeight} leaving={leaving}
      body={body} receipt={hasReceipt}
      onDismiss={!statusList && onDismiss && row.dismissKeys.length ? () => onDismiss(row) : undefined}
      dot={<HostStatusDot host={alias} label={label} decorative />}
      singleLine={singleLine} dense={dense} open={expanded} statusList={statusList}
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

/** The group's members' attempts, read from the shared store as one value (a stable string while nothing changes). */
function groupActionKey(hosts: readonly string[]): string {
  return hosts.map((h) => {
    const a = getHostActionSnapshot(h);
    return `${a.pending ?? ''}|${a.failed ?? ''}|${a.receipt ?? ''}`;
  }).join('\n');
}

/**
 * Hosts waiting on the same login (cert_expired, agent_missing): one row,
 * 'Retry all' dials each through the SHARED attempt store (host-action-store),
 * the same one every other surface reads: a card that remounts in the other
 * panel shows the same 'Retrying...' and a second click sends nothing (C48).
 * From the click until every member settles the row is the user's own attempt:
 * 'Connecting to Cert box and Cert box 2...' with a disabled 'Retrying...'.
 */
export function GroupRow({ row, defaultExpanded, singleLine, dense, leaving, onDismiss, onOpenSettings }: HostRowProps) {
  const [expanded, setExpanded] = useRowExpanded(row.id, defaultExpanded);
  const hostsKey = row.hosts.join(' ');
  const key = useSyncExternalStore(subscribeHostActions, () => groupActionKey(row.hosts), () => groupActionKey(row.hosts));
  const members = key.split('\n').map((m) => m.split('|'));
  const pending = members.some((m) => m[0] === 'retry');
  const failed = members.some((m) => m[1] === 'retry');
  // Same result for every member: the one receipt; any member that changed says so itself.
  const receipt = !pending && members.every((m) => m[2]) ? members[0][2] : null;
  const { ref, minHeight, maxHeight, lock } = useHeightLock(pending || !!receipt, pending);
  const retryAll = useCallback(async () => {
    const results = await Promise.allSettled(hostsKey.split(' ').map((h) => runHostAction(h, 'retry')));
    const bad = results.filter((r) => r.status === 'rejected').length;
    if (bad) log.warn('attention-banner', 'retry all: some connect requests failed', { hosts: hostsKey, failed: bad });
  }, [hostsKey]);
  const actions: HostActions = {
    retry: retryAll, connectNow: retryAll, update: async () => {}, checkAgain: async () => {},
    pending: pending ? 'retry' : null, failed: failed ? 'retry' : null, receipt, fixing: null, lastTriedAt: null,
  };
  const mine = pending || row.by === 'user';
  const labels = row.hosts.length > 1 ? RETRY_ALL_LABELS : RETRY_LABELS;
  const actionsNode = row.type === 'trying' || pending
    ? (mine ? <div className="hpb-actions"><StableButton label="Retrying..." labels={labels} disabled onClick={() => {}} testId="hpb-retry" /></div> : null)
    : (
      <ActionButtons ids={singleLine || (dense && !expanded) ? row.actions.slice(0, 1) : row.actions} actions={actions} alias={row.hosts[0]} name={row.labels.join(', ')} many={row.hosts.length > 1}
        onOpenSettings={onOpenSettings} onLock={lock} />
    );
  const after = <>{actionsNode}<Receipts actions={actions} /></>;
  const body = row.type === 'trying' || pending
    ? (
      <>
        <div className="hpb-trying" data-testid="hpb-trying">
          {mine && <span className="hpb-spinner" aria-hidden="true" />}
          <span className="hpb-trying-text">{mine ? `Connecting to ${joinLabels(row.labels)}...` : 'Trying again...'}</span>
          {mine && <StepLabel alias={row.hosts[0]} />}
        </div>
        {after}
      </>
    )
    : <ConnectBody row={row} expanded={expanded} onToggle={() => setExpanded(!expanded)}
        singleLine={singleLine} after={after} receipt={!!receipt} />;
  return (
    <RowFrame
      row={row} lockRef={ref} minHeight={minHeight} maxHeight={maxHeight} leaving={leaving}
      body={body}
      onDismiss={onDismiss ? () => onDismiss(row) : undefined}
      dot={<HostStatusDot dot={{ kind: row.type === 'trying' || pending ? 'connecting' : 'failed', title: row.headline ?? '' }} decorative />}
      singleLine={singleLine} dense={dense} open={expanded}
    />
  );
}

/** The shared success sentence without its leading check mark: the row's ok dot carries the state. */
export function readySentenceText(sentence: string | undefined): string {
  return (sentence ?? '').replace(/^\u2713\s*/, '');
}

/**
 * 'Build box is ready (Claude Code 2.1.281)' for 3 seconds, after the ok dot.
 * It takes the height the host's problem row had (same-height rule): the rows
 * below never move under the pointer; the row shrinks only as it leaves.
 */
export function ReadyRow({ row, leaving }: { row: BannerRow; leaving?: boolean }) {
  const [held] = useState(() => lastRowHeight.get(row.hosts[0]));
  return (
    <li className={`hpb-row hpb-ready${leaving ? ' hpb-leaving' : ''}`} data-host={row.hosts.join(' ')} data-type="ready" data-row-id={row.id}
      style={held && !leaving ? { minHeight: held } : undefined}>
      <span className="hpb-dot"><HostStatusDot host={row.hosts[0]} label={row.labels[0]} decorative /></span>
      <div className="hpb-body"><span className="hpb-ready-text">{readySentenceText(row.sentence)}</span></div>
    </li>
  );
}

/** Test seam: forget the per-host row heights. */
export function __resetRowHeightsForTests(): void { lastRowHeight.clear(); }
