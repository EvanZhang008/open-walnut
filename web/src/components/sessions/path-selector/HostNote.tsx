/**
 * The folder picker's host pieces (spec 4.1 / 4.2): the tab bar, the ONE note
 * row for the selected host (decided by the pure pickerNoteOf in
 * host-status-merge.ts), and the Off / Removed lines.
 *
 * Every sentence comes from the shared model (@open-walnut/host-problem) or the
 * server verbatim; buttons go through useHostActions (connectHost /
 * checkHostReadiness), never /api/sessions/host-retry. Nothing here dials a
 * host by itself: a connecting host is joined (HostConnectSteps), not redialed.
 *
 * Note buttons sit after the search box in Tab order and are never listbox
 * options: the arrow keys stay on the list rows.
 */
import { useEffect, useRef, useState } from 'react';
import {
  HOST_READY_HOLD_MS, hostActionsFor, hostReadySentence, REMOTE_OFF_NOTE, HOST_REMOVED_NOTE,
  type HostActionId, type HostDot, type HostProblem,
} from '@open-walnut/host-problem';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { serverNow, useHostStatus } from '@/hooks/useHostStatus';
import { useHostActions, RETRY_FAILED_TEXT, CHECK_FAILED_TEXT, type HostActions } from '@/hooks/useHostActions';
import { HostFailureText } from '@/components/hosts/HostFailureText';
import { HostCommands } from '@/components/hosts/HostCommands';
import { InlineCodeText } from '@/components/common/InlineCodeText';
import { StableButton } from '@/components/common/HostProblemRows';
import { HostStatusDot } from './HostStatusDot';
import { HostConnectSteps } from './HostConnectSteps';
import { pickerNoteOf, type PickerNote } from './host-status-merge';
import type { HostLiveState } from './useLiveDirs';
import { REMOVED_TAB, tabTitle, type HostTab } from './host-tabs';
import '@/styles/host-picker-settings.css';

