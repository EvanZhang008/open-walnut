/**
 * A long rule reworded deploy after deploy, as a running session hears it (2026-11-20, review of the
 * sentence-level notices): the record keeps the wording it was told, so each notice is told against
 * that one; a wording a newer one replaced is no longer told, so a rollback to it is told again, and
 * it never reads as a told line the record cannot name (which would send every long rule whole).
 *
 * The charter is the real one, with its rules reworded between "deploys" through a live binding.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-instruction-rewords'));
const charter = vi.hoisted(() => ({ text: '' }));
vi.mock('../../../src/core/team-charter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/team-charter.js')>();
  if (!charter.text) charter.text = real.TEAM_CHARTER;
  return { ...real, get TEAM_CHARTER() { return charter.text; } };
});
import { WALNUT_HOME } from '../../../src/constants.js';
import { addTask } from '../../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../../src/core/session-tracker.js';
import { markProcessing, removeProcessed, resetCache, sendMessageToSession } from '../../../src/core/session-message-queue.js';
import { NOTICE_GAP_MS } from '../../../src/core/sessions/instruction-notice.js';
import { LONG_LINE_CHARS, sentencesOf } from '../../../src/core/sessions/instruction-diff.js';
import { buildSessionContext } from '../../../src/core/sessions/session-context.js';

const NOTICE = 'Walnut changed your default instructions';
let REAL = '';

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
  REAL ||= charter.text;
  charter.text = REAL;
});

const longRules = () => REAL.split('\n').filter((l) => l.length >= LONG_LINE_CHARS && sentencesOf(l).length >= 3);
/** `rule` with its second sentence in other words. */
const wording = (rule: string, words: string) => rule.replace(sentencesOf(rule)[1], words);
/** A deploy: the charter's `rule` now reads `to`. */
const deploy = (from: string, to: string) => { charter.text = charter.text.split(from).join(to); };

async function session() {
  const { task } = await addTask({ title: 'Worker', project: 'marina' });
  const sid = randomUUID();
  await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
  await updateSessionRecord(sid, { appliedAppendSystemPrompt: (await buildSessionContext(task.id)).systemPrompt });
  return sid;
}
async function line(sid: string, text: string): Promise<string> {
  await sendMessageToSession(sid, text);
  const batch = await markProcessing(sid);
  await removeProcessed(sid, batch.map((r) => r.id));
  return batch.map((r) => r.message).join('\n\n');
}
/** The gap passes: the last notice was told NOTICE_GAP_MS earlier. */
async function gap(sid: string) {
  const noted = (await getSessionByClaudeId(sid))!.taskRoutingNoted;
  if (!noted?.toldAt) return;
  await updateSessionRecord(sid, { taskRoutingNoted: { ...noted, toldAt: new Date(Date.parse(noted.toldAt) - NOTICE_GAP_MS - 60_000).toISOString() } });
}

describe('a long rule reworded deploy after deploy', () => {
  it('each notice is told against the wording the session was told last, by its sentences', async () => {
    const [RULE] = longRules();
    const sid = await session();
    const v2 = wording(RULE, 'The second wording of this sentence, from a first deploy.');
    const v3 = wording(RULE, 'The third wording of this sentence, from a second deploy.');
    deploy(RULE, v2);
    const first = await line(sid, 'After the first deploy');
    expect(first).toContain('Added or reworded: The second wording of this sentence, from a first deploy.');
    expect(first).not.toContain(v2);
    await gap(sid);
    deploy(v2, v3);
    const second = await line(sid, 'After the second deploy');
    expect(second).toContain('Added or reworded: The third wording of this sentence, from a second deploy.');
    expect(second).toContain('Taken out: "The second wording of this sentence, from a first deploy."');
    expect(second).not.toContain(v3);
  });

  it('a rollback to a wording it was told earlier is told again, against the wording it holds (review G2)', async () => {
    const [RULE] = longRules();
    const sid = await session();
    const v2 = wording(RULE, 'The second wording of this sentence, from a first deploy.');
    const v3 = wording(RULE, 'The third wording of this sentence, from a second deploy.');
    deploy(RULE, v2);
    await line(sid, 'After the first deploy');
    await gap(sid);
    deploy(v2, v3);
    await line(sid, 'After the second deploy');
    await gap(sid);
    // The second deploy is rolled back.
    deploy(v3, v2);
    const back = await line(sid, 'After the rollback');
    expect(back.split(NOTICE).length - 1).toBe(1);
    expect(back).toContain('Added or reworded: The second wording of this sentence, from a first deploy.');
    expect(back).toContain('Taken out: "The third wording of this sentence, from a second deploy."');
  });

  it('a rule reworded twice leaves every other long rule told by its sentences (review G1)', async () => {
    const [RULE, OTHER] = longRules();
    const sid = await session();
    const v2 = wording(RULE, 'The second wording of this sentence, from a first deploy.');
    const v3 = wording(RULE, 'The third wording of this sentence, from a second deploy.');
    deploy(RULE, v2);
    await line(sid, 'After the first deploy');
    await gap(sid);
    deploy(v2, v3);
    await line(sid, 'After the second deploy');
    await gap(sid);
    const other = wording(OTHER, 'Another rule\'s sentence in new words, from a third deploy.');
    deploy(OTHER, other);
    const out = await line(sid, 'After the third deploy');
    expect(out).toContain('Added or reworded: Another rule\'s sentence in new words, from a third deploy.');
    expect(out).not.toContain(other);
  });
});
