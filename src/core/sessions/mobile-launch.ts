/**
 * Mobile session-launch core — shared by the /api/v1 launch route (primary
 * box) and the daemon launch-relay handler (cloud companion path).
 *
 * The cloud companion (REPLICA) has no spawn path of its own: session records
 * live on the primary box (session-tracker) and quickStartSession() is the
 * only correct creation core (task create/reuse → SESSION_START → session-
 * runner). So a phone launch through the cloud rides the bridge to the
 * PRIMARY's daemon as a narrow `session.launch` command, which the daemon
 * relays up to its connected walnut server as a `launch-request` event (same
 * relay shape as the STT path). That server calls handleLaunchRelayRequest()
 * here — the exact validation + quick-start chain the local HTTP route uses.
 *
 * Everything here is Mac-side logic: config.hosts allowlist, frequent-dirs
 * scoring, quickStartSession. The cloud box only forwards validated shapes.
 */

import { randomUUID } from 'node:crypto';
import { QUICK_START_MESSAGE_HARD_LIMIT } from '../../constants.js';
import { getConfig } from '../config-manager.js';
import { getFrequentDirs, scoreFrequentDir } from '../frequent-dirs.js';
import { quickStartSession, QuickStartError } from './quick-start.js';
import { resolveModelSwitchValue, VALID_SESSION_MODEL_IDS, VALID_SESSION_MODE_IDS } from '../types.js';
import type { SessionEngine } from '../types.js';
import { engineCaps, isKnownEngine, normalizeEngine } from '../agents/engine-registry.js';
import { log } from '../../logging/index.js';

/** Launch-time permission modes — the full registry set (core/types.ts). */
export const VALID_LAUNCH_MODES = VALID_SESSION_MODE_IDS;
const MAX_SUGGESTED_DIRS = 30;

export interface LaunchOptionsHost { alias: string; label: string }
export interface LaunchOptionsDir {
  cwd: string; host: string; hostLabel?: string; lastUsed: string; count: number;
}
export interface LaunchOptionsResult { hosts: LaunchOptionsHost[]; dirs: LaunchOptionsDir[] }

/** Validated launch input — every field already shape-checked. */
export interface MobileLaunchInput {
  cwd: string;
  /** undefined = the primary box; otherwise a config.hosts alias (validated
   *  against the config in performMobileLaunch, not here). */
  host?: string;
  message: string;
  taskId?: string;
  taskTitle?: string;
  project?: string;
  model?: string;
  mode?: string;
  engine?: SessionEngine;
}

/** HTTP status → frozen v1 error code (also the relay errorKind vocabulary). */
export function launchErrorCode(status: number): string {
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'internal';
  return 'bad_request';
}

/**
 * Static shape validation (no config reads) — shared verbatim between the
 * local route, the cloud route's fast-fail, and the relay handler's re-check.
 * Throws QuickStartError(message, 400) with the exact messages the frozen
 * /api/v1 contract already ships.
 */
