/**
 * The home banner's host section as a pure function: statuses (Settings order)
 * + dismissed keys + what is on screen now -> title, rows, "and N more".
 *
 * Rules (spec 3.1 to 3.6), each a shipped complaint:
 *   - one row per problem host: connect failures first, readiness second,
 *     Settings order inside a group; hosts waiting on the same login kind
 *     (cert_expired, agent_missing) share ONE row;
 *   - healthy and connecting hosts take no row, unless the row is already on
 *     screen: it stays in place reading 'Trying again...' until the attempt
 *     settles (auto retries every 1/2/5/10 minutes must not make rows blink);
 *   - a reconnect earns a row only after 2 minutes and with a known cause;
 *   - a row that heals reads the one success sentence for 3s (not a dismissed one);
 *   - on-screen rows never reorder on a new frame, only on a group change; with
 *     the pointer or focus inside the card, new rows append at the end and
 *     removals / moves wait for the pointer to leave (at most 10s);
 *   - up to 4 rows show; from 5 on, 3 rows + 'and N more' (success rows are
 *     receipts: they never count toward the cap or the N);
 *   - a host found in ~/.ssh/config (`discovered`) takes no row until the user
 *     pressed Retry or Connect now on it in this page (`engaged`).
 * Stateless apart from `prev` (the last result), so it is unit-tested frame by frame.
 */
import {
  CREDENTIAL_WAIT_KINDS, RECONNECT_BANNER_AFTER_MS, autofixVerbFor, credentialGroupHeadline,
  hostActionsFor, hostDotOf, hostProblemOf, hostReadySentence, isConnectingPhaseWire, READINESS_ANSWER_GRACE_MS, HOST_READY_HOLD_MS,
  type HostActionId, type HostProblem, type HostReadinessProblemInput, type HostStatusInput,
} from '@open-walnut/host-problem';

export const READY_HOLD_MS = HOST_READY_HOLD_MS;
export const DEFER_MAX_MS = 10_000;
export const HOST_TITLE = 'Remote hosts need attention';
export const HOST_SUBHEAD = 'Remote hosts';

export type BannerRowType = 'connect' | 'reconnecting' | 'readiness' | 'trying' | 'ready';
export type BannerGroup = 'connect' | 'readiness';

export interface BannerRow {
  /** Stable across frames: `host:<alias>`, `cred:<kind>` or `ready:<alias>`. */
  id: string;
  type: BannerRowType;
  group: BannerGroup;
  hosts: string[];
  labels: string[];
  kind?: string;
  headline?: string;
  hint?: string;
  summary?: string;
  retryAt?: number;
  retryable?: boolean;
  problem?: HostReadinessProblemInput;
  /** The keys a row x writes (one per host in a merged row). */
  dismissKeys: string[];
  actions: HostActionId[];
  /** trying: 'user' = the user's own Retry ('Connecting to X...'), 'auto' = 'Trying again...'. */
  by?: 'user' | 'auto';
  /** ready: the success sentence. */
  sentence?: string;
  /** Server time the row's frame was built (a stale countdown drops its line). */
  frameAt?: number;
}

export interface BannerInput {
  /** In Settings order. */
  statuses: readonly (HostStatusInput & { label?: string; discovered?: boolean })[];
  dismissed: ReadonlySet<string>;
  /** Server clock. */
  now: number;
  replica?: boolean;
  /** Hosts whose Retry the user pressed and is still settling. */
  userRetrying?: ReadonlySet<string>;
  /** Hosts the user pressed Retry / Connect now on in this page (a discovered host needs it for a row). */
  engaged?: ReadonlySet<string>;
  /** Pointer or focus inside the card. */
  pointerInside?: boolean;
  /** The local Claude Code section renders (the host section then gets a subhead). */
  localPresent?: boolean;
  /** Success rows the user hid with Dismiss all (they carry no stored key). */
  hiddenIds?: ReadonlySet<string>;
}

