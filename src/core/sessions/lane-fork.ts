/**
 * Fork a Personal AI conversation — "copy this chat's history into a new
 * conversation and keep talking there".
 *
 * A chat conversation is backed by a lane-bound Claude Code session, so the
 * fork is a SESSION fork underneath: a fresh conversation is created, a new
 * session id is minted and seeded with `forkedFromSessionId`, and the spawn
 * rides the CLI's native `--resume <src> --fork-session` (the same mechanism
 * task-session forks use in session-controls.ts). Unlike those, a chat fork
 * creates NO task — lane sessions are taskless by design, and the fork's
 * lifecycle is the conversation's.
 *
 * The spawn is emitted HERE, at fork time, with an empty first message (the
 * same created-idle contract the lane-session endpoint uses): the forked id
 * does not exist in any CLI JSONL until `--fork-session` runs, so deferring
 * the spawn to the first send would cold-`--resume` an id the CLI has never
 * seen and die with "No conversation found".
 */

import crypto from 'node:crypto';
import { bus, EventNames } from '../event-bus.js';
import { getSessionByLane, createSessionRecord } from '../session-tracker.js';
import { createConversation, listConversations } from '../conversations.js';
import { SessionControlError } from './session-controls.js';
import { log } from '../../logging/index.js';
import type { ConversationMeta } from '../types.js';

export interface LaneForkResult {
  conversation: ConversationMeta;
  sessionId: string;
}

export async function forkLaneConversation(
  agentId: string,
  conversationId: string,
): Promise<LaneForkResult> {
  // Lane key format is frozen (persisted on every lane SessionRecord) — the
  // canonical builder lives in the lane module; inlined here to keep this file
  // free of that module's heavyweight profile imports.
  const sourceLane = `chat:${agentId}:${conversationId}`;
  const source = await getSessionByLane(sourceLane);
  if (!source) {
    throw new SessionControlError('This conversation has no session yet — nothing to fork', 409);
  }
  if (!source.cwd) {
    throw new SessionControlError('Source session has no working directory — cannot fork', 400);
  }
  // Which id `--resume` targets. A lane with no delivered message has NO CLI
  // JSONL (the fork spawn is init-only — it writes nothing until its first
  // stdin turn), so resuming it dies with "No conversation found". The
  // CONVERSATION's messageCount is the honest signal (touchLaneConversation
  // feeds it on every real send). For an untouched FORK, walk one hop up and
  // resume the ANCESTOR the fork itself would have resumed — by induction that
  // one has history. Only a message-less lane with no ancestor is unforkable.
  let resumeFromId = source.claudeSessionId;
  let sourceTitle = source.title ?? 'Chat';
  try {
    const convs = await listConversations(agentId);
    const meta = convs.find((c) => c.id === conversationId);
    if (meta) {
      sourceTitle = meta.isMain ? 'Main' : meta.title;
      if (meta.messageCount === 0) {
        if (!source.forkedFromSessionId) {
          throw new SessionControlError('This conversation is empty — nothing to fork', 409);
        }
        resumeFromId = source.forkedFromSessionId;
      }
    }
  } catch (err) {
    if (err instanceof SessionControlError) throw err;
    /* title/guard read failed — cosmetic; never block the fork on it */
  }
  // Strip a previous fork decoration so titles don't compound without bound
  // ("Fork of Fork of Fork of …" — same rule task forks apply).
  const baseTitle = sourceTitle.replace(/^(Fork of\s+)+/i, '').trim() || sourceTitle;
  const forkTitle = `Fork of ${baseTitle}`.slice(0, 60);

  // New conversation first (server sets it active), then bind the forked
  // session to ITS lane before the spawn — same seed-before-spawn contract as
  // getOrCreateLaneSession, so a concurrent send finds the record and queues.
  const conversation = await createConversation(agentId, forkTitle);
  const forkSessionId = crypto.randomUUID();
  const lane = `chat:${agentId}:${conversation.id}`;

  await createSessionRecord(forkSessionId, '', '', source.cwd, {
    title: forkTitle,
    // The fork inherits the source's launch bundle verbatim: same persona, same
    // effort, re-applied from the record on every cold resume.
    ...(source.profile ? { profile: source.profile } : {}),
    ...(source.effort ? { effort: source.effort } : {}),
    lane,
    forkedFromSessionId: resumeFromId,
    initialProcessStatus: 'idle',
    initialStatusReason: 'awaiting_spawn',
  });

  bus.emit(EventNames.SESSION_START, {
    taskId: '',
    // Created idle — the user's next message rides session:send like any lane.
    message: '',
    cwd: source.cwd,
    title: forkTitle,
    ...(source.profile ? { profile: source.profile } : {}),
    ...(source.effort ? { effort: source.effort } : {}),
    // Fork must resume on the parent's exact --model arg (see session-controls:
    // the CLI does not inherit a model across --fork-session).
    ...(source.cliModel ? { model: source.cliModel } : {}),
    lane,
    preassignedSessionId: forkSessionId,
    forkedFromSessionId: resumeFromId,
  }, ['session-runner'], { source: 'lane-fork' });

  log.session.info('lane fork: conversation forked', {
    agentId, conversationId, newConversationId: conversation.id,
    sourceSessionId: source.claudeSessionId, resumeFromId, forkSessionId,
  });

  return { conversation, sessionId: forkSessionId };
}
