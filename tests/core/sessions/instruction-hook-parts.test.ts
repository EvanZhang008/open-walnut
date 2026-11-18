/**
 * The changed default instructions are restated right after a compaction, in hooks of their own,
 * before the session's next model call (2026-11-18: a worker on an old prompt ran 74 s with none of
 * its rules after a compaction mid-turn, while the restatement waited for its next message). Only a
 * restatement no hooks could carry still waits for the next message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-instruction-hook-parts'));
import { WALNUT_HOME } from '../../../src/constants.js';
import { addTask } from '../../../src/core/task-manager.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../../src/core/session-tracker.js';
import { TEAM_CHARTER } from '../../../src/core/team-charter.js';
import { WALNUT_PROMPT_MARK, defaultInstructions } from '../../../src/core/sessions/session-context.js';
import { enqueueMessage, markProcessing, removeProcessed, resetCache } from '../../../src/core/session-message-queue.js';
import { HOOK_CONTEXT_MAX, collectOpenItems } from '../../../src/core/sessions/open-items.js';
import { notePlaceCompaction } from '../../../src/core/sessions/place-notice.js';
import { INSTRUCTION_HOOK_PARTS, _resetPartsServed, notePartServed, splitAtLines } from '../../../src/core/sessions/instruction-hook-parts.js';
import { compactOpenItemsHooks } from '../../../src/providers/compact-open-items-hook.js';
import { getOp } from '../../../src/ops/index.js';

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
  _resetPartsServed();
});

const RELAY = TEAM_CHARTER.split('\n').find((l) => l.startsWith("- When you pass on the user's request"))!;
const NOTICE = 'Walnut changed your default instructions';

/** A worker's session from long ago: its prompt holds only Walnut's identity line, so every rule is due. */
async function oldSession(role?: 'lead') {
  const { task } = await addTask({ title: 'Worker', project: 'marina', ...(role ? { org_role: role } : {}) });
  const keep = defaultInstructions(task).split('\n').find((l) => l.includes(WALNUT_PROMPT_MARK)) ?? WALNUT_PROMPT_MARK;
  const sid = randomUUID();
  await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
  await updateSessionRecord(sid, { appliedAppendSystemPrompt: keep });
  return { sid, task };
}
async function line(sid: string, text: string): Promise<string> {
  await enqueueMessage(sid, text);
  const batch = await markProcessing(sid);
  await removeProcessed(sid, batch.map((r) => r.id));
  return batch.map((r) => r.message).join('\n\n');
}
const part = (sid: string, i: number, of = INSTRUCTION_HOOK_PARTS) => collectOpenItems(sid, Date.now(), { afterCompaction: true, part: i, of });
const bodyOf = (text: string) => text.replace(/^<walnut-message[^>]*>\n?/, '').replace(/\n?<\/walnut-message>$/, '').replace(/^Walnut restates[^\n]*\n\n/, '');

describe('splitAtLines', () => {
  it('keeps every line, in order, each chunk within its room, cut at a line end', () => {
    const body = Array.from({ length: 300 }, (_, i) => (i % 20 === 19 ? '' : `- Rule line ${i}: a sentence of a real length for a rule.`)).join('\n');
    const chunks = splitAtLines(body, 2_000);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2_000);
    expect(chunks.join('\n').replace(/\n+/g, '\n')).toBe(body.trim().replace(/\n+/g, '\n'));
    for (const c of chunks) expect(c).not.toMatch(/^\s|\s$/);
    expect(splitAtLines('short', 100)).toEqual(['short']);
  });

  it('keeps a nested line\'s indent, and cuts a line longer than the room at a space, never mid-word', () => {
    const body = ['- A rule of its own here.', ...Array.from({ length: 4 }, (_, i) => `  - nested point ${i} under it`)].join('\n');
    const chunks = splitAtLines(body, 60);
    expect(chunks.join('\n')).toBe(body);
    expect(chunks.slice(1).some((c) => c.startsWith('  - nested'))).toBe(true);
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const cut = splitAtLines(long, 50);
    for (const c of cut) expect(c.length).toBeLessThanOrEqual(50);
    expect(cut.join(' ')).toBe(long);
  });
});

