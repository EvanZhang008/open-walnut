/**
 * Side threads — "ask a question off to the side of this coding session".
 *
 * A side thread is a HIDDEN lightweight fork of a parent coding session: a real
 * `claude` session (so the answer streams, and follow-ups ride the ordinary send
 * path with an incremental prompt cache) that carries NO task row and never shows
 * up in a session list. The hiding is the `lane` field, the same mechanism
 * Personal AI chat lanes use (`isLaneSession` / `isListableSession` in
 * session-tracker.ts) — here namespaced `side:<parentSid>:<threadId>`.
 *
 * The spawn is emitted HERE, at fork time, exactly as lane-fork.ts does it: the
 * forked id exists in no CLI JSONL until `--resume <parent> --fork-session` runs,
 * so deferring the spawn to a later send would cold-`--resume` an id the CLI has
 * never seen and die with "No conversation found".
 */

import crypto from 'node:crypto';
import { bus, EventNames } from '../event-bus.js';
import { getSessionByClaudeId, createSessionRecord, updateSessionRecord } from '../session-tracker.js';
import { engineCaps } from '../agents/engine-registry.js';
import { SessionControlError } from './session-controls.js';
import { log } from '../../logging/index.js';
import type { SessionEffort, SessionOutputMode, SessionRecord } from '../types.js';

/** Lane namespace for every side-thread session. */
export const SIDE_LANE_PREFIX = 'side:';

/** Thread id of the prewarmed, not-yet-consumed standby fork of a parent. */
export const STANDBY_THREAD_ID = 'standby';

export function sideThreadLaneKey(parentSid: string, threadId: string): string {
  return `${SIDE_LANE_PREFIX}${parentSid}:${threadId}`;
}

/**
 * Inverse of `sideThreadLaneKey`. Returns null for anything that is not a side
 * lane (a chat lane, a hand-edited record, an empty string) — every caller
 * null-guards, the same contract `parseLaneKey` has for `chat:` lanes.
 *
 * Both components are colon-free by construction (a CLI session id is a UUID,
 * thread ids are minted below), so the first separator splits them.
 */
