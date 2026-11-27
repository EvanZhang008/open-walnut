/**
 * One host problem row (li.hpb-row), as the notification panel shows it: in All
 * and Errors with an x (NotificationProblems) and in System's host list without
 * one (NotificationHostRow). The sentences come
 * from the shared model (@open-walnut/host-problem) and the server verbatim;
 * the buttons are hostActionsFor(surface 'banner') and run through
 * useHostActions, the same implementation Settings and the picker use.
 *
 * DOM order is the reading and Tab order: the headline (it names the host),
 * the row's buttons right under it (always in view with the headline), the
 * details and their toggle, then the row x (drawn at the headline's line end).
 *
 * A row's expanded flag lives in the page session (host-row-expanded.ts),
 * keyed by row id: the user's own Show / Hide details holds in both views.
 * Without a choice, the row's `defaultExpanded` applies.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  DETAILS_NOT_SSH_KINDS, autofixProgressText, autofixVerbFor, firstSentence, formatElapsed, type HostActionId,
} from '@open-walnut/host-problem';
import { useHostStatus } from '@/hooks/useHostStatus';
import { useServerTick } from '@/hooks/useServerTick';
import { useHostActions, RETRY_FAILED_TEXT, CHECK_FAILED_TEXT, type HostActions } from '@/hooks/useHostActions';
import { HostFailureText } from '@/components/hosts/HostFailureText';
import { InlineCodeText } from '@/components/common/InlineCodeText';
import { HostCommands } from '@/components/hosts/HostCommands';
import { demoHostMessage } from '@/utils/demo-generation';
import { HostStatusDot } from '@/components/sessions/path-selector/HostStatusDot';
import { useLineClose } from '@/utils/notice-dismiss';
import { NoticeClose } from './NoticeClose';
import { activeStepLabel } from '@/utils/host-connect';
import type { BannerRow } from '@/utils/attention-banner-model';
import { useRowExpanded } from '@/utils/host-row-expanded';
import { HostFixButton } from './HostFixButton';
import { SetupProgress } from './SetupProgress';

export interface HostRowProps {
  row: BannerRow;
  /** Row 1 opens expanded; the rest start behind 'Show details'. */
  defaultExpanded: boolean;
  /** Several rows: until opened, the headline (wrapped in full), then the primary action and the details toggle. */
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
  onNavigate?: (to: string) => void;
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
      className={`btn btn-sm hpb-btn${secondary ? ' btn-ghost hpb-btn-secondary' : ''}`}
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
const CHECK_LABELS = ['Check again', 'Checking...', CHECK_FAILED_TEXT];
const CONNECT_NOW_LABELS = ['Connect now', 'Retrying...'];
const UPDATE_LABELS = ['Update', 'Updating...', 'Try again'];
const INSTALL_LABELS = ['Install', 'Installing...', 'Try again'];

/**
 * What a row shows of its actions: its own buttons (`ids`) and Fix with agent
 * (`fix`), which is the last of them. A folded dense row shows
 * one action, the first (BP-R3-N1: every problem reads at a glance); the rest,
 * Fix with agent included, are behind Show details (`folds`, the toggle shows
 * even when the row has no words to open). A row with no action of its own leads
 * with Fix with agent. 2026-10-21 added Fix with agent after the cap, and every
 * folded row took a third line (2026-10-31: BP-R3-N1, BP-C54, C61).
 */
export function rowActionsFor(all: HostActionId[], canFix: boolean,
  form: { dense?: boolean; expanded?: boolean; statusList?: boolean }):
  { ids: HostActionId[]; fix: boolean; folds: boolean } {
  // Every action stays one Show details away: an opened row (or one whose fix failed, which
  // opens by itself) shows them all, and the toggle folds them back.
  const folding = !!form.dense;
  const total = all.length + (canFix ? 1 : 0);
  if (!folding || form.expanded) return { ids: all, fix: canFix, folds: folding && total > 1 };
  const ids = all.slice(0, 1);
  // The System list (statusList) is where a repair starts: its rows keep Fix with agent folded too.
  const fix = canFix && (ids.length === 0 || !!form.statusList);
  return { ids, fix, folds: all.length + (canFix && !fix ? 1 : 0) > 1 };
}

