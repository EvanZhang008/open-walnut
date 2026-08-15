/**
 * Butler lanes — "one chat conversation ⇄ one long-lived Claude Code session".
 *
 * When `config.agent.provider === 'claude-code'` a butler chat turn is not run by
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
import { butlerProfile } from './profiles.js';
import { buildSessionSkillsPrompt } from '../skill-loader.js';
import { log } from '../../logging/index.js';

/** The lane key a butler conversation's session is bound to. */
export function butlerLaneKey(agentId: string, conversationId: string): string {
  return `chat:${agentId}:${conversationId}`;
}

/**
 * Inverse of `butlerLaneKey` — recover the (agentId, conversationId) a lane-bound
 * session belongs to. Returns null for anything that is not a butler chat lane
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
  const lane = butlerLaneKey(agentId, conversationId);
  let sessionId: string | null = null;
  try {
    const record = await getSessionByLane(lane);
    if (!record) return null;
    sessionId = record.claudeSessionId;

    try {
      const { terminateSession } = await import('./session-lifecycle.js');
      await terminateSession(sessionId, { force: true });
    } catch (err) {
      log.session.warn('butler lane: stopping the CLI failed; archiving anyway', {
        lane, sessionId, error: err instanceof Error ? err.message : String(err),
      });
    }

    const { updateSessionRecord } = await import('../session-tracker.js');
    await updateSessionRecord(sessionId, {
      archived: true,
      archive_reason: 'chat_cleared',
    });
    log.session.info('butler lane: archived on chat clear', { lane, sessionId });
    return sessionId;
  } catch (err) {
    log.session.warn('butler lane: archive on clear failed', {
      lane, sessionId, error: err instanceof Error ? err.message : String(err),
    });
    return sessionId;
  }
}

/**
 * Stop the turn currently running in this conversation's lane — the lane half of
 * the butler's "stop" button.
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
  const lane = butlerLaneKey(agentId, conversationId);
  try {
    const record = await getSessionByLane(lane);
    if (!record) return null;
    if (record.process_status !== 'running' && record.process_status !== 'idle') return null;
    bus.emit(
      EventNames.SESSION_INTERRUPT,
      { sessionId: record.claudeSessionId },
      ['session-runner'],
      { source: 'butler-lane' },
    );
    log.session.info('butler lane: interrupt requested', {
      lane, sessionId: record.claudeSessionId, processStatus: record.process_status,
    });
    return record.claudeSessionId;
  } catch (err) {
    log.session.warn('butler lane: interrupt failed', {
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
  const lane = butlerLaneKey(agentId, conversationId);
  const pending = inFlight.get(lane);
  if (pending) return pending;
  const promise = resolveLane(lane, agentId, conversationId, opts?.firstMessage ?? '')
    .finally(() => { inFlight.delete(lane); });
  inFlight.set(lane, promise);
  return promise;
}

/**
 * Marker line identifying the lane-managed CLAUDE.md in WALNUT_HOME. A file
 * without it is the USER's and is never touched.
 */
const LANE_CLAUDE_MD_MARKER = '<!-- walnut:butler-lane-context v1 -->';

const LANE_CLAUDE_MD = `${LANE_CLAUDE_MD_MARKER}
# Main AI home directory

Walnut's persistent memory loads below via imports — treat it as standing
context, exactly like the old per-turn memory sections.

@AGENTS.md
@memory/MEMORY.md
@memory/USER.md

Daily activity logs live in memory/daily/<date>.md — read recent ones on
demand when the user asks "what happened / what did I do".
`;

/**
 * Make the CLI load Walnut's memory natively: `--system-prompt` REPLACES the
 * system prompt but Claude Code still reads {cwd}/CLAUDE.md (verified by probe),
 * and @imports resolve from it. The old in-process engine injected MEMORY.md /
 * USER.md / notes context into every turn; this file is the lane engine's
 * equivalent — written once, refreshed when OUR managed copy drifts, and a
 * user-authored CLAUDE.md (no marker) is left strictly alone.
 *
 * Never throws: a lane that can't get the file still answers.
 */
export async function ensureLaneClaudeMd(homeDir: string = WALNUT_HOME): Promise<void> {
  const file = path.join(homeDir, 'CLAUDE.md');
  try {
    const current = await fs.readFile(file, 'utf-8').catch(() => null);
    if (current === LANE_CLAUDE_MD) return;
    if (current !== null && !current.includes(LANE_CLAUDE_MD_MARKER)) {
      log.session.info('butler lane: user-authored CLAUDE.md present, leaving it alone', { file });
      return;
    }
    await fs.writeFile(file, LANE_CLAUDE_MD, 'utf-8');
    log.session.info('butler lane: managed CLAUDE.md written', { file, refreshed: current !== null });
  } catch (err) {
    log.session.warn('butler lane: ensuring CLAUDE.md failed; lane runs without memory imports', {
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
  // Memory reaches the model through {cwd}/CLAUDE.md @imports (native CLI
  // loading) — do this for EXISTING lanes too: the file is read at spawn, so a
  // refresh lands on the next cold resume, same cadence as profile drift.
  await ensureLaneClaudeMd();
  // Walnut's own skills (workspace / ~/.open-walnut/skills / shipped) — no CLI
  // engine ever discovers these, so the lane prompt carries the index itself.
  // ~/.claude/skills is excluded (Claude Code loads it natively). Failure is
  // non-fatal: a lane without the index still answers.
  const skillsIndex = await buildSessionSkillsPrompt().catch(() => '');
  const profile = butlerProfile(config.user?.name ?? 'the user', skillsIndex);
  // Chat latency matters more than reasoning depth here. Without an explicit
  // effort the CLI inherits the user's global settings.json effortLevel (often
  // xhigh, tuned for coding sessions) — measured 100s+ for "what tasks do I have
  // today". Config `agent.session_effort` still wins when the user set one.
  const effort = config.agent?.session_effort ?? 'medium';

  const existing = await getSessionByLane(lane);
  if (existing) {
    // Profile drift repair: the prompt/effort live on the RECORD (spawn-time
    // args, no live channel), so a lane minted before a butlerProfile upgrade
    // would otherwise keep the stale persona forever. Refreshing the record here
    // makes the next cold resume (~idle timeout) pick the current one up; the
    // live CLI process keeps the old prompt until then, which is acceptable.
    if (existing.profile?.systemPrompt !== profile.systemPrompt) {
      const { updateSessionRecord } = await import('../session-tracker.js');
      await updateSessionRecord(existing.claudeSessionId, { profile, effort }).catch((err) => {
        log.session.warn('butler lane: profile refresh failed', {
          lane, sessionId: existing.claudeSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      log.session.info('butler lane: stale profile refreshed on record', {
        lane, sessionId: existing.claudeSessionId,
      });
    }
    log.session.info('butler lane: reusing session', {
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
  // butler (which never prompted the user to approve its own tool calls).
  bus.emit(EventNames.SESSION_START, {
    taskId: '',
    message: firstMessage,
    cwd: WALNUT_HOME,
    title,
    profile,
    lane,
    effort,
    preassignedSessionId: sessionId,
  }, ['session-runner'], { source: 'butler-lane' });

  log.session.info('butler lane: session created', { lane, sessionId, agentId, conversationId });
  return { sessionId, created: true };
}
