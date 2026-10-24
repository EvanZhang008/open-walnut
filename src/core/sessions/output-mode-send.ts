/**
 * Applying the output-mode directive to ONE outgoing message — the send-side
 * choreography, in one place.
 *
 * `output-mode.ts` is the pure policy (what a send OWES the model). This module is
 * the part every surface has to get right around it, and there are three pieces:
 * skip slash commands (the CLI only treats input as a command when the raw string
 * startsWith('/'), so a wrapper makes "/compact" a chat message the model
 * role-plays), wrap the text the CLI will actually receive rather than the text the
 * human sees, and advance the record's edge marker ONLY after the enqueue
 * succeeded — a throw before that must leave the session still owing the
 * instruction, or the mode change is silently lost.
 *
 * It exists because the web `session:send` RPC was the only caller doing all
 * three. A session driven from the phone therefore never heard the instruction at
 * all (rich mode was inert on mobile even while the composer pill said it was on),
 * and a phone send in the middle of a rich session dropped the standing reminder
 * that keeps the model from drifting back to plain markdown mid-conversation.
 * Every send path that reaches a CLI now goes through here: the web RPC, the
 * phone's `POST /api/v1/sessions/:id/messages`, and the cloud relay's
 * `session.message` (which lands on the primary as a durable enqueue).
 */

import { getConfig } from '../config-manager.js';
import { updateSessionRecord } from '../session-tracker.js';
import { log } from '../../logging/index.js';
import type { Config, SessionOutputMode, SessionRecord } from '../types.js';
import {
  resolveOutputModeDirective,
  resolveEffectiveOutputMode,
  applyOutputModeDirective,
  stripOutputModeWrappers,
  RICH_OUTPUT_MODE_ON_INSTRUCTION,
} from './output-mode.js';

/**
 * Turns nobody typed, whose replies the user still reads: a trigger fire, another
 * task's message, the wait_until clock, Walnut's notices, a letter reply, an
 * automatic continue or recovery. They reach the CLI through the queue directly,
 * so the queue applies the directive for them (session-message-queue.ts). The
 * human paths (web, phone, cloud relay) wrap before they enqueue and are not here.
 */
export const AUTOMATED_OUTPUT_MODE_SOURCES: ReadonlySet<string> = new Set([
  'routine-trigger', 'routine-watcher', 'wait-until', 'peer', 'walnut-notify',
  'human-inbox', 'auto-continue', 'auto-recover', 'app-state',
]);

/**
 * The directive for a turn an automated source starts, or null when the source
 * is not one of those, the text already carries a wrapper, or the session has no
 * record. Never throws: a send must not fail over a reply-style reminder.
 */
export async function prepareAutomatedOutputModeSend(
  sessionId: string,
  source: string | undefined,
  message: string,
): Promise<PreparedOutputModeSend | null> {
  if (!source || !AUTOMATED_OUTPUT_MODE_SOURCES.has(source)) return null;
  try {
    if (stripOutputModeWrappers(message) !== message) return null;
    // The edge marker lives on the leader's record; a replica's copy may lag.
    const { role } = await import('../server-role.js');
    if (role() !== 'leader') return null;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    if (!record) return null;
    const prepared = await prepareOutputModeSend(sessionId, record, message);
    return prepared.changed ? prepared : null;
  } catch {
    return null;
  }
}

/**
 * The full rich instruction for the post-compaction hook to put into context,
 * recorded as told; null when the session is not on rich. A compaction in the
 * middle of a turn would otherwise leave the rest of that turn without it until
 * the next send. Never throws.
 */
export async function stateOutputModeAfterCompaction(
  record: Pick<SessionRecord, 'claudeSessionId' | 'output_mode'>,
  config?: Pick<Config, 'session'> | null,
  now = Date.now(),
): Promise<string | null> {
  try {
    const resolvedConfig = config !== undefined ? config : await getConfig().catch(() => null);
    if (resolveEffectiveOutputMode(record, resolvedConfig) !== 'rich') return null;
    const { updateSessionRecordConditionally } = await import('../session-tracker.js');
    await updateSessionRecordConditionally(record.claudeSessionId, {
      output_mode_injected: 'rich',
      outputModeHookAt: new Date(now).toISOString(),
    }, () => true, { preserveLastActiveAt: true });
    return RICH_OUTPUT_MODE_ON_INSTRUCTION;
  } catch {
    return null;
  }
}

export interface PreparedOutputModeSend {
  /** The effective mode this send was resolved against. */
  mode: SessionOutputMode;
  /** Text the CLI must receive — identical to the input when nothing is owed. */
  enqueueText: string;
  /** What a history parse will DISPLAY for this message: the input, or the
   *  augmented text minus the wrapper the projection strips back out
   *  (core/session-history.ts). Optimistic-dedup matches on this basis, so an
   *  emitter that hands back anything else leaves the bubble unmatchable. */
  displayText: string;
  /** Did the wrapper change the text at all? */
  changed: boolean;
  /** Advance `output_mode_injected`. Call ONLY after the text is safely queued;
   *  a no-op when this send carried no edge instruction. Never throws — a failure
   *  to persist means the instruction repeats on the next send, which is strictly
   *  better than failing the send. */
  commit(): Promise<void>;
}

/**
 * What this send must carry, ready to hand to `sendMessageToSession`.
 *
 * `record` is the session row (nullable so a caller with a missing record still
 * gets a sane no-op result); `message` is the text the CLI would have received
 * WITHOUT this feature, image preamble included. `config` is injectable for tests
 * — omitted, it reads the live config, whose failure degrades to "no config
 * preference" rather than failing the send.
 */
export async function prepareOutputModeSend(
  sessionId: string,
  record: Pick<SessionRecord, 'output_mode' | 'output_mode_injected'> | null | undefined,
  message: string,
  config?: Pick<Config, 'session'> | null,
): Promise<PreparedOutputModeSend> {
  const resolvedConfig = config !== undefined ? config : await getConfig().catch(() => null);
  const directive = resolveOutputModeDirective(record, resolvedConfig);
  // A slash command must reach the CLI byte-exact (inc-1788194545341: a prefixed
  // "/compact" stopped being a command and the model narrated a compaction that
  // never happened). Appending is nearly as bad — the text rides into the
  // command's argument string. Skip the wrapper; the edge stays owed and ships
  // with the next real message.
  const isSlashCommand = message.startsWith('/');
  const enqueueText = isSlashCommand ? message : applyOutputModeDirective(directive, message);
  const changed = enqueueText !== message;
  return {
    mode: directive.mode,
    enqueueText,
    displayText: changed ? stripOutputModeWrappers(enqueueText) : message,
    changed,
    async commit(): Promise<void> {
      if (!directive.instruction || isSlashCommand) return;
      // try/catch, not .catch(): a bookkeeping write must not be able to fail a
      // send that already committed, and that has to hold for a synchronous
      // throw too (the enqueue is done by the time we get here — there is
      // nothing left to roll back, and repeating the instruction next send is
      // the whole cost of losing this write).
      try {
        await updateSessionRecord(sessionId, { output_mode_injected: directive.mode });
      } catch (err) {
        log.session.warn('output-mode edge persist failed', {
          sessionId,
          outputMode: directive.mode,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