export interface BannerState {
  /** Every row as last computed, in display order (including ones behind 'and N more'). */
  order: BannerRow[];
  /** Success rows and when they go. */
  ready: Record<string, number>;
  /** When a deferred change (pointer inside) first waited. */
  deferSince: number | null;
}

export interface BannerView {
  /** Card title for the host-only case; null when nothing asks for attention. */
  title: string | null;
  /** 'Remote hosts' above the host rows when the local section is present. */
  subhead: string | null;
  rows: BannerRow[];
  /** Rows behind 'and N more'. */
  more: number;
  /** Every host dismissal key of every problem row (Dismiss all hides the hidden ones too). */
  allKeys: string[];
  /** Server time of the next change that needs no new frame (a timer wakes the banner). */
  wakeAt: number | null;
}

export const EMPTY_BANNER_STATE: BannerState = { order: [], ready: {}, deferSince: null };

const labelOf = (s: HostStatusInput): string => s.label || s.host;

/** Rows shown for N rows: all up to 4, else 3 (a lone 'and 1 more' hides too little to pay for itself). */
export function visibleCount(n: number): number {
  return n <= 4 ? n : 3;
}

/**
 * The rows on screen for an order, and how many problem rows 'and N more'
 * stands for. The cap counts problem rows only: a success row is a 3s receipt,
 * it never folds a problem away and is never one of the N. A success row past
 * the cut goes unshown (it is gone in 3s anyway).
 */
export function capRows(order: readonly BannerRow[]): { rows: BannerRow[]; more: number } {
  const n = order.filter((r) => r.type !== 'ready').length;
  const limit = visibleCount(n);
  if (limit === n) return { rows: [...order], more: 0 };
  const rows: BannerRow[] = [];
  let taken = 0;
  for (const r of order) {
    if (taken >= limit) break;
    rows.push(r);
    if (r.type !== 'ready') taken++;
  }
  return { rows, more: n - taken };
}

/** Whether a row draws its own x (success rows and a key-less attempt do not). */
export function rowHasDismiss(row: BannerRow): boolean {
  return row.type !== 'ready' && row.dismissKeys.length > 0;
}

/**
 * Where focus goes after a row x: the index of that row among the rows that
 * draw an x, which is where the NEXT row's x sits once it is gone. Counted on
 * the same list the DOM query sees, or a success row above shifts it by one.
 */
export function dismissFocusIndex(rows: readonly BannerRow[], rowId: string): number {
  return rows.filter(rowHasDismiss).findIndex((r) => r.id === rowId);
}

/** Success rows hidden by Dismiss all, until their own 3s would have ended (then a later heal shows again). */
export function activeHiddenIds(hidden: ReadonlyMap<string, number>, now: number): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [id, until] of hidden) if (until > now) out.add(id);
  return out;
}

/** A host with a live attempt: connecting, reconnecting, or connected with Claude Code not yet checked. */
function inFlight(s: HostStatusInput, now: number): boolean {
  if (isConnectingPhaseWire(s.phase) && !s.connected) return true;
  return s.connected && hostDotOf(s, { now }).kind === 'checking';
}

function healthy(s: HostStatusInput, now: number): boolean {
  return s.connected && hostDotOf(s, { now }).kind === 'connected' && !hostProblemOf(s, { surface: 'banner' });
}

interface Candidate { row: BannerRow; settingsIndex: number }

function problemRow(s: HostStatusInput, p: HostProblem, input: BannerInput): BannerRow | null {
  const label = labelOf(s);
  const base = { id: `host:${s.host}`, hosts: [s.host], labels: [label], frameAt: s.serverNow ?? s.at };
  if (p.type === 'connect') {
    return {
      ...base, type: 'connect', group: 'connect', kind: p.kind, headline: p.headline, hint: p.hint,
      summary: p.summary, retryable: p.retryable, ...(p.retryAt !== undefined ? { retryAt: p.retryAt } : {}),
      dismissKeys: [p.dismissKey], actions: hostActionsFor(p, { surface: 'banner', replica: input.replica }),
    };
  }
  if (p.type === 'reconnecting') {
    const age = input.now - p.since;
    if (!p.kind || age < RECONNECT_BANNER_AFTER_MS) return null;
    return {
      ...base, type: 'reconnecting', group: 'connect', kind: p.kind, headline: p.headline, hint: p.hint,
      dismissKeys: [`${s.host}|connect`],
      actions: hostActionsFor(p, { surface: 'banner', replica: input.replica, reconnectAgeMs: age }),
    };
  }
  if (p.type === 'readiness') {
    const verb = autofixVerbFor(p.problem, s.readiness?.claude?.installMethod);
    return {
      ...base, type: 'readiness', group: 'readiness', kind: p.problem.kind, problem: p.problem,
      dismissKeys: [p.dismissKey],
      actions: hostActionsFor(p, { surface: 'banner', replica: input.replica, autofixable: verb ?? false }),
    };
  }
  return null;
}

