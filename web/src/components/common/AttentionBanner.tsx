/**
 * The ONE card for "something needs you": this machine's Claude Code first
 * (it silences Walnut itself), then the remote hosts that cannot run a
 * session (connect failures and readiness problems). One card, so there are
 * never two host banners, two titles and two sets of x buttons.
 *
 * It renders wherever the owner rule puts it (`mount`: the task panel, the
 * notification panel, the Ask Walnut slot, or compact in the draft column);
 * the wrapper and its reserve belong to AttentionBannerMount. Rows come from
 * the pure model (utils/attention-banner-model.ts); the frame state, the
 * Dismiss all hidden rows and each row's expanded flag live in the page
 * session (utils/attention-banner-session.ts), so a remount elsewhere
 * continues from the last frame. This file owns the interactions: a row x,
 * the local x and Dismiss all turn into undo lines (banner-undo.tsx),
 * 'and N more' and Open Settings leave through onLeave + openHostSettings.
 *
 * `draft` is the compact variant: the same rows, keys and cap, without the
 * card title or the local section, and without the hosts a refused-Start bar
 * below it already speaks for. Dismiss all is the same quiet text button at the
 * end of the list on every mount (a corner x sat 5px from a row x, N3).
 */
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SystemHealth } from '@/hooks/useSystemHealth';
import { serverNow, useAllHostStatus, useHostStatusHydration } from '@/hooks/useHostStatus';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { openHostSettings } from '@/utils/host-settings-nav';
import { HOST_SUBHEAD, HOST_TITLE, READY_HOLD_MS, activeHiddenIds, nextBanner, type BannerRow } from '@/utils/attention-banner-model';
import {
  dismissHostKeys, getHostDismissed, subscribeHostDismissed, undismissHostKeys, undismissLocal,
} from '@/utils/host-banner-dismiss';
import { setBannerRowsDeferred, type BannerMount } from '@/utils/host-banner-placement';
import {
  cardMounted, getBannerState, isResumingAfterGap, setBannerState, withoutReplayedReady,
} from '@/utils/attention-banner-session';
import { useUserEngagedHosts, useUserRetryingHosts } from '@/utils/host-user-retrying';
import { useGateBarHosts } from '@/utils/host-gate-shown';
import { useLocalClaudeNotice } from './SetupBanner';
import { GroupRow, ReadyRow, SingleHostRow } from './HostProblemRows';
import { UNDO_ALL_TEXT, UNDO_ROW_TEXT, UndoLine, undoAllText, undoRowText, useBannerUndo, withUndoSlots, type UndoEntry } from './banner-undo';
import {
  CARD_MIN_CAP_PX, cardCapPx, focusAfter, prefersReducedMotion, useHeldLayout, useHiddenReady, useMountHeight, usePointerFocus, useWakeAt, verticalMarginPx,
} from './attention-banner-hooks';
import { fitsTight, keepRowInView, nextCompact, scrollRowIntoView, undoLinePx, useFirstRowMin, useScrollBudget, useScrollCue } from './banner-scroll';
import { log } from '@/utils/log';
import '@/styles/attention-banner.css';
import '@/styles/attention-banner-dense.css';
import '@/styles/attention-banner-fit.css';

export const DISMISS_ALL_LABEL = 'Dismiss all';

export interface AttentionBannerProps {
  mount: BannerMount;
  health?: SystemHealth;
  healthLoading?: boolean;
  onNavigateSettings: (hash?: string) => void;
  onStartSession?: () => void;
  /** Called BEFORE any navigation away (Open Settings, 'and N more', the local Settings link). */
  onLeave?: () => void;
  /** Focus target when an undo line with focus inside collapses and no row x follows it. */
  focusOnLeave?: () => void;
  /** Queue height changes (at most 10s from the first) while the pointer is where they would land. */
  holdLayout?: boolean;
  /** Each host row is one line: headline, the primary action, the x; row 1 not auto-expanded. */
  singleLineRows?: boolean;
}

