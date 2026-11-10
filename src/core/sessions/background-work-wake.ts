/**
 * Wake a session whose own command, left running when its turn ended, has ended.
 *
 * Claude Code runs a turn of its own when a background command it started ends. Codex does not:
 * its turn ends while a build or test run it started goes on, and nothing wakes it when that run
 * ends (2026-11-10: a Codex task sat idle in Needs you three times while its own build ran, each
 * needing a person's nudge). The direct Codex client reports such commands and their ends
 * (providers/codex-app-server/background.ts); the session (acp-session.ts) reads the task as
 * working while one runs and, when one ends, sends this message through the normal queue, so the
 * model goes on with what it waited for.
 */

import { buildWalnutMessage } from '../peers/walnut-message-tag.js';
import type { FinishedTerminal } from '../../providers/acp-worker/protocol.js';

export const BACKGROUND_WORK_ENDED_SOURCE = 'background-work-ended';

/** Its command in the message: one line, at most this long. */
const COMMAND_CHARS = 200;

const oneLine = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > COMMAND_CHARS ? `${line.slice(0, COMMAND_CHARS - 3)}...` : line;
};

function describe(t: FinishedTerminal): string {
  const how = t.exitCode === null ? 'it ended (Codex gave no exit code)' : `exit code ${t.exitCode}`;
  const head = `- \`${oneLine(t.command) || `process ${t.processId}`}\` (process ${t.processId}): ${how}.`;
  const output = t.output.trimEnd();
  if (!output) return head;
  // A fence its own output cannot close.
  const fence = output.includes('```') ? '~~~~' : '```';
  return `${head} Its output ends with:\n${fence}\n${output}\n${fence}`;
}

/** The message that wakes the session. Pure, for tests. */
export function backgroundWorkEndedText(finished: readonly FinishedTerminal[]): string {
  const lead = finished.length === 1
    ? 'A command you left running when your turn ended has ended:'
    : `${finished.length} commands you left running when your turn ended have ended:`;
  return buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', note: 'your own background command ended' },
    body: `${lead}\n${finished.map(describe).join('\n')}\n\n`
      + 'Read what you need of its result, then carry on with your task.',
  });
}

/**
 * Send the wake. `messageId` is stable per journal record, so the same record read again (a
 * server restart re-reading the journal past its last commit) is the same queued message.
 */
export async function wakeForEndedBackgroundWork(
  sessionId: string,
  taskId: string | undefined,
  finished: readonly FinishedTerminal[],
  messageId: string,
  guard: { stopFence?: string | null; stillWanted?: () => boolean } = {},
): Promise<void> {
  const { sendMessageToSession } = await import('../session-message-queue.js');
  await sendMessageToSession(sessionId, backgroundWorkEndedText(finished), {
    source: BACKGROUND_WORK_ENDED_SOURCE,
    ...(taskId ? { taskId } : {}),
    messageId,
    // A stop after the end was told withdraws the wake: the queue refuses a row from before it.
    ...(guard.stopFence !== undefined ? { stopFence: guard.stopFence } : {}),
    ...(guard.stillWanted ? { stillWanted: guard.stillWanted } : {}),
  });
}
