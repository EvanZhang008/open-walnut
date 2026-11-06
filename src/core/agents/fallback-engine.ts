/**
 * The fallback engine: where a NEW task starts while the default engine is out of
 * usage on its host (Settings > Sessions, "When it is out of usage";
 * `config.defaults.fallback_engine`).
 *
 *   launch names no engine and no model
 *        │
 *        ├─ no fallback set ─────────────────────────────► default engine (as before)
 *        ├─ default engine not limited on this host ─────► default engine
 *        ├─ fallback cannot run there, or is limited too ► default engine (it waits for the reset)
 *        ├─ another model of the same subscription,
 *        │  under a limit that covers it too ───────────► default engine (it waits for the reset)
 *        └─ otherwise ───────────────────────────────────► fallback engine (and its model);
 *                                                           the task carries Task.engine_fallback
 *
 * "Limited" is read through one seam (engine-limit-source.ts), not tracked here: a session of
 * that engine on that host whose turn the limit stopped and whose reset has not come
 * (sessionLimitOf), or the host's own Claude reading that the limit blocks (blockedLimitOf over the
 * host's subscription-limit frame). A session that is already running is not this module's.
 *
 * A launch that names an engine or a model chose for itself and never falls back.
 */
import { log } from '../../logging/index.js';
import { resolveModelSwitchValue, type EngineFallbackNote, type FallbackEngineSetting, type SessionEngine, type SessionRecord } from '../types.js';
import type { HostLimitFrame } from '../sessions/subscription-limits.js';
import { blockedLimitOf, sessionLimitOf, type SessionLimitReading } from './engine-limit-source.js';
import { isKnownEngine, resolveEngine } from './engine-registry.js';
import { claudeFamilyOf } from './fallback-engine-words.js';

const LOCAL_HOST = '__local__';

/** A stop whose reset the engine did not name holds this long past the stop (the wait's first look). */
export const UNKNOWN_RESET_HOLD_MS = 30 * 60_000;

/** One limit in force: what stopped the engine, and until when. */
export interface EngineLimitNow {
  window?: string;
  /** Epoch ms; absent = the engine did not say. */
  resetsAt?: number;
  resetsFrom?: 'event' | 'text' | 'host';
}

/** What the launch reads; a test hands in its own. */
export interface FallbackDeps {
  listSessions: () => Promise<SessionRecord[]>;
  /** One session's usage-limit stop (engine-limit-source.ts), or undefined when none holds it. */
  sessionLimit: (rec: SessionRecord, now: number) => SessionLimitReading | undefined;
  hostFrame: (host: string) => Promise<HostLimitFrame | undefined>;
  /** Whether `engine` can start on `host` (undefined = no answer); `dial` false asks no unlinked host. */
  runnable: (engine: SessionEngine, host: string, dial?: boolean) => Promise<boolean | undefined>;
  now: () => number;
}

function hostKey(host: string | null | undefined): string {
  return !host || host === 'local' ? LOCAL_HOST : host;
}

/** The setting, or null when it is off or names nothing usable. */
export function fallbackSetting(config: { defaults?: { fallback_engine?: unknown } } | null | undefined): FallbackEngineSetting | null {
  const raw = config?.defaults?.fallback_engine as { engine?: unknown; model?: unknown; model_label?: unknown } | null | undefined;
  if (!raw || typeof raw !== 'object' || !isKnownEngine(raw.engine)) return null;
  const model = typeof raw.model === 'string' && raw.model.trim() && raw.model !== 'default' ? raw.model.trim() : undefined;
  const label = model && typeof raw.model_label === 'string' && raw.model_label.trim() ? raw.model_label.trim() : undefined;
  return { engine: raw.engine, ...(model ? { model } : {}), ...(label ? { model_label: label } : {}) };
}

/** Re-exported: the launch's rule (claudeFamilyOf) lives with the words, which the web reads too. */
export { claudeFamilyOf };

/** How long one session's usage-limit stop holds the engine, or null when it no longer does. */
function recordHoldsUntil(w: SessionLimitReading | undefined, now: number): EngineLimitNow | null {
  if (!w) return null;
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (Number.isFinite(reset)) {
    return reset > now ? { ...(w.window ? { window: w.window } : {}), resetsAt: reset, ...(w.resetsFrom ? { resetsFrom: w.resetsFrom } : {}) } : null;
  }
  // No reset named: the latest word on it holds for the wait's first look, or until its next try.
  const marks = [w.since, w.resumedAt, w.offAt, w.gaveUpAt].map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite);
  const last = marks.length ? Math.max(...marks) : NaN;
  const due = w.dueAt ? Date.parse(w.dueAt) : NaN;
  const until = Math.max(Number.isFinite(last) ? last + UNKNOWN_RESET_HOLD_MS : -Infinity, Number.isFinite(due) ? due : -Infinity);
  return until > now ? { ...(w.window ? { window: w.window } : {}) } : null;
}