function validateLaunchBody(body: unknown, allowEngine: boolean): MobileLaunchInput {
  const {
    cwd, host: rawHost, message, taskId, taskTitle, project, model: rawModel, mode, engine,
  } = (body ?? {}) as {
    cwd?: unknown;
    host?: unknown;
    message?: unknown;
    taskId?: unknown;
    taskTitle?: unknown;
    project?: unknown;
    model?: unknown;
    mode?: unknown;
    engine?: unknown;
  };

  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw new QuickStartError('cwd is required', 400);
  }
  // Absolute-only: a relative path from a phone keyboard would still 201
  // (spawn is async) and then die as an opaque session error. This is the
  // server-side gate; the sheet's hasPrefix("/") check is the client mirror.
  if (!cwd.startsWith('/')) {
    throw new QuickStartError('cwd must be an absolute path', 400);
  }
  if (cwd.length > 4096) {
    throw new QuickStartError('cwd too long (max 4096 chars)', 400);
  }
  // Empty/absent message = spawn + idle with no first turn (same contract as
  // the web launcher's path-first start).
  if (message !== undefined && typeof message !== 'string') {
    throw new QuickStartError('message must be a string', 400);
  }
  const msg = typeof message === 'string' ? message : '';
  if (msg.length > QUICK_START_MESSAGE_HARD_LIMIT) {
    throw new QuickStartError(`message too long (max ${QUICK_START_MESSAGE_HARD_LIMIT} chars)`, 400);
  }
  if (taskId !== undefined && (typeof taskId !== 'string' || !taskId)) {
    throw new QuickStartError('taskId must be a non-empty string', 400);
  }
  if (taskTitle !== undefined && (typeof taskTitle !== 'string' || !taskTitle.trim() || taskTitle.length > 500)) {
    throw new QuickStartError('taskTitle must be a non-empty string up to 500 characters', 400);
  }
  if (project !== undefined && (typeof project !== 'string' || project.length > 256)) {
    throw new QuickStartError('project must be a string up to 256 characters', 400);
  }
  if (allowEngine && engine !== undefined && !isKnownEngine(engine)) {
    throw new QuickStartError('engine must be claude or codex', 400);
  }

  // Host: '' / absent = the primary box. Non-string is a shape error here;
  // whether the alias exists/is enabled is a config check in performMobileLaunch.
  let host: string | undefined;
  if (rawHost !== undefined && rawHost !== null && rawHost !== '') {
    if (typeof rawHost !== 'string') {
      throw new QuickStartError('host must be a string', 400);
    }
    host = rawHost;
  }

  // Model: same shared validator as the web quick-start / model-switch routes.
  let model: string | undefined;
  if (typeof rawModel === 'string' && rawModel && rawModel !== 'default') {
    const resolved = resolveModelSwitchValue(rawModel);
    if (!resolved) {
      throw new QuickStartError(`Invalid model: ${rawModel}. Use one of: ${[...VALID_SESSION_MODEL_IDS].join('/')}`, 400);
    }
    model = resolved;
  }

  if (mode !== undefined && (typeof mode !== 'string' || !VALID_LAUNCH_MODES.has(mode))) {
    throw new QuickStartError(`Invalid mode: ${String(mode)}. Must be one of: ${[...VALID_LAUNCH_MODES].join(', ')}`, 400);
  }

  return {
    cwd, host, message: msg,
    taskId: typeof taskId === 'string' ? taskId : undefined,
    taskTitle: typeof taskTitle === 'string' ? taskTitle.trim() : undefined,
    project: typeof project === 'string' ? project.trim() : undefined,
    model,
    mode: typeof mode === 'string' ? mode : undefined,
    engine: allowEngine ? engine as MobileLaunchInput['engine'] : undefined,
  };
}

export function validateMobileLaunchBody(body: unknown): MobileLaunchInput {
  return validateLaunchBody(body, false);
}

export function validateDelegateLaunchBody(body: unknown): MobileLaunchInput {
  return validateLaunchBody(body, true);
}

/**
 * Hosts + suggested working dirs for the mobile New Session sheet. Hosts: the
 * primary box (alias '' — matching ProjectedSession.host semantics) plus every
 * enabled config.hosts entry. Dirs: the frequent-directories store, scored by
 * the shared launcher formula (same as GET /api/sessions/working-dirs),
 * capped at 30.
 */
