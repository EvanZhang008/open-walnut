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
import { WALNUT_HOME } from '../../constants.js';
import { bus, EventNames } from '../event-bus.js';
import { getConfig } from '../config-manager.js';
import { getSessionByLane, createSessionRecord } from '../session-tracker.js';
import { butlerProfile } from './profiles.js';
import { log } from '../../logging/index.js';

/** The lane key a butler conversation's session is bound to. */
export function butlerLaneKey(agentId: string, conversationId: string): string {
  return `chat:${agentId}:${conversationId}`;
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

async function resolveLane(
  lane: string,
  agentId: string,
  conversationId: string,
  firstMessage: string,
): Promise<LaneSession> {
  const existing = await getSessionByLane(lane);
  if (existing) {
    log.session.info('butler lane: reusing session', {
      lane, sessionId: existing.claudeSessionId, processStatus: existing.process_status,
    });
    return { sessionId: existing.claudeSessionId, created: false };
  }

  const config = await getConfig();
  const profile = butlerProfile(config.user?.name ?? 'the user');
  const sessionId = crypto.randomUUID();
  const title = agentId === 'general' ? 'Butler chat' : `Butler chat (${agentId})`;

  // Seed the record BEFORE the spawn — same reason quick-start does (the id is
  // ours, so the row can exist before the CLI). Here it additionally CLOSES the
  // lane: a second message arriving during the spawn window finds this row and
  // reuses the session instead of minting a rival one.
  await createSessionRecord(sessionId, '', '', WALNUT_HOME, {
    title,
    profile,
    lane,
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
    preassignedSessionId: sessionId,
  }, ['session-runner'], { source: 'butler-lane' });

  log.session.info('butler lane: session created', { lane, sessionId, agentId, conversationId });
  return { sessionId, created: true };
}
