/**
 * The budget of a changed-instructions notice (2026-11-20, the org reflection: 65 notices, about
 * 600K characters, in one night across 94 tasks).
 *
 * Three members of one class, each pinned for every line and block the instructions have:
 * - a notice is never mostly what the session already holds: a long line reworded (the Threads
 *   rules were one 6 KB line, sent whole four times that night for one sentence each) is told as the
 *   sentences that changed in it. Every long line of every role's instructions is enumerated from
 *   the source, so a new one is covered the day it is added;
 * - a session gets at most one notice in NOTICE_GAP_MS on one prompt and boundary, whatever changed
 *   (the user's profile, a role's instructions, the Threads rules, Walnut's own wording);
 * - a notice never starts a turn: it rides a message that would reach the session anyway, never a
 *   line of Walnut's notes that ask nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-instruction-budget'));
import { USER_FILE, WALNUT_HOME } from '../../../src/constants.js';
import { addTask } from '../../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../../src/core/session-tracker.js';
import { markProcessing, removeProcessed, resetCache, sendMessageToSession } from '../../../src/core/session-message-queue.js';
import { NOTICE_GAP_MS } from '../../../src/core/sessions/instruction-notice.js';
import {
  CHANGE_LABELS, LONG_LINE_CHARS, dueChanges, parseInstructions, renderDue, sentencesOf,
} from '../../../src/core/sessions/instruction-diff.js';
import { buildSessionContext, defaultInstructions, type InstructionTask } from '../../../src/core/sessions/session-context.js';
import { refreshUserProfile } from '../../../src/core/sessions/user-profile-context.js';
import { editOrgNode } from '../../../src/core/org/org-node-edit.js';
import { buildWalnutMessage } from '../../../src/core/peers/walnut-message-tag.js';
import { TEAM_CHARTER } from '../../../src/core/team-charter.js';

const NOTICE = 'Walnut changed your default instructions';
const OLD_SENTENCE = 'This older sentence said the rule another way and is gone from it now.';

async function writeUser(rules: string[]) {
  await fs.mkdir(path.dirname(USER_FILE), { recursive: true });
  await fs.writeFile(USER_FILE, `---\nname: User Profile\n---\n\n## Standing rules\n${rules.map((r) => `- ${r}`).join('\n')}\n`);
  await new Promise((r) => setTimeout(r, 15));
  await refreshUserProfile();
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
  await writeUser(Array.from({ length: 12 }, (_, i) => `Standing rule ${i + 1}, kept as it is across every save.`));
});

/**
 * How much of a notice's rules the session already holds in `held`, by characters: every sentence
 * of a rule line counts, Walnut's framing (headings, labels, a block's head, the line naming which
 * line changed, a removed line's name) does not, since it says what changed rather than restating it.
 */
export function heldShare(body: string, held: string): { held: number; total: number } {
  const framing = (l: string) => !l.trim() || l.startsWith('#') || (CHANGE_LABELS as readonly string[]).includes(l)
    || l.startsWith('In your line that starts ') || l.startsWith('Taken out: ') || / is below, up to the next blank line, as version v/.test(l)
    || /^- .*\(under "/.test(l) || l.startsWith('A part of your instructions (');
  let total = 0;
  let kept = 0;
  for (const raw of body.split('\n')) {
    if (framing(raw)) continue;
    const line = raw.replace(/^Added or reworded: /, '');
    for (const s of sentencesOf(line)) {
      total += s.length;
      if (held.includes(s)) kept += s.length;
    }
  }
  return { held: kept, total };
}

const ROLES: Array<[string, InstructionTask]> = [
  ['worker', { id: 'w', project: 'marina' }],
  ['worker with Threads on', { id: 't', project: 'marina', threads_on: true }],
  ['ask', { id: 'a', project: 'Ask Walnut', walnut_agent: true }],
  ['lead', { id: 'l', project: 'marina', org_role: 'lead' }],
  ['main', { id: 'm', project: 'Ask Walnut', walnut_agent: true, org_role: 'main' }],
];

/** Every line of `text` long enough to be told by its sentences, with at least three of them. */
const longLines = (text: string) => [...new Set(text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length >= LONG_LINE_CHARS && sentencesOf(l).length >= 3))];

