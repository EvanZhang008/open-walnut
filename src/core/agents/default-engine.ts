/**
 * The DEFAULT engine reader — "which coding agent does a launch that named none
 * run on?".
 *
 * Kept beside the registry rather than inside it: the registry is pure data about
 * engines, while this answers a CONFIG question, and the default deliberately
 * lives at the reader instead of in DEFAULT_CONFIG (config-manager spreads the
 * parsed file OVER its defaults at the TOP level, so anything seeded in the
 * `defaults` object there is dropped by any config.yaml that has a `defaults:`
 * section at all — which every real config does).
 *
 * Every Walnut-initiated launch that names no engine goes through here (Ask
 * Walnut, the AI actions, triage runs, routines). A launch that picked one
 * explicitly never consults this — the caller's pick wins.
 */

import { log } from '../../logging/index.js';
import type { SessionEngine } from '../types.js';
import { DEFAULT_ENGINE, isAcpEngine, isKnownEngine } from './engine-registry.js';
import { ENGINE_PROBE_TTL_MS, probeEnginePresence } from './engine-probe.js';

/** Just the slice of config this reader needs (a whole `Config` satisfies it). */
export interface DefaultEngineConfig {
  defaults?: { engine?: unknown };
}

/** This machine's own host alias — the launcher's value for "no remote host". */
const LOCAL_HOST_ALIAS = '__local__';

// ── Availability: is the configured engine actually on this machine? ──
//
// A known engine id is not a usable engine. The Settings row that writes this
// value filters by the catalog's `installed` flag, but the client's COLD-START
// catalog presets `installed: true` (web/src/utils/engines.ts), so before
// GET /api/engines has hydrated a user can pick an engine this box does not
// have — and hand-editing config.yaml, or uninstalling a CLI after choosing it,
// reaches the same state. From then on EVERY Walnut-initiated launch (Ask
// Walnut, the mail/Slack AI actions, routines, Inbox Triage) inherits an engine
// whose worker cannot start. The server is the side that knows the truth, so it
// degrades here instead of producing broken sessions.
//
// There is exactly ONE notion of "installed" in this codebase: engine-probe.ts,
// the module GET /api/engines answers from. Deciding it is genuinely expensive
// (a PATH/bin-dir walk plus a `binary --version` child), and this reader is
// SYNCHRONOUS on the launch path, so what lives here is a MIRROR of the probe's
// last verdict, refreshed in the BACKGROUND off the same cache the catalog route
// serves. A launch therefore never waits for a probe and never adds a spawn: it
// reads the mirror and returns, and at worst that verdict is ENGINE_PROBE_TTL_MS
// old — exactly the staleness GET /api/engines already serves. The refresh it
// kicks is the probe's own work, at most once per engine per TTL, and it is a
// cache read whenever the catalog route (every page load) warmed it first.
//
// Deliberate: an engine we have NO verdict for keeps the user's choice. The only
// window that can hit is a launch before the first refresh has landed in a fresh
// process (microtasks after the first read, or after one fs walk on a cold probe
// cache). Demoting an engine nobody has looked at yet would cost a correctly
// configured user their engine, which is a worse failure than the one this guard
// exists for. Calling refreshDefaultEngineAvailability at boot would close even
// that window.

/** One engine's last known verdict, with the clock that decides a refresh. */
type EngineVerdict = { at: number; installed: boolean; reason: string | null };

const verdicts = new Map<SessionEngine, EngineVerdict>();
const refreshing = new Set<SessionEngine>();

/**
 * A unit-test process has none of these CLIs installed, and a config fixture
 * naming one must keep meaning what it says — so the launch path never starts a
 * probe (nor a `--version` child) under vitest. Same rule, same reason as
 * session-title-reconciler / search's background work. A test that wants the
 * guard exercised calls refreshDefaultEngineAvailability() itself.
 */
