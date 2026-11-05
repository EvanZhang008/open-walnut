/**
 * How many hint blocks a session's model receives over 10 messages, for a worker, a lead and Main,
 * against a real server (2026-11-05, the user, of the reply-language block under every message of
 * his: "I said don't do this every round remove thies"). Half the messages are the user's own,
 * typed in the chat (composed by session:send's pipeline, queued as `ui`); half are Walnut notices
 * (`walnut-notify`, composed by the queue); the first is the task's start message, composed as the
 * session runner composes a new conversation's. A compaction lands before the 6th.
 *
 * The rule this pins: a hint goes out only when one of its registry triggers holds. The reply
 * language's are session start, after a compaction, a change of the setting and a reply that
 * drifted, so 10 messages with one compaction and no drift carry it twice, for every role.
 * Would fail if any path forced it onto every turn again (the old `everyTurnRoles` and
 * `everyPersonTurn` rules carried it 10 times out of 10).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import { vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('hint-counts-e2e', { IS_EPHEMERAL: true }));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js';
import { getQueue, sendMessageToSession } from '../../src/core/session-message-queue.js';
import { updateConfig } from '../../src/core/config-manager.js';
import { prepareHintedSend, prepareStartHints } from '../../src/core/hints/hint-send.js';

const RULE = 'Talk to the user in Chinese; code, commits, UI strings and repo docs stay English.';
const MESSAGES = 10;
const COMPACT_BEFORE = 6;

/** Hint blocks per kind in the text a session received. */
function countKinds(text: string, into: Record<string, number>): void {
  for (const m of text.matchAll(/<system-reminder>\nWalnut \(([a-z-]+)[^)\n]*\):/g)) into[m[1]] = (into[m[1]] ?? 0) + 1;
}

async function tenMessages(sid: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  for (let n = 1; n <= MESSAGES; n++) {
    if (n === COMPACT_BEFORE) await updateSessionRecord(sid, { lastCompactUuid: `compact-${sid}` } as never);
    const text = `Message ${n}: how is the build going?`;
    if (n === 1) {
      // The task's first message, composed the way the session runner composes every new conversation's
      // (providers/claude-code-session.ts startSession), and counted as what the spawned CLI reads.
      const started = await prepareStartHints({ taskId: (await getSessionByClaudeId(sid))!.taskId, message: text, preassignedSessionId: sid });
      await started.commit(sid);
      counts.messages = 1;
      countKinds(started.data.message, counts);
      continue;
    } else if (n % 2 === 1) {
      // The user's own message, the way session:send composes it (web/routes/session-chat.ts).
      const hinted = await prepareHintedSend(sid, await getSessionByClaudeId(sid), text, { sentBy: 'person' });
      await sendMessageToSession(sid, text, { source: 'ui', enqueueMessage: hinted.enqueueText, hinted: true });
      await hinted.commit();
    } else {
      // A Walnut notice (a worker's status, a reply): the queue composes its hints itself.
      await sendMessageToSession(sid, text, { source: 'walnut-notify' });
    }
    // Every new row, whatever the queue did with it since (no CLI here: a delivery try parks it).
    const fresh = (await getQueue(sid)).filter((q) => !seen.has(q.id));
    for (const q of fresh) seen.add(q.id);
    counts.messages = (counts.messages ?? 0) + fresh.length;
    countKinds(fresh.map((q) => q.message).join('\n'), counts);
  }
  return counts;
}

const results: Record<string, Record<string, number>> = {};

beforeAll(async () => {
  await startServer({ port: 0, dev: true });
  await updateConfig({ session: { reply_language: RULE } });
  const main = (await addTask({ title: 'Main', project: 'Walnut', source: 'local', org_role: 'main' } as never)).task;
  const lead = (await addTask({ title: 'Walnut lead', project: 'Walnut', source: 'local', org_role: 'lead' } as never)).task;
  const worker = (await addTask({ title: 'A worker', project: 'Walnut', source: 'local', parent_task_id: lead.id } as never)).task;
  for (const [role, task] of [['worker', worker], ['lead', lead], ['main', main]] as const) {
    const sid = `hint-counts-${role}`;
    await createSessionRecord(sid, task.id, 'Walnut');
    results[role] = await tenMessages(sid);
  }
  if (process.env.HINT_COUNTS_OUT) await fs.writeFile(process.env.HINT_COUNTS_OUT, JSON.stringify(results, null, 2));
  console.log('hint blocks over 10 messages', JSON.stringify(results));
}, 120_000);
afterAll(async () => { await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('hint blocks over 10 messages', () => {
  for (const role of ['worker', 'lead', 'main']) {
    it(`${role}: the reply language goes out at session start and after the compaction, never on every message`, () => {
      expect(results[role]['reply-language']).toBe(2);
    });
  }

  it('no built-in rides every message unless its triggers say every_turn', () => {
    // threads is every_turn by its registry entry, and only on a person's message to Main or a lead.
    for (const [role, counts] of Object.entries(results)) {
      for (const [kind, n] of Object.entries(counts)) {
        if (kind === 'threads' || kind === 'messages') continue;
        expect(n, `${role} got ${kind} ${n} times`).toBeLessThan(MESSAGES / 2);
      }
    }
  });
});
