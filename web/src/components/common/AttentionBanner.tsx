/**
 * The ONE home banner for "something needs you": this machine's Claude Code
 * first (it silences Walnut itself), then the remote hosts that cannot run a
 * session (connect failures and readiness problems). A single card, so there
 * are never two host banners, two titles and two x buttons.
 *
 * Rows come from the pure model (utils/attention-banner-model.ts); this file
 * owns the live inputs (host store, dismissed keys, pointer inside, a timer
 * for the next time-based change) and the interactions: row x with a 150ms
 * collapse and focus to the next row's x, Dismiss all (last in Tab order),
 * 'and N more' and Open Settings through openHostSettings.
 *
 * `compact` is the draft-column mount used while the Ask Walnut slot is
 * hidden: the same rows, keys and cap, without the card title or the local
 * section, and without the hosts a refused-Start bar below it already speaks for.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SystemHealth } from '@/hooks/useSystemHealth';
import { serverNow, useAllHostStatus, useHostStatusHydration } from '@/hooks/useHostStatus';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { openHostSettings } from '@/utils/host-settings-nav';
import {
  EMPTY_BANNER_STATE, READY_HOLD_MS, activeHiddenIds, dismissFocusIndex, nextBanner, rowHasDismiss,
  type BannerRow, type BannerState,
} from '@/utils/attention-banner-model';
import { dismissHostKeys, getHostDismissed, pruneHostDismissed, subscribeHostDismissed } from '@/utils/host-banner-dismiss';
import { useUserEngagedHosts, useUserRetryingHosts } from '@/utils/host-user-retrying';
import { useGateBarHosts } from '@/utils/host-gate-shown';
import { useLocalClaudeNotice } from './SetupBanner';
import { GroupRow, ReadyRow, SingleHostRow } from './HostProblemRows';
import { log } from '@/utils/log';
import '@/styles/attention-banner.css';

export const DISMISS_ALL_LABEL = 'Dismiss all';
const COLLAPSE_MS = 150;
/** A pending "focus the next x" that did not land by then is dropped (it must never steal focus later). */
const FOCUS_NEXT_TTL_MS = COLLAPSE_MS + 1_000;
/** A connected host's connect dismissal can expire with no new frame: look again this often. */
const PRUNE_EVERY_MS = 60_000;

interface AttentionBannerProps {
  health?: SystemHealth;
  healthLoading?: boolean;
  onNavigateSettings: (hash?: string) => void;
  onStartSession?: () => void;
  /** The draft-column mount (Ask Walnut slot hidden): no title, no local section. */
  compact?: boolean;
}

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The first focusable element after `el` in document order (the composer, usually). */
function focusAfter(el: HTMLElement | null): void {
  if (!el) return;
  const all = Array.from(document.querySelectorAll<HTMLElement>('button, [href], input, textarea, select, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'));
  const next = all.find((c) => !el.contains(c) && (el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) && c.getClientRects().length > 0);
  next?.focus();
}

