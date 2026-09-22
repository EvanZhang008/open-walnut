/**
 * Personal AI lanes — "one chat conversation ⇄ one long-lived Claude Code session".
 *
 * Lanes are the ONLY chat engine: the old in-process agent loop is gone
 * (62e54ed4 removed its callers, 0e5672fd deleted the module). A Personal AI
 * chat turn is delivered into a `claude` CLI session that the
 * daemon owns. That session is bound to the conversation by its `lane` field
 * (`chat:<agentId>:<conversationId>`), which is what makes it durable: the lane is
 * persisted on the SessionRecord, so it survives the CLI being reaped, the web
 * server restarting, and the daemon restarting. Lane records are also exempt from
 * host capacity and hidden from the default session lists (session-tracker.ts).
 *
 * The lifecycle here is deliberately thin — TWO states, no reaping of our own:
 *
 *   - no record for the lane → mint an id, seed the record, spawn with the user's
 *     message as the first turn.
 *   - record exists → return its id. Reviving a dead CLI is NOT our job: the
 *     normal send path (`sendMessageToSession` → session-runner `processNext`)
 *     already cold-`--resume`s a reaped process and re-applies the profile from
 *     the record (`resolveResumeArgs`). Re-implementing that here would be a
 *     second, divergent revival path.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME, validateAgentId } from '../../constants.js';
import { bus, EventNames } from '../event-bus.js';
import { getConfig } from '../config-manager.js';
import { getSessionByLane, createSessionRecord } from '../session-tracker.js';
// One source of truth for the seed's header: the store renders the block, this
// module splices it into the spawn prompt and has to find it again on a repair.
import { CONVERSATION_SEED_HEADER, clipRenderedSeed } from '../chat-history.js';
import { personalAiProfile, consoleAgentProfile } from './profiles.js';
import { buildSessionSkillsPrompt } from '../skill-loader.js';
import type { SessionEngine } from '../types.js';
import { engineCaps, isAcpEngine, isKnownEngine, resolveEngine } from '../agents/engine-registry.js';
import { log } from '../../logging/index.js';

/** The lane key a Personal AI conversation's session is bound to. */
export function personalAiLaneKey(agentId: string, conversationId: string): string {
  return `chat:${encodeURIComponent(validateAgentId(agentId))}:${conversationId}`;
}

/**
 * Inverse of `personalAiLaneKey` — recover the (agentId, conversationId) a lane-bound
 * session belongs to. Returns null for anything that is not a Personal AI chat lane
 * (a future lane namespace, a hand-edited record, an empty string).
 *
 * The agent component is URI-encoded so namespaced Plugin agent ids remain one
 * lane segment. The conversation id is everything after the first separator.
 */