export async function computeLaunchOptions(): Promise<LaunchOptionsResult> {
  const config = await getConfig();
  const hostsCfg = config.hosts ?? {};
  const { reservedHostAliasConflicts } = await import('../cloud-exec.js');
  // A config.hosts entry named '__local__'/'__cloud__' would SHADOW a reserved
  // alias in the picker, and a launch on it would silently run on the wrong
  // machine. Drop it from the offer and say so — never throw: one bad host entry
  // must not take down the whole launcher.
  const reserved = new Set(reservedHostAliasConflicts(Object.keys(hostsCfg)));
  if (reserved.size > 0) {
    log.session.warn('launch options: dropping config.hosts entries that shadow reserved aliases', {
      aliases: [...reserved],
    });
  }
  const hosts = [
    { alias: '', label: 'This Mac' },
    ...Object.entries(hostsCfg)
      .filter(([alias, h]) => h.enabled !== false && !reserved.has(alias))
      .map(([alias, h]) => ({ alias, label: h.label ?? alias })),
  ];
  // NOTE: the cloud companion's own host row is NOT added here. This function
  // answers the primary's relay too, and the PRIMARY cannot know whether the
  // companion is configured to execute — only the companion knows that. The
  // cloud route appends its own entry to the relayed result
  // (routes/session-launch-v1.ts), which is also the only box that can honor a
  // launch targeting it.
  const offeredAliases = new Set(hosts.map((h) => h.alias));

  const raw = await getFrequentDirs();
  const now = Date.now();
  let maxAgeMs = 1;
  let maxCount = 1;
  for (const d of raw) {
    const age = now - new Date(d.lastUsed).getTime();
    if (age > maxAgeMs) maxAgeMs = age;
    if (d.count > maxCount) maxCount = d.count;
  }
  const dirs = raw
    // count===0 rows are recordLaunchPrefs placeholders (a launch pref was
    // remembered but no session ever started there) — their fresh lastUsed
    // would rank them TOP by recency, and the sheet preselects rank #1, so
    // they'd become the default path despite never having worked. Dirs on
    // hosts we don't offer (disabled/removed) are unlaunchable dead payload.
    .filter((d) => d.count > 0 && offeredAliases.has(d.host ?? ''))
    .map((d) => ({
      cwd: d.cwd,
      // The store uses null for local; mobile gets '' so Dir.host
      // string-equals Host.alias (the sheet filters suggestions with ==).
      host: d.host ?? '',
      hostLabel: d.host ? hostsCfg[d.host]?.label ?? d.host : undefined,
      lastUsed: d.lastUsed,
      count: d.count,
      score: scoreFrequentDir(d, now, maxAgeMs, maxCount),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTED_DIRS)
    .map(({ score: _s, ...rest }) => rest);

  return { hosts, dirs };
}

export interface MobileLaunchResult { sessionId?: string; taskId: string; title: string }

/**
 * Config host check + the shared quickStartSession core. Throws
 * QuickStartError with an HTTP-ish statusCode on every failure.
 */
export async function performMobileLaunch(
  input: MobileLaunchInput,
  source: string,
): Promise<MobileLaunchResult> {
  // Host: must be an enabled config.hosts alias — a clear 400 beats a doomed
  // daemon connect.
  if (input.host !== undefined) {
    const config = await getConfig();
    const entry = config.hosts?.[input.host];
    if (!entry || entry.enabled === false) {
      throw new QuickStartError(
        `Unknown host: ${input.host}. Use an alias from GET /api/v1/sessions/launch-options`, 400,
      );
    }
  }

  const preassignedSessionId = engineCaps(input.engine).idProvisioning === 'provider-issued' ? undefined : randomUUID();
  const task = await quickStartSession({
    message: input.message,
    cwd: input.cwd,
    host: input.host,
    model: input.model,
    mode: input.mode,
    existingTaskId: input.taskId,
    taskTitle: input.taskTitle,
    project: input.project,
    source,
    requestTs: Date.now(),
    engine: normalizeEngine(input.engine),
    preassignedSessionId,
  });
  log.web.info(`${source}: session created`, {
    sessionId: preassignedSessionId, taskId: task.id, cwd: input.cwd, host: input.host ?? '',
  });
  return {
    ...(preassignedSessionId ? { sessionId: preassignedSessionId } : {}),
    taskId: task.id,
    title: task.title,
  };
}

/**
 * Entry point for the daemon launch-relay (phone → cloud → bridge →
 * `launch-request` event → here, on the PRIMARY box). Returns the reply
 * envelope for the `launch-result` command — never throws, so a validation
 * failure travels back to the phone as a precise 4xx instead of killing the
 * daemon WS handler.
 */
export async function handleLaunchRelayRequest(
  action: string,
  params: unknown,
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string; errorKind: string }> {
  try {
    if (action === 'options') {
      const result = await computeLaunchOptions();
      return { ok: true, result: result as unknown as Record<string, unknown> };
    }
    if (action === 'launch') {
      // Re-validate here even though the cloud route pre-validated: the relay
      // crosses a semi-trusted box, so the PRIMARY's checks are the real gate.
      const input = validateMobileLaunchBody(params);
      const result = await performMobileLaunch(input, 'mobile-launch-bridge');
      return { ok: true, result: result as unknown as Record<string, unknown> };
    }
    return { ok: false, error: `Unknown launch action: ${action}`, errorKind: 'bad_request' };
  } catch (err) {
    if (err instanceof QuickStartError) {
      return { ok: false, error: err.message, errorKind: launchErrorCode(err.statusCode) };
    }
    const message = err instanceof Error ? err.message : String(err);
    log.web.error('launch relay failed', { action, error: message });
    return { ok: false, error: message, errorKind: 'internal' };
  }
}