function inTestRunner(): boolean {
  return !!(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test');
}

/**
 * Pull one engine's verdict from the probe into the mirror. Safe to call often:
 * probeEnginePresence serves its own cache and dedupes concurrent probes, and
 * this skips a refresh that is already in flight.
 */
export async function refreshDefaultEngineAvailability(engine: SessionEngine): Promise<void> {
  if (refreshing.has(engine)) return;
  refreshing.add(engine);
  try {
    const availability = await probeEnginePresence(engine);
    verdicts.set(engine, {
      at: Date.now(),
      installed: availability.installed,
      reason: availability.reason ?? null,
    });
  } catch {
    // An availability check that failed says nothing about the engine, and must
    // never be the reason a user loses the one they configured.
  } finally {
    refreshing.delete(engine);
  }
}

/** The mirrored verdict, kicking a background refresh when it is missing or stale. */
function availabilityOf(engine: SessionEngine): EngineVerdict | undefined {
  const known = verdicts.get(engine);
  if (!inTestRunner() && (!known || Date.now() - known.at >= ENGINE_PROBE_TTL_MS)) {
    void refreshDefaultEngineAvailability(engine);
  }
  // A stale verdict is still used: "one launch on claude" is a smaller wrong
  // than "one broken session per minute" for an engine that is really missing.
  return known;
}

/** Tests only: forget every mirrored verdict. */
export function _resetDefaultEngineAvailabilityForTesting(): void {
  verdicts.clear();
  refreshing.clear();
}

/**
 * The engine a launch inherits.
 *
 * Unknown / malformed values fall back to the default engine with a debug line
 * rather than throwing: this is read on the launch path, and a config typo must
 * not be able to fail every session start.
 *
 * `opts.host` applies the one rule that is not about config: the ACP worker is
 * only deployed locally (`localOnly` in GET /api/engines, the client's
 * `resolveEngineForHost`), so an ACP default is dropped for a launch aimed at a
 * remote host instead of spawning something that host cannot run. An engine the
 * CALLER named explicitly is not touched by this — only the inherited one.
 *
 * An engine that is not INSTALLED degrades the same way (see the availability
 * block above): a default nothing can start would otherwise break every
 * Walnut-initiated session, and it degrades loudly (a warn naming the configured
 * engine, what ran instead, and the probe's reason).
 */
export function resolveDefaultEngine(
  config: DefaultEngineConfig | null | undefined,
  opts?: { host?: string | null },
): SessionEngine {
  const configured = config?.defaults?.engine;
  if (configured === undefined || configured === null || configured === '') return DEFAULT_ENGINE;
  if (!isKnownEngine(configured)) {
    log.session.debug('default engine: config value is not a known engine — using the default', {
      configured: String(configured), engine: DEFAULT_ENGINE,
    });
    return DEFAULT_ENGINE;
  }
  // '__local__' is this machine's own alias, not a remote host (daemon-file-reader,
  // cloud-exec's reserved list) — reading it as remote would drop the user's
  // engine on a launch that runs right here.
  const remoteHost = opts?.host && opts.host !== LOCAL_HOST_ALIAS ? opts.host : null;
  if (remoteHost && isAcpEngine(configured)) {
    log.session.debug('default engine: the configured engine runs locally only — a remote launch uses the default', {
      configured, host: remoteHost, engine: DEFAULT_ENGINE,
    });
    return DEFAULT_ENGINE;
  }
  // The default engine is walnut's own substrate and is always installed (it is
  // also the fallback), so it is never probed — the check would only ever be
  // able to demote it to itself.
  if (configured === DEFAULT_ENGINE) return configured;
  const availability = availabilityOf(configured);
  if (availability && !availability.installed) {
    // warn, not debug: a configured engine this machine cannot run is a broken
    // setting, and the only place it can be noticed is a log line.
    log.session.warn('default engine: the configured engine is not available on this machine — using the default', {
      configured, engine: DEFAULT_ENGINE, reason: availability.reason,
    });
    return DEFAULT_ENGINE;
  }
  return configured;
}