describe('a part opens with the headings and labels its lines sit under', () => {
  // The shape renderDue gives: a heading, then items split by blank lines; an item is a head line, list
  // labels and tagged lines, with no blank line inside.
  const removed = Array.from({ length: 60 }, (_, i) => `- [v1] Removed rule number ${i}, which no longer holds at all.`);
  const body = [
    '## How we work', '',
    'Your user\'s profile (v1 to v2). Only what changed is below, tagged [v2].',
    'New:', '[v2] ## Standing rules', '[v2] - A new rule that holds now.',
    'Removed, no longer in force:', ...removed, '',
    '- A plain rule after the block, under the same heading.',
  ].join('\n');

  it('a list cut in two keeps its label, its item and its heading in the next part', () => {
    const chunks = splitAtLines(body, 1_500);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks.slice(1)) {
      expect(c.startsWith('## How we work\n')).toBe(true);
      expect(c.length).toBeLessThanOrEqual(1_500);
      if (c.includes('Removed rule number')) {
        expect(c).toContain('(Continued from the part before) Your user\'s profile');
        // The label right above the first removed line it holds, never the "New:" sub-heading.
        const lines = c.split('\n');
        const first = lines.findIndex((l) => l.includes('Removed rule number'));
        expect(lines[first - 1]).toBe('Removed, no longer in force:');
        expect(lines.slice(0, first)).not.toContain('[v2] ## Standing rules');
      }
    }
    // The plain rule after the block never reads under the block's "Removed" label.
    const last = chunks.find((c) => c.includes('- A plain rule after the block'))!;
    const tail = last.slice(0, last.indexOf('- A plain rule after the block'));
    if (!tail.includes('Removed rule number')) expect(tail).not.toContain('Removed, no longer in force:');
    // Every line of the body is in some part, in order.
    const given = chunks.flatMap((c) => c.split('\n')).filter((l) => removed.includes(l));
    expect(given).toEqual(removed);
  });

  it('a block right after a plain rule (renderDue puts no blank line between them) keeps its Removed label', () => {
    const shaped = ['## How we work', '', '- A changed plain rule.',
      'A part of your instructions (v1) is gone; none of its lines apply any more:', ...removed].join('\n');
    for (const c of splitAtLines(shaped, 1_200).slice(1)) {
      expect(c).toContain('(Continued from the part before) A part of your instructions (v1) is gone');
      expect(c).not.toContain('A changed plain rule');
    }
  });

  it('a lead\'s author line survives a tagged rule that ends in a colon', () => {
    const lead = ['Your lead\'s instructions (v2):', '[v2] Added by Lead Alice:', '[v2] When you start a task:',
      ...Array.from({ length: 50 }, (_, i) => `[v2] - Lead rule ${i} of a real length for one line here.`)].join('\n');
    for (const c of splitAtLines(lead, 1_000).slice(1)) expect(c.split('\n').slice(0, 2)).toEqual(['(Continued from the part before) Your lead\'s instructions (v2):', '[v2] Added by Lead Alice:']);
  });

  it('a run of plain rules repeats only its heading, never its first rule', () => {
    const plain = ['## Tasks', '', ...Array.from({ length: 80 }, (_, i) => `- Plain rule ${i} of a real length for one rule line.`)].join('\n');
    const chunks = splitAtLines(plain, 1_200);
    for (const c of chunks.slice(1)) {
      expect(c.split('\n')[0]).toBe('## Tasks');
      expect(c).not.toContain('Continued');
    }
  });
});

describe('the parts of one compaction count together, never with another one\'s', () => {
  it('a fork\'s round of parts and the real compaction\'s are two rounds: three of one and one of the other make no set', () => {
    const t0 = 1_000_000;
    expect(notePartServed('s', 'k', 1, 4, t0)).toBe(false);
    expect(notePartServed('s', 'k', 2, 4, t0 + 1)).toBe(false);
    expect(notePartServed('s', 'k', 3, 4, t0 + 2)).toBe(false);
    // The real compaction minutes later: its part 4 alone completes nothing.
    expect(notePartServed('s', 'k', 4, 4, t0 + 5 * 60_000)).toBe(false);
    for (const i of [1, 2, 3]) expect(notePartServed('s', 'k', i, 4, t0 + 5 * 60_000 + i)).toBe(i === 3);
  });

  it('a second compaction soon after a complete one is told again, as its own round', () => {
    const t0 = 2_000_000;
    expect(notePartServed('s', 'k', 1, 2, t0)).toBe(false);
    expect(notePartServed('s', 'k', 2, 2, t0)).toBe(true);
    expect(notePartServed('s', 'k', 2, 2, t0 + 120_000)).toBe(false);
    expect(notePartServed('s', 'k', 1, 2, t0 + 120_001)).toBe(true);
  });

  it('two sessions with the same restatement never share a round', () => {
    expect(notePartServed('a', 'k', 1, 2)).toBe(false);
    expect(notePartServed('b', 'k', 2, 2)).toBe(false);
  });
});