/** The tab row: scrolls sideways (never wraps), one title per tab, the selected tab kept in view. */
export function HostTabBar({ tabs, selected, dots, onSelect }: {
  tabs: HostTab[]; selected: string; dots: ReadonlyMap<string, HostDot>; onSelect: (key: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('.sps-host-tab.active');
    el?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [selected]);
  return (
    <div className="sps-host-filter" ref={ref}>
      {tabs.map((tab) => {
        const dot = tab.kind === 'host' ? dots.get(tab.key) : undefined;
        const title = tabTitle(tab, dot);
        return (
          <button
            key={tab.key}
            type="button"
            className={`sps-host-tab${selected === tab.key ? ' active' : ''}${tab.kind === 'removed' ? ' sps-host-tab-removed' : ''}`}
            data-host={tab.kind === 'host' ? tab.key : tab.kind === 'removed' ? REMOVED_TAB : undefined}
            title={title}
            // One accessible name, '{L}: {state}': the dot inside is decorative (it
            // used to add the same sentence again, so the host was read twice).
            {...(dot ? { 'aria-label': title } : {})}
            onClick={() => onSelect(tab.key)}
          >
            {dot && <HostStatusDot dot={dot} host={tab.key} decorative />}
            <span className="sps-host-tab-label">{tab.label}</span>
            {tab.rawName && <span className="sps-host-tab-raw" aria-hidden>✎</span>}
          </button>
        );
      })}
      <span className="sps-host-hint">Shift+Tab</span>
    </div>
  );
}

/** Remote hosts are off on a test server: one grey line, no button (nothing could help). */
export function RemoteOffNote() {
  return (
    <div className="sps-host-note sps-host-note-off" data-type="off">
      <HostStatusDot dot={{ kind: 'off', title: REMOTE_OFF_NOTE }} />
      <span className="sps-host-note-text">{REMOTE_OFF_NOTE}</span>
    </div>
  );
}

/** Top line of the Removed hosts tab. */
export function RemovedHostsNote() {
  return (
    <div className="sps-host-note sps-host-note-removed" data-type="removed">
      <span className="sps-host-note-text">{HOST_REMOVED_NOTE}</span>
    </div>
  );
}

interface NoteButtonsProps {
  ids: HostActionId[];
  actions: HostActions;
  /** A connect (connectHost then re-list) or, for a listing, the re-list only. */
  onRetry: () => void;
  onOpenSettings: () => void;
  /** A listing re-list in flight (a connect's own pending state is in `actions`). */
  relisting?: boolean;
}

const RETRY_LABELS = ['Retry', 'Retrying...'];
const CHECK_LABELS = ['Check again', 'Checking...'];

/** The note's buttons: tabbable in WebKit, and a width that does not change with the label (Retry / Retrying...). */
function NoteButtons({ ids, actions, onRetry, onOpenSettings, relisting }: NoteButtonsProps) {
  if (ids.length === 0) return null;
  const retrying = relisting ?? actions.pending === 'retry';
  const checking = actions.pending === 'check';
  return (
    <div className="sps-host-note-actions">
      {ids.map((id) => {
        if (id === 'retry') {
          return <StableButton key={id} label={retrying ? 'Retrying...' : 'Retry'} labels={RETRY_LABELS} disabled={retrying} onClick={onRetry} testId="sps-note-retry" />;
        }
        if (id === 'checkAgain') {
          return <StableButton key={id} label={checking ? 'Checking...' : 'Check again'} labels={CHECK_LABELS} disabled={checking} onClick={() => { void actions.checkAgain(); }} testId="sps-note-check" />;
        }
        if (id === 'openSettings') {
          return <StableButton key={id} label="Open Settings" labels={['Open Settings']} secondary onClick={onOpenSettings} testId="sps-note-open-settings" />;
        }
        return null;
      })}
    </div>
  );
}

/** 'Could not retry right now.' / 'Check failed' / the same-result receipt: one muted line. */
function NoteMessage({ actions }: { actions: HostActions }) {
  if (actions.failed === 'retry') return <div className="sps-host-note-msg sps-host-note-error" role="status">{RETRY_FAILED_TEXT}</div>;
  if (actions.failed === 'check') return <div className="sps-host-note-msg sps-host-note-error" role="status">{CHECK_FAILED_TEXT}</div>;
  if (actions.receipt) return <div className="sps-host-note-msg" role="status">{actions.receipt}</div>;
  return null;
}

export interface HostNoteProps {
  hostKey: string;
  label: string;
  /** This host's live listing (absent while nothing path-like is typed). */
  live?: HostLiveState;
  /** The folder being listed, for 'Could not list {path} on {L}'. */
  path?: string;
  /** The dot this host's tab wears (the note leads with the same one). */
  dot?: HostDot;
  /** Re-list this host only (no connect). */
  onRelist: (hostKey: string) => void;
  /** Close the picker (the outside-click path) and open this host's Settings row. */
  onOpenSettings: (alias: string) => void;
}

/** A readiness problem that clears says so for 3s ('✓ Build box is ready (Claude Code 2.1.280)'). */
function useReadyHold(note: PickerNote | null, connected: boolean, label: string, version?: string): string | null {
  const [ready, setReady] = useState<string | null>(null);
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !note && connected) setReady(hostReadySentence(label, version));
    if (note) setReady(null);
    was.current = note?.type === 'readiness';
  }, [note?.type, connected, label, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => setReady(null), HOST_READY_HOLD_MS);
    return () => clearTimeout(t);
  }, [ready]);
  return ready;
}

const RELIST_CAP_MS = 15_000;

/**
 * A listing Retry re-lists in place: the note stays, its button reads
 * 'Retrying...', until the next answer for this host lands (a new listing state
 * that is not loading). Without this the note vanished for the round trip and
 * came back unchanged, so the click looked like it did nothing.
 */
function useRelist(live: HostLiveState | undefined, path: string | undefined, note: PickerNote | null, relist: () => void) {
  // The listing state and folder at click time; null = no re-list running.
  const [since, setSince] = useState<{ live: HostLiveState | undefined; path: string | undefined } | null>(null);
  const last = useRef<PickerNote | null>(null);
  if (note?.type === 'listing') last.current = note;
  // A new folder typed meanwhile is a new listing, not this retry.
  const running = since !== null && since.path === path && (live === since.live || live?.status === 'loading');
  useEffect(() => { if (since !== null && !running) setSince(null); }, [since, running]);
  useEffect(() => {
    if (since === null) return;
    const t = setTimeout(() => setSince(null), RELIST_CAP_MS);
    return () => clearTimeout(t);
  }, [since]);
  return { running, shown: note ?? (running ? last.current : null), start: () => { setSince({ live, path }); relist(); } };
}

