/**
 * First-run setup (core/first-run.ts): the dialog a fresh install opens with. For now one
 * question, "Add your other machines": the SSH hosts Walnut found in ~/.ssh/config, each
 * with Add, which says yes to it (POST /api/hosts/:host/found-answer: it connects, installs
 * the session daemon there if missing, and lists it in Settings › Remote Hosts). This
 * computer is listed first, as already there.
 *
 * Built for more questions: `steps` is the list the server says this install still asks,
 * each a component below; the dots show only with two or more.
 *
 * It never closes on an outside click (a stray click would answer the question). Escape,
 * Not now and Done close it, and each records the answer, so it never comes back by itself;
 * Settings › Remote Hosts › Add host › "Pick from your SSH config" opens the step again
 * (`mode: 'picker'`, which records nothing).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Config } from '@open-walnut/core';
import { ModalOverlayOwner, useModalOverlay } from '@/hooks/useModalOverlay';
import { useEvent } from '@/hooks/useWebSocket';
import { fetchConfig } from '@/api/config';
import { answerFoundHost, connectHost } from '@/api/hosts';
import { seedHostStatus, serverNow, useAllHostStatus, useHostStatus } from '@/hooks/useHostStatus';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { HostFailureText } from '@/components/hosts/HostFailureText';
import type { FirstRunStep } from '@/api/first-run';
import { WalkthroughSteps, useSshKey } from '@/components/hosts/SshWalkthrough';
import { addedRowState, firstRunHostRows, type FirstRunHostRow } from './first-run-model';
import '@/styles/first-run.css';

export type FirstRunMode = 'first-run' | 'picker';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A host already said yes to, while it connects or once it did (a failure is AddedFailure, under the row). */
function AddedState({ row }: { row: FirstRunHostRow }) {
  const status = useHostStatus(row.alias);
  const state = addedRowState(row, status, serverNow());
  if (state.type === 'connected') {
    return <span className="fr-state fr-state-ok" data-testid={`first-run-state-${row.alias}`}><span className="fr-dot fr-dot-ok" aria-hidden="true" />{state.words}</span>;
  }
  if (state.type === 'off') {
    return <span className="fr-state fr-state-muted" data-testid={`first-run-state-${row.alias}`}>{state.words}</span>;
  }
  if (state.type === 'connecting') {
    return <span className="fr-state fr-state-busy" data-testid={`first-run-state-${row.alias}`}><span className="fr-spinner" aria-hidden="true" />{state.words}</span>;
  }
  return null;
}

/** A try that fails at once would look like nothing happened: the button stays busy this long. */
const RETRY_MIN_MS = 800;

function AddedFailure({ row, onUndo, onRetry }: { row: FirstRunHostRow; onUndo: () => void; onRetry: () => void }) {
  const status = useHostStatus(row.alias);
  const [retrying, setRetrying] = useState(false);
  const [retriedAt, setRetriedAt] = useState<number | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const kind = addedRowState(row, status, serverNow()).type === 'failed' ? (status?.kind ?? status?.lastKind) : undefined;
  const key = useSshKey(row.alias, kind === 'auth' || kind === 'agent_missing');
  const state = addedRowState(row, status, serverNow(), key);
  if (state.type !== 'failed') return null;
  const retry = async () => {
    onRetry();
    const started = Date.now();
    setRetrying(true);
    setRetryError(null);
    try {
      seedHostStatus(await connectHost(row.alias));
    } catch (err) {
      setRetryError(errorText(err));
    } finally {
      const left = RETRY_MIN_MS - (Date.now() - started);
      if (left > 0) await new Promise((ok) => window.setTimeout(ok, left));
      setRetrying(false);
      setRetriedAt(Date.now());
    }
  };
  const walk = state.walkthrough;
  return (
    <div className="fr-failure" data-testid={`first-run-failure-${row.alias}`} data-kind={state.kind}>
      {walk
        ? <>
          <div className="fr-failure-headline">{walk.headline}</div>
          <WalkthroughSteps walk={walk} alias={row.alias} />
          {state.summary && <HostFailureText headline="" summary={state.summary} kind={state.kind} />}
        </>
        : <HostFailureText headline={state.headline} hint={state.hint} summary={state.summary} kind={state.kind} retryAt={state.retryAt} lastFrameAt={status?.at} />}
      <div className="fr-failure-actions">
        {/* A machine that is not Linux never connects over SSH: trying again only fails again. */}
        {state.kind !== 'not_linux' && (
          <button type="button" tabIndex={0} className="app-modal-btn primary" onClick={() => void retry()} disabled={retrying} data-testid={`first-run-retry-${row.alias}`}>
            {retrying ? 'Trying…' : 'Try again'}
          </button>
        )}
        <button type="button" tabIndex={0} className="app-modal-btn" onClick={onUndo} disabled={retrying} data-testid={`first-run-undo-${row.alias}`}>
          Don&apos;t add it
        </button>
        {retryError
          ? <span className="fr-error" role="alert">{retryError}</span>
          : retriedAt && !retrying && <span className="fr-tried" role="status" data-testid={`first-run-tried-${row.alias}`}>{`Still not connected (tried at ${new Date(retriedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })})`}</span>}
      </div>
    </div>
  );
}