/** A window of one model only (the weekly Opus window): another model of the engine still runs. */
const PER_MODEL_WINDOW = /^seven_day_(opus|sonnet)$/;

/**
 * The host's own reading blocks Claude: rejected with no extra usage to go on, reset still ahead,
 * on the subscription the host is signed in with now (a host moved to an API key or a cloud
 * provider keeps its old subscription reading until the reset), and not one model's own window.
 */
function frameHolds(frame: HostLimitFrame | undefined, now: number, perModel = false): EngineLimitNow | null {
  const cur = frame?.current;
  if (!cur || frame?.signIn?.kind === 'other') return null;
  if (!perModel && cur.type && PER_MODEL_WINDOW.test(cur.type)) return null;
  const blocked = blockedLimitOf({
    status: cur.status, rateLimitType: cur.type, resetsAt: cur.resetsAt,
    overageStatus: frame?.overage?.status, isUsingOverage: frame?.overage?.isUsingOverage,
  });
  if (!blocked || blocked === 'allowed' || !blocked.resetsAt || blocked.resetsAt <= now) return null;
  return { ...(blocked.window ? { window: blocked.window } : {}), resetsAt: blocked.resetsAt, resetsFrom: 'host' };
}

/**
 * Is `engine` out of usage on `host` now? The limit with the latest known reset wins (the one the
 * user waits for); a stop with no named reset counts when nothing names one.
 */
export async function engineLimitNow(
  engine: SessionEngine, host: string | null | undefined, deps: FallbackDeps,
  /** The session rows already read for this launch (one read serves both engines). */
  rows?: SessionRecord[],
): Promise<EngineLimitNow | null> {
  return latestLimit(await engineLimits(engine, host, deps, rows));
}

/** Every limit in force on `engine` there; `perModel` also counts the host's one-model windows. */
async function engineLimits(
  engine: SessionEngine, host: string | null | undefined, deps: FallbackDeps,
  rows?: SessionRecord[], perModel = false,
): Promise<EngineLimitNow[]> {
  const key = hostKey(host);
  const now = deps.now();
  const found: EngineLimitNow[] = [];
  for (const rec of rows ?? await deps.listSessions()) {
    if (resolveEngine(rec.engine) !== engine || hostKey(rec.host) !== key || rec.archived) continue;
    const held = recordHoldsUntil(deps.sessionLimit(rec, now), now);
    // One model's weekly window leaves the engine's other models running, as the host reading does.
    if (held && !perModel && held.window && PER_MODEL_WINDOW.test(held.window)) continue;
    if (held) found.push(held);
  }
  // The host's subscription reading is Claude Code's (its rate_limit_event).
  if (engine === 'claude') {
    const held = frameHolds(await deps.hostFrame(key).catch(() => undefined), now, perModel);
    if (held) found.push(held);
  }
  return found;
}

function latestLimit(found: EngineLimitNow[]): EngineLimitNow | null {
  if (!found.length) return null;
  const named = found.filter((f) => f.resetsAt !== undefined).sort((a, b) => b.resetsAt! - a.resetsAt!);
  return named[0] ?? found[0];
}

/** The launch's decision: run on the fallback, and why. */
export interface FallbackDecision {
  engine: SessionEngine;
  model?: string;
  note: EngineFallbackNote;
}

/**
 * Why a fallback that is set does not take a launch while the default engine is out of usage
 * (Settings says so under the row): no model picked for the same engine, the fallback is not
 * installed there or did not answer, it is out of usage too, or it is another model of the same
 * subscription and the limit covers it as well.
 */
export type FallbackSkip = 'needs_model' | 'not_runnable' | 'limited_too' | 'shares_limit';

/** The decision with its reasons: the limit in force (if any), and why the fallback did not take it. */
export interface FallbackExplained {
  decision: FallbackDecision | null;
  limit: EngineLimitNow | null;
  skip?: FallbackSkip;
}

/**
 * Where a launch that named no engine and no model starts, when it is not the default engine:
 * the fallback, with the note its task carries. null = the default engine, as before.
 */
export async function resolveFallbackLaunch(
  config: { defaults?: { fallback_engine?: unknown } } | null | undefined,
  defaultEngine: SessionEngine,
  host: string | null | undefined,
  opts: { deps?: FallbackDeps; /** A read for display (the draft's line): no log lines. */ quiet?: boolean } = {},
): Promise<FallbackDecision | null> {
  return (await explainFallbackLaunch(config, defaultEngine, host, opts)).decision;
}