/** How many hosts need attention, shown or not (rows on screen, scrolled, behind 'and N more'). */
export function hostCount(rows: readonly BannerRow[], moreHosts: readonly string[]): number {
  const hosts = new Set<string>();
  for (const r of rows) if (r.type !== 'ready') for (const h of r.hosts) hosts.add(h);
  for (const h of moreHosts) hosts.add(h);
  return hosts.size;
}

/** '4 hosts' after the card title. */
export function hostCountText(rows: readonly BannerRow[], moreHosts: readonly string[]): string {
  const n = hostCount(rows, moreHosts);
  return n ? `${n} host${n === 1 ? '' : 's'}` : '';
}

/** '(4)' after the 'Remote hosts' subhead, which already says hosts (N15). */
export function subheadCountText(rows: readonly BannerRow[], moreHosts: readonly string[]): string {
  const n = hostCount(rows, moreHosts);
  return n ? `(${n})` : '';
}

interface CardLayout {
  rows: BannerRow[];
  more: number;
  moreHosts: string[];
  title: string | null;
  subhead: string | null;
  localNode: ReactNode;
  undo: UndoEntry[];
}

/** What changes the card's height: the held layout compares these. */
function layoutSignature(l: CardLayout, localKind: string | null): string {
  return [
    `local:${localKind ?? ''}`, l.title ? 'title' : '', l.subhead ?? '', `more:${l.more}`,
    ...l.rows.map((r) => r.id), ...l.undo.map((e) => `${e.id}${e.collapsing ? '~' : ''}`),
  ].join('|');
}