export function parseSideLaneKey(
  lane: string | undefined | null,
): { parentSid: string; threadId: string } | null {
  if (!lane || !lane.startsWith(SIDE_LANE_PREFIX)) return null;
  const rest = lane.slice(SIDE_LANE_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const parentSid = rest.slice(0, sep);
  const threadId = rest.slice(sep + 1);
  if (!parentSid || !threadId) return null;
  return { parentSid, threadId };
}

/** True for a session hidden as a side thread (standby forks included). */
export function isSideThreadLane(lane: string | undefined | null): boolean {
  return parseSideLaneKey(lane) !== null;
}

/** Mint a thread id. Doubles as the side-questions store entry id, so one id
 *  addresses the lane, the store row and the HTTP route. */
export function mintSideThreadId(): string {
  return `sth-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function neverTurned(r: SessionRecord): boolean {
  // A stale reservation reason must not fork from the grandparent; require absent spawn evidence, as in api-v1.ts.
  return r.consumedOffset === undefined && r.pid == null && !r.outputFile;
}

export interface SideThreadForkResult {
  /** The hidden fork's session id (pre-assigned, so callers can use it at once). */
  sessionId: string;
  /** Which id the spawn's `--resume` targets (parent, or its ancestor). */
  resumeFromSessionId: string;
}

/**
 * Fork `parentSid` into a hidden side-thread session.
 *
 * `opts.message` empty (the default) makes this an INIT-ONLY spawn: the CLI boots,
 * adopts the pre-assigned id, runs no turn and parks on its FIFO — that is the
 * standby prewarm. A non-empty message rides the spawn as the first turn, which
 * is the only race-free way to ask immediately (a send issued right after
 * SESSION_START can lose the race and cold-`--resume` an id that does not exist
 * yet — see the note on LaneSession.created in personal-ai-lane.ts).
 *
 * `opts.model` / `opts.effort` / `opts.outputMode` are the drawer's control row
 * asking for something OTHER than what the parent runs. All three are optional
 * and absent means inherit (see the override comment below for what a model or
 * effort override costs).
 */
export async function forkSideThreadSession(
  parentSid: string,
  threadId: string,
  opts?: {
    message?: string;
    title?: string;
    /** Verbatim `--model` arg to spawn with instead of the parent's. */
    model?: string;
    effort?: SessionEffort;
    /** Seeds the new record's `output_mode`; absent = inherit the parent's. */
    outputMode?: SessionOutputMode;
  },
): Promise<SideThreadForkResult> {
  const parent = await getSessionByClaudeId(parentSid);
  if (!parent) throw new SessionControlError('Parent session not found', 404);
  if (!engineCaps(parent.engine).fork) {
    throw new SessionControlError('Side threads need a forkable session', 409, {
      code: 'ACP_FORK_UNSUPPORTED',
    });
  }
  if (!parent.cwd) {
    throw new SessionControlError('Parent session has no working directory — cannot fork', 400);
  }

  let resumeFrom = parent.claudeSessionId;
  if (neverTurned(parent)) {
    if (!parent.forkedFromSessionId) {
      throw new SessionControlError('This session has no conversation yet — nothing to fork', 409);
    }
    // Walk ONE hop up and resume the ancestor the parent itself would have
    // resumed; by induction that one has a transcript.
    resumeFrom = parent.forkedFromSessionId;
  }

  const title = (opts?.title ?? `Side: ${parent.title ?? parentSid.slice(0, 8)}`).slice(0, 60);
  const sessionId = crypto.randomUUID();
  const lane = sideThreadLaneKey(parentSid, threadId);

  // The permission mode rides the spawn argv and shapes the CLI's system
  // prompt/tool surface — a mismatch there busts the parent's cache prefix.
  // Same inheritance rule as forkSessionToTask.
  const mode = parent.mode !== 'default' ? parent.mode : undefined;

  // The rest of the prefix (append prompt, model, effort) is copied from the
  // parent's LIVE process argv when the daemon can tell us, else from the
  // record. Never rebuilt: see spawn-prefix.ts for the measured cost.
  const { readParentSpawnPrefix } = await import('./spawn-prefix.js');
  const prefix = await readParentSpawnPrefix(parent, {
    // The live CLI outranks the record for model/effort: the record is written
    // optimistically before the CLI acknowledges a switch, so a refused switch
    // would otherwise send the thread off under a model the parent isn't using.
    liveAppliedSettings: async (sid) => {
      const { sessionRunner } = await import('../../providers/claude-code-session.js');
      const session = sessionRunner.findSessionByClaudeId(sid);
      return session ? session.refreshAppliedSettings('fork-prefix') : null;
    },
  });
  // An explicit pick OVERRIDES the copied prefix, and the cost is real: the model
  // and the effort are both part of the prompt-cache key, so an override forfeits
  // the parent's cache and this thread's FIRST turn pays a full prefix write
  // (measured in spawn-prefix.ts: 195K tokens re-written, 47s to first text on a
  // 300K-token parent). That is the caller's deliberate choice — inheriting, the
  // default, is exactly what makes a side thread cheap.
  const modelOverride = opts?.model?.trim() || undefined;
  const effortOverride = opts?.effort || undefined;
  // `prefix.model`/`prefix.effort` are the parent's CURRENT applied settings, not
  // its spawn argv (spawn-prefix.ts explains why that distinction is the whole
  // ballgame for cache reuse). The record is the fallback for a dead parent.
  const cliModel = modelOverride ?? prefix.model ?? parent.cliModel;
  const effort = effortOverride ?? prefix.effort ?? parent.effort;
  // Reply style is per-record and applied per send, so it costs the cache nothing.
  // Absent ⇒ inherit the parent's (undefined included: that means "follow the
  // config default", which is a live preference, not a value to freeze).
  const outputMode = opts?.outputMode ?? parent.output_mode;

  // Seed the record BEFORE the spawn — the client gets this id in its HTTP
  // response and its first read must not 404 (same contract as every fork).
  // taskId '' is the repo-wide "no task" sentinel and is LOAD-BEARING here: a
  // real id would trigger triage, auto-title and the one-session-per-task guard.
  await createSessionRecord(sessionId, '', parent.project ?? '', parent.cwd, {
    title,
    ...(mode ? { mode } : {}),
    ...(parent.host ? { host: parent.host } : {}),
    // The thread inherits the parent's launch bundle verbatim, re-applied from
    // the record on every cold resume.
    ...(parent.profile ? { profile: parent.profile } : {}),
    ...(effort ? { effort } : {}),
    ...(cliModel ? { cliModel } : {}),
    // '' = the parent runs without an append prompt, and so does the thread.
    appliedAppendSystemPrompt: prefix.appendSystemPrompt ?? '',
    lane,
    forkedFromSessionId: resumeFrom,
    initialProcessStatus: 'idle',
    initialStatusReason: 'awaiting_spawn',
  });

  // `createSessionRecord`'s creation bundle has no output_mode field, so the seed
  // is a follow-up write. Deliberately carries `output_mode` ONLY: the parent's
  // `output_mode_injected` is NOT inherited, because a brand-new CLI process has
  // never been told the mode and still owes the full instruction — copying the
  // marker would silently skip it and the thread would answer in plain markdown.
  if (outputMode) await updateSessionRecord(sessionId, { output_mode: outputMode });

  bus.emit(EventNames.SESSION_START, {
    preassignedSessionId: sessionId,
    taskId: '',
    message: opts?.message ?? '',
    cwd: parent.cwd,
    project: parent.project ?? '',
    title,
    ...(mode ? { mode } : {}),
    ...(parent.host ? { host: parent.host } : {}),
    ...(parent.profile ? { profile: parent.profile } : {}),
    ...(effort ? { effort } : {}),
    // Must be `cliModel` (the parent's verbatim --model arg, [1m] marker
    // included): the CLI does NOT inherit a model across --fork-session, and
    // the reported `model` has lost the marker.
    ...(cliModel ? { model: cliModel } : {}),
    appendSystemPromptExact: prefix.appendSystemPrompt,
    lane,
    forkedFromSessionId: resumeFrom,
  }, ['session-runner'], { source: 'side-thread-fork' });

  log.session.info('side thread: forked', {
    parentSid, threadId, sessionId, resumeFrom, initOnly: !opts?.message,
    prefixSource: prefix.source, prefixPromptLength: prefix.appendSystemPrompt?.length ?? 0,
    // Overrides are worth a field each: they explain a first turn that paid a
    // full prefix write instead of hitting the parent's cache.
    modelOverride: !!modelOverride, effortOverride: !!effortOverride,
    outputModeOverride: !!opts?.outputMode, ...(outputMode ? { outputMode } : {}),
  });

  return { sessionId, resumeFromSessionId: resumeFrom };
}
