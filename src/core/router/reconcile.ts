/**
 * The router's missed-message check (2026-11-16, the Slack source: "a missed-message reconciliation
 * (compare router intake with Slack's own counts)"). Once an hour per area, each bound account whose
 * source can say what it saw (`recent` on its adapter) is compared with what reached the router: an
 * arrival its filter takes that is neither an item of the area nor a row of its ledger was missed
 * (a poll that failed, a restart between the fetch and the intake), and enters now, through the same
 * intake as any arrival. The counts are kept per area for the router page ("Slack saw 12, the router
 * had 12").
 *
 * Counts and ids only; never an item's words. A source that cannot answer is reported as such, never
 * as "nothing missed".
 */
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { readJsonFile, writeJsonFile } from '../../utils/fs.js';
import { allAreaItems, readRouterAreas, routerAreasPath, sourceTakes, type RouterAreasFile } from './areas.js';
import { chatSourcesEnabled, enterArrivals } from './plugin-intake.js';
import { hasRouterRecent, recentRouterSources, type RouterRecentArrival } from './source-registry.js';
import { routerKey } from './store.js';
import type { RouterSource, RouterSourceKind } from './types.js';

/** How far back each check looks: a day, so a missed arrival is found on the next hourly check. */
export const ROUTER_RECONCILE_WINDOW_MS = 24 * 60 * 60_000;
/** A binding is written during its first intake, a little after the arrivals that made it: they count. */
export const ROUTER_RECONCILE_BIND_MARGIN_MS = 10 * 60_000;
/** An arrival younger than this may still be on its way through the intake: not counted yet. */
export const ROUTER_RECONCILE_GRACE_MS = 5 * 60_000;
export const ROUTER_RECONCILE_EVERY_MS = 60 * 60_000;

export interface RouterReconcileAccount {
  kind: RouterSourceKind;
  account: string;
  /** What the source saw in the window that the account's filter takes. */
  saw: number;
  /** What the source saw that the filter leaves out. */
  filtered: number;
  /** Of `saw`, what had reached the router (an item of the area or a ledger row). */
  had: number;
  /** Of `saw`, what had not. */
  missed: number;
  /** Of `missed`, what this check entered (the rest the intake refused: gone from the cache, another area's). */
  entered: number;
  /** The source could not say what it saw: nothing above is counted. */
  error?: string;
}

export interface RouterReconcileReport {
  areaId: string;
  at: number;
  sinceMs: number;
  untilMs: number;
  accounts: RouterReconcileAccount[];
}

export interface RouterReconcileDeps {
  home?: string;
  now?: () => number;
  readAreas?: (home: string) => Promise<RouterAreasFile>;
  hasRecent?: (kind: RouterSourceKind) => boolean;
  recent?: (kind: RouterSourceKind, account: string, sinceMs: number, untilMs: number) => Promise<RouterRecentArrival[]>;
  routesFor?: (areaId: string, sources: readonly RouterSource[]) => Promise<Map<string, unknown>>;
  enter?: (sources: readonly RouterSource[], home: string) => Promise<readonly RouterSource[]>;
  kick?: (areaId: string) => Promise<void>;
  /** Whether the check runs at all; absent = the chat-source experiment and the auto-router switch. */
  enabled?: () => Promise<boolean>;
}

const LOOKUP_BATCH = 200;

function reportPath(home: string, areaId: string): string {
  return path.join(path.dirname(routerAreasPath(home)), `reconcile-${areaId}.json`);
}

export async function readReconcileReport(areaId: string, home = WALNUT_HOME): Promise<RouterReconcileReport | null> {
  const report = await readJsonFile<RouterReconcileReport | null>(reportPath(home, areaId), null).catch(() => null);
  return report && report.areaId === areaId && Array.isArray(report.accounts) ? report : null;
}

const same = (a: RouterSource, b: RouterSource) => a.kind === b.kind && a.account === b.account && a.message === b.message
  && (a.version ?? '') === (b.version ?? '');