export function AttentionBanner({
  mount, health, healthLoading, onNavigateSettings, onStartSession, onLeave, focusOnLeave, holdLayout, singleLineRows: singleProp,
}: AttentionBannerProps) {
  const compact = mount === 'draft';
  const navigate = useNavigate();
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const { pointerInside, focusInside, handlers } = usePointerFocus(el);
  const leaveToSettings = useCallback((hash?: string) => { onLeave?.(); onNavigateSettings(hash); }, [onLeave, onNavigateSettings]);
  // Set further down (it needs the undo store); the local section calls it on its x.
  const localDismissedRef = useRef<(key: string) => void>(() => {});
  const onLocalDismissed = useCallback((key: string) => localDismissedRef.current(key), []);
  const local = useLocalClaudeNotice({
    health: health ?? {}, loading: healthLoading || !health, onNavigateSettings: leaveToSettings, onStartSession,
    onDismissed: onLocalDismissed,
  });

  // An undo line leaving with focus inside: the next row's x, else the mount's named target.
  const onUndoGone = useCallback((entry: UndoEntry, hadFocus: boolean) => {
    if (!hadFocus || !el) return;
    const node = el.querySelector(`[data-undo-id="${entry.id}"]`);
    const xs = Array.from(el.querySelectorAll<HTMLElement>('li.hpb-row:not(.hpb-leaving) .hpb-x'));
    const next = node ? xs.find((x) => node.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) : undefined;
    if (next) next.focus();
    else if (focusOnLeave) focusOnLeave();
    else focusAfter(el);
  }, [el, focusOnLeave]);
  const undo = useBannerUndo({ pointerInside, reducedMotion: prefersReducedMotion, onGone: onUndoGone, root: el });
  const localUndoLive = undo.entries.some((e) => e.kind === 'local');
  const localPresent = !compact && (local.present || localUndoLive);

  const allStatuses = useAllHostStatus();
  const hydration = useHostStatusHydration();
  const dismissed = useSyncExternalStore(subscribeHostDismissed, getHostDismissed);
  const replica = useIsCloudReplica();
  const userRetrying = useUserRetryingHosts();
  const engaged = useUserEngagedHosts();
  const gateHosts = useGateBarHosts();
  // The draft column's compact card leaves out a host its own gate bar speaks for.
  const statuses = compact && gateHosts.size ? allStatuses.filter((s) => !gateHosts.has(s.host)) : allStatuses;
  const mountH = useMountHeight(el, mount);
  const marginY = verticalMarginPx(el);
  // A cap at its 132px floor (a phone's task band, a very short panel) cannot hold
  // an opened row plus its buttons, so every row is one line there: headline + first action.
  const singleLineRows = !!singleProp || (mountH != null && cardCapPx(mountH, marginY) <= CARD_MIN_CAP_PX);
  // The task panel's card box itself is at most max(40%, 132px) (spec 4.1, C28, C61): its margin
  // is outside that box. Elsewhere the margin stays inside the cap (the panel body keeps 60%, C29).
  const capMargin = mount === 'tasks' ? 0 : marginY;
  const [hidden, setHidden] = useHiddenReady();

  // Hydration not done: no host section at all (never a flash of 'unknown').
  const hydrated = hydration === 'done' || hydration === 'unsupported' || hydration === 'failed';
  const now = serverNow();
  const prev = getBannerState();
  let frame = nextBanner({
    statuses: hydrated ? statuses : [], dismissed, now, replica,
    pointerInside: pointerInside || focusInside, localPresent, hiddenIds: activeHiddenIds(hidden, now),
    userRetrying, engaged,
  }, prev);
  // Back after a while with no card anywhere: a heal that happened meanwhile is not replayed.
  if (isResumingAfterGap()) frame = withoutReplayedReady(frame, prev);
  // The session keeps the frame (idempotent for the same input, so a double render is safe).
  setBannerState(frame.state);
  const { view } = frame;
  useWakeAt(view.wakeAt);
  useLayoutEffect(() => cardMounted(), []);

  const live: CardLayout = {
    rows: view.rows, more: view.more, moreHosts: view.moreHosts, title: view.title, subhead: view.subhead,
    localNode: !compact && local.present ? local.node : null, undo: undo.entries,
  };
  const readySeenRef = useRef(new Map<string, BannerRow>());
  const held = useHeldLayout(live, layoutSignature(live, !compact && local.present ? local.kind : null), !!holdLayout);
  const shown = held.value;
  // Held structure, live contents: a row still in the model renders its latest frame.
  // A host that healed while the layout is held shows its success line in its row's
  // place at once (same height, nothing moves), and keeps it until the hold ends,
  // even past the model's 3s: never its stale failure again (C22).
  const liveById = new Map(view.rows.map((r) => [r.id, r]));
  const readySeen = readySeenRef.current;
  for (const r of view.rows) if (r.type === 'ready') readySeen.set(r.hosts[0], r);
  if (shown === live) {
    for (const h of Array.from(readySeen.keys())) if (!liveById.has(`ready:${h}`)) readySeen.delete(h);
  }
  const rows = shown.rows.map((r) => liveById.get(r.id)
    ?? (r.type !== 'ready' && r.hosts.length === 1 ? readySeen.get(r.hosts[0]) : undefined)
    ?? r);
  // A new host row held back under a resting pointer: the bell says it until it lands (spec 5.5).
  const shownIds = new Set(shown.rows.map((r) => r.id));
  const deferredNew = view.rows.some((r) => r.type !== 'ready' && !shownIds.has(r.id));
  useLayoutEffect(() => { setBannerRowsDeferred(deferredNew); }, [deferredNew]);
  useLayoutEffect(() => () => setBannerRowsDeferred(false), []);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const rowsKey = `${rows.map((r) => r.id).join('|')}#${shown.undo.length}`;
  const { below, above, clamped } = useScrollCue(scrollEl, rowsKey);
  useFirstRowMin(scrollEl, rowsKey);
  // Inside the fitted form: one-line rows only when one two-line row does not fit (N3-3).
  const [compactRows, setCompactRows] = useState(false);
  const denseHead = useRef(0);
  const marginRef = useRef(0);
  marginRef.current = capMargin;
  const tightRef = useRef(false);
  const onRoom = useCallback((room: number, firstRow: number) => setCompactRows((prev) => {
    // Only the fitted card's own chrome counts (before it applies, the local chip still shows).
    if (!tightRef.current) return false;
    if (!prev && firstRow > 0) denseHead.current = firstRow;
    // Judged against the spec's own cap, max(40% of the mount, 132px) for the card's box (the
    // budget above also keeps the card's margin inside it), plus the head's 2px of slack.
    return nextCompact(prev, room + marginRef.current + 2, denseHead.current || undefined);
  }), []);
  useScrollBudget(el, scrollEl, mountH ? cardCapPx(mountH, capMargin) : null, rowsKey, onRoom);

  const rowHeight = (sel: string): number => el?.querySelector<HTMLElement>(sel)?.getBoundingClientRect().height ?? 0;

  const onDismissRow = (row: BannerRow) => {
    const slots = withUndoSlots(rows, undo.entries);
    const index = slots.findIndex((s) => 'row' in s && s.row.id === row.id);
    const before = getBannerState();
    const at = before.order.findIndex((r) => r.id === row.id);
    const stored = at >= 0 ? before.order[at] : row;
    const height = undoLinePx(el?.querySelector<HTMLElement>(`li.hpb-row[data-row-id="${row.id}"]`));
    held.flush();
    dismissHostKeys(row.dismissKeys);
    undo.add({
      id: `row:${row.id}`, kind: 'row', index: Math.max(0, index), height, text: undoRowText(row.labels),
      restore: () => {
        held.flush();
        // Back where it stood: the next frame keeps a row that is already in the order in its place.
        const cur = getBannerState();
        if (!cur.order.some((r) => r.id === stored.id)) {
          const order = [...cur.order];
          order.splice(Math.min(Math.max(0, at), order.length), 0, stored);
          setBannerState({ ...cur, order });
        }
        undismissHostKeys(row.dismissKeys);
        log.info('attention-banner', 'row dismiss undone', { row: row.id, mount });
      },
    });
    log.info('attention-banner', 'row dismissed', { row: row.id, keys: row.dismissKeys.join(','), mount });
  };

  const onDismissAll = () => {
    const keys = view.allKeys;
    const readyIds = view.rows.filter((r) => r.type === 'ready').map((r) => r.id);
    const before = getBannerState();
    // The host list's whole space (rows + foot) holds until the line collapses, so the
    // card shrinks once, not twice (N3-12).
    const scrollTop = el?.querySelector<HTMLElement>('.hpb-scroll')?.getBoundingClientRect().top;
    const hpbBottom = el?.querySelector<HTMLElement>('.hpb')?.getBoundingClientRect().bottom;
    const height = scrollTop != null && hpbBottom != null ? Math.max(0, Math.round(hpbBottom - scrollTop))
      : undoLinePx(el?.querySelector<HTMLElement>('li.hpb-row'));
    const problemRows = view.rows.filter((r) => r.type !== 'ready');
    const allText = undoAllText(hostCount(view.rows, view.moreHosts), problemRows.length === 1 && problemRows[0].labels.length === 1 ? problemRows[0].labels[0] : undefined);
    held.flush();
    dismissHostKeys(keys);
    const at = serverNow();
    setHidden((m) => {
      const next = new Map(m);
      for (const id of readyIds) next.set(id, before.ready[id] ?? at + READY_HOLD_MS);
      return next;
    });
    log.info('attention-banner', 'dismissed all host rows', { count: keys.length, mount });
    if (compact) { requestAnimationFrame(() => focusAfter(el)); return; }
    undo.add({
      id: 'all', kind: 'all', index: 0, height, text: allText,
      restore: () => {
        held.flush();
        const saved = before.order.filter((r) => r.type !== 'ready');
        const savedIds = new Set(saved.map((r) => r.id));
        const cur = getBannerState();
        setBannerState({ ...cur, order: [...saved, ...cur.order.filter((r) => !savedIds.has(r.id))] });
        undismissHostKeys(keys);
        setHidden((m) => { const next = new Map(m); for (const id of readyIds) next.delete(id); return next; });
        log.info('attention-banner', 'dismiss all undone', { count: keys.length, mount });
      },
    });
  };

  localDismissedRef.current = (key: string) => {
    const height = rowHeight('.ab-local');
    held.flush();
    undo.add({
      id: 'local', kind: 'local', index: 0, height,
      restore: () => { held.flush(); undismissLocal(key); log.info('attention-banner', 'local notice dismiss undone', { key, mount }); },
    });
    log.info('attention-banner', 'local notice dismissed', { key, mount });
  };

  const onOpenSettings = useCallback((alias?: string) => {
    onLeave?.();
    openHostSettings(navigate, alias);
  }, [navigate, onLeave]);
  const onMore = () => {
    onLeave?.();
    openHostSettings(navigate, undefined, { flashHosts: shown.moreHosts });
  };

  const localUndo = shown.undo.find((e) => e.kind === 'local');
  const allUndo = shown.undo.find((e) => e.kind === 'all');
  const slots = withUndoSlots(rows, shown.undo);
  const hostEntries = rows.some((r) => r.type !== 'ready') || shown.more > 0;
  if (!shown.localNode && !localUndo && !allUndo && slots.length === 0) return null;
  const style = mountH
    ? ({ '--ab-slot-h': `${Math.round(mountH)}px`, '--ab-cap': `${cardCapPx(mountH, capMargin)}px` } as CSSProperties)
    : undefined;
  const localShown = !!shown.localNode || !!localUndo;
  // More than one entry: every row starts as its headline and its primary action,
  // so all of them read at a glance (row 1 does not open and fill the list, N1).
  const dense = !singleLineRows && (slots.filter((s) => 'undo' in s || s.row.type !== 'ready').length > 1 || shown.more > 0);
  // One count format for the title and the subhead: '(4)' (N3-17; the words already say hosts, N15).
  const count = subheadCountText(rows, shown.moreHosts);
  const both = localShown && (slots.length > 0 || !!allUndo);
  // A short mount with both sections (a 600px window, N3-3): the fitted form keeps the whole card under its cap.
  const tight = !singleLineRows && fitsTight(mountH ? cardCapPx(mountH, capMargin) : null, both);
  tightRef.current = tight;
  const cls = `setup-banner attention-banner${compact ? ' attention-banner-compact' : ''}${singleLineRows ? ' attention-banner-single' : ''}${both ? ' ab-both' : ''}${tight ? ' ab-fit' : ''}${tight && compactRows ? ' ab-fit-rows' : ''}`;
  const hostHeader = !compact && !localShown && (
    <div className="setup-banner-header hpb-header">
      <span className="setup-banner-title">{shown.title ?? HOST_TITLE}</span>
      {count && <span className="hpb-count">{count}</span>}
    </div>
  );
  const subCount = subheadCountText(rows, shown.moreHosts);
  const subhead = shown.subhead && (
    <div className="hpb-subhead-row">
      <div className="hpb-subhead">{shown.subhead}</div>
      {subCount && <span className="hpb-count">{subCount}</span>}
    </div>
  );
  return (
    <div
      ref={setEl}
      className={cls}
      data-testid="attention-banner"
      data-mount={mount}
      style={style}
      {...handlers}
    >
      {localUndo ? <UndoLine as="div" entry={localUndo} text={UNDO_ROW_TEXT} onUndo={undo.undo} /> : shown.localNode}
      {allUndo ? (
        <section className="hpb" data-testid="host-problems" aria-label="Remote hosts">
          {!compact && !localShown && (
            // Nothing asks for attention while everything is hidden: the plain section name (N3-12).
            <div className="setup-banner-header hpb-header"><span className="setup-banner-title">{HOST_SUBHEAD}</span></div>
          )}
          {shown.subhead && <div className="hpb-subhead-row"><div className="hpb-subhead">{shown.subhead}</div></div>}
          <UndoLine as="div" entry={allUndo} text={UNDO_ALL_TEXT} onUndo={undo.undo} />
        </section>
      ) : slots.length > 0 && (
        <section className="hpb" data-testid="host-problems" aria-label="Remote hosts">
          {hostHeader}
          {subhead}
          <div
            ref={setScrollEl}
            className="hpb-scroll"
            data-more-below={below > 0 ? 'true' : 'false'}
            onFocus={(e) => {
              const sc = e.currentTarget;
              const t = e.target as HTMLElement;
              // Keyboard focus only: scrolling under a mouse press would move the
              // button before its mouseup (WebKit focuses buttons on press), losing the click.
              if (!t.matches?.(':focus-visible')) return;
              keepRowInView(sc, t);
              // Again after the browser's own focus scrolling has run.
              requestAnimationFrame(() => keepRowInView(sc, t));
            }}
          >
            <ul className={`hpb-rows${dense ? ' hpb-rows-dense' : ''}`}>
              {slots.map((slot, i) => {
                if ('undo' in slot) return <UndoLine key={slot.undo.id} entry={slot.undo} text={UNDO_ROW_TEXT} onUndo={undo.undo} />;
                const { row } = slot;
                // Row 1 opens by position; an undo line in the first place opens nothing (no jump beside it).
                const props = {
                  row, defaultExpanded: i === 0 && !singleLineRows && !dense && !tight, singleLine: !!singleLineRows, dense,
                  onDismiss: onDismissRow, onOpenSettings,
                };
                if (row.type === 'ready') return <ReadyRow key={row.id} row={row} />;
                if (row.id.startsWith('cred:')) return <GroupRow key={row.id} {...props} />;
                return <SingleHostRow key={row.id} {...props} />;
              })}
            </ul>
          </div>
          {(shown.more > 0 || below > 0 || hostEntries) && (
            <div className="hpb-foot">
              {shown.more === 0 && below > 0 && (
                // One phrase per meaning: rows past the fold here; rows the cap hid are 'and N more' (N4).
                <button type="button" tabIndex={0} className="hpb-below" data-testid="hpb-below"
                  onClick={() => {
                    const next = Array.from(scrollEl?.querySelectorAll<HTMLElement>('li.hpb-row') ?? [])
                      .find((li) => li.getBoundingClientRect().bottom > (scrollEl?.getBoundingClientRect().bottom ?? 0) + 1);
                    if (next && scrollEl) scrollRowIntoView(scrollEl, next);
                  }}>
                  {below} more below
                </button>
              )}
              {shown.more === 0 && below === 0 && clamped && above > 0 && (
                // Scrolled to the end: the cue turns round in the same place (N8, N3-8).
                <button type="button" tabIndex={0} className="hpb-below" data-testid="hpb-above"
                  onClick={() => {
                    const rowsAbove = Array.from(scrollEl?.querySelectorAll<HTMLElement>('li.hpb-row') ?? [])
                      .filter((li) => li.getBoundingClientRect().top < (scrollEl?.getBoundingClientRect().top ?? 0) - 1);
                    const prev = rowsAbove[rowsAbove.length - 1];
                    if (prev && scrollEl) scrollRowIntoView(scrollEl, prev);
                  }}>
                  {above} more above
                </button>
              )}
              {shown.more === 0 && below === 0 && clamped && above === 0 && (
                // The cue's place stays, so Dismiss all does not jump left (N8).
                <span className="hpb-below hpb-below-slot" aria-hidden="true">1 more below</span>
              )}
              {shown.more > 0 && (
                <button type="button" tabIndex={0} className="hpb-more" onClick={onMore}>and {shown.more} more</button>
              )}
              {hostEntries && (
                // A quiet text button at the end, the same on every mount (no corner x beside a row x, N3, N16).
                <button type="button" tabIndex={0} className="ab-dismiss-all" onClick={onDismissAll}>
                  {DISMISS_ALL_LABEL}
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