export async function explainFallbackLaunch(
  config: { defaults?: { fallback_engine?: unknown } } | null | undefined,
  defaultEngine: SessionEngine,
  host: string | null | undefined,
  opts: { deps?: FallbackDeps; quiet?: boolean } = {},
): Promise<FallbackExplained> {
  const deps = opts.deps ?? fallbackDeps();
  const say = (level: 'info' | 'warn', msg: string, fields: Record<string, unknown>): void => {
    if (!opts.quiet) log.session[level](msg, fields);
  };
  const setting = fallbackSetting(config);
  if (!setting) return { decision: null, limit: null };
  const sameEngine = setting.engine === defaultEngine;
  const rows = await deps.listSessions();
  // Another Claude model of the same subscription helps only under one model's own weekly window
  // (the weekly Opus limit leaves Sonnet running); the 5-hour and weekly windows cover them all.
  const family = sameEngine && defaultEngine === 'claude' ? claudeFamilyOf(setting.model) : null;
  const limits = await engineLimits(defaultEngine, host, deps, rows, !!family);
  const limit = latestLimit(limits);
  if (!limit) return { decision: null, limit: null };
  // The same engine on its own default model is no fallback at all.
  if (sameEngine && !setting.model) return { decision: null, limit, skip: 'needs_model' };
  const key = hostKey(host);
  if (family) {
    const covers = limits.filter((l) => !l.window || !PER_MODEL_WINDOW.test(l.window) || l.window === `seven_day_${family}`);
    if (covers.length) {
      say('info', 'fallback engine: the fallback model shares the limit in force, so the launch stays on the default model', {
        host: key, model: setting.model, window: latestLimit(covers)?.window,
      });
      return { decision: null, limit: latestLimit(covers), skip: 'shares_limit' };
    }
  }
  const runs = setting.engine === 'claude' ? true : await deps.runnable(setting.engine, key, !opts.quiet).catch(() => undefined);
  if (runs !== true) {
    say('warn', 'fallback engine: it cannot start on this host, so the launch stays on the default engine and waits for the reset', {
      host: key, from: defaultEngine, fallback: setting.engine, answer: runs === undefined ? 'no answer' : 'not installed',
    });
    return { decision: null, limit, skip: 'not_runnable' };
  }
  // Another engine that is out of usage too would only stop at once.
  if (!sameEngine && await engineLimitNow(setting.engine, host, deps, rows)) {
    say('info', 'fallback engine: it is out of usage too, so the launch stays on the default engine', { host: key, from: defaultEngine, fallback: setting.engine });
    return { decision: null, limit, skip: 'limited_too' };
  }
  const note: EngineFallbackNote = {
    from: defaultEngine, to: setting.engine, ...(setting.model ? { model: setting.model } : {}),
    ...(setting.model_label ? { model_label: setting.model_label } : {}),
    ...(limit.window ? { window: limit.window } : {}),
    ...(limit.resetsAt ? { resets_at: new Date(limit.resetsAt).toISOString() } : {}),
    ...(limit.resetsFrom ? { resets_from: limit.resetsFrom } : {}),
    ...(key !== LOCAL_HOST ? { host: key } : {}),
    at: new Date(deps.now()).toISOString(),
  };
  say('info', 'fallback engine: the default engine is out of usage, so this new task starts on the fallback', {
    host: key, from: defaultEngine, to: setting.engine, model: setting.model, window: limit.window, resetsAt: note.resets_at,
  });
  // A Claude Code model is the CLI's form ('sonnet-1m' -> 'sonnet[1m]'), as a picked one is.
  const model = setting.model && setting.engine === 'claude' ? resolveModelSwitchValue(setting.model) : setting.model;
  // A Claude Code model the launch cannot take (a config written by hand) is no fallback.
  if (setting.model && !model) {
    say('warn', 'fallback engine: its model is not one Claude Code takes, so the launch stays on the default engine', { model: setting.model });
    return { decision: null, limit };
  }
  return { decision: { engine: setting.engine, ...(model ? { model } : {}), note }, limit };
}

/**
 * Whether a launch through quickStartSession that names no engine and no model may fall back on
 * its own: a routine's new task. The web's new task decides in its route (and hands the decision
 * in); Walnut's own agents (Ask Walnut, subagents, an org lead) run the profile only Claude Code
 * carries, and the other callers (the phone, a repair, a workspace's replay) keep the engine they
 * were given.
 */
export function selfDecidesFallback(source: string, walnutAgent: boolean | undefined): boolean {
  return !walnutAgent && /^routine(-|$)/.test(source);
}

/** The launch's own readers (the session store, the host's limit reading, its engines). */
export function fallbackDeps(): FallbackDeps {
  return {
    listSessions: async () => (await import('../session-tracker.js')).listSessions(),
    sessionLimit: sessionLimitOf,
    hostFrame: async (host) => {
      const { readSubscriptionLimits } = await import('../sessions/subscription-limits.js');
      return (await readSubscriptionLimits(host))[0];
    },
    runnable: async (engine, host, dial = true) => {
      // The same answers the engine rail greys engines out by (GET /api/engines/availability).
      // A read for display does not dial a host that is not linked (a draft reads every minute).
      const { hostEnginesAvailability } = await import('./host-engines.js');
      const a = (await hostEnginesAvailability(host, { dial }))[engine];
      return a ? a.installed : undefined;
    },
    now: () => Date.now(),
  };
}