/** The prompt a session would hold had `line` said its middle sentence the old way, in an older version of its block. */
function olderPrompt(text: string, line: string): { prompt: string; changed: string } {
  const sentences = sentencesOf(line);
  const mid = Math.floor(sentences.length / 2);
  const old = line.replace(sentences[mid], OLD_SENTENCE);
  // A block's version changes with its words: every head naming the block's version names an older one.
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trimEnd() === line);
  let head = at - 1;
  while (head >= 0 && lines[head].trim() && !/This version \(v[0-9a-f]{8}\)/.test(lines[head])) head--;
  if (head >= 0 && lines[head].trim()) {
    const version = /This version \((v[0-9a-f]{8})\)/.exec(lines[head])![1];
    lines[head] = lines[head].split(version).join('v0000aaaa');
  }
  lines[at] = old;
  return { prompt: lines.join('\n'), changed: sentences[mid] };
}

describe('a notice is never mostly what the session already holds', () => {
  for (const [label, task] of ROLES) {
    const text = defaultInstructions(task);
    const lines = longLines(text);
    it(`${label}: its instructions have long lines to check`, () => {
      // The Threads rules and the charter's longer rules at least: a fixture that lost them proves nothing.
      expect(lines.length).toBeGreaterThan(0);
    });
    it.each(lines.map((l) => [l.slice(0, 70), l]))(`${label}: one sentence changed in "%s..." is told as that sentence`, (_name, line) => {
      const { prompt, changed } = olderPrompt(text, line);
      const due = dueChanges(parseInstructions(text), parseInstructions(prompt), new Set(), {});
      expect(due).not.toBeNull();
      const body = renderDue(due!);
      expect(body).toContain(changed);
      // The changed sentence, plus Walnut's framing of it (a block's head, the line it sits in, the old sentence's name).
      expect(body.length).toBeLessThanOrEqual(changed.length + 1_000);
      const share = heldShare(body, prompt);
      expect(share.held * 2, `${share.held} of ${share.total} characters already held`).toBeLessThan(share.total);
    });
  }
});

describe('a long rule told in full, then reworded again', () => {
  const task: InstructionTask = { id: 'w', project: 'marina' };
  const text = defaultInstructions(task);
  const line = longLines(text).find((l) => sentencesOf(l).length >= 4)!;
  const s = sentencesOf(line);
  // Its spawn prompt had v1; a notice told it v2 in full; now it reads `line` (v3).
  const v1 = line.replace(s[1], 'The first wording of this sentence, long since changed.');
  const v2 = line.replace(s[1], 'The second wording of this sentence, which a notice told in full.').replace(s[2], `${s[2]} A sentence only the second version had.`);
  const prompt = text.split('\n').map((l) => (l.trimEnd() === line ? v1 : l)).join('\n');

  it('is told against the wording the session was told, not its prompt\'s: only what changed since, and what it no longer says', () => {
    const due = dueChanges(parseInstructions(text), parseInstructions(prompt), new Set(), {}, {}, [v2])!;
    const body = renderDue(due);
    expect(body).toContain(`Added or reworded: ${s[1]}`);
    expect(body).toContain('Taken out: "The second wording of this sentence, which a notice told in full."');
    expect(body).toContain('Taken out: "A sentence only the second version had."');
    expect(body).not.toContain('first wording');
    expect(body.length).toBeLessThan(line.length);
  });

  it('a told line the record cannot name (told before full words were kept): its rewording goes whole, never against the prompt (review F1)', () => {
    const told = new Set([createHash('sha256').update(v2).digest('hex').slice(0, 16)]);
    const body = renderDue(dueChanges(parseInstructions(text), parseInstructions(prompt), told, {}, {}, [])!);
    expect(body).toContain(line);
    expect(body).not.toContain('Taken out');
  });

  it('several told wordings of one rule: the newest is the base, even when an older one reads closer (review F2)', () => {
    // v2 rewrote the rule wholesale and went whole; then v3 came back close to v1.
    const big = sentencesOf(line).map((x, i) => (i === 0 ? x : `A wholly new sentence number ${i} of the big rewrite, kept for its words.`)).join(' ');
    const body = renderDue(dueChanges(parseInstructions(text), parseInstructions(prompt), new Set(), {}, {}, [big, v1])!);
    // Against `big` the change is about the whole line: told whole, never as v1's sentences.
    expect(body).not.toContain('The first wording of this sentence');
    expect(body).toContain(line);
  });

  it('a rule changed back to its prompt\'s wording after the session was told another is told again (review F3)', () => {
    const now = prompt;
    const due = dueChanges(parseInstructions(now), parseInstructions(prompt), new Set(), {}, {}, [v2])!;
    expect(due).not.toBeNull();
    const body = renderDue(due);
    expect(body).toContain('Added or reworded: The first wording of this sentence, long since changed.');
    expect(body).toContain('Taken out: "A sentence only the second version had."');
  });

  it('with no told wording it is told against the prompt\'s', () => {
    const body = renderDue(dueChanges(parseInstructions(text), parseInstructions(prompt), new Set(), {})!);
    expect(body).toContain(`Added or reworded: ${s[1]}`);
    expect(body).toContain('Taken out: "The first wording of this sentence, long since changed."');
  });
});

