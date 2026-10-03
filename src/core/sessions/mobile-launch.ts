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
import { mobileWorkspacePlace } from '../workspaces/launch.js';
import { resolveModelSwitchValue, VALID_SESSION_MODEL_IDS, VALID_SESSION_MODE_IDS } from '../types.js';
import type { SessionEngine } from '../types.js';
import { engineCaps, isAcpEngine, normalizeEngine } from '../agents/engine-registry.js';
import {
  ASK_HOST_REFUSAL,
  ASK_LAUNCH_CWD,
  askLaunchProject,
  askLaunchTier,
  rememberAskModelPick,
  rememberedAskModel,
  resolveLaunchAskAgent,
} from './ask-launch-plan.js';
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
  /** '' for an ask: the server owns an ask's cwd (ask-launch-plan.ts). */
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
  /** "Start anyway": skip an overridable readiness refusal (claude_outdated / claude_not_logged_in). */
  overrideReadiness?: boolean;
  /**
   * Launch an ASK (the phone's New chat): the same task the web draft's Ask
   * Walnut tab creates, filed under "Ask <name>", born in Focus, running in
   * the server's home with the agent's persona. `agentId` absent = Walnut.
   */
  walnutAgent?: true;
  agentId?: string;
  /** The body's `model` as sent, kept for an ask's launch memory (absent = not named). */
  rawModel?: string;
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
function validateLaunchBody(body: unknown): MobileLaunchInput {
  const {
    cwd, host: rawHost, message, taskId, taskTitle, project, model: rawModel, mode, overrideReadiness,
    walnutAgent, agentId,
  } = (body ?? {}) as {
    cwd?: unknown;
    host?: unknown;
    message?: unknown;
    taskId?: unknown;
    taskTitle?: unknown;
    project?: unknown;
    model?: unknown;
    mode?: unknown;
    overrideReadiness?: unknown;
    walnutAgent?: unknown;
    agentId?: unknown;
  };

  // An ask: the same rule as the web quick-start (agentId only with walnutAgent;
  // no host, an ask runs where the server runs; the server owns the cwd, so a
  // client cwd is ignored rather than checked).
  if (walnutAgent !== undefined && typeof walnutAgent !== 'boolean') {
    throw new QuickStartError('walnutAgent must be a boolean', 400);
  }
  const isAsk = walnutAgent === true;
  if (agentId !== undefined && (typeof agentId !== 'string' || !agentId.trim() || agentId.length > 128 || !isAsk)) {
    throw new QuickStartError('agentId must be a non-empty string and requires walnutAgent', 400);
  }
  if (isAsk && rawHost !== undefined && rawHost !== null && rawHost !== '') {
    throw new QuickStartError(ASK_HOST_REFUSAL, 400);
  }

  if (!isAsk) {
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
    cwd: isAsk ? '' : cwd as string, host, message: msg,
    taskId: typeof taskId === 'string' ? taskId : undefined,
    taskTitle: typeof taskTitle === 'string' ? taskTitle.trim() : undefined,
    project: typeof project === 'string' ? project.trim() : undefined,
    model,
    mode: typeof mode === 'string' ? mode : undefined,
    ...(overrideReadiness === true ? { overrideReadiness: true } : {}),
    ...(isAsk ? { walnutAgent: true as const } : {}),
    ...(isAsk && typeof agentId === 'string' ? { agentId: agentId.trim() } : {}),
    ...(isAsk && typeof rawModel === 'string' ? { rawModel } : {}),
  };
}

