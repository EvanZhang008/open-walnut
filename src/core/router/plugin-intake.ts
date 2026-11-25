/**
 * A plugin's door into the router: the new arrivals of one of its accounts (a chat source's new DMs
 * and mentions) enter the person's router the way a mailbox's new mail does (account-intake.ts),
 * through the same binding, the same dedupe and the same wake. One router code path for every
 * channel (2026-11-16, the Slack source: "One router code path for both sources, no Slack-only copy").
 *
 * The plugin gives each arrival's labels ("dm", "mention", "channel:<name>"); the router takes only
 * those its account's `include` list names (areas.ts `sourceTakes`), every one when it has none.
 * Unlike a mailbox, a chat account never makes a router of its own: with no router to join, its
 * arrivals are not taken (`reason: 'none'`, or `closed` when its router's task is closed), and the
 * plugin keeps its own letters as before. The exception is a kind with a router of its own
 * (account-intake.ts OWN_ROUTER_AREAS, WeChat): its first arrival makes that router, and it never
 * joins the mail router. The arrivals the filter leaves out are named in
 * `skipped`, so the plugin handles those its old way too: a filter says what the router takes, it
 * never drops a message.
 *
 * Each kind is behind its own experiment (src/core/experimental.ts, CHAT_SOURCE_SWITCH): Slack behind
 * `router_chat_sources`, WeChat behind `router_wechat_source`. Off, nothing of that kind is taken.
 */
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { accountBinding, readRouterAreas, ROUTER_ACCOUNT_MAX, ROUTER_MESSAGE_MAX, sourceTakes, type RouterAreasFile } from './areas.js';
import {
  accountRouterState, confirmAccountArrivals, ensureAccountRouter, OWN_ROUTER_AREAS, type AccountArrivalDeps, type AccountRouterDeps,
} from './account-intake.js';
import { ROUTER_SOURCE_KINDS, type RouterSource, type RouterSourceKind } from './types.js';

export interface RouterArrival {
  message: string;
  version?: string;
  labels?: string[];
}

export type RouterIntakeResult =
  /** `skipped`: the message ids the account's filter leaves out, for the plugin's own handling. */
  | { taken: true; areaId: string; entered: number; filtered: number; skipped: string[] }
  | { taken: false; reason: 'off' | 'replica' | 'test_run' | 'choose' | 'none' | 'closed' };

/** The most arrivals one call may carry: a chat source's poll tick is far below it. */
export const ROUTER_INTAKE_MAX = 200;
const LABELS_MAX = 20;
const LABEL_MAX = 200;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface RouterIntakeDeps extends AccountArrivalDeps {
  home?: string;
  ensure?: (kind: RouterSourceKind, account: string, deps: AccountRouterDeps) => ReturnType<typeof ensureAccountRouter>;
  readAreas?: (home: string) => Promise<RouterAreasFile>;
  /** Wakes the area's router now rather than at its next 5-minute check. */
  kick?: (areaId: string) => Promise<void>;
  /** Whether a router task is open; absent = the task store's answer. */
  routerOpen?: (taskId: string) => Promise<boolean>;
  /** The experiment switch of the kind; absent = its CHAT_SOURCE_SWITCH in config.experimental. */
  enabled?: (kind: ChatSourceKind) => Promise<boolean>;
}

export type ChatSourceKind = Exclude<RouterSourceKind, 'mail'>;

/** Each chat kind's own experiment: turning one on never turns on another. */
export const CHAT_SOURCE_SWITCH = { slack: 'router_chat_sources', wechat: 'router_wechat_source' } as const satisfies Record<ChatSourceKind, string>;

/** Whether this chat kind enters the router at all (its CHAT_SOURCE_SWITCH experiment). */
export async function chatSourcesEnabled(kind: ChatSourceKind): Promise<boolean> {
  const [{ getConfig }, { experimentalEnabled }] = await Promise.all([import('../config-manager.js'), import('../experimental.js')]);
  return experimentalEnabled((await getConfig().catch(() => undefined))?.experimental, CHAT_SOURCE_SWITCH[kind]);
}

/**
 * Enters the arrivals as one batch, and one by one when the batch fails, so one bad item never holds
 * the rest. Throws only when every one failed.
 */
export async function enterArrivals(sources: readonly RouterSource[], home: string, deps: AccountArrivalDeps = {},
  enter: typeof confirmAccountArrivals = confirmAccountArrivals): Promise<readonly RouterSource[]> {
  try { return await enter(sources, home, deps); } catch (error) {
    if (sources.length <= 1) throw error;
    const entered: RouterSource[] = [];
    let failed = 0;
    for (const one of sources) {
      try { entered.push(...await enter([one], home, deps)); } catch { failed += 1; }
    }
    if (failed === sources.length) throw error;
    log.web.warn('router: some arrivals could not enter; the rest did', { failed, entered: entered.length });
    return entered;
  }
}

const plain = (value: unknown, max: number): value is string => typeof value === 'string' && !!value && value.length <= max && !CONTROL.test(value);