/** The one note row for a remote host (spec 4.2), or nothing when the host is fine. */
export function HostNote({ hostKey, label, live, path, dot, onRelist, onOpenSettings }: HostNoteProps) {
  const status = useHostStatus(hostKey);
  const actions = useHostActions(hostKey);
  const replica = useIsCloudReplica();
  const current = pickerNoteOf({ host: hostKey, label, status, live, path, now: serverNow() });
  const relist = () => onRelist(hostKey);
  const relisting = useRelist(live, path, current, relist);
  const note = relisting.shown;
  const ready = useReadyHold(note, !!status?.connected, label, status?.readiness?.claude?.version);

  if (!note) {
    if (!ready) return null;
    return (
      <div className="sps-host-note" data-host={hostKey} data-type="ready" role="status">
        <span className="sps-host-note-text">{ready}</span>
      </div>
    );
  }
  if (note.type === 'off') return <RemoteOffNote />;
  if (note.type === 'connecting') {
    return <HostConnectSteps key={hostKey} hostKey={hostKey} label={label} pending={note.pending ?? live?.pending} lastHeadline={note.lastHeadline} />;
  }
  const openSettings = () => onOpenSettings(hostKey);
  const connectThenRelist = () => { void actions.retry().then(relist); };

  if (note.type === 'readiness') {
    const problem: HostProblem = { type: 'readiness', problem: note.problem, blocking: true, dismissKey: '' };
    return (
      <div className="sps-host-note" data-host={hostKey} data-type="readiness" data-kind={note.problem.kind}>
        <div className="sps-host-note-head">
          <HostStatusDot dot={dot ?? { kind: 'warn', title: `${label}: ${note.problem.message}` }} host={hostKey} />
          <div className="sps-host-note-body">
            <span className="sps-host-note-text"><InlineCodeText text={note.problem.message} /></span>
            <HostCommands commands={note.problem.commands} />
          </div>
        </div>
        <NoteButtons
          ids={hostActionsFor(problem, { surface: 'picker', replica })}
          actions={actions} onRetry={connectThenRelist} onOpenSettings={openSettings}
        />
        <NoteMessage actions={actions} />
      </div>
    );
  }

  // connect / listing / give-up: the shared failure text, then its buttons.
  const failure = note.type === 'giveup'
    ? { headline: note.headline, hint: note.hint, summary: '', kind: 'timeout', retryAt: undefined, ids: replica ? [] : ['retry'] as HostActionId[] }
    : note.type === 'listing'
      ? { headline: note.problem.headline, hint: note.problem.hint, summary: note.problem.summary, kind: 'listing', retryAt: undefined, ids: hostActionsFor(note.problem, { surface: 'picker', replica }) }
      : { headline: note.problem.headline, hint: note.problem.hint, summary: note.problem.summary, kind: note.problem.kind, retryAt: note.problem.retryAt, ids: hostActionsFor(note.problem, { surface: 'picker', replica }) };
  const listing = note.type === 'listing';
  return (
    <div className="sps-host-note sps-host-note-failure" data-host={hostKey} data-type={note.type} data-kind={failure.kind}>
      <div className="sps-host-note-head">
        <HostStatusDot dot={listing ? { kind: 'warn', title: failure.headline } : { kind: 'failed', title: `${label}: ${failure.headline}` }} host={hostKey} />
        <div className="sps-host-note-body">
          <HostFailureText
            headline={failure.headline} hint={failure.hint} summary={failure.summary} kind={failure.kind}
            retryAt={failure.retryAt} lastFrameAt={status?.at}
          />
        </div>
      </div>
      <NoteButtons
        ids={failure.ids} actions={actions} onRetry={listing ? relisting.start : connectThenRelist} onOpenSettings={openSettings}
        {...(listing ? { relisting: relisting.running } : {})}
      />
      {!listing && <NoteMessage actions={actions} />}
    </div>
  );
}
