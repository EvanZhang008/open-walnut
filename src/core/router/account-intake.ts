/**
 * Whole accounts a router area takes every new arrival of. The mail plugin binds each mailbox to
 * the one mail router (making it when there is none), and each new mail of a bound mailbox enters
 * that area as an open item: the router is woken for it like any confirmed item, and no reader is
 * restricted by it, so Main, a VP or any task reads that mail as before.
 *
 * 2026-11-12, the user: "it is the mail plugin that creates it ... then all mail should go through
 * it, do a triage ... any new mail it gets, it should look at it". Before, an item entered an area
 * only through a person's confirmation or a confirmed rule, so a router with neither (the prod
 * Personal router) was never woken.
 */
import { WALNUT_HOME } from '../../constants.js';
import {
  accountBinding, allAreaItems, readRouterAreas, updateRouterAreas, ROUTER_CANONICAL_KEY_MAX,
  type RouterArea, type RouterAreasFile,
} from './areas.js';
import type { RouterItem, RouterSource, RouterSourceKind } from './types.js';
import type { RouterNodeInput } from './nodes.js';
import type { LetterRecord } from '../human-inbox/types.js';
import type { StillNeededContext } from '../human-inbox/walnut-letters/kind.js';
import { letterOpKey } from '../human-inbox/walnut-letters/kind.js';
import { MAIL_NO_ROUTER, mailNoRouterSettled, type MailNoRouterParams } from '../human-inbox/walnut-letters/mail-no-router.js';

/** The area the plugin makes when the person has no router area yet. */
export const ACCOUNT_ROUTER_AREA = { id: 'mail', name: 'Mail', router: 'Mail router' } as const;

interface OwnRouterArea { id: string; name: string; router: string; include?: readonly string[] }

/**
 * Kinds whose accounts get a router of their own and never join the mail router (2026-11-25, the
 * WeChat source: "make it another router for the wechat, so that we can route to correct task").
 * `include` is the filter the new area starts with: direct messages and unmuted groups, not muted
 * chats or official accounts.
 */
export const OWN_ROUTER_AREAS: Partial<Record<RouterSourceKind, OwnRouterArea>> = {
  wechat: { id: 'wechat', name: 'WeChat', router: 'WeChat router', include: ['dm', 'group'] },
};

/** The kind an area is kept for: a kind's own area by id, or one whose accounts are all of one such kind. */
export function areaKeptFor(area: Pick<RouterArea, 'id' | 'sources'>): RouterSourceKind | undefined {
  for (const [kind, own] of Object.entries(OWN_ROUTER_AREAS) as Array<[RouterSourceKind, OwnRouterArea]>) {
    if (area.id === own.id) return kind;
  }
  const first = area.sources[0]?.kind;
  return first && OWN_ROUTER_AREAS[first] && area.sources.every((one) => one.kind === first) ? first : undefined;
}

export type AccountRouterOutcome =
  | { bound: true; areaId: string; created: boolean; already: boolean }
  | { bound: false; reason: 'off' | 'replica' | 'test_run' | 'choose' };

export interface AccountRouterDeps {
  home?: string;
  now?: () => number;
  readAreas?: (home: string) => Promise<RouterAreasFile>;
  /** Makes the area's router, active. Default: the Org's own router setup, then a resume. */
  createRouter?: (kind: RouterSourceKind, account: string) => Promise<string>;
  /** A router task that is gone or complete does not count as the area's router. */
  routerOpen?: (taskId: string) => Promise<boolean>;
}

export interface AccountArrivalDeps {
  resolve?: (source: RouterSource) => Promise<RouterItem>;
  current?: (sources: readonly RouterSource[]) => Promise<RouterSource[]>;
}

/** Off on a replica, inside an automated test run, and with WALNUT_MAIL_AUTO_ROUTER=0. */
async function gate(): Promise<'off' | 'replica' | 'test_run' | undefined> {
  if (process.env.WALNUT_MAIL_AUTO_ROUTER === '0') return 'off';
  const [{ role }, { ambientTestRun }] = await Promise.all([import('../server-role.js'), import('../test-run.js')]);
  if (role() === 'replica') return 'replica';
  if (ambientTestRun()) return 'test_run';
  return undefined;
}

async function defaultRouterOpen(taskId: string): Promise<boolean> {
  const { getTask } = await import('../task-manager.js');
  const task = await getTask(taskId).catch(() => undefined);
  return !!task && task.id === taskId && task.org_role === 'router' && task.phase !== 'COMPLETE';
}