describe('a long restatement rides the hooks of its own, right after the compaction', () => {
  it('the main hook leaves it out and says so; each part names itself and fits; all of them hold every rule', async () => {
    const { sid } = await oldSession();
    const main = await collectOpenItems(sid, Date.now(), { afterCompaction: true, parts: INSTRUCTION_HOOK_PARTS });
    expect(main.text).not.toContain(NOTICE);
    expect(main.text).not.toContain(RELAY);
    expect(main.text).toMatch(/restates your changed default instructions right beside this, in \d parts? of their own/);
    expect(main.text).not.toContain('front of your next message');
    const parts = await Promise.all(Array.from({ length: INSTRUCTION_HOOK_PARTS }, (_, i) => part(sid, i + 1)));
    const given = parts.filter((p) => p.text);
    const n = given.length;
    expect(n).toBeGreaterThan(1);
    given.forEach((p, i) => {
      expect(p.text.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX);
      expect(p.instructionPart).toEqual({ part: i + 1, of: n });
      expect(p.text).toContain(`part ${i + 1} of ${n}`);
      // A later part opens under the heading its lines sit under.
      if (i > 0) expect(bodyOf(p.text)).toMatch(/^(#|\(Continued from the part before\))/);
    });
    // A part past the restatement's own count gives nothing.
    expect(parts.slice(n).every((p) => !p.text)).toBe(true);
    const all = given.map((p) => bodyOf(p.text)).join('\n');
    expect(all).toContain(RELAY);
    // The rules it holds are the ones the next message would have carried, none left out.
    const before = await line((await oldSession()).sid, 'probe');
    for (const rule of before.split('\n').filter((l) => l.startsWith('- ') && l.length > 30)) expect(all).toContain(rule);
  });

  it('counts as told once every part reached the session, in any order: the next message carries none', async () => {
    const { sid } = await oldSession();
    const n = (await part(sid, INSTRUCTION_HOOK_PARTS)).instructionPart!.of;
    // The last part first, the first part last, and all at once.
    await part(sid, n);
    await Promise.all(Array.from({ length: n - 2 }, (_, i) => part(sid, i + 2)));
    expect((await getSessionByClaudeId(sid))!.taskRoutingNoted).toBeUndefined();
    await part(sid, 1);
    expect((await getSessionByClaudeId(sid))!.taskRoutingNoted?.byHookAt).toBeTruthy();
    await notePlaceCompaction(sid, 'c1');
    expect(await line(sid, 'After the compaction')).toBe('After the compaction');
  });

  it('a part that never came (an older walnut on the host) leaves it due: the next message carries it whole', async () => {
    const { sid } = await oldSession();
    const n = (await part(sid, 1)).instructionPart!.of;
    for (let i = 2; i < n; i++) await part(sid, i);
    expect((await getSessionByClaudeId(sid))!.taskRoutingNoted).toBeUndefined();
    await notePlaceCompaction(sid, 'c1');
    expect(await line(sid, 'After')).toContain(RELAY);
  });

  it('longer than all the hooks together: the hooks give what they hold, and the next message carries it whole', async () => {
    const { sid } = await oldSession();
    const main = await collectOpenItems(sid, Date.now(), { afterCompaction: true, parts: 1 });
    expect(main.text).toContain('come in full in front of your next message too');
    expect((await part(sid, 1, 1)).text).toContain('part 1 of');
    expect((await part(sid, 2, 1)).text).toBe('');
    expect((await getSessionByClaudeId(sid))!.taskRoutingNoted).toBeUndefined();
    await notePlaceCompaction(sid, 'c1');
    expect(await line(sid, 'After')).toContain(RELAY);
  });

  it('a lead\'s core instructions still lead the main hook; the changed rules go to the parts', async () => {
    const { sid } = await oldSession('lead');
    const main = await collectOpenItems(sid, Date.now(), { afterCompaction: true, parts: INSTRUCTION_HOOK_PARTS });
    expect(main.text.startsWith('Restated after the compaction, first because they are your role\'s first rules.')).toBe(true);
    expect(main.text).not.toContain(RELAY);
    expect(main.text.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX);
  });

  it('without part hooks (a session spawned before them) the main hook works as before', async () => {
    const { sid } = await oldSession();
    const main = await collectOpenItems(sid, Date.now(), { afterCompaction: true });
    expect(main.text).toContain('come in full in front of your next message');
  });
});

describe('the hooks and the op agree', () => {
  const op = getOp('open_items')!;
  const args = (command: string) => JSON.parse(/open_items '(\{[^']*\})'/.exec(command)![1]) as Record<string, unknown>;

  it('every compaction hook\'s arguments are ones open_items takes, and the main hook falls back to the old call', () => {
    const groups = (compactOpenItemsHooks({})!.SessionStart as Array<{ matcher: string; hooks: Array<{ command: string }> }>);
    const commands = groups.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toHaveLength(1 + INSTRUCTION_HOOK_PARTS);
    for (const c of commands) expect(z.object(op.input).strict().safeParse(args(c)).success, c).toBe(true);
    expect(commands[0]).toMatch(/"parts":4\}' 2>\/dev\/null \|\| walnut tools call open_items '\{"hook":"compact"\}' 2>\/dev\/null \|\| true$/);
    expect(commands.slice(1).map((c) => args(c).part)).toEqual(Array.from({ length: INSTRUCTION_HOOK_PARTS }, (_, i) => i + 1));
  });

  it('a part hook prints only the part the server names: an older server\'s whole readback prints nothing', () => {
    const map = (body: unknown, a: Record<string, unknown>) => op.mapResult!({ body, args: a } as never);
    expect(map({ text: 'the whole readback' }, { hook: 'compact', part: 2, of: 4 })).toEqual({});
    expect(map({ text: 'part two', instructionPart: { part: 2, of: 3 } }, { hook: 'compact', part: 2, of: 4 }))
      .toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'part two' } });
    expect(map({ text: '', instructionPart: { part: 4, of: 3 } }, { hook: 'compact', part: 4, of: 4 })).toEqual({});
  });
});
