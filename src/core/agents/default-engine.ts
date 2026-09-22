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

/** Just the slice of config this reader needs (a whole `Config` satisfies it). */
export interface DefaultEngineConfig {
  defaults?: { engine?: unknown };
}

/** This machine's own host alias — the launcher's value for "no remote host". */
const LOCAL_HOST_ALIAS = '__local__';

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
  return configured;
}