/** The router an account's first arrival makes: its kind's own (WeChat) or the Mail router. */
export function accountRouterSetup(kind: RouterSourceKind, account: string, now = Date.now()): RouterNodeInput {
  const own = OWN_ROUTER_AREAS[kind];
  const spec = own ?? ACCOUNT_ROUTER_AREA;
  return {
    name: spec.router, areaId: spec.id, areaName: spec.name, host: '__local__', links: [],
    sources: [{ kind, account, ...(own?.include ? { include: [...own.include], includeAt: now } : {}) }],
  };
}

async function defaultCreateRouter(kind: RouterSourceKind, account: string): Promise<string> {
  const { createRouterNode, updateRouterNode } = await import('./nodes.js');
  const { task } = await createRouterNode(accountRouterSetup(kind, account));
  // A router the plugin makes works from the start: its whole point is to read each new item.
  if (task.router_paused !== false) await updateRouterNode(task.id, { paused: false });
  return task.id;
}

/**
 * The one area this account's arrivals belong to: where the kind's other accounts are bound, else the
 * one local area with an open router that takes this kind, else the Mail router's own area. Never
 * left for later (2026-11-14: every mailbox goes straight to a router, nothing else reads its mail):
 * with no such area, 'none' makes the Mail router. A Mail area whose router is closed is the person's
 * choice ('choose'): the mailbox stays unbound, and its new mail waits in the mail intake's pending
 * queue while one letter tells the person (src/integrations/mail/router-intake.ts).
 */
async function pickArea(file: RouterAreasFile, kind: RouterSourceKind, routerOpen: (id: string) => Promise<boolean>): Promise<RouterArea | 'none' | 'choose'> {
  const openRouter = async (area: RouterArea) => {
    for (const router of file.routers.filter((one) => one.areaId === area.id && area.taskIds.includes(one.taskId))) {
      if (await routerOpen(router.taskId)) return true;
    }
    return false;
  };
  const boundAreas = new Set((file.accountBindings ?? []).filter((one) => one.kind === kind).map((one) => one.areaId));
  if (boundAreas.size === 1) {
    const area = file.areas.find((one) => one.id === [...boundAreas][0]);
    if (area && await openRouter(area)) return area;
  }
  // A kind with a router of its own looks only at areas kept for it, and makes its own when there is none.
  const own = OWN_ROUTER_AREAS[kind];
  if (own) {
    const kept: RouterArea[] = [];
    for (const area of file.areas) {
      if (area.host === '__local__' && areaKeptFor(area) === kind && await openRouter(area)) kept.push(area);
    }
    if (kept.length === 1) return kept[0];
    const ownArea = file.areas.find((one) => one.id === own.id);
    if (kept.length > 1) return ownArea && kept.includes(ownArea) ? ownArea : 'choose';
    // Its own area with its router closed is the person's choice: never a router made beside it.
    return ownArea || file.areas.some((area) => areaKeptFor(area) === kind) ? 'choose' : 'none';
  }
  // Another kind's own area never takes this kind.
  const shared = (area: RouterArea) => { const keptFor = areaKeptFor(area); return !keptFor || keptFor === kind; };
  const candidates: RouterArea[] = [];
  for (const area of file.areas) {
    if (area.host !== '__local__' || !shared(area)) continue;
    if (area.sources.length && !area.sources.some((one) => one.kind === kind)) continue;
    if (await openRouter(area)) candidates.push(area);
  }
  if (boundAreas.size === 0 && candidates.length === 1) return candidates[0];
  // A kind no area takes yet (Slack beside a mail router) joins the person's one router, if there is
  // exactly one: one router for every inbound channel (2026-11-16, the Slack source), never a second.
  if (boundAreas.size === 0 && candidates.length === 0) {
    const open: RouterArea[] = [];
    for (const area of file.areas) if (area.host === '__local__' && shared(area) && await openRouter(area)) open.push(area);
    if (open.length === 1) return open[0];
  }
  // Several routers could take it, or none: the Mail router's own area takes the rest.
  const mail = file.areas.find((one) => one.id === ACCOUNT_ROUTER_AREA.id);
  if (mail && await openRouter(mail)) return mail;
  if (mail) return 'choose';
  return 'none';
}

let chain: Promise<unknown> = Promise.resolve();