describe('one notice per session in the gap, whatever changed', () => {
  const RELAY = TEAM_CHARTER.split('\n').find((l) => l.startsWith("- When you pass on the user's request"))!;
  const OTHER = TEAM_CHARTER.split('\n').find((l) => l.startsWith('- ') && l !== RELAY && l.length > 40)!;

  /** A session spawned before RELAY and OTHER were in its instructions. */
  async function seed(task: Awaited<ReturnType<typeof addTask>>['task']) {
    const sid = randomUUID();
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
    const current = (await buildSessionContext(task.id)).systemPrompt;
    const gone = new Set([RELAY.trim(), OTHER.trim()]);
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: current.split('\n').filter((l) => !gone.has(l.trim())).join('\n') });
    return sid;
  }
  /** One line into the session, as the CLI takes it. */
  async function line(sid: string, text: string): Promise<string> {
    await sendMessageToSession(sid, text);
    const batch = await markProcessing(sid);
    await removeProcessed(sid, batch.map((r) => r.id));
    return batch.map((r) => r.message).join('\n\n');
  }
  /** Time passes: the last notice was told `ms` earlier. */
  async function later(sid: string, ms: number) {
    const noted = (await getSessionByClaudeId(sid))!.taskRoutingNoted!;
    await updateSessionRecord(sid, { taskRoutingNoted: { ...noted, toldAt: new Date(Date.parse(noted.toldAt!) - ms).toISOString() } });
  }
  /** The session's record forgets it was told `text`: as a deploy that rewords that rule looks to it. */
  async function reworded(sid: string, text: string) {
    const noted = (await getSessionByClaudeId(sid))!.taskRoutingNoted!;
    const h = createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
    await updateSessionRecord(sid, { taskRoutingNoted: { ...noted, lines: (noted.lines ?? []).filter((l) => l !== h) } });
  }
  /** The session holds an older version of a block (a save of it after it was told). */
  async function blockMoved(sid: string, id: string) {
    const record = (await getSessionByClaudeId(sid))!;
    const noted = record.taskRoutingNoted!;
    const block = noted.blocks?.[id] ?? parseInstructions(record.appliedAppendSystemPrompt!).blocks.get(id);
    if (!block) return false;
    const older = { version: 'v0000aaaa', words: [...block.words, 'A line the older version had.'], form: block.form };
    await updateSessionRecord(sid, { taskRoutingNoted: { ...noted, blocks: { ...noted.blocks, [id]: older } } });
    return true;
  }

  it('a lead: its profile, its role\'s instructions and Walnut\'s wording, changed within the gap, go out as one notice after it', async () => {
    const { task } = await addTask({ title: 'Lead', project: 'marina', org_role: 'lead' });
    const sid = await seed(task);
    const seen: string[] = [await line(sid, 'First')];
    expect(seen[0]).toContain(NOTICE);
    // Within the next three hours: a USER.md save, an edit of the role's instructions, a reworded charter rule.
    await later(sid, 20 * 60_000);
    await writeUser(['A rule the user gave while the session ran.']);
    seen.push(await line(sid, 'After the profile save'));
    await later(sid, 40 * 60_000);
    await editOrgNode(task.id, { instructions: 'Ship weekly.' });
    seen.push(await line(sid, 'After the edit'));
    await later(sid, 60 * 60_000);
    await reworded(sid, OTHER);
    seen.push(await line(sid, 'After the deploy'));
    expect(seen.slice(1).filter((l) => l.includes(NOTICE))).toEqual([]);
    // Past the gap: one notice holds all of them.
    await later(sid, NOTICE_GAP_MS);
    const merged = await line(sid, 'After the gap');
    expect(merged.split(NOTICE).length - 1).toBe(1);
    expect(merged).toContain('A rule the user gave while the session ran.');
    expect(merged).toContain('Ship weekly.');
    expect(merged).toContain(OTHER);
    expect(await line(sid, 'Next')).not.toContain(NOTICE);
  });

  it('the record keeps the full words of a long rule it told, for the next rewording of it', async () => {
    const LONG = TEAM_CHARTER.split('\n').find((l) => l.length >= LONG_LINE_CHARS && sentencesOf(l).length >= 3)!;
    const { task } = await addTask({ title: 'Worker', project: 'marina' });
    const sid = randomUUID();
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
    const current = (await buildSessionContext(task.id)).systemPrompt;
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: current.split('\n').filter((l) => l.trim() !== LONG.trim()).join('\n') });
    expect(await line(sid, 'First')).toContain(LONG);
    const noted = (await getSessionByClaudeId(sid))!.taskRoutingNoted!;
    expect(noted.texts).toContain(LONG);
    // A deploy rewords one of its sentences: the record holds the old words, the new line is not told yet.
    const sentence = sentencesOf(LONG)[1];
    const older = LONG.replace(sentence, 'The way this sentence read before the deploy.');
    const h = createHash('sha256').update(LONG.trim()).digest('hex').slice(0, 16);
    await updateSessionRecord(sid, { taskRoutingNoted: { ...noted, texts: [older], lines: (noted.lines ?? []).filter((l) => l !== h) } });
    await later(sid, NOTICE_GAP_MS + 60_000);
    const out = await line(sid, 'After the gap');
    expect(out).toContain(`Added or reworded: ${sentence}`);
    expect(out).not.toContain(LONG);
    expect((await getSessionByClaudeId(sid))!.taskRoutingNoted!.texts).toEqual([LONG]);
  });

  it('a worker with Threads on: a change of its Threads rules within the gap waits too', async () => {
    const { task } = await addTask({ title: 'Worker', project: 'marina' });
    await (await import('../../../src/core/task-manager.js')).updateTask(task.id, { threads_on: true } as never);
    const sid = await seed(task);
    expect(await line(sid, 'First')).toContain(NOTICE);
    // The record holds the Threads block now; a later save of its rules moves the version.
    expect(await blockMoved(sid, 'task-threads')).toBe(true);
    await later(sid, 30 * 60_000);
    expect(await line(sid, 'Inside the gap')).not.toContain(NOTICE);
    await later(sid, NOTICE_GAP_MS);
    expect(await line(sid, 'After the gap')).toContain(NOTICE);
  });
});