export function validateMobileLaunchBody(body: unknown): MobileLaunchInput {
  return validateLaunchBody(body);
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
 * The phone's request dies at 30s and a relayed one also pays up to 8s of
 * bridge wait, so the host gate gets 10s here instead of its 25s default.
 */
export const MOBILE_HOST_GATE_DEADLINE_MS = 10_000;

/**
 * Config host check + the shared quickStartSession core. Throws
 * QuickStartError with an HTTP-ish statusCode on every failure.
 */
export async function performMobileLaunch(
  input: MobileLaunchInput,
  source: string,
): Promise<MobileLaunchResult> {
  // Host: must be an enabled config.hosts alias. Refused with the gate's own
  // host_removed body, so the phone and the web draft answer a gone host alike.
  if (input.host !== undefined) {
    const config = await getConfig();
    const hosts = config.hosts ?? {};
    const entry = Object.hasOwn(hosts, input.host) ? hosts[input.host] : undefined;
    if (!entry || entry.enabled === false) {
      const { hostGateBody, HOST_REMOVED_NOTE } = await import('../hosts/host-problem.js');
      const body = hostGateBody({ code: 'host_removed', host: input.host, headline: HOST_REMOVED_NOTE });
      throw new QuickStartError(body.error, 409, { ...body });
    }
  }

  const preassignedSessionId = engineCaps(input.engine).idProvisioning === 'provider-issued' ? undefined : randomUUID();
  const ask = input.walnutAgent ? await planMobileAsk(input) : undefined;
  // A task with a ready isolated workspace launches in it (core/workspaces/launch.ts).
  const wsPlace = input.taskId && !ask ? await mobileWorkspacePlace(input.taskId, input.cwd, input.host) : null;
  const task = await quickStartSession({
    message: input.message,
    cwd: ask ? ASK_LAUNCH_CWD : wsPlace?.cwd ?? input.cwd,
    host: wsPlace ? wsPlace.host : input.host,
    model: ask ? ask.model : input.model,
    mode: input.mode,
    existingTaskId: input.taskId,
    taskTitle: input.taskTitle,
    project: ask ? ask.project : input.project,
    ...(ask ? {
      walnutAgent: true,
      agentId: ask.agentId,
      projectFromFolder: false,
      taskMeta: { pinTier: askLaunchTier(undefined) },
    } : {}),
    source,
    requestTs: Date.now(),
    engine: normalizeEngine(input.engine),
    preassignedSessionId,
    ...(input.overrideReadiness ? { overrideReadiness: true } : {}),
    hostGate: { deadlineMs: MOBILE_HOST_GATE_DEADLINE_MS },
  });
  if (ask) rememberAskModelPick(input.rawModel, input.taskId);
  log.web.info(`${source}: session created`, {
    sessionId: preassignedSessionId, taskId: task.id, cwd: ask ? ASK_LAUNCH_CWD : wsPlace?.cwd ?? input.cwd, host: (wsPlace ? wsPlace.host : input.host) ?? '',
    ...(ask ? { ask: true, agentId: ask.agentId } : {}),
  });
  return {
    ...(preassignedSessionId ? { sessionId: preassignedSessionId } : {}),
    taskId: task.id,
    title: task.title,
  };
}

/**
 * The ask half of a phone launch, from the same rules the web draft uses
 * (ask-launch-plan.ts): whose ask it is (a retry names no agent, the task's
 * stamp decides), the project it files under, and the remembered model when
 * the body names none. An unknown agent is a 400 before anything is written.
 */
async function planMobileAsk(input: MobileLaunchInput): Promise<{ agentId: string; project: string; model?: string }> {
  const agent = await resolveLaunchAskAgent(input.agentId, input.taskId);
  if (!agent) throw new QuickStartError(`Unknown console agent "${input.agentId}"`, 400);
  // A phone launch always mints its session id, so it runs on the native engine
  // unless the body named another (quickStartSession: an inherited engine yields
  // to a promised id). The memory only applies there.
  const model = input.rawModel === undefined
    ? await rememberedAskModel(!isAcpEngine(input.engine))
    : input.model;
  return { agentId: agent.id, project: askLaunchProject(input.project, agent), ...(model ? { model } : {}) };
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
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string; errorKind: string; details?: Record<string, unknown> }> {
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
      // A host gate refusal keeps its code and fields across the bridge, or the
      // phone gets a bare "conflict" with no host, headline, hint or Start anyway.
      const gate = hostGateRelayFields(err);
      if (gate) return { ok: false, error: err.message, errorKind: gate.code, details: gate.details };
      return { ok: false, error: err.message, errorKind: launchErrorCode(err.statusCode) };
    }
    const message = err instanceof Error ? err.message : String(err);
    log.web.error('launch relay failed', { action, error: message });
    return { ok: false, error: message, errorKind: 'internal' };
  }
}

/** The host gate's 409 body split for the relay reply: `code` rides errorKind, the rest rides `details`. */
export function hostGateRelayFields(err: QuickStartError): { code: string; details: Record<string, unknown> } | null {
  const body = err.body;
  if (err.statusCode !== 409 || !body || typeof body.code !== 'string' || !body.code.startsWith('host_')) return null;
  const { error: _error, code, ...details } = body;
  return { code, details };
}