function checkedArrivals(arrivals: unknown): RouterArrival[] {
  if (!Array.isArray(arrivals) || arrivals.length > ROUTER_INTAKE_MAX) throw new TypeError(`router.intake takes a list of at most ${ROUTER_INTAKE_MAX} arrivals.`);
  return arrivals.map((raw, index) => {
    const one = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (!plain(one.message, ROUTER_MESSAGE_MAX)) throw new TypeError(`router.intake arrival ${index} needs a message id.`);
    if (one.version !== undefined && !plain(one.version, 200)) throw new TypeError(`router.intake arrival ${index} has an unusable version.`);
    const labels = one.labels === undefined ? [] : one.labels;
    if (!Array.isArray(labels) || labels.length > LABELS_MAX || !labels.every((label) => plain(label, LABEL_MAX))) {
      throw new TypeError(`router.intake arrival ${index} has unusable labels (at most ${LABELS_MAX} short strings).`);
    }
    return { message: one.message, ...(one.version !== undefined ? { version: one.version as string } : {}), labels: labels as string[] };
  });
}

/** Enters one account's new arrivals into the router that reads that account, binding it first. */
export async function routerIntake(kind: RouterSourceKind, account: string, arrivals: unknown, deps: RouterIntakeDeps = {}): Promise<RouterIntakeResult> {
  if (!(ROUTER_SOURCE_KINDS as readonly string[]).includes(kind)) throw new TypeError(`Unknown routing source kind: ${String(kind)}.`);
  // Mail has its own intake (it keeps arrivals for a closed router and writes the no-router letter).
  if (kind === 'mail') throw new TypeError('Mail enters the router through the mail plugin\'s own intake.');
  if (!plain(account, ROUTER_ACCOUNT_MAX)) throw new TypeError('router.intake needs the exact account id.');
  const asked = checkedArrivals(arrivals);
  if (!(await (deps.enabled ?? chatSourcesEnabled)(kind))) return { taken: false, reason: 'off' };
  const home = deps.home ?? WALNUT_HOME;
  const readAreas = deps.readAreas ?? readRouterAreas;
  // A chat account joins a router that exists; it never makes one, unless its kind has a router of its own.
  const ownRouter = !!OWN_ROUTER_AREAS[kind];
  const before = await readAreas(home);
  if (!ownRouter && !accountBinding(before, kind, account) && !before.routers.length) return { taken: false, reason: 'none' };
  // Bound to a router whose task is closed: nobody would wake for it, so the plugin keeps them.
  if (accountBinding(before, kind, account) && await accountRouterState(before, kind, account, deps.routerOpen) === 'closed') {
    return { taken: false, reason: 'closed' };
  }
  // The same open check as above, so the binding never reads a router as open that the check read as closed.
  const bound = await (deps.ensure ?? ensureAccountRouter)(kind, account, {
    home, readAreas, ...(deps.routerOpen ? { routerOpen: deps.routerOpen } : {}),
    ...(ownRouter ? {} : { createRouter: async () => { throw new Error('no router'); } }),
  })
    .catch(() => ({ bound: false as const, reason: 'none' as const }));
  if (!bound.bound) return { taken: false, reason: bound.reason };
  if (asked.length === 0) return { taken: true, areaId: bound.areaId, entered: 0, filtered: 0, skipped: [] };
  const file = await readAreas(home);
  const area = file.areas.find((one) => one.id === bound.areaId);
  const entry = area?.sources.find((one) => one.kind === kind && one.account === account);
  const wanted = asked.filter((one) => sourceTakes(entry, one.labels ?? []));
  const sources: RouterSource[] = wanted.map((one) => ({ kind, account, message: one.message, ...(one.version ? { version: one.version } : {}) }));
  const entered = sources.length ? await enterArrivals(sources, home, deps) : [];
  if (entered.length) {
    await (deps.kick ?? kickRouterWake)(bound.areaId).catch((error) => {
      log.web.warn('router: could not wake the router now; its next check takes the items', { areaId: bound.areaId, error: String(error) });
    });
  }
  const skipped = asked.filter((one) => !wanted.includes(one)).map((one) => one.message);
  return { taken: true, areaId: bound.areaId, entered: entered.length, filtered: skipped.length, skipped };
}

const KICK_GAP_MS = 30_000;
const lastKick = new Map<string, number>();
const trailing = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Runs the area's wake routine now, at most once per KICK_GAP_MS: a chat message should not wait
 * for the 5-minute check, and a burst of messages becomes one wake (the wake batches what is pending).
 * A kick inside the gap runs once more when the gap ends, so the tail of a burst waits seconds, not
 * the next 5-minute check.
 */
export async function kickRouterWake(areaId: string, now = Date.now()): Promise<void> {
  const wait = KICK_GAP_MS - (now - (lastKick.get(areaId) ?? 0));
  if (wait > 0) {
    if (!trailing.has(areaId)) {
      const timer = setTimeout(() => {
        trailing.delete(areaId);
        void kickRouterWake(areaId).catch(() => undefined);
      }, wait);
      timer.unref?.();
      trailing.set(areaId, timer);
    }
    return;
  }
  lastKick.set(areaId, now);
  const file = await readRouterAreas(WALNUT_HOME);
  const router = file.routers.find((one) => one.areaId === areaId && !one.paused);
  if (!router) return;
  const [{ routerWakeJobId }, { runRoutineNow }] = await Promise.all([import('./wake.js'), import('../routines/routines-core.js')]);
  await runRoutineNow(await routerWakeJobId(router.taskId));
}

/** Test-only: how many trailing kicks are armed. */
export function __pendingRouterKicks(): number { return trailing.size; }

/** Test-only. */
export function __resetRouterKicks(): void {
  lastKick.clear();
  for (const timer of trailing.values()) clearTimeout(timer);
  trailing.clear();
}