function tryingRow(s: HostStatusInput, prevRow: BannerRow, input: BannerInput): BannerRow {
  return {
    id: `host:${s.host}`, type: 'trying', group: prevRow.group, hosts: [s.host], labels: [labelOf(s)],
    // The keys of the failure it is retrying: its x (and Dismiss all) still hide it.
    dismissKeys: prevRow.dismissKeys.filter((k) => k.startsWith(`${s.host}|`)),
    actions: [], by: input.userRetrying?.has(s.host) ? 'user' : 'auto',
  };
}

function readyRow(s: HostStatusInput, group: BannerGroup): BannerRow {
  return {
    id: `ready:${s.host}`, type: 'ready', group, hosts: [s.host], labels: [labelOf(s)],
    dismissKeys: [], actions: [], sentence: hostReadySentence(labelOf(s), s.readiness?.claude?.version),
  };
}

/** One row for every host waiting on the same login kind; the earliest real retry wins. */
function credentialRow(kind: string, members: Array<{ s: HostStatusInput; p: Extract<HostProblem, { type: 'connect' }> | null }>, input: BannerInput): BannerRow {
  const failing = members.filter((m) => m.p);
  const first = failing[0]?.p ?? null;
  const retryAts = failing.map((m) => m.p!.retryAt).filter((t): t is number => typeof t === 'number');
  const labels = members.map((m) => labelOf(m.s));
  const row: BannerRow = {
    id: `cred:${kind}`, type: failing.length ? 'connect' : 'trying', group: 'connect', kind,
    hosts: members.map((m) => m.s.host), labels,
    headline: credentialGroupHeadline(labels, kind), hint: first?.hint ?? '', summary: first?.summary ?? '',
    retryable: failing.every((m) => m.p!.retryable),
    ...(retryAts.length ? { retryAt: Math.min(...retryAts) } : {}),
    dismissKeys: members.map((m) => `${m.s.host}|connect`),
    actions: first ? hostActionsFor(first, { surface: 'banner', replica: input.replica }) : [],
    frameAt: Math.max(...members.map((m) => m.s.serverNow ?? m.s.at ?? 0)),
  };
  if (!failing.length) row.by = members.some((m) => input.userRetrying?.has(m.s.host)) ? 'user' : 'auto';
  return row;
}

interface Ranked extends Candidate { replaces?: string; member?: number }
type ConnectProblem = Extract<HostProblem, { type: 'connect' }>;