export function parseLaneKey(lane: string | undefined | null): { agentId: string; conversationId: string } | null {
  if (!lane || !lane.startsWith('chat:')) return null;
  const rest = lane.slice('chat:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const conversationId = rest.slice(sep + 1);
  if (!conversationId) return null;
  try {
    return { agentId: validateAgentId(decodeURIComponent(rest.slice(0, sep))), conversationId };
  } catch {
    return null;
  }
}

/**
 * Retire the session bound to this conversation's lane — the "clear conversation"
 * half of the lane lifecycle.
 *
 * Clearing chat history only empties WALNUT's store; the CLI on the other side
 * still holds the whole transcript in its own JSONL and would keep answering from
 * it, so a user who cleared for privacy reasons did not actually forget anything.
 * Two effects, in this order:
 *
 *   1. stop the live CLI (canonical `terminateSession`, force — a lane owning
 *      crons must not 409 a clear), then
 *   2. archive the record, which is what makes the NEXT resolve mint a fresh
 *      session (`getSessionByLane` excludes archived rows).
 *
 * Stop-before-archive is the order that leaves a consistent record: terminate
 * writes process_status='stopped', so the row ends up archived AND terminal —
 * the shape every reaper/list already expects. (The write goes through
 * `updateSessionRecord`, not `patchSession`, deliberately: patchSession's
 * "stop it before archiving" 400 is a guard for a HUMAN archiving a live
 * session, and it would turn a failed terminate into a failed clear.)
 *
 * Neither step may block the clear — a dead CLI, an already-reaped record, or a
 * daemon that is simply gone are all normal — so every failure is warned and
 * swallowed. Worst case the archive still lands and the orphan CLI is reaped by
 * the idle timer.
 *
 * Returns the session id it retired, or null when the lane had no session.
 */
export async function archiveLaneForConversation(
  agentId: string,
  conversationId: string,
  reason: string = 'chat_cleared',
): Promise<string | null> {
  const lane = personalAiLaneKey(agentId, conversationId);
  let sessionId: string | null = null;
  try {
    const record = await getSessionByLane(lane);
    if (!record) return null;
    sessionId = record.claudeSessionId;

    try {
      const { terminateSession } = await import('./session-lifecycle.js');
      await terminateSession(sessionId, { force: true });
    } catch (err) {
      log.session.warn('Personal AI lane: stopping the CLI failed; archiving anyway', {
        lane, sessionId, error: err instanceof Error ? err.message : String(err),
      });
    }

    const { updateSessionRecord } = await import('../session-tracker.js');
    await updateSessionRecord(sessionId, {
      archived: true,
      archive_reason: reason,
    });
    log.session.info('Personal AI lane: archived', { lane, sessionId, reason });
    return sessionId;
  } catch (err) {
    log.session.warn('Personal AI lane: archive failed', {
      lane, sessionId, reason, error: err instanceof Error ? err.message : String(err),
    });
    return sessionId;
  }
}

/**
 * Stop the turn currently running in this conversation's lane — the lane half of
 * the Personal AI's "stop" button.
 *
 * Aborting the in-process AbortController is meaningless on the lane engine: the
 * work is happening in a `claude` CLI the daemon owns, so without this a stop was
 * a silent no-op — the CLI kept working and kept spending tokens. Reuses the SAME
 * canonical path the session composer's stop button uses — bus SESSION_INTERRUPT
 * → the runner's handler, which routes CLI / SDK / ACP and settles the in-flight
 * batch. Deliberately NOT a kill: no signal is ever sent from here.
 *
 * Only fires for a session the record says is live ('running'/'idle'); a stopped
 * or archived lane has nothing to interrupt. Never throws — a stop that fails to
 * reach a dead CLI must not turn into an error for the user.
 *
 * Returns the session id it interrupted, or null when there was nothing to stop.
 */
export async function interruptLaneForConversation(
  agentId: string,
  conversationId: string,
): Promise<string | null> {
  const lane = personalAiLaneKey(agentId, conversationId);
  try {
    const record = await getSessionByLane(lane);
    if (!record) return null;
    if (record.process_status !== 'running' && record.process_status !== 'idle') return null;
    bus.emit(
      EventNames.SESSION_INTERRUPT,
      { sessionId: record.claudeSessionId },
      ['session-runner'],
      { source: 'personal-ai-lane' },
    );
    log.session.info('Personal AI lane: interrupt requested', {
      lane, sessionId: record.claudeSessionId, processStatus: record.process_status,
    });
    return record.claudeSessionId;
  } catch (err) {
    log.session.warn('Personal AI lane: interrupt failed', {
      lane, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface LaneSession {
  /** The `claude` session id backing this conversation. */
  sessionId: string;
  /**
   * True when this call SPAWNED the session and the caller's `firstMessage` was
   * consumed as the spawn's first turn. The caller MUST NOT then send it again —
   * that would deliver the same message twice.
   *
   * Why the message rides the spawn instead of an init-only spawn + a send:
   * `SESSION_START` is fire-and-forget, so a send issued immediately after it
   * races the spawn. Losing that race lands in `processNext`'s "no live session"
   * branch, which cold-`--resume`s an id the CLI has never seen — two CLI
   * processes claiming one session id. Passing the message as the first turn
   * removes the window entirely.
   */
  created: boolean;
  /** Coding-agent engine backing this lane ('claude' default). */
  engine: SessionEngine;
}

/**
 * One in-flight create per lane. Two chat sends for the same conversation can
 * arrive before the first record write lands (the per-agent turn queue serializes
 * turns, but cron/heartbeat/REST producers do not share that queue), and each
 * would otherwise mint its own session — permanently splitting the conversation
 * across two CLIs.
 */
const inFlight = new Map<string, Promise<LaneSession>>();

/**
 * Resolve (or create) the session bound to this conversation's lane.
 *
 * `firstMessage` is only used when a session has to be created; pass the user's
 * message so the spawn's first turn IS that message, then honor `created` in the
 * result and skip your own send.
 */
export function getOrCreateLaneSession(
  agentId: string,
  conversationId: string,
  opts?: { firstMessage?: string; engine?: SessionEngine },
): Promise<LaneSession> {
  const lane = personalAiLaneKey(agentId, conversationId);
  const pending = inFlight.get(lane);
  if (pending) return pending;
  const promise = resolveLane(lane, agentId, conversationId, opts?.firstMessage ?? '', opts?.engine)
    .finally(() => { inFlight.delete(lane); });
  inFlight.set(lane, promise);
  return promise;
}

/**
 * Turn a WHOLE conversation into a task: create the task and link the
 * conversation's lane session to it (session_id slot + session_ids history +
 * the record's taskId back-pointer).
 *
 * The conversation is NOT moved, archived, or re-homed — the lane session keeps
 * its `lane` binding, so the chat surface stays exactly where it was and the
 * task's session circle simply routes back to it. That dual identity is the
 * point: one transcript, visible from both the Main Chat and the task.
 *
 * Uses linkSession (the primary `session_id` slot, same as quick-start), NOT
 * addSessionToHistory: the lane IS this task's working session, not a
 * spectator. Deleting the task later therefore requires stopping/clearing the
 * slot (force delete) — same contract as every other session-holding task.
 */
export async function promoteLaneConversationToTask(
  agentId: string,
  conversationId: string,
  input: { title?: string; project?: string },
): Promise<{ task: import('../types.js').Task; sessionId: string }> {
  const lane = personalAiLaneKey(agentId, conversationId);
  // Let a mid-flight resolve settle so we link the record it created.
  const pending = inFlight.get(lane);
  if (pending) await pending.catch(() => {});
  const record = await getSessionByLane(lane);
  if (!record) {
    const { SessionControlError } = await import('./session-controls.js');
    throw new SessionControlError('This conversation has no session yet — send a message first', 409);
  }

  // Title: caller's choice → conversation auto-title → generic.
  let title = input.title?.trim() ?? '';
  if (!title) {
    const { listConversations } = await import('../conversations.js');
    const meta = (await listConversations(agentId)).find((c) => c.id === conversationId);
    title = meta?.title?.trim() || 'Chat conversation';
  }

  const { addTask, linkSession } = await import('../task-manager.js');
  const { task } = await addTask({
    title,
    ...(input.project !== undefined ? { project: input.project } : {}),
    // Promoting a conversation is a deliberate "track this" act, so the task
    // joins the board (Satellite = pinned, no stored tier).
    pinned: true,
  });
  const { task: linked } = await linkSession(task.id, record.claudeSessionId);
  // Back-pointer on the record: task surfaces resolve session→task through it
  // (handleSessionClick, reconciler phase sync).
  const { linkSessionToTask } = await import('../session-tracker.js');
  await linkSessionToTask(record.claudeSessionId, task.id);

  log.session.info('Personal AI lane: conversation promoted to task', {
    lane, sessionId: record.claudeSessionId, taskId: task.id, project: linked.project || '',
  });
  return { task: linked, sessionId: record.claudeSessionId };
}

/**
 * Header marking the Walnut-injected standing-memory block inside the lane's
 * system prompt. The inspector splits on it for display.
 */
export const LANE_MEMORY_HEADER = '## Standing memory (injected by Walnut)';

/**
 * Fold Walnut's persistent memory into ONE engine-neutral prompt block.
 *
 * Deliberately NOT delivered via any engine's context-file convention
 * (CLAUDE.md @imports, AGENTS.md discovery, …): those are per-engine file
 * formats that can change name or shape under us. The memory lives in Walnut's
 * own files and Walnut itself injects the content into the profile's system
 * prompt — identical for claude, codex, or any future lane engine. Edits to the
 * files land on the next cold resume (same cadence as persona drift repair).
 *
 * Never throws — a missing file contributes nothing.
 */
export async function buildLaneMemoryContext(homeDir: string = WALNUT_HOME): Promise<string> {
  const readOr = async (rel: string): Promise<string> => {
    try { return (await fs.readFile(path.join(homeDir, rel), 'utf-8')).trim(); } catch { return ''; }
  };
  const [memoryMd, userMd] = await Promise.all([
    readOr('memory/MEMORY.md'),
    readOr('memory/USER.md'),
  ]);
  const parts = [
    LANE_MEMORY_HEADER,
    'Walnut injects this at session start — standing context, the same role the old per-turn memory sections played. The live files under your working directory are the source of truth; your edits to them are picked up on the next session start.',
  ];
  if (memoryMd) parts.push(`### Global memory (memory/MEMORY.md)\n\n${memoryMd}`);
  if (userMd) parts.push(`### User profile (memory/USER.md)\n\n${userMd}`);
  parts.push('Daily activity logs live in memory/daily/<date>.md — Read recent ones on demand when the user asks "what happened / what did I do".');
  return parts.join('\n\n');
}

/** Exact markers of retired lane-managed CLAUDE.md files (memory used to ride @imports). */
// Keep cleanup compatible without retaining the retired product name in source.
const MANAGED_LANE_CONTEXT_MARKERS = [
  '<!-- walnut:personal-ai-lane-context v1 -->',
  `<!-- walnut:${String.fromCharCode(98, 117, 116, 108, 101, 114)}-lane-context v1 -->`,
];

/**
 * Remove the previously-managed {cwd}/CLAUDE.md. Memory now rides the profile
 * injection above; leaving the old file would double-feed claude-engine lanes.
 * Marker-guarded — a user-authored CLAUDE.md is never touched. Never throws.
 */
export async function cleanupLaneClaudeMd(homeDir: string = WALNUT_HOME): Promise<void> {
  const file = path.join(homeDir, 'CLAUDE.md');
  try {
    const current = await fs.readFile(file, 'utf-8').catch(() => null);
    if (current === null || !MANAGED_LANE_CONTEXT_MARKERS.some((marker) => current.includes(marker))) return;
    await fs.rm(file, { force: true });
    log.session.info('Personal AI lane: retired managed CLAUDE.md removed (memory now injected via profile)', { file });
  } catch (err) {
    log.session.warn('Personal AI lane: removing retired CLAUDE.md failed', {
      file, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Hard ceiling the provider enforces on a spawn's system prompt
 * (claude-code-session.ts `MAX_PROFILE_PROMPT_BYTES`): the prompt rides the
 * spawn argv, so an oversized one does NOT degrade — `send()` throws and the
 * mint fails, which would take the whole chat down. Mirrored rather than
 * imported because it is a local const over there; the ratchet is a test that
 * mints on a whale conversation and asserts the prompt stays under it.
 */
const MAX_LANE_PROMPT_BYTES = 65536;

/** Argv headroom held back for the join, the header and future persona growth. */
const LANE_SEED_RESERVE_BYTES = 4096;

/** Below this there is no room for a useful recap; seeding is skipped and said. */
const LANE_SEED_MIN_BYTES = 2048;

/** The persona/skills/memory bundle + effort a claude-engine lane spawns with.
 *  Exported for quick-start's `walnutAgent` launches ("Ask Walnut" draft tab):
 *  those are ordinary task sessions that spawn with this same profile, so the
 *  persona/memory/skills bundle has exactly one builder.
 *
 *  `opts.conversationId` additionally appends the CONVERSATION SEED — the prior
 *  content of that conversation — and is passed ONLY by the mint. Two reasons it
 *  must not be passed anywhere else: the seed is a one-shot snapshot (the record
 *  keeps it verbatim, and a cold `--resume` deliberately re-emits the spawn-time
 *  prompt byte-for-byte to hold the cache prefix), and the drift-repair path
 *  compares persona halves, so a repair that rebuilt a GROWN seed would rewrite
 *  the record on every single turn. See splitLanePrompt. */
export async function buildLaneProfile(
  config: Awaited<ReturnType<typeof getConfig>>,
  agentId: string,
  opts?: { conversationId?: string },
): Promise<{
  profile: import('../types.js').SessionProfile;
  effort: import('../types.js').SessionEffort;
  /** Present only when a conversation seed was requested AND rendered. */
  seed?: import('../chat-history.js').ConversationSeed;
}> {
  // Walnut's own skills (workspace / ~/.open-walnut/skills / shipped) — no CLI
  // engine ever discovers these, so the lane prompt carries the index itself.
  // ~/.claude/skills is excluded (Claude Code loads it natively). Failure is
  // non-fatal: a lane without the index still answers.
  const skillsIndex = await buildSessionSkillsPrompt().catch(() => '');
  // Standing memory — Walnut-owned injection, engine-neutral (see
  // buildLaneMemoryContext). Rides the SAME profile as the persona.
  const memoryContext = await buildLaneMemoryContext().catch(() => '');
  // general = the Personal AI persona; any other agent gets ITS persona plus the
  // same two work modes — one engine, one consistent chat feel, per-agent
  // identity. Any REGISTRY agent, not only a console one: the console flag
  // decides which agents the chat pickers OFFER (getConsoleAgents), not whose
  // persona can be built — a dispatcher-launched run (subagent-runner) names a
  // background agent by design and its persona builds exactly the same way.
  let profile;
  if (agentId === 'general') {
    profile = personalAiProfile(config.user?.name ?? 'the user', skillsIndex, memoryContext);
  } else {
    const { getAgent } = await import('../agent-registry.js');
    const agentDef = await getAgent(agentId);
    if (!agentDef) throw new Error(`Agent '${agentId}' not found`);
    const { loadContextSources } = await import('../context-sources.js');
    const contextBlock = await loadContextSources(agentDef, {}).catch(() => '');
    profile = consoleAgentProfile(agentDef, skillsIndex, contextBlock);
  }
  // Chat latency matters more than reasoning depth here. Without an explicit
  // effort the CLI inherits the user's global settings.json effortLevel (often
  // xhigh, tuned for coding sessions) — measured 100s+ for "what tasks do I have
  // today". Config `agent.session_effort` still wins when the user set one.
  const effort = config.agent?.session_effort ?? 'medium';
  if (!opts?.conversationId) return { profile, effort };

  // ── Conversation seed (mint only) ──
  // The invariant this serves: an engine that answers a turn must be given the
  // conversation's whole prior content, or it denies things the user can see on
  // screen. Delivered HERE rather than as a first user turn: a turn burns a turn,
  // the model often answers it, and the mints that carry no message at all (the
  // read-driven `ensure: true` one the phone's model pill triggers on mount)
  // would produce a visible orphan turn.
  const base = profile.systemPrompt ?? '';
  const headroom = MAX_LANE_PROMPT_BYTES - Buffer.byteLength(base, 'utf-8') - LANE_SEED_RESERVE_BYTES;
  if (headroom < LANE_SEED_MIN_BYTES) {
    log.session.warn('Personal AI lane: no argv headroom for the conversation seed — the lane starts without prior turns', {
      agentId, conversationId: opts.conversationId,
      personaBytes: Buffer.byteLength(base, 'utf-8'), headroom,
    });
    return { profile, effort };
  }
  const { buildConversationSeed } = await import('../chat-history.js');
  const seed = await buildConversationSeed(agentId, opts.conversationId, { maxBytes: headroom })
    .catch((err) => {
      // A lane without prior turns still answers; a lane that failed to mint
      // does not. Never let the seed fail the spawn.
      log.session.warn('Personal AI lane: building the conversation seed failed', {
        agentId, conversationId: opts.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
  if (!seed || !seed.text) return { profile, effort, ...(seed ? { seed } : {}) };
  return {
    profile: { ...profile, systemPrompt: `${base}\n\n${seed.text}` },
    effort,
    seed,
  };
}

/**
 * Split a lane system prompt into its persona half and its frozen conversation
 * seed.
 *
 * The seed is a mint-time snapshot that must stay byte-stable for the life of
 * the lane (a cold `--resume` re-emits the spawn prompt verbatim so the cache
 * prefix holds). The persona half, in contrast, is refreshed whenever skills /
 * memory / the persona itself change. Comparing and rewriting only the persona
 * half is what keeps the drift repair from firing on every turn just because the
 * conversation grew — which would be a sqlite write per lane send AND a record
 * whose stored prompt grows without bound.
 */
export function splitLanePrompt(prompt: string): { persona: string; seed: string } {
  // LAST occurrence, not the first: the seed is appended, so the real boundary is
  // always the last one. The persona half can legitimately contain the header
  // string (standing memory quoting it, a skill describing this mechanism), and
  // splitting there would classify the whole persona as "seed" — after which the
  // persona half never changes, the drift repair silently stops repairing, and a
  // lane keeps a stale persona for its entire life. The same reasoning is why the
  // rendered seed neutralizes the marker inside quoted turns (chat-history
  // neutralizeSeedMarkers): the boundary must be the one WE wrote.
  const at = prompt.lastIndexOf(CONVERSATION_SEED_HEADER);
  if (at < 0) return { persona: prompt.trimEnd(), seed: '' };
  return { persona: prompt.slice(0, at).trimEnd(), seed: prompt.slice(at) };
}

/**
 * The prompt a drift repair writes: the FRESH persona plus the lane's FROZEN
 * seed, clamped to the provider's ceiling.
 *
 * Why the clamp is not optional. The mint clamps (headroom check above), but the
 * repair used to concatenate blind, and the persona is the half that grows —
 * standing memory grows every week, a skill gets added. A lane that minted at
 * 60,729 B with a 6 KB memory growth wrote a 66,729 B record: 1,193 B over the
 * ceiling. Nothing notices at write time; the next COLD RESUME throws in the
 * provider (claude-code-session MAX_PROFILE_PROMPT_BYTES) and the lane is bricked
 * — the exact "the chat is dead" outcome this whole change exists to prevent,
 * arrived at from the fix side.
 *
 * Degradation ladder, worst case last: keep the whole seed → shrink the seed from
 * its oldest end (clipRenderedSeed, which keeps the notice) → drop the seed
 * entirely. Dropping is survivable precisely because the record's seed only
 * matters on a cold resume, and a resumed CLI restores its own transcript: the
 * cost is a lost cache prefix, not lost memory.
 */
export function buildRepairedLanePrompt(
  freshPersona: string,
  frozenSeed: string,
): { prompt: string; seed: 'none' | 'whole' | 'clipped' | 'dropped' } {
  const personaBytes = Buffer.byteLength(freshPersona, 'utf-8');
  // Nothing to preserve: a lane minted before the seed existed, or one whose mint
  // had no argv headroom. Its catch-up rides the message channel instead.
  if (!frozenSeed) return { prompt: freshPersona, seed: 'none' };
  const whole = `${freshPersona}\n\n${frozenSeed}`;
  if (Buffer.byteLength(whole, 'utf-8') <= MAX_LANE_PROMPT_BYTES) return { prompt: whole, seed: 'whole' };
  // Same reserve as the mint, so a repaired record is never closer to the
  // ceiling than a freshly minted one.
  const room = MAX_LANE_PROMPT_BYTES - personaBytes - LANE_SEED_RESERVE_BYTES - 2;
  if (room < LANE_SEED_MIN_BYTES) return { prompt: freshPersona, seed: 'dropped' };
  return { prompt: `${freshPersona}\n\n${clipRenderedSeed(frozenSeed, room)}`, seed: 'clipped' };
}

/** Last drift-repair attempt per session — the check reads skills + memory
 *  files, so once per TTL per session is plenty (a lane re-resolves every turn;
 *  this is the equivalent budget for quick-start walnut sessions). */
const walnutProfileRefreshAt = new Map<string, number>();
const WALNUT_PROFILE_REFRESH_TTL_MS = 10 * 60 * 1000;

/**
 * Profile drift repair for "Ask Walnut" quick-start sessions — the counterpart
 * of resolveLane's per-turn refresh for chat lanes, hooked into
 * sendMessageToSession and AWAITED there so a send that triggers a cold
 * --resume spawns with the freshly-written profile (resolveResumeArgs reads
 * the record after this returns).
 *
 * The persona/effort live on the RECORD (spawn-time args, no live channel), so
 * a walnut session minted before a personalAiProfile upgrade would keep the
 * stale persona forever without this. Identified by the task's `walnut_agent`
 * flag (the same per-task marker the UI keys the amber title on) — no new
 * record field. Every failure degrades to "stale persona until next attempt";
 * nothing here may throw into the send path.
 */
export async function refreshWalnutSessionProfile(sessionId: string): Promise<void> {
  const last = walnutProfileRefreshAt.get(sessionId);
  if (last && Date.now() - last < WALNUT_PROFILE_REFRESH_TTL_MS) return;
  if (walnutProfileRefreshAt.size > 1000) walnutProfileRefreshAt.clear();
  // Stamped BEFORE the work, deliberately: a transient failure suppresses
  // retries for one TTL instead of hammering the store on every send.
  walnutProfileRefreshAt.set(sessionId, Date.now());
  try {
    const { getSessionByClaudeId, updateSessionRecord } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    // Lanes have their own repair in resolveLane; ACP has no profile channel;
    // a record without a stamped prompt was never a persona session.
    if (!record || record.lane || !record.profile?.systemPrompt) return;
    if (isAcpEngine(resolveEngine(record.engine))) return;
    if (!record.taskId) return;
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(record.taskId).catch(() => null);
    if (!task?.walnut_agent) return;
    // Rebuild the persona the task was launched with: an "Ask Mentor" must not
    // be repaired into the Personal AI.
    const { profile } = await buildLaneProfile(await getConfig(), task.agent_id || 'general');
    if (record.profile.systemPrompt === profile.systemPrompt) return;
    // Persona only. An Ask Walnut session's effort is the user's (its launch
    // memory or the session picker — see ask-walnut-launch), never the lane
    // default this builder returns, so the repair must not touch it.
    await updateSessionRecord(sessionId, { profile });
    log.session.info('Ask Walnut: stale profile refreshed on record', { sessionId, taskId: record.taskId });
  } catch (err) {
    log.session.warn('Ask Walnut: profile refresh failed', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Wait for the record an ACP spawn creates for this lane. ACP mints its
 * own session id at provider `session/new` — there is no preassigned id to seed
 * a record with, so the lane binding rides the SESSION_START event and the
 * record appears when the worker establishes (see AcpSession.adoptSessionResponse).
 */
async function waitForLaneRecord(lane: string, timeoutMs: number, engineLabel: string): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await getSessionByLane(lane);
    if (record) return record.claudeSessionId;
    if (Date.now() >= deadline) {
      throw new Error(`${engineLabel} session did not start in time — check that the ${engineLabel} CLI is installed and try again`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * The prior conversation wrapped onto the mint's first MESSAGE, or null when
 * there is nothing to carry that way.
 *
 * The second carrier for the conversation seed, and for an ACP lane the only one.
 * Its existence is the answer to "the argv is a hard ceiling": a system prompt
 * over 64KB makes the provider throw and the mint fail, while stdin has no
 * ceiling at all — so a recap the profile cannot hold is not lost, it changes
 * carrier. Bounded only by the token policy for that reason.
 *
 * Wrapped in the established `[Conversation context]…[/Conversation context]`
 * banner, exactly like the turn-time catch-up: the mobile transcript projection
 * strips a leading banner, the console folds it into a collapsed disclosure row,
 * and the conversation auto-titler ignores it. The store keeps the user's clean
 * text either way — both senders persist the message BEFORE the mint, so only the
 * CLI transcript ever sees the spliced copy.
 *
 * PRECONDITION: `firstMessage` is non-empty. A mint with no message (the
 * read-driven `ensure: true` one the phone's model pill fires on mount) has
 * nothing to prepend to, and inventing a turn would put a bubble on screen the
 * user never sent — the callers guard that, visibly, rather than this returning
 * null for two different reasons.
 *
 * Never throws: a lane that answers is worth more than a seeded one that never
 * minted.
 */
async function recapOntoFirstMessage(
  agentId: string,
  conversationId: string,
  firstMessage: string,
  lane: string,
): Promise<{ message: string; watermark: string; stats: import('../chat-history.js').ConversationSeedStats } | null> {
  try {
    const { buildConversationSeed, CATCH_UP_BANNER_OPEN, CATCH_UP_BANNER_CLOSE } = await import('../chat-history.js');
    // No maxBytes: this rides stdin, so only the token policy bounds it.
    const recap = await buildConversationSeed(agentId, conversationId);
    if (!recap.text) return null;
    return {
      message: `${CATCH_UP_BANNER_OPEN}\n${recap.text}\n${CATCH_UP_BANNER_CLOSE}\n\n${firstMessage}`,
      watermark: recap.watermark,
      stats: recap.stats,
    };
  } catch (err) {
    log.session.warn('Personal AI lane: building the message-carried recap failed', {
      lane, agentId, conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Latch how far this lane has been caught up.
 *
 * Called ONLY when the recap was actually delivered by one of the two carriers,
 * or when there was nothing to deliver. The key's presence is what tells the
 * turn-time catch-up "this lane was seeded, only inject what another engine has
 * answered SINCE", so latching after a recap that reached neither carrier tells
 * that exact lie: trigger B is suppressed by the mark and trigger A only ever
 * carries foreign answers, so a lane that got nothing stays blind to the
 * conversation for its entire life. Measured on a 60KB persona: the record
 * carried no seed, the mark was latched anyway, and the next send found nothing
 * to inject.
 *
 * Best-effort — a lane that answers is worth more than a bookkeeping row, and the
 * worst case of a lost write is one duplicated recap later.
 */
async function latchLaneSeen(
  agentId: string,
  conversationId: string,
  sessionId: string,
  watermark: string,
  lane: string,
): Promise<void> {
  try {
    const { recordLaneSeen, laneEngineLabel } = await import('../chat-history.js');
    await recordLaneSeen(agentId, conversationId, laneEngineLabel(sessionId), watermark);
  } catch (err) {
    log.session.warn('Personal AI lane: recording the seed high-water mark failed', {
      lane, sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function resolveLane(
  lane: string,
  agentId: string,
  conversationId: string,
  firstMessage: string,
  engine?: SessionEngine,
): Promise<LaneSession> {
  const config = await getConfig();
  // The chat engine: the caller's explicit choice (a relay that already knows)
  // > agent.chat_engine (Settings > Ask Walnut) > claude.
  //
  // Deliberately NOT `defaults.engine`: that knob steers CODING sessions, and
  // an ACP engine has no system-prompt channel, so a lane on one answers
  // without the persona, the skills index or the memory block (see the ACP
  // branch below). Inheriting a Codex coding default would therefore degrade
  // every chat conversation silently. Chat opts in explicitly or stays on
  // claude. An unknown value reads as unset rather than breaking the launch.
  engine ??= isKnownEngine(config.agent?.chat_engine) ? config.agent.chat_engine : undefined;
  // One-time cleanup of the retired CLAUDE.md delivery path (see
  // cleanupLaneClaudeMd) — memory now rides the profile injection below.
  await cleanupLaneClaudeMd();

  const existing = await getSessionByLane(lane);
  if (existing) {
    const existingEngine = resolveEngine(existing.engine);
    // Profile drift repair: the prompt/effort live on the RECORD (spawn-time
    // args, no live channel), so a lane minted before a personalAiProfile upgrade
    // would otherwise keep the stale persona forever. Refreshing the record here
    // makes the next cold resume (~idle timeout) pick the current one up; the
    // live CLI process keeps the old prompt until then, which is acceptable.
    // claude engine only — ACP has no profile channel (no system-prompt param).
    if (!isAcpEngine(existingEngine)) {
      const { profile, effort } = await buildLaneProfile(config, agentId);
      // PERSONA halves only. The record's prompt also carries the mint-time
      // conversation seed, which is a frozen snapshot: comparing whole prompts
      // would differ on every turn (the conversation grew) and rewrite the
      // record on every send, and rebuilding the seed here would break the
      // byte-exact spawn prompt a cold --resume re-emits.
      const current = splitLanePrompt(existing.profile?.systemPrompt ?? '');
      const freshPersona = splitLanePrompt(profile.systemPrompt ?? '').persona;
      if (current.persona !== freshPersona) {
        // CLAMPED, always: the persona is the half that grows, and an over-ceiling
        // record does not degrade — it throws on the next cold resume and the lane
        // never comes back. See buildRepairedLanePrompt.
        const rebuilt = buildRepairedLanePrompt(profile.systemPrompt ?? '', current.seed);
        const { updateSessionRecord } = await import('../session-tracker.js');
        await updateSessionRecord(existing.claudeSessionId, {
          profile: { ...profile, systemPrompt: rebuilt.prompt }, effort,
        }).catch((err) => {
          log.session.warn('Personal AI lane: profile refresh failed', {
            lane, sessionId: existing.claudeSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        // A clipped or dropped seed means the grown persona is crowding out the
        // conversation the lane was given — worth a warn, not an info.
        const logAt = rebuilt.seed === 'clipped' || rebuilt.seed === 'dropped'
          ? log.session.warn
          : log.session.info;
        logAt('Personal AI lane: stale profile refreshed on record', {
          lane, sessionId: existing.claudeSessionId, seed: rebuilt.seed,
          promptBytes: Buffer.byteLength(rebuilt.prompt, 'utf-8'),
        });
      }
    }
    log.session.info('Personal AI lane: reusing session', {
      lane, sessionId: existing.claudeSessionId, processStatus: existing.process_status,
    });
    return { sessionId: existing.claudeSessionId, created: false, engine: existingEngine };
  }

  const title = agentId === 'general' ? 'Main AI chat' : `Main AI chat (${agentId})`;

  if (isAcpEngine(engine)) {
    // ACP lane: the worker mints the session id itself, so there is no record to
    // seed up front — emit the start (the runner routes any ACP engine to
    // handleAcpStart, which creates the lane-bound record on establish) and wait
    // for that record. Known limitation: no persona/profile — ACP has no
    // system-prompt channel, so an ACP lane is a bare provider chat.
    //
    // That limitation is why the MESSAGE is an ACP lane's only carrier for the
    // conversation seed — not a fallback the way it is on the claude branch, the
    // whole channel. The invariant has no exception for a transport: an ACP lane
    // that answers turn one without the prior conversation denies text the user is
    // looking at, exactly like a claude lane would.
    //
    // Same guard, same banner, same latch-follows-delivery rule as below; the
    // `!seedInProfile` half is constantly true here because there is no profile.
    // A message-less mint still carries nothing and latches nothing, so
    // buildLaneCatchUp trigger B covers it on its first real send.
    const acpEngine = resolveEngine(engine);
    const viaMessage = firstMessage
      ? await recapOntoFirstMessage(agentId, conversationId, firstMessage, lane)
      : null;
    bus.emit(EventNames.SESSION_START, {
      taskId: '',
      message: viaMessage?.message ?? firstMessage,
      cwd: WALNUT_HOME,
      title,
      lane,
      engine: acpEngine,
    }, ['session-runner'], { source: 'personal-ai-lane' });
    // Throws on a session that never established — and then nothing was delivered,
    // so nothing has been latched. That ordering is the point.
    const sessionId = await waitForLaneRecord(lane, 90_000, engineCaps(acpEngine).displayName);
    if (viaMessage) await latchLaneSeen(agentId, conversationId, sessionId, viaMessage.watermark, lane);
    log.session.info('Personal AI lane: ACP session created', {
      lane, sessionId, agentId, conversationId, engine: acpEngine,
      // One grep answers "did this lane ever get its history, and how".
      seedCarrier: viaMessage ? 'message' : 'none',
      seedTurns: viaMessage?.stats.turnsKept ?? 0,
      seedTurnsAvailable: viaMessage?.stats.turnsTotal ?? 0,
      seedTokens: viaMessage?.stats.tokens ?? 0,
      seedOmitted: viaMessage?.stats.omitted ?? false,
    });
    return { sessionId, created: true, engine: acpEngine };
  }

  // The seed rides the profile, so it lands on BOTH the record and the spawn —
  // deliberately the same string, because a cold --resume re-emits the record's
  // prompt and the cache prefix has to match the original spawn byte for byte.
  const { profile, effort, seed } = await buildLaneProfile(config, agentId, { conversationId });
  const sessionId = crypto.randomUUID();

  // Did the seed actually ride the spawn profile? Empty text with turns available
  // means it did NOT (no argv headroom, or the build failed); empty text with no
  // turns available means there was nothing to carry.
  const seedInProfile = !!seed && (seed.text !== '' || seed.stats.turnsTotal === 0);

  // ── Fallback carrier: the first message ──
  // The argv could not hold the recap, but the conversation HAS prior content, so
  // the lane would answer its very first turn blind — the exact failure this whole
  // change exists to prevent, narrowed to one turn. So it changes carrier (see
  // recapOntoFirstMessage), which is the same channel the turn-time catch-up uses.
  //
  // Only when there IS a message to ride: a read-driven `ensure: true` mint passes
  // none, and that lane is covered by buildLaneCatchUp trigger B instead.
  let message = firstMessage;
  /** null = nothing was delivered, so nothing may be latched (see below). */
  let deliveredWatermark: string | null = seedInProfile ? (seed?.watermark ?? '') : null;
  if (!seedInProfile && firstMessage) {
    const viaMessage = await recapOntoFirstMessage(agentId, conversationId, firstMessage, lane);
    if (viaMessage) {
      message = viaMessage.message;
      deliveredWatermark = viaMessage.watermark;
      log.session.warn('Personal AI lane: the spawn argv could not hold the seed — the recap rides the first message instead', {
        lane, sessionId, agentId, conversationId,
        turns: viaMessage.stats.turnsKept, tokens: viaMessage.stats.tokens, omitted: viaMessage.stats.omitted,
      });
    }
  }

  // Seed the record BEFORE the spawn — same reason quick-start does (the id is
  // ours, so the row can exist before the CLI). Here it additionally CLOSES the
  // lane: a second message arriving during the spawn window finds this row and
  // reuses the session instead of minting a rival one.
  await createSessionRecord(sessionId, '', '', WALNUT_HOME, {
    title,
    profile,
    lane,
    effort,
    // No turn has begun from the record's point of view (the CLI isn't up yet);
    // 'running' here would paint a phantom "working…" badge.
    initialProcessStatus: 'idle',
    initialStatusReason: 'awaiting_spawn',
  });

  // Mode is left unset → send() defaults to 'bypass', matching the in-process
  // Personal AI (which never prompted the user to approve its own tool calls).
  bus.emit(EventNames.SESSION_START, {
    taskId: '',
    message,
    cwd: WALNUT_HOME,
    title,
    profile,
    lane,
    effort,
    preassignedSessionId: sessionId,
  }, ['session-runner'], { source: 'personal-ai-lane' });

  // Latch how far this lane has been caught up — ONLY when the recap was actually
  // delivered by one of the two carriers, or when there was nothing to deliver
  // (see latchLaneSeen). Not latching is cheap and self-healing: the very next
  // send finds no mark and no seed in the profile, and trigger B delivers the
  // recap through the message channel. That path is what the read-driven mint
  // (no message to ride) relies on.
  if (deliveredWatermark !== null) {
    await latchLaneSeen(agentId, conversationId, sessionId, deliveredWatermark, lane);
  } else {
    log.session.warn('Personal AI lane: the mint delivered no conversation seed — the next send catches the lane up instead', {
      lane, sessionId, agentId, conversationId,
      seedBuilt: !!seed, seedTurnsAvailable: seed?.stats.turnsTotal ?? 0,
      hadMessageToRide: !!firstMessage,
    });
  }

  log.session.info('Personal AI lane: session created', {
    lane, sessionId, agentId, conversationId,
    seedCarrier: seedInProfile ? 'profile' : (message !== firstMessage ? 'message' : 'none'),
    seedTurns: seed?.stats.turnsKept ?? 0,
    seedTurnsAvailable: seed?.stats.turnsTotal ?? 0,
    seedTokens: seed?.stats.tokens ?? 0,
    seedOmitted: seed?.stats.omitted ?? false,
  });
  return { sessionId, created: true, engine: 'claude' };
}
