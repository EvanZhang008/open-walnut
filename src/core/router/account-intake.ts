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
  accountBinding, activeRouter, allAreaItems, readRouterAreas, updateRouterAreas, ROUTER_CANONICAL_KEY_MAX,
  type RouterArea, type RouterAreasFile,
} from './areas.js';
import type { RouterItem, RouterSource, RouterSourceKind } from './types.js';

/** The area the plugin makes when the person has no router area yet. */
export const ACCOUNT_ROUTER_AREA = { id: 'mail', name: 'Mail', router: 'Mail router' } as const;

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

async function defaultCreateRouter(kind: RouterSourceKind, account: string): Promise<string> {
  const { createRouterNode, updateRouterNode } = await import('./nodes.js');
  const { task } = await createRouterNode({
    name: ACCOUNT_ROUTER_AREA.router, areaId: ACCOUNT_ROUTER_AREA.id, areaName: ACCOUNT_ROUTER_AREA.name,
    host: '__local__', links: [], sources: [{ kind, account }],
  });
  // A router the plugin makes works from the start: its whole point is to read each new mail.
  if (task.router_paused !== false) await updateRouterNode(task.id, { paused: false });
  return task.id;
}

/**
 * The one area this account's arrivals belong to: where the kind's other accounts are bound, else the
 * one local area with an open router that takes this kind (no source yet, or one of this kind).
 * Several candidates are the person's choice, so nothing is bound.
 */
async function pickArea(file: RouterAreasFile, kind: RouterSourceKind, routerOpen: (id: string) => Promise<boolean>): Promise<RouterArea | 'none' | 'choose'> {
  const boundAreas = new Set((file.accountBindings ?? []).filter((one) => one.kind === kind).map((one) => one.areaId));
  if (boundAreas.size === 1) {
    const area = file.areas.find((one) => one.id === [...boundAreas][0]);
    if (area) return area;
  }
  if (boundAreas.size > 1) return 'choose';
  const candidates: RouterArea[] = [];
  for (const area of file.areas) {
    if (area.host !== '__local__') continue;
    if (area.sources.length && !area.sources.some((one) => one.kind === kind)) continue;
    const routers = file.routers.filter((one) => one.areaId === area.id && area.taskIds.includes(one.taskId));
    let open = false;
    for (const router of routers) if (await routerOpen(router.taskId)) { open = true; break; }
    if (open) candidates.push(area);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0 && file.areas.length === 0) return 'none';
  return 'choose';
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
    picked = file.areas.find((one) => one.id === ACCOUNT_ROUTER_AREA.id) ?? 'choose';
  }
  if (picked === 'choose') return { bound: false, reason: 'choose' };
  const areaId = picked.id;
  const now = (deps.now ?? Date.now)();
  const saved = await updateRouterAreas(home, (current) => {
    if (accountBinding(current, kind, account)) return current;
    const area = current.areas.find((one) => one.id === areaId);
    // The area went away meanwhile: nothing is bound, the next arrival asks again.
    if (!area) return current;
    if (!area.sources.some((one) => one.kind === kind && one.account === account)) area.sources.push({ kind, account });
    current.accountBindings = [...(current.accountBindings ?? []), { kind, account, areaId, boundAt: now }];
    return current;
  });
  const binding = accountBinding(saved, kind, account);
  if (!binding) return { bound: false, reason: 'choose' };
  return { bound: true, areaId: binding.areaId, created, already: false };
}

const sameSource = (a: RouterSource, b: RouterSource) => a.kind === b.kind && a.account === b.account && a.message === b.message
  && (a.version ?? '') === (b.version ?? '');

/** A copy (same canonical key or message) another area already holds stays that area's: never opened here. */
function heldElsewhere(file: RouterAreasFile, source: RouterSource, areaId: string, canonicalKey: string): boolean {
  return allAreaItems(file).some((one) => one.areaId !== areaId && one.source.kind === source.kind && one.source.account === source.account
    && (one.canonicalKey === canonicalKey || one.source.message === source.message));
}

const usableKey = (key: unknown): key is string => typeof key === 'string' && !!key && key.length <= ROUTER_CANONICAL_KEY_MAX
  && !/[\u0000-\u001f\u007f]/.test(key);

/**
 * Enters each exact new arrival of a bound account with an active router as an open item of its
 * area, under the areas lock with the live cache. Returns the sources this call wrote; one already
 * listed, held by another area, no longer current or of an account with no active router is not among them.
 */
export async function confirmAccountArrivals(sources: readonly RouterSource[], home = WALNUT_HOME, deps: AccountArrivalDeps = {}): Promise<readonly RouterSource[]> {
  if (sources.length === 0) return [];
  const off = await gate();
  if (off === 'replica' || off === 'test_run') return [];
  const before = await readRouterAreas(home);
  const routed = (file: RouterAreasFile, source: RouterSource) => {
    const binding = accountBinding(file, source.kind, source.account);
    return binding && activeRouter(file, binding.areaId) ? binding.areaId : undefined;
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
      file.openItems = [...(file.openItems ?? []), { source: { ...one.source }, areaId, canonicalKey: one.canonicalKey }];
      entered.push({ ...one.source });
    }
    return file;
  });
  return entered.filter((one) => (saved.openItems ?? []).some((item) => sameSource(item.source, one)));
}