/** Every row this frame wants, before ordering and the cap. */
function collect(input: BannerInput, prev: BannerState): { cands: Ranked[]; ready: Record<string, number> } {
  const { now, dismissed } = input;
  const shown = new Set(capRows(prev.order).rows.map((r) => r.id));
  const prevRowOfHost = new Map<string, BannerRow>();
  for (const r of prev.order) if (shown.has(r.id) && r.type !== 'ready') for (const h of r.hosts) prevRowOfHost.set(h, r);
  const prevGroupOf = new Map(prev.order.map((r) => [r.id, r.group]));
  const cands: Ranked[] = [];
  const ready: Record<string, number> = {};
  const cred = new Map<string, { index: number; members: Array<{ s: HostStatusInput; p: ConnectProblem | null }> }>();
  const addCred = (kind: string, i: number, s: HostStatusInput, p: ConnectProblem | null) => {
    const g = cred.get(kind) ?? { index: i, members: [] };
    g.members.push({ s, p });
    cred.set(kind, g);
  };
  const pushReady = (s: HostStatusInput, i: number, group: BannerGroup, until: number, replaces?: string, member = 0) => {
    const row = readyRow(s, group);
    if (input.hiddenIds?.has(row.id)) return;
    ready[row.id] = until;
    cands.push({ row, settingsIndex: i, ...(replaces ? { replaces } : {}), member });
  };

  input.statuses.forEach((s, i) => {
    if (s.removed || !counts(s, input)) return;
    const p = hostProblemOf(s, { replica: input.replica, surface: 'banner' });
    const prevRow = prevRowOfHost.get(s.host);
    if (p?.type === 'connect' && CREDENTIAL_WAIT_KINDS.includes(p.kind)) {
      if (!dismissed.has(p.dismissKey)) addCred(p.kind, i, s, p);
      return;
    }
    const row = p ? problemRow(s, p, input) : null;
    if (row) {
      if (!row.dismissKeys.every((k) => dismissed.has(k))) cands.push({ row, settingsIndex: i });
      return;
    }
    const readyId = `ready:${s.host}`;
    const until = prev.ready[readyId];
    if (!prevRow) {
      if (until !== undefined && until > now && healthy(s, now)) pushReady(s, i, prevGroupOf.get(readyId) ?? 'connect', until);
      return;
    }
    // Already on screen: the row stays in place while an attempt runs (G9).
    if (inFlight(s, now) || p?.type === 'reconnecting') {
      if (prevRow.id.startsWith('cred:') && prevRow.kind) {
        if (!dismissed.has(`${s.host}|connect`)) addCred(prevRow.kind, i, s, null);
        return;
      }
      const row = tryingRow(s, prevRow, input);
      if (!row.dismissKeys.length || !row.dismissKeys.every((k) => dismissed.has(k))) cands.push({ row, settingsIndex: i });
      return;
    }
    if (healthy(s, now)) pushReady(s, i, prevRow.group, now + READY_HOLD_MS, prevRow.id, prevRow.hosts.indexOf(s.host));
  });

  for (const [kind, g] of cred) {
    // In-flight members only keep a row that is already on screen.
    if (!g.members.some((m) => m.p) && !shown.has(`cred:${kind}`)) continue;
    cands.push({ row: credentialRow(kind, g.members, input), settingsIndex: g.index });
  }
  return { cands, ready };
}

/** A discovered host speaks only once the user reached for it. */
function counts(s: { host: string; discovered?: boolean }, input: BannerInput): boolean {
  return !s.discovered || !!input.engaged?.has(s.host);
}

const groupRank = (g: BannerGroup): number => (g === 'connect' ? 0 : 1);

/** Normal order: groups in order, on-screen rows keep their places, new rows land where Settings order puts them. */
function orderNormally(cands: Ranked[], prev: BannerState): BannerRow[] {
  const prevIndex = new Map(prev.order.map((r, i) => [r.id, i]));
  const existing = (c: Ranked): number | undefined => {
    const i = prevIndex.get(c.row.id);
    return i !== undefined && prev.order[i].group === c.row.group ? i : undefined;
  };
  const rank = (c: Ranked): number => {
    const own = existing(c);
    if (own !== undefined) return own;
    const anchor = c.replaces !== undefined ? prevIndex.get(c.replaces) : undefined;
    if (anchor !== undefined) return anchor + 0.001 * (c.member ?? 0);
    let pos = -0.5;
    for (const o of cands) {
      const oi = existing(o);
      if (oi !== undefined && o.row.group === c.row.group && o.settingsIndex < c.settingsIndex) pos = Math.max(pos, oi + 0.5);
    }
    return pos;
  };
  return cands
    .map((c) => ({ c, g: groupRank(c.row.group), r: rank(c) }))
    .sort((a, b) => a.g - b.g || a.r - b.r || a.c.settingsIndex - b.c.settingsIndex)
    .map((x) => x.c.row);
}