/** The slot's height as a CSS variable: the host section caps itself at 40% of it. */
function useSlotHeight(el: HTMLDivElement | null, compact?: boolean): number | null {
  const [h, setH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const slot = el?.closest<HTMLElement>(compact ? '.main-page-session-column, .draft-session-panel' : '.main-page-chat');
    if (!slot || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setH(slot.getBoundingClientRect().height));
    ro.observe(slot);
    setH(slot.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, [el, compact]);
  return h;
}

export function AttentionBanner({ health, healthLoading, onNavigateSettings, onStartSession, compact }: AttentionBannerProps) {
  const local = useLocalClaudeNotice({ health: health ?? {}, loading: healthLoading || !health, onNavigateSettings, onStartSession });
  const localPresent = !compact && local.present;
  const allStatuses = useAllHostStatus();
  const hydration = useHostStatusHydration();
  const dismissed = useSyncExternalStore(subscribeHostDismissed, getHostDismissed);
  const replica = useIsCloudReplica();
  const userRetrying = useUserRetryingHosts();
  const engaged = useUserEngagedHosts();
  const gateHosts = useGateBarHosts();
  // The draft column's compact banner leaves out a host its own gate bar speaks for.
  const statuses = compact && gateHosts.size ? allStatuses.filter((s) => !gateHosts.has(s.host)) : allStatuses;
  const navigate = useNavigate();
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const slotH = useSlotHeight(el, compact);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  // Success rows hidden by Dismiss all -> the server time their 3s would end.
  const [hidden, setHidden] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const [, setWake] = useState(0);
  const stateRef = useRef<BannerState>(EMPTY_BANNER_STATE);
  const focusNextRef = useRef<{ index: number; until: number } | null>(null);

  // Hydration not done: no host section at all (never a flash of 'unknown').
  const hydrated = hydration === 'done' || hydration === 'unsupported' || hydration === 'failed';
  const now = serverNow();
  const { view, state } = nextBanner({
    statuses: hydrated ? statuses : [], dismissed, now, replica,
    pointerInside: pointerInside || focusInside, localPresent, hiddenIds: activeHiddenIds(hidden, now),
    userRetrying, engaged,
  }, stateRef.current);
  // Derived state from the previous frame (idempotent for the same input, so a double render is safe).
  stateRef.current = state;

  // A time-based change with no new frame (3s success hold, 2-minute reconnect, deferral cap).
  useEffect(() => {
    if (view.wakeAt === null) return;
    const t = setTimeout(() => setWake((n) => n + 1), Math.max(0, view.wakeAt - serverNow()) + 30);
    return () => clearTimeout(t);
  }, [view.wakeAt]);

  // Expire dismissals the frames answer (a cleared problem, 10 connected minutes).
  // Judged on every host, the gate-bar ones included.
  useEffect(() => {
    if (!hydrated) return;
    pruneHostDismissed(allStatuses, serverNow());
    if (dismissed.size === 0) return;
    const t = setInterval(() => pruneHostDismissed(allStatuses, serverNow()), PRUNE_EVERY_MS);
    return () => clearInterval(t);
  }, [allStatuses, hydrated, dismissed.size]);

  // A hidden success row is forgotten when its own 3s would have ended, so the
  // same host healing again later shows its success row.
  useEffect(() => {
    if (hidden.size === 0) return;
    const next = Math.min(...hidden.values());
    const t = setTimeout(() => {
      setHidden((m) => {
        const at = serverNow();
        const kept = new Map([...m].filter(([, until]) => until > at));
        return kept.size === m.size ? m : kept;
      });
    }, Math.max(0, next - serverNow()) + 30);
    return () => clearTimeout(t);
  }, [hidden]);

  const hostEntries = view.rows.some((r) => r.type !== 'ready') || view.more > 0;

  const commitDismiss = useCallback((row: BannerRow) => {
    setLeaving((s) => { const n = new Set(s); n.delete(row.id); return n; });
    dismissHostKeys(row.dismissKeys);
    log.info('attention-banner', 'row dismissed', { row: row.id, keys: row.dismissKeys.join(',') });
  }, []);

  const onDismissRow = useCallback((row: BannerRow) => {
    // Counted among the rows that draw an x: the same list the focus effect queries.
    focusNextRef.current = { index: dismissFocusIndex(view.rows, row.id), until: Date.now() + FOCUS_NEXT_TTL_MS };
    if (prefersReducedMotion()) { commitDismiss(row); return; }
    setLeaving((s) => new Set(s).add(row.id));
    setTimeout(() => commitDismiss(row), COLLAPSE_MS);
  }, [view.rows, commitDismiss]);

  const onDismissAll = useCallback(() => {
    dismissHostKeys(view.allKeys);
    const at = serverNow();
    const ready = stateRef.current.ready;
    setHidden((m) => {
      const next = new Map(m);
      for (const r of view.rows) if (r.type === 'ready') next.set(r.id, ready[r.id] ?? at + READY_HOLD_MS);
      return next;
    });
    log.info('attention-banner', 'dismissed all host rows', { count: view.allKeys.length });
    requestAnimationFrame(() => focusAfter(el));
  }, [view.allKeys, view.rows, el]);

  // After a row x: focus moves to the next row's x (else past the card). The
  // intent expires: if the rows never settle into the expected shape (a new
  // row arrived, a deferral held one), it is dropped rather than firing later.
  useLayoutEffect(() => {
    const pendingFocus = focusNextRef.current;
    if (pendingFocus === null || !el) return;
    if (Date.now() > pendingFocus.until) { focusNextRef.current = null; return; }
    const xs = Array.from(el.querySelectorAll<HTMLButtonElement>('li.hpb-row:not(.hpb-leaving) .hpb-x'));
    if (xs.length === view.rows.filter(rowHasDismiss).length && !leaving.size) {
      focusNextRef.current = null;
      const i = pendingFocus.index;
      if (i >= 0 && xs[i]) xs[i].focus();
      else focusAfter(el);
    }
  });
  useEffect(() => () => { focusNextRef.current = null; }, []);

  const onOpenSettings = useCallback((alias?: string) => openHostSettings(navigate, alias), [navigate]);

  if (!localPresent && view.rows.length === 0) return null;
  const style = slotH ? ({ '--ab-slot-h': `${Math.round(slotH)}px` } as CSSProperties) : undefined;
  return (
    <div
      ref={setEl}
      className={`setup-banner attention-banner${compact ? ' attention-banner-compact' : ''}`}
      data-testid="attention-banner"
      style={style}
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
      // Keyboard focus holds rows in place like the pointer does; the focus a
      // mouse click leaves on a button does not (the pointer already said where it is).
      onFocus={(e) => setFocusInside(!!(e.target as HTMLElement).matches?.(':focus-visible'))}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusInside(false); }}
    >
      {localPresent && local.node}
      {view.rows.length > 0 && (
        <section className="hpb" data-testid="host-problems" role="status" aria-live="polite" aria-label="Remote hosts">
          {!compact && !localPresent && view.title && (
            <div className="setup-banner-header hpb-header"><span className="setup-banner-title">{view.title}</span></div>
          )}
          {view.subhead && <div className="hpb-subhead">{view.subhead}</div>}
          <div className="hpb-scroll">
            <ul className="hpb-rows">
              {view.rows.map((row, i) => {
                const props = { row, defaultExpanded: i === 0, leaving: leaving.has(row.id), onDismiss: onDismissRow, onOpenSettings };
                if (row.type === 'ready') return <ReadyRow key={row.id} row={row} leaving={props.leaving} />;
                if (row.id.startsWith('cred:')) return <GroupRow key={row.id} {...props} />;
                return <SingleHostRow key={row.id} {...props} />;
              })}
            </ul>
            {view.more > 0 && (
              <button type="button" tabIndex={0} className="hpb-more" onClick={() => onOpenSettings()}>
                and {view.more} more
              </button>
            )}
          </div>
        </section>
      )}
      {hostEntries && (
        <button type="button" tabIndex={0} className="setup-banner-dismiss ab-dismiss-all" aria-label={DISMISS_ALL_LABEL} onClick={onDismissAll}>
          &times;
        </button>
      )}
    </div>
  );
}
