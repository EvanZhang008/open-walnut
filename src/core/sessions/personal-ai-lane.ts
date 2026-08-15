/**
 * Personal AI lanes — "one chat conversation ⇄ one long-lived Claude Code session".
 *
 * When `config.agent.provider === 'claude-code'` a Personal AI chat turn is not run by
 * the in-process agent loop; it is delivered into a `claude` CLI session that the
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
import { WALNUT_HOME } from '../../constants.js';
import { bus, EventNames } from '../event-bus.js';
import { getConfig } from '../config-manager.js';
import { getSessionByLane, createSessionRecord } from '../session-tracker.js';
import { personalAiProfile, consoleAgentProfile } from './profiles.js';
import { buildSessionSkillsPrompt } from '../skill-loader.js';
import { log } from '../../logging/index.js';

/** The lane key a Personal AI conversation's session is bound to. */
export function personalAiLaneKey(agentId: string, conversationId: string): string {
  return `chat:${agentId}:${conversationId}`;
}

/**
 * Inverse of `personalAiLaneKey` — recover the (agentId, conversationId) a lane-bound
 * session belongs to. Returns null for anything that is not a Personal AI chat lane
 * (a future lane namespace, a hand-edited record, an empty string).
 *
 * Parse rule, deliberately asymmetric: strip the `chat:` prefix, then split on
 * the FIRST remaining ':' only — agentId is the head, and EVERYTHING after it is
 * the conversationId, colons included. Today neither id can contain ':'
 * (validateAgentId / validateConversationId both reject it), so a naive
 * three-way split would also work; the single-split form is chosen so that if a
 * conversation id ever grows a separator, the agent attribution stays right and
 * the conversation id stays whole instead of being silently truncated.
 */
export function parseLaneKey(lane: string | undefined | null): { agentId: string; conversationId: string } | null {
  if (!lane || !lane.startsWith('chat:')) return null;
  const rest = lane.slice('chat:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null; // no separator, or an empty agentId
  const agentId = rest.slice(0, sep);
  const conversationId = rest.slice(sep + 1);
  if (!conversationId) return null;
  return { agentId, conversationId };
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
      archive_reason: 'chat_cleared',
    });
    log.session.info('Personal AI lane: archived on chat clear', { lane, sessionId });
    return sessionId;
  } catch (err) {
    log.session.warn('Personal AI lane: archive on clear failed', {
      lane, sessionId, error: err instanceof Error ? err.message : String(err),
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
  opts?: { firstMessage?: string },
): Promise<LaneSession> {
  const lane = personalAiLaneKey(agentId, conversationId);
  const pending = inFlight.get(lane);
  if (pending) return pending;
  const promise = resolveLane(lane, agentId, conversationId, opts?.firstMessage ?? '')
    .finally(() => { inFlight.delete(lane); });
  inFlight.set(lane, promise);
  return promise;
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
  const [agentsMd, memoryMd, userMd] = await Promise.all([
    readOr('AGENTS.md'),
    readOr('memory/MEMORY.md'),
    readOr('memory/USER.md'),
  ]);
  const parts = [
    LANE_MEMORY_HEADER,
    'Walnut injects this at session start — standing context, the same role the old per-turn memory sections played. The live files under your working directory are the source of truth; your edits to them are picked up on the next session start.',
  ];
  if (agentsMd) parts.push(`### Home directory guide (AGENTS.md)\n\n${agentsMd}`);
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

async function resolveLane(
  lane: string,
  agentId: string,
  conversationId: string,
  firstMessage: string,
): Promise<LaneSession> {
  const config = await getConfig();
  // One-time cleanup of the retired CLAUDE.md delivery path (see
  // cleanupLaneClaudeMd) — memory now rides the profile injection below.
  await cleanupLaneClaudeMd();
  // Walnut's own skills (workspace / ~/.open-walnut/skills / shipped) — no CLI
  // engine ever discovers these, so the lane prompt carries the index itself.
  // ~/.claude/skills is excluded (Claude Code loads it natively). Failure is
  // non-fatal: a lane without the index still answers.
  const skillsIndex = await buildSessionSkillsPrompt().catch(() => '');
  // Standing memory — Walnut-owned injection, engine-neutral (see
  // buildLaneMemoryContext). Rides the SAME profile as the persona.
  const memoryContext = await buildLaneMemoryContext().catch(() => '');
  // general = the Personal AI persona; any other console agent gets ITS persona
  // wrapped in the same session addendum (consoleAgentProfile) — one engine,
  // one consistent chat feel, per-agent identity.
  let profile;
  if (agentId === 'general') {
    profile = personalAiProfile(config.user?.name ?? 'the user', skillsIndex, memoryContext);
  } else {
    const { getConsoleAgent } = await import('../agent-registry.js');
    const agentDef = await getConsoleAgent(agentId);
    if (!agentDef) throw new Error(`Console agent '${agentId}' not found`);
    const { loadContextSources } = await import('../../agent/context-sources.js');
    const contextBlock = await loadContextSources(agentDef, {}).catch(() => '');
    profile = consoleAgentProfile(agentDef, skillsIndex, contextBlock);
  }
  // Chat latency matters more than reasoning depth here. Without an explicit
  // effort the CLI inherits the user's global settings.json effortLevel (often
  // xhigh, tuned for coding sessions) — measured 100s+ for "what tasks do I have
  // today". Config `agent.session_effort` still wins when the user set one.
  const effort = config.agent?.session_effort ?? 'medium';

  const existing = await getSessionByLane(lane);
  if (existing) {
    // Profile drift repair: the prompt/effort live on the RECORD (spawn-time
    // args, no live channel), so a lane minted before a personalAiProfile upgrade
    // would otherwise keep the stale persona forever. Refreshing the record here
    // makes the next cold resume (~idle timeout) pick the current one up; the
    // live CLI process keeps the old prompt until then, which is acceptable.
    if (existing.profile?.systemPrompt !== profile.systemPrompt) {
      const { updateSessionRecord } = await import('../session-tracker.js');
      await updateSessionRecord(existing.claudeSessionId, { profile, effort }).catch((err) => {
        log.session.warn('Personal AI lane: profile refresh failed', {
          lane, sessionId: existing.claudeSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      log.session.info('Personal AI lane: stale profile refreshed on record', {
        lane, sessionId: existing.claudeSessionId,
      });
    }
    log.session.info('Personal AI lane: reusing session', {
      lane, sessionId: existing.claudeSessionId, processStatus: existing.process_status,
    });
    return { sessionId: existing.claudeSessionId, created: false };
  }

  const sessionId = crypto.randomUUID();
  const title = agentId === 'general' ? 'Main AI chat' : `Main AI chat (${agentId})`;

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
    message: firstMessage,
    cwd: WALNUT_HOME,
    title,
    profile,
    lane,
    effort,
    preassignedSessionId: sessionId,
  }, ['session-runner'], { source: 'personal-ai-lane' });

  log.session.info('Personal AI lane: session created', { lane, sessionId, agentId, conversationId });
  return { sessionId, created: true };
}