/**
 * Pointer or focus inside: nothing moves under the hand. Rows keep their
 * places (even across a group change), a row that would go stays as it was,
 * new rows append at the end.
 */
function orderDeferred(cands: Ranked[], prev: BannerState, input: BannerInput): BannerRow[] {
  const { dismissed } = input;
  const byId = new Map(cands.map((c) => [c.row.id, c]));
  const used = new Set<string>();
  const order: BannerRow[] = [];
  for (const r of prev.order) {
    const c = byId.get(r.id);
    if (c) { order.push(c.row); used.add(r.id); continue; }
    const subs = cands.filter((x) => x.replaces === r.id).sort((a, b) => (a.member ?? 0) - (b.member ?? 0));
    if (subs.length) { for (const s of subs) { order.push(s.row); used.add(s.row.id); } continue; }
    // The user's own x is never deferred: that move is the one they asked for.
    if (r.dismissKeys.length && r.dismissKeys.every((k) => dismissed.has(k))) continue;
    if (input.hiddenIds?.has(r.id)) continue;
    order.push(r);
  }
  const fresh = cands.filter((c) => !used.has(c.row.id)).sort((a, b) => a.settingsIndex - b.settingsIndex);
  for (const c of fresh) order.push(c.row);
  return order;
}

function wakeAtOf(input: BannerInput, ready: Record<string, number>, deferSince: number | null): number | null {
  const times: number[] = Object.values(ready);
  if (deferSince !== null) times.push(deferSince + DEFER_MAX_MS);
  for (const s of input.statuses) {
    if (!counts(s, input)) continue;
    const p = hostProblemOf(s, { surface: 'banner' });
    if (p?.type === 'reconnecting' && p.kind && input.now - p.since < RECONNECT_BANNER_AFTER_MS) times.push(p.since + RECONNECT_BANNER_AFTER_MS);
    if (s.connected && typeof s.connectedAt === 'number' && hostDotOf(s, { now: input.now }).kind === 'checking') {
      times.push(s.connectedAt + READINESS_ANSWER_GRACE_MS);
    }
  }
  const future = times.filter((t) => t > input.now);
  return future.length ? Math.min(...future) : null;
}

/** The banner for this frame, and the state the next frame starts from. */
export function nextBanner(input: BannerInput, prev: BannerState = EMPTY_BANNER_STATE): { view: BannerView; state: BannerState } {
  const { now } = input;
  const { cands, ready } = collect(input, prev);
  const deferring = !!input.pointerInside && (prev.deferSince === null || now - prev.deferSince < DEFER_MAX_MS);
  const normal = orderNormally(cands, prev);
  let order = normal;
  let deferSince: number | null = null;
  // Nothing on screen yet: nothing can move under the hand.
  if (deferring && prev.order.length) {
    order = orderDeferred(cands, prev, input);
    const same = order.length === normal.length && order.every((r, i) => r.id === normal[i].id);
    if (!same) deferSince = prev.deferSince ?? now;
  }
  // A success row that stayed past its 3s (pointer inside) keeps its old deadline.
  const keptReady: Record<string, number> = {};
  for (const r of order) if (r.type === 'ready') keptReady[r.id] = ready[r.id] ?? prev.ready[r.id] ?? now;

  const attention = order.filter((r) => r.type !== 'ready');
  const hosts = new Set(attention.flatMap((r) => r.hosts));
  const capped = capRows(order);
  let title: string | null = null;
  if (!input.localPresent && hosts.size > 0) {
    title = hosts.size === 1 ? `${attention[0].labels[0]} needs attention` : HOST_TITLE;
  }
  const view: BannerView = {
    title,
    subhead: input.localPresent && order.length > 0 ? HOST_SUBHEAD : null,
    rows: capped.rows,
    more: capped.more,
    allKeys: [...new Set(attention.flatMap((r) => r.dismissKeys))],
    wakeAt: wakeAtOf(input, keptReady, deferSince),
  };
  return { view, state: { order, ready: keptReady, deferSince } };
}