/** Compares one area's accounts with what their sources saw, enters the missed, and keeps the counts. */
export async function reconcileArea(areaId: string, deps: RouterReconcileDeps = {}): Promise<RouterReconcileReport> {
  const home = deps.home ?? WALNUT_HOME;
  const now = (deps.now ?? Date.now)();
  const untilMs = now - ROUTER_RECONCILE_GRACE_MS;
  const sinceMs = now - ROUTER_RECONCILE_WINDOW_MS;
  const file = await (deps.readAreas ?? readRouterAreas)(home);
  const area = file.areas.find((one) => one.id === areaId);
  const accounts: RouterReconcileAccount[] = [];
  const hasRecent = deps.hasRecent ?? hasRouterRecent;
  const recent = deps.recent ?? recentRouterSources;
  const routesFor = deps.routesFor ?? (async (id: string, sources: readonly RouterSource[]) => {
    const { routerStore } = await import('./runtime.js');
    return await routerStore(id, home).getSources(sources);
  });
  const enter = deps.enter ?? ((sources: readonly RouterSource[], at: string) => enterArrivals(sources, at));
  let enteredAny = false;
  for (const binding of (file.accountBindings ?? []).filter((one) => one.areaId === areaId)) {
    if (!hasRecent(binding.kind)) continue;
    const row: RouterReconcileAccount = { kind: binding.kind, account: binding.account, saw: 0, filtered: 0, had: 0, missed: 0, entered: 0 };
    accounts.push(row);
    try {
      const entry = area?.sources.find((one) => one.kind === binding.kind && one.account === binding.account);
      // Never before the binding (less its first intake's margin), and never before the filter
      // last changed: widening a filter takes the next arrivals, it does not reach back a day.
      const from = Math.max(sinceMs, binding.boundAt - ROUTER_RECONCILE_BIND_MARGIN_MS, entry?.includeAt ?? 0);
      const seen = await recent(binding.kind, binding.account, from, untilMs);
      const taken = seen.filter((one) => sourceTakes(entry, one.labels));
      row.saw = taken.length;
      row.filtered = seen.length - taken.length;
      const listed = allAreaItems(file).filter((item) => item.areaId === areaId).map((item) => item.source);
      const missing: RouterSource[] = [];
      for (let at = 0; at < taken.length; at += LOOKUP_BATCH) {
        const batch = taken.slice(at, at + LOOKUP_BATCH).map((one) => one.source);
        const routes = await routesFor(areaId, batch);
        for (const source of batch) {
          if (routes.has(routerKey(source)) || listed.some((one) => same(one, source))) row.had += 1;
          else missing.push(source);
        }
      }
      row.missed = missing.length;
      if (missing.length) {
        row.entered = (await enter(missing, home)).length;
        enteredAny ||= row.entered > 0;
        log.web.info('router reconcile: entered arrivals the intake missed', {
          areaId, kind: binding.kind, missed: row.missed, entered: row.entered,
        });
      }
    } catch (error) {
      row.error = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }
  }
  const report: RouterReconcileReport = { areaId, at: now, sinceMs, untilMs, accounts };
  if (accounts.length) await writeJsonFile(reportPath(home, areaId), report);
  if (enteredAny) {
    const kick = deps.kick ?? (async (id: string) => (await import('./plugin-intake.js')).kickRouterWake(id));
    await kick(areaId).catch(() => undefined);
  }
  return report;
}

const running = new Set<string>();

async function reconcileEnabled(): Promise<boolean> {
  // The intake's own switches: what the intake would refuse, the check never enters behind its back.
  if (process.env.WALNUT_MAIL_AUTO_ROUTER === '0') return false;
  return await chatSourcesEnabled();
}

/**
 * Runs the check when the last one is an hour old, in the background: the router wake's 5-minute
 * check calls it, so a slow source never holds the wake. One at a time per area.
 */
export async function reconcileIfDue(areaId: string, deps: RouterReconcileDeps = {}): Promise<void> {
  // Taken before the first await: two wakes of one area at once must not both pass the check.
  if (running.has(areaId)) return;
  running.add(areaId);
  try {
    if (!(await (deps.enabled ?? reconcileEnabled)())) return;
    const home = deps.home ?? WALNUT_HOME;
    const now = (deps.now ?? Date.now)();
    const last = await readReconcileReport(areaId, home);
    if (last && now - last.at < ROUTER_RECONCILE_EVERY_MS && last.at <= now) return;
    const file = await (deps.readAreas ?? readRouterAreas)(home);
    const hasRecent = deps.hasRecent ?? hasRouterRecent;
    if (!(file.accountBindings ?? []).some((one) => one.areaId === areaId && hasRecent(one.kind))) return;
    await reconcileArea(areaId, deps);
  } catch (error) {
    log.web.warn('router reconcile: the check failed', { areaId, error: String(error) });
  } finally { running.delete(areaId); }
}