describe('a notice never starts a turn of its own', () => {
  it('Walnut\'s notes that ask nothing reach no session with it; the next real message carries it', async () => {
    const { task } = await addTask({ title: 'Worker', project: 'marina' });
    const sid = randomUUID();
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
    const RELAY = TEAM_CHARTER.split('\n').find((l) => l.startsWith("- When you pass on the user's request"))!;
    const current = (await buildSessionContext(task.id)).systemPrompt;
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: current.split('\n').filter((l) => l.trim() !== RELAY.trim()).join('\n') });
    const status = buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'status', note: 'status changes of tasks you follow, not a work request' }, body: 'A task you follow moved.' });
    for (const outcome of ['status', 'stopped', 'waiting', 'org-update']) {
      const note = outcome === 'status' ? status : buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome }, body: `A ${outcome} note.` });
      await sendMessageToSession(sid, note, { source: 'walnut-notify' });
      const batch = await markProcessing(sid);
      // Held for the next message (wake-policy.ts), or at most its own line: never with the notice.
      for (const row of batch) expect(row.message).not.toContain(NOTICE);
      await removeProcessed(sid, batch.map((r) => r.id));
    }
    const out = await (async () => {
      await sendMessageToSession(sid, 'Please look at the build.');
      const batch = await markProcessing(sid);
      await removeProcessed(sid, batch.map((r) => r.id));
      return batch.map((r) => r.message).join('\n\n');
    })();
    expect(out.split(NOTICE).length - 1).toBe(1);
    expect(out).toContain('Please look at the build.');
  });
});