function HostRow({ row, adding, addError, onAdd, onUndo }: {
  row: FirstRunHostRow;
  adding: boolean;
  addError: string | null;
  onAdd: () => void;
  onUndo: () => void;
}) {
  const status = useHostStatus(row.alias);
  const stateType = row.waits ? 'waits' : addedRowState(row, status, serverNow()).type;
  const failed = stateType === 'failed';
  // A Try again's answer can come half a minute later, below the visible part of the list:
  // once it lands (failed again, or connected), the row scrolls into view.
  const liRef = useRef<HTMLLIElement | null>(null);
  const follow = useRef(false);
  useEffect(() => {
    if (!follow.current || stateType === 'connecting') return;
    follow.current = false;
    liRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [stateType, status?.at]);
  return (
    <li ref={liRef} className={`fr-host${failed ? ' fr-host-failed' : ''}`} data-testid={`first-run-host-${row.alias}`} data-added={row.waits ? 'no' : 'yes'}>
      <div className="fr-host-line">
        <span className="fr-host-text">
          <span className="fr-host-name">{row.name}</span>
          <span className="fr-host-address">{row.address}</span>
        </span>
        <span className="fr-host-end">
          {row.waits
            ? (
              <button
                type="button"
                tabIndex={0}
                className="app-modal-btn fr-add"
                onClick={onAdd}
                disabled={adding}
                aria-label={`Add ${row.name}`}
                data-testid={`first-run-add-${row.alias}`}
              >
                {adding ? 'Adding…' : 'Add'}
              </button>
            )
            : !failed && <AddedState row={row} />}
        </span>
      </div>
      {row.waits && addError && <div className="fr-error" role="alert">{`Could not add ${row.name}: ${addError}`}</div>}
      {!row.waits && <AddedFailure row={row} onUndo={onUndo} onRetry={() => { follow.current = true; }} />}
    </li>
  );
}

function HostsStep({ hosts, saidYes, onSaidYes, onUndone, onAddByHand }: {
  hosts: Config['hosts'] | undefined;
  /** Hosts this dialog said yes to: shown as added at once, before the config change comes back. */
  saidYes: ReadonlySet<string>;
  onSaidYes: (alias: string) => void;
  /** A host taken back (its "Don't add it"): it waits for a yes again. */
  onUndone: (alias: string) => void;
  onAddByHand: () => void;
}) {
  const rows = firstRunHostRows(hosts);
  // Every Add in flight (two clicked in a row each keep their spinner until their own answer).
  const [adding, setAdding] = useState<ReadonlySet<string>>(() => new Set());
  const [addError, setAddError] = useState<{ alias: string; text: string } | null>(null);
  // Rows keep the place they first showed in while the dialog is open: an Add that moved its row
  // put the next host's Add under the pointer (2026-11-11 review).
  const order = useRef(new Map<string, number>());
  for (const r of rows) if (!order.current.has(r.alias)) order.current.set(r.alias, order.current.size);
  const shown = rows
    .map((r) => (saidYes.has(r.alias) ? { ...r, waits: false } : r))
    .sort((a, b) => (order.current.get(a.alias) ?? 0) - (order.current.get(b.alias) ?? 0));
  const add = async (alias: string) => {
    if (adding.has(alias)) return;
    setAdding((prev) => new Set(prev).add(alias));
    setAddError(null);
    try {
      const r = await answerFoundHost(alias, 'yes');
      seedHostStatus(r.status);
      onSaidYes(alias);
      // The Add that had the focus is gone: the next host's Add takes it, else the way out.
      window.setTimeout(() => {
        const next = document.querySelector<HTMLButtonElement>('.fr-modal .fr-add:not(:disabled)')
          ?? document.querySelector<HTMLButtonElement>('[data-testid="first-run-primary"]');
        if (next && (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected)) next.focus();
      }, 0);
    } catch (err) {
      setAddError({ alias, text: errorText(err) });
    } finally {
      setAdding((prev) => { const next = new Set(prev); next.delete(alias); return next; });
    }
  };
  // "Don't add it" on a host that could not connect: Not now, so it waits with its Add again.
  const undo = async (alias: string) => {
    setAddError(null);
    try {
      await answerFoundHost(alias, 'not_now');
      onUndone(alias);
    } catch (err) {
      setAddError({ alias, text: errorText(err) });
    }
  };
  return (
    <div className="fr-step" data-testid="first-run-step-hosts">
      <h2 className="fr-step-title">Add your other machines</h2>
      <p className="fr-step-lead">
        Walnut can run your sessions on the machines you reach with SSH. Add them from your SSH config:
        Walnut connects to each one and installs what it needs there.
      </p>
      <ul className="fr-hosts" data-testid="first-run-hosts">
        <li className="fr-host fr-host-here" data-testid="first-run-host-here">
          <div className="fr-host-line">
            <span className="fr-host-text"><span className="fr-host-name">This computer</span></span>
            <span className="fr-host-end"><span className="fr-state fr-state-ok"><span className="fr-dot fr-dot-ok" aria-hidden="true" />Walnut runs here</span></span>
          </div>
        </li>
        {shown.map((row) => (
          <HostRow
            key={row.alias}
            row={row}
            adding={adding.has(row.alias)}
            addError={addError?.alias === row.alias ? addError.text : null}
            onAdd={() => void add(row.alias)}
            onUndo={() => void undo(row.alias)}
          />
        ))}
      </ul>
      {rows.length === 0 && (
        <p className="fr-empty" data-testid="first-run-hosts-empty">No machines found in ~/.ssh/config.</p>
      )}
      <button type="button" tabIndex={0} className="fr-link" onClick={onAddByHand} data-testid="first-run-add-by-hand">
        + Add a machine that is not listed
      </button>
    </div>
  );
}

export function FirstRunDialog({ steps, mode, onClose, onAddByHand }: {
  steps: FirstRunStep[];
  mode: FirstRunMode;
  /**
   * `added`: the person added at least one host here. `answered`: the person closed it (Done,
   * Not now, Escape); false when Walnut closed it for them (a link that navigates away closes
   * every modal), which records nothing, so the question comes back.
   */
  onClose: (how: { added: boolean; answered: boolean }) => void;
  onAddByHand: () => void;
}) {
  const [config, setConfig] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  // Only the newest read applies: an older one landing late (the yes's config:changed after
  // the "Don't add it" overlay) would show the host as added again.
  const readSeq = useRef(0);
  const read = useCallback(() => {
    const seq = ++readSeq.current;
    fetchConfig()
      .then((c) => { if (seq === readSeq.current) { setConfig(c); setLoadError(null); } })
      .catch((err) => { if (seq === readSeq.current) setLoadError(errorText(err)); });
  }, []);
  useEffect(read, [read]);
  useEvent('config:changed', read);

  // Done once this dialog added a host.
  const [saidYes, setSaidYes] = useState<Set<string>>(() => new Set());
  const onSaidYes = useCallback((alias: string) => setSaidYes((prev) => new Set(prev).add(alias)), []);
  const onUndone = useCallback((alias: string) => {
    setSaidYes((prev) => { const next = new Set(prev); next.delete(alias); return next; });
    // The config read may still say yes for a moment: lay the answer over it, and drop reads in flight.
    readSeq.current += 1;
    setConfig((c) => (c?.hosts?.[alias] ? { ...c, hosts: { ...c.hosts, [alias]: { ...c.hosts[alias], connect: 'not_now', enabled: false } } } : c));
  }, []);
  const addedHere = saidYes.size > 0;
  // Done once a host added here connected; Close while the added ones still connect or failed.
  // Every host the list shows as added (said yes here, or before, a reload included), so the
  // button and the footer read the same before and after a reload.
  const statuses = useAllHostStatus();
  const statusOf = (alias: string) => statuses.find((s) => s.host === alias);
  const addedAliases = new Set([...saidYes, ...firstRunHostRows(config?.hosts).filter((r) => !r.waits).map((r) => r.alias)]);
  const connectedHere = [...addedAliases].some((a) => statusOf(a)?.connected);
  const failedHere = !connectedHere && [...addedAliases].some((a) => { const s = statusOf(a); return !!s && !s.connected && (s.phase === 'failed' || !!s.lastError); });

  const close = useCallback(() => onClose({ added: addedHere, answered: true }), [onClose, addedHere]);
  const owner = useModalOverlay(useCallback(() => onClose({ added: addedHere, answered: false }), [onClose, addedHere]));
  // Focus starts on the dialog itself: Tab reaches the first Add, and nothing looks picked yet.
  const modalRef = useRef<HTMLDivElement | null>(null);
  // Tab stays inside the dialog, and Escape closes it as Not now (the page under it takes no key).
  useOverlayLayer({ open: true, refs: [modalRef], closeOnOutside: false, trapFocus: true, onClose: (reason) => { if (reason === 'escape') close(); } });
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !config) return;
    focused.current = true;
    const t = window.setTimeout(() => modalRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [config]);

  const step = steps[index] ?? 'hosts';
  const last = index >= steps.length - 1;
  // Done once a host is connected; Close while added hosts have not connected (and always in
  // Settings' picker, where nothing is skipped); Not now when nothing was added.
  const primaryLabel = !last ? 'Next' : connectedHere ? 'Done' : addedAliases.size > 0 || mode === 'picker' ? 'Close' : 'Not now';
  const primaryStrong = !last || connectedHere;
  const primary = () => (last ? close() : setIndex(index + 1));

  return createPortal(
    <ModalOverlayOwner.Provider value={owner}>
      <div className="app-modal-overlay fr-overlay" role="dialog" aria-modal="true" aria-label={mode === 'picker' ? 'Add machines from your SSH config' : 'Set up Walnut'} data-testid="first-run-dialog">
        <div className="app-modal fr-modal" ref={modalRef} tabIndex={-1}>
          <div className="fr-head">
            <div className="app-modal-title">{mode === 'picker' ? 'Remote Hosts' : 'Set up Walnut'}</div>
            {steps.length > 1 && (
              <div className="fr-dots" aria-label={`Step ${index + 1} of ${steps.length}`}>
                {steps.map((s, i) => <span key={s} className={`fr-dot-step${i === index ? ' on' : ''}`} />)}
              </div>
            )}
          </div>
          <div className="fr-body">
            {loadError && <div className="fr-error" role="alert">{`Could not read your settings: ${loadError}`}</div>}
            {!config && !loadError && <div className="fr-state fr-state-busy"><span className="fr-spinner" aria-hidden="true" />Looking for your machines…</div>}
            {config && step === 'hosts' && <HostsStep hosts={config.hosts} saidYes={saidYes} onSaidYes={onSaidYes} onUndone={onUndone} onAddByHand={onAddByHand} />}
          </div>
          <div className="fr-foot">
            <span className="fr-later" data-testid="first-run-later">
              {mode === 'picker'
                ? 'Hosts you add here show in Remote Hosts.'
                : failedHere
                  ? 'Hosts that could not connect stay in Remote Hosts. To see these steps again: Add host › Pick from your SSH config.'
                  : 'You can add machines any time in Settings › Remote Hosts.'}
            </span>
            <span className="fr-actions">
              {index > 0 && <button type="button" tabIndex={0} className="app-modal-btn" onClick={() => setIndex(index - 1)}>Back</button>}
              <button
                type="button"
                tabIndex={0}
                className={`app-modal-btn${primaryStrong ? ' primary' : ''}`}
                onClick={primary}
                data-testid="first-run-primary"
              >
                {primaryLabel}
              </button>
            </span>
          </div>
        </div>
      </div>
    </ModalOverlayOwner.Provider>,
    document.body,
  );
}