/** Binds one account to its router area, making the area's router first when the person has none. One at a time. */
export function ensureAccountRouter(kind: RouterSourceKind, account: string, deps: AccountRouterDeps = {}): Promise<AccountRouterOutcome> {
  const run = chain.then(() => ensureOne(kind, account, deps));
  chain = run.catch(() => undefined);
  return run;
}

async function ensureOne(kind: RouterSourceKind, account: string, deps: AccountRouterDeps): Promise<AccountRouterOutcome> {
  const off = await gate();
  if (off) return { bound: false, reason: off };
  const home = deps.home ?? WALNUT_HOME;
  const readAreas = deps.readAreas ?? readRouterAreas;
  const routerOpen = deps.routerOpen ?? defaultRouterOpen;
  let file = await readAreas(home);
  const held = accountBinding(file, kind, account);
  if (held) return { bound: true, areaId: held.areaId, created: false, already: true };
  let picked = await pickArea(file, kind, routerOpen);
  let created = false;
  if (picked === 'none') {
    await (deps.createRouter ?? defaultCreateRouter)(kind, account);
    created = true;
    file = await readAreas(home);
    const madeId = OWN_ROUTER_AREAS[kind]?.id ?? ACCOUNT_ROUTER_AREA.id;
    picked = file.areas.find((one) => one.id === madeId) ?? 'choose';
  }
  if (picked === 'choose') return { bound: false, reason: 'choose' };
  const areaId = picked.id;
  const now = (deps.now ?? Date.now)();
  const saved = await updateRouterAreas(home, (current) => {
    if (accountBinding(current, kind, account)) return current;
    const area = current.areas.find((one) => one.id === areaId);
    // The area went away meanwhile: nothing is bound, the next arrival asks again.
    if (!area) return current;
    // A kind with a router of its own starts each account on its default filter, the first one or a later one.
    const include = OWN_ROUTER_AREAS[kind]?.include;
    if (!area.sources.some((one) => one.kind === kind && one.account === account)) {
      area.sources.push({ kind, account, ...(include ? { include: [...include], includeAt: now } : {}) });
    }
    current.accountBindings = [...(current.accountBindings ?? []), { kind, account, areaId, boundAt: now }];
    return current;
  });
  const binding = accountBinding(saved, kind, account);
  if (!binding) return { bound: false, reason: 'choose' };
  return { bound: true, areaId: binding.areaId, created, already: false };
}

/** The area's router assignment, paused or not. */
const areaRouter = (file: RouterAreasFile, areaId: string) => {
  const area = file.areas.find((one) => one.id === areaId);
  return area ? file.routers.find((one) => one.areaId === areaId && area.taskIds.includes(one.taskId)) : undefined;
};

/**
 * Who reads an account's new arrivals now: `open` its area's router task is open (paused counts:
 * the person paused it, and its items wait for the resume); `closed` the area has a router whose
 * task is complete or gone, so its arrivals are listed but nobody is woken for them; `none` the
 * account is bound to no area, or its area has no router, so nothing can take them at all.
 */
export type AccountRouterState = 'open' | 'closed' | 'none';

export async function accountRouterState(
  file: RouterAreasFile, kind: RouterSourceKind, account: string, routerOpen: (taskId: string) => Promise<boolean> = defaultRouterOpen,
): Promise<AccountRouterState> {
  const binding = accountBinding(file, kind, account);
  const area = binding ? file.areas.find((one) => one.id === binding.areaId) : undefined;
  if (!area) return 'none';
  const routers = file.routers.filter((one) => one.areaId === area.id && area.taskIds.includes(one.taskId));
  if (routers.length === 0) return 'none';
  for (const router of routers) if (await routerOpen(router.taskId)) return 'open';
  return 'closed';
}

/** The letter's op key for one episode of an account no router reads (see MAIL_NO_ROUTER). */
export function noRouterLetterOpKey(account: string, since: number): string {
  return letterOpKey(MAIL_NO_ROUTER.id, account, String(since));
}

/**
 * Tells the person, once per episode (`opKey`), that the new mail of `mailbox` is not being read by
 * any router. Never on a replica, in a test run, or with the automatic router off.
 */
export async function sendNoRouterLetter(params: MailNoRouterParams, opKey: string): Promise<boolean> {
  if (await gate()) return false;
  const [{ sendLetterOnce }, { walnutLetterLanguage }] = await Promise.all([
    import('../human-inbox/store.js'), import('../human-inbox/walnut-letters/languages.js'),
  ]);
  const { subject, markdown } = MAIL_NO_ROUTER.render(await walnutLetterLanguage(), params);
  await sendLetterOnce({ subject, type: 'review', markdown, sender: { sessionId: 'external', host: 'local' } }, { opKey });
  return true;
}