/** The row's buttons, in spec order; the secondary Open Settings is quieter and last. */
function ActionButtons({ ids, actions, alias, name, fixFailed, onOpenSettings, onLock }: {
  ids: HostActionId[]; actions: HostActions; alias: string; fixFailed?: boolean;
  /** The host(s) the buttons act on: the group's name, so a screen reader hears 'Key box, Retry' (N3-16). */
  name?: string;
  onOpenSettings: (alias?: string) => void; onLock: () => void;
}) {
  const { pending, failed } = actions;
  const run = (fn: () => Promise<void>) => () => { onLock(); void fn(); };
  const out: ReactNode[] = [];
  for (const id of ids) {
    if (id === 'retry') {
      const labels = RETRY_LABELS;
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
  const p = autofixProgressText(actions.fixing.verb, label, actions.fixing.startedAt, now, actions.fixing.action);
  return (
    <div className="hpb-fixing" data-testid="hpb-fixing">
      <SetupProgress label={`${p.base}${p.elapsed ? ` ${p.elapsed}` : ''}`} ariaLabel={p.base} inline />
      {p.showCheckAgain && (
        <button type="button" tabIndex={0} className="hft-details" onClick={() => { void actions.checkAgain(); }}>Check again</button>
      )}
    </div>
  );
}

/**
 * The muted line under a settled attempt: same result, or the POST itself failed. The receipt's ×
 * takes it away now (it would go after 5 s anyway); the next press's receipt shows again.
 */
function Receipts({ actions }: { actions: HostActions }) {
  const receipt = useLineClose(actions.receipt);
  return (
    <>
      {receipt.shown && (
        <div className="hpb-receipt-line">
          <div className="hpb-receipt" data-testid="hpb-receipt">{actions.receipt}</div>
          <NoticeClose onClose={receipt.close} label="Hide this line" testId="hpb-receipt-close" className="hpb-receipt-close" />
        </div>
      )}
      {actions.failed === 'retry' && <div className="host-connect-retry-msg" role="alert">{RETRY_FAILED_TEXT}</div>}
    </>
  );
}

/** The last height of each host's problem row: its success line takes the same height (nothing below moves). */
const lastRowHeight = new Map<string, number>();

/** While `on`, the height the host's problem row had when the attempt began (undefined otherwise). */
function useSelfTryHeight(host: string, on: boolean): number | undefined {
  const held = useRef<number | undefined>(undefined);
  if (!on) held.current = undefined;
  else if (held.current === undefined) held.current = lastRowHeight.get(host);
  return held.current;
}

function RowFrame({ row, lockRef, minHeight, maxHeight, leaving, body, onDismiss, dot, dense, open, receipt, statusList }: {
  row: BannerRow; lockRef: React.RefObject<HTMLLIElement | null>; minHeight?: number; maxHeight?: number; leaving?: boolean;
  body: ReactNode; onDismiss?: () => void; dot: ReactNode; dense?: boolean; open?: boolean; receipt?: boolean;
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
      className={`hpb-row${leaving ? ' hpb-leaving' : ''}${dense ? ' hpb-dense' : ''}${open ? ' hpb-open' : ''}${receipt ? ' hpb-has-receipt' : ''}${maxHeight !== undefined ? ' hpb-locked' : ''}`}
      data-host={row.hosts.join(' ')}
      data-type={row.type}
      {...(row.kind ? { 'data-kind': row.kind } : {})}
      data-row-id={row.id}
      style={minHeight !== undefined ? { minHeight, ...(maxHeight !== undefined ? { maxHeight } : {}) } : undefined}
    >
      <span className="hpb-dot">{dot}</span>
      {/* Headline first, then the row's buttons, then the details: the host is named before Retry. */}
      {/* data-label: the host's name alone (N3-3, N3-10). */}
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
 * A connect failure's words. Folded: the headline alone (and the retry time);
 * open: the hint inline and the raw output
 * behind its own toggle. The fold toggle is the row's, so its state is the
 * session's and a remount keeps it.
 */
function ConnectBody({ row, expanded, onToggle, after, receipt, more }: {
  row: BannerRow; expanded: boolean; onToggle: () => void;
  /** The folded row keeps actions back (rowActionsFor): the toggle opens them even with no words to show. */
  more?: boolean;
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
        {...(receipt ? {} : { retryAt: row.retryAt })}
        afterHeadline={after}
      />
      {(foldable || more) && <DetailsToggle open={expanded} onToggle={onToggle} />}
    </>
  );
}

/** A readiness message's first sentence is the row's bold headline; the rest is the detail under the buttons. */
export function splitReadinessMessage(message: string): { head: string; rest: string } {
  const head = firstSentence(message).trim();
  return { head, rest: message.slice(head.length).trim() };
}

/** A row for ONE host: connect failure, reconnect with a cause, readiness, or an attempt in flight. */
export function SingleHostRow({ row, defaultExpanded, dense, leaving, onDismiss, statusList, onOpenSettings, onNavigate }: HostRowProps) {
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
  // An attempt of its own ('Trying again...') keeps the height of the problem row it
  // stands in for, the success line's rule: nothing around it moves (C61). The user's
  // own Retry is held by the click's lock instead.
  const selfTry = useSelfTryHeight(alias, trying && !userRetry && !statusList);
  const problem = row.problem;
  const fixFailed = problem?.fix?.state === 'failed';
  const fixing = row.type === 'readiness' && !!actions.fixing && !fixFailed;
  const allIds = fixing ? row.actions.filter((a) => a !== 'update' && a !== 'install') : row.actions;
  const shown = rowActionsFor(allIds, row.type !== 'trying', { dense, expanded: expanded || fixFailed, statusList });
  const ids = shown.ids;
  const autofix = problem ? autofixVerbFor(problem, status?.readiness?.claude?.installMethod) : null;
  const actionsNode = trying
    ? (userRetry
      ? <div className="hpb-actions"><StableButton label="Retrying..." labels={RETRY_LABELS} disabled onClick={() => {}} testId="hpb-retry" /></div>
      : null)
    : <ActionButtons ids={ids} actions={actions} alias={alias} name={label} fixFailed={fixFailed && !!autofix}
        onOpenSettings={onOpenSettings} onLock={lock} />;
  const after = <>{actionsNode}{shown.fix && <HostFixButton target={{ host: alias }} name={label} onNavigate={onNavigate} />}<Receipts actions={actions} /></>;
  const more = shown.folds;
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
      after={after} receipt={hasReceipt} more={more} />;
  } else if (row.type === 'reconnecting') {
    body = (
      <div className="hft">
        <div className="hft-headline wn-title" title={`Reconnecting to ${label}`}>Reconnecting to {label}</div>
        {after}
        {!hasReceipt && <div className="hpb-last">Last attempt: {row.headline}</div>}
        {expanded && row.hint && <div className="hft-hint"><InlineCodeText text={row.hint} /></div>}
        {(row.hint || more) && <DetailsToggle open={expanded} onToggle={toggle} />}
      </div>
    );
  } else {
    const hasCommands = !!problem && problem.commands.length > 0;
    const { head, rest } = splitReadinessMessage(fixFailed ? problem!.fix!.text : demoHostMessage(problem?.message ?? '', problem?.commands ?? []));
    const open = expanded || fixFailed;
    body = (
      <>
        {fixing ? <FixProgress actions={actions} label={label} /> : (
          <div className="hpb-message hpb-headline wn-title" title={head}><InlineCodeText text={head} /></div>
        )}
        {after}
        {!fixing && open && rest && !hasReceipt && <div className="hpb-rest"><InlineCodeText text={rest} /></div>}
        {!fixing && open && hasCommands && <HostCommands commands={problem!.commands} />}
        {!fixing && !fixFailed && (hasCommands || !!rest || more) && <DetailsToggle open={expanded} onToggle={toggle} />}
      </>
    );
  }
  return (
    <RowFrame
      row={row} lockRef={ref} minHeight={minHeight ?? (leaving ? undefined : selfTry)} maxHeight={maxHeight} leaving={leaving}
      body={body} receipt={hasReceipt}
      onDismiss={onDismiss && row.dismissKeys.length ? () => onDismiss(row) : undefined}
      dot={<HostStatusDot host={alias} label={label} decorative />}
      dense={dense} open={expanded} statusList={statusList}
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

/** The shared success sentence without its leading check mark: the row's ok dot carries the state. */
export function readySentenceText(sentence: string | undefined): string {
  return (sentence ?? '').replace(/^\u2713\s*/, '');
}

/** Test seam: forget the per-host row heights. */
export function __resetRowHeightsForTests(): void { lastRowHeight.clear(); }