/** The account a MAIL_NO_ROUTER letter is about, from its op key. */
export function noRouterLetterAccount(letter: Pick<LetterRecord, 'createdByOp'>): string | undefined {
  const [id, account] = (letter.createdByOp ?? '').split(':');
  if (id !== MAIL_NO_ROUTER.id || !account) return undefined;
  try { return decodeURIComponent(account); } catch { return undefined; }
}

/** MAIL_NO_ROUTER's stillNeeded check: settled once the mailbox has an open router again. */
export async function noRouterLetterSettleReason(letter: LetterRecord, ctx: StillNeededContext, home = WALNUT_HOME): Promise<string | null> {
  const account = noRouterLetterAccount(letter);
  if (!account) return null;
  const open = async (taskId: string) => {
    const task = await ctx.task(taskId);
    return !!task && task.id === taskId && task.org_role === 'router' && task.phase !== 'COMPLETE';
  };
  return await accountRouterState(await readRouterAreas(home), 'mail', account, open) === 'open' ? mailNoRouterSettled(ctx.lang) : null;
}

const sameSource = (a: RouterSource, b: RouterSource) => a.kind === b.kind && a.account === b.account && a.message === b.message
  && (a.version ?? '') === (b.version ?? '');

/** A copy (same canonical key or message) another area already holds stays that area's: never opened here. */
function heldElsewhere(file: RouterAreasFile, source: RouterSource, areaId: string, canonicalKey: string): boolean {
  return allAreaItems(file).some((one) => one.areaId !== areaId && one.source.kind === source.kind && one.source.account === source.account
    && (one.canonicalKey === canonicalKey || one.source.message === source.message));
}

/** The Message-ID a mail item's canonical key names (["mail", account, "rfc", id]); undefined for a key by cache id. */
export function rfcIdOf(canonicalKey: string | undefined): string | undefined {
  if (!canonicalKey) return undefined;
  try {
    const parts: unknown = JSON.parse(canonicalKey);
    return Array.isArray(parts) && parts[0] === 'mail' && parts[2] === 'rfc' && typeof parts[3] === 'string' && parts[3] ? parts[3] : undefined;
  } catch { return undefined; }
}

const usableKey = (key: unknown): key is string => typeof key === 'string' && !!key && key.length <= ROUTER_CANONICAL_KEY_MAX
  && !/[\u0000-\u001f\u007f]/.test(key);

/**
 * Enters each exact new arrival of a bound account with an active router as an open item of its
 * area, under the areas lock with the live cache. Returns the sources this call wrote; one already
 * listed, held by another area, no longer current or of an account with no router is not among them.
 */
export async function confirmAccountArrivals(sources: readonly RouterSource[], home = WALNUT_HOME, deps: AccountArrivalDeps = {}): Promise<readonly RouterSource[]> {
  if (sources.length === 0) return [];
  const off = await gate();
  if (off === 'replica' || off === 'test_run') return [];
  const before = await readRouterAreas(home);
  const routed = (file: RouterAreasFile, source: RouterSource) => {
    const binding = accountBinding(file, source.kind, source.account);
    // A paused router keeps its mail: the wake hands it over once the person resumes it.
    return binding && areaRouter(file, binding.areaId) ? binding.areaId : undefined;
  };
  const asked = sources.filter((one) => !!one.message && (one.kind !== 'mail' || !!one.version) && routed(before, one)
    && !allAreaItems(before).some((item) => sameSource(item.source, one)));
  if (asked.length === 0) return [];
  const { resolveRouterItem, currentRouterSources } = await import('./source-registry.js');
  const resolve = deps.resolve ?? resolveRouterItem;
  const found: Array<{ source: RouterSource; canonicalKey: string }> = [];
  for (const source of asked) {
    let item: RouterItem;
    try { item = await resolve(source); } catch (error) {
      if (['source_missing', 'source_changed'].includes((error as { code?: string } | null)?.code ?? '')) continue;
      throw error;
    }
    if (item.source.kind !== source.kind || item.source.account !== source.account || item.source.message !== source.message
      || (source.version !== undefined && item.source.version !== source.version)) continue;
    const canonicalKey = item.scopeKey ?? item.key;
    if (usableKey(canonicalKey)) found.push({ source: { ...source }, canonicalKey });
  }
  if (found.length === 0) return [];
  const current = deps.current ?? currentRouterSources;
  let entered: RouterSource[] = [];
  const saved = await updateRouterAreas(home, async (file) => {
    entered = [];
    const live = await current(found.map((one) => one.source));
    for (const one of found) {
      const areaId = routed(file, one.source);
      if (!areaId || !live.some((entry) => sameSource(entry, one.source))) continue;
      if (allAreaItems(file).some((item) => sameSource(item.source, one.source))) continue;
      if (heldElsewhere(file, one.source, areaId, one.canonicalKey)) continue;
      // One decision per mail: another folder's copy of a message this area already lists (a label's copy) is not new.
      if (allAreaItems(file).some((item) => item.areaId === areaId && item.source.kind === one.source.kind
        && item.source.account === one.source.account && item.canonicalKey === one.canonicalKey)) continue;
      // One decision per mail across mailboxes too: a mail sent to two of the person's addresses (or
      // to one that forwards to another) arrives once in each, under one Message-ID.
      const message = rfcIdOf(one.canonicalKey);
      if (message && allAreaItems(file).some((item) => item.areaId === areaId && item.source.kind === one.source.kind
        && item.source.account !== one.source.account && rfcIdOf(item.canonicalKey) === message)) continue;
      file.openItems = [...(file.openItems ?? []), { source: { ...one.source }, areaId, canonicalKey: one.canonicalKey }];
      entered.push({ ...one.source });
    }
    return file;
  });
  return entered.filter((one) => (saved.openItems ?? []).some((item) => sameSource(item.source, one)));
}

export interface FollowOpenDeps {
  /** Ledger rows of a batch, keyed by routerKey: a routed arrival never moves. */
  routesFor(areaId: string, sources: readonly RouterSource[]): Promise<Map<string, unknown>>;
  current?: (sources: readonly RouterSource[]) => Promise<RouterSource[]>;
  relocate?: (source: RouterSource, scopeKey: string) => Promise<RouterItem | null | undefined>;
}

/**
 * An open arrival no route settled yet follows its mail when the exact cached copy is no longer
 * current: a filter moved it to another folder within seconds of arriving, or its cached delivery
 * changed (2026-11-12: a CI notice arrived in the inbox and the person's "keep out of the inbox"
 * rule moved it before the router's next wake, so the router never saw it and it had no receipt).
 * Its current copy (same scope key) takes its place; one the cache holds no copy of leaves the list.
 * Returns how many open items changed.
 */
export async function followOpenArrivals(areaId: string, deps: FollowOpenDeps, home = WALNUT_HOME): Promise<number> {
  const file = await readRouterAreas(home);
  const mine = (file.openItems ?? []).filter((one) => one.areaId === areaId);
  if (mine.length === 0) return 0;
  const { routerKey } = await import('./store.js');
  const routes = await deps.routesFor(areaId, mine.map((one) => one.source));
  const unsettled = mine.filter((one) => !routes.has(routerKey(one.source)));
  if (unsettled.length === 0) return 0;
  const { currentRouterSources, relocateRouterItem } = await import('./source-registry.js');
  const live = await (deps.current ?? currentRouterSources)(unsettled.map((one) => one.source));
  const stale = unsettled.filter((one) => !live.some((entry) => sameSource(entry, one.source)));
  if (stale.length === 0) return 0;
  const moves: Array<{ from: RouterSource; to: RouterSource | null }> = [];
  for (const one of stale) {
    if (!one.canonicalKey) continue;
    let found: RouterItem | null | undefined;
    // One item the source cannot follow never holds back the others.
    try { found = await (deps.relocate ?? relocateRouterItem)(one.source, one.canonicalKey); } catch { continue; }
    // No hook, or no answer: nothing is known, so the item stays as it is.
    if (found === undefined) continue;
    moves.push({ from: one.source, to: found ? { ...found.source } : null });
  }
  if (moves.length === 0) return 0;
  let changed = 0;
  await updateRouterAreas(home, (current) => {
    changed = 0;
    const open = [...(current.openItems ?? [])];
    for (const move of moves) {
      const at = open.findIndex((one) => one.areaId === areaId && sameSource(one.source, move.from));
      if (at < 0) continue;
      const listed = move.to && allAreaItems({ items: current.items, openItems: open }).some((one) => sameSource(one.source, move.to!));
      if (!move.to || listed) open.splice(at, 1);
      else open[at] = { ...open[at]!, source: { ...move.to } };
      changed += 1;
    }
    current.openItems = open;
    return current;
  });
  return changed;
}
