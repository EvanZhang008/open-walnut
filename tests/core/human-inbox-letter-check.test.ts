/**
 * The rules of a new letter, shared by the store and the daemon's offline host
 * (src/core/human-inbox/letter-check.ts), and the store's options for a letter a host
 * saved while the server was away (sendLetterOnce: the host's id, the time it was
 * written, and the journal op that makes a second drain of it send nothing).
 *
 * WALNUT_HOME is redirected to an isolated tmpdir via createMockConstants.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());
// A per-run letter budget that is spent: a redrain of a letter already sent must not reach it.
const triage = vi.hoisted(() => ({ refuse: false, calls: 0 }));
vi.mock('../../src/core/human-inbox/triage-quota.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/human-inbox/triage-quota.js')>()),
  guardTriageLetter: vi.fn(async () => {
    triage.calls++;
    if (triage.refuse) throw new Error('the run budget is spent (injected)');
    return undefined;
  }),
}));

import { bus, type BusEvent } from '../../src/core/event-bus.js';
import { createLetterCheck } from '../../src/core/human-inbox/letter-check.js';
import {
  findLetterByOp,
  getLetter,
  humanInboxPaths,
  listLetters,
  sendLetter,
  sendLetterOnce,
  setPinned,
  setRead,
} from '../../src/core/human-inbox/store.js';
import { sendLetterAsCallerOnce } from '../../src/core/human-inbox/letter-ops.js';
import { LETTER_ID_RE } from '../../src/core/human-inbox/normalize.js';
import {
  LETTER_BODY_MAX_BYTES,
  LETTER_HTML_MAX_BYTES,
  LETTER_TYPES,
  letterFieldMaxBytes,
  type LetterSender,
  type NewLetter,
} from '../../src/core/human-inbox/types.js';
import { getOp, parseOpArgs } from '../../src/ops/index.js';

const SENDER: LetterSender = { sessionId: 'sess-marina-1', host: 'devbox', taskId: 'task-7', taskTitle: 'Marina page', project: 'Acme' };
const letter = (over: Partial<NewLetter> = {}): NewLetter => ({ subject: 'Pick a layout', type: 'review', markdown: 'Two layouts, see below.', sender: SENDER, ...over });

describe('letter-check: one set of rules for the store and the host', () => {
  const check = createLetterCheck();

  it('carries the caps and types of types.ts', () => {
    expect(check.TYPES).toEqual([...LETTER_TYPES]);
    expect(check.BODY_MAX_BYTES).toBe(LETTER_BODY_MAX_BYTES);
    expect(check.HTML_MAX_BYTES).toBe(LETTER_HTML_MAX_BYTES);
    for (const f of ['html', 'markdown', 'text', 'subject']) expect(check.maxBytes(f)).toBe(letterFieldMaxBytes(f));
  });

  it('names exactly the inputs of human_inbox_send', () => {
    const op = getOp('human_inbox_send');
    expect(op).toBeDefined();
    expect([...check.OP_INPUTS].sort()).toEqual(Object.keys(op!.input).sort());
  });

  const MATRIX: Array<[string, Record<string, unknown>]> = [
    ['plain markdown', { subject: 's', type: 'info', markdown: 'm' }],
    ['every field', { subject: 's', type: 'action_required', markdown: 'm', text: 't', actions: [{ id: 'a', label: 'A', description: 'd' }], task_refs: ['t1'], pin: true }],
    ['html body', { subject: 's', type: 'completion', html: '<p>x</p>' }],
    ['an unknown key', { subject: 's', type: 'info', markdown: 'm', foo: 1 }],
    ['html_ref (a route field, not an op input)', { subject: 's', type: 'info', html_ref: 'ref-1' }],
    ['no subject', { type: 'info', markdown: 'm' }],
    ['empty subject', { subject: '', type: 'info', markdown: 'm' }],
    ['a number subject', { subject: 5, type: 'info', markdown: 'm' }],
    ['an unknown type', { subject: 's', type: 'urgent', markdown: 'm' }],
    ['a number body', { subject: 's', type: 'info', markdown: 5 }],
    ['a null html', { subject: 's', type: 'info', markdown: 'm', html: null }],
    ['a number text', { subject: 's', type: 'info', markdown: 'm', text: 5 }],
    ['a string pin', { subject: 's', type: 'info', markdown: 'm', pin: 'yes' }],
    ['task_refs not an array', { subject: 's', type: 'info', markdown: 'm', task_refs: 't1' }],
    ['task_refs of numbers', { subject: 's', type: 'info', markdown: 'm', task_refs: [1] }],
    ['no actions in the list', { subject: 's', type: 'action_required', markdown: 'm', actions: [] }],
    ['actions not a list', { subject: 's', type: 'action_required', markdown: 'm', actions: 'a' }],
    ['an empty action id', { subject: 's', type: 'action_required', markdown: 'm', actions: [{ id: '', label: 'A' }] }],
    ['an action with no label', { subject: 's', type: 'action_required', markdown: 'm', actions: [{ id: 'a' }] }],
    ['an action with an unknown key', { subject: 's', type: 'action_required', markdown: 'm', actions: [{ id: 'a', label: 'A', url: 'x' }] }],
    ['a number action description', { subject: 's', type: 'action_required', markdown: 'm', actions: [{ id: 'a', label: 'A', description: 5 }] }],
    ['a null action', { subject: 's', type: 'action_required', markdown: 'm', actions: [null] }],
    ['a list as an action', { subject: 's', type: 'action_required', markdown: 'm', actions: [[]] }],
  ];

  it.each(MATRIX)('opArgs agrees with the op\'s own parse: %s', (_label, args) => {
    const parsed = parseOpArgs(getOp('human_inbox_send')!, args);
    const mine = check.opArgs(args);
    expect(mine === null).toBe(parsed.ok);
    if (mine) expect(mine).toMatch(/^Invalid arguments for human_inbox_send: /);
  });

  it('the shape check refuses what the store refuses, in the store\'s words', () => {
    expect(check.shape({ subject: ' ', type: 'info', markdown: 'm' })).toEqual({ ok: false, message: 'subject is required' });
    expect(check.shape({ subject: 's', type: 'info', markdown: 'm', html: '<p>x</p>' })).toEqual({ ok: false, message: 'exactly one of html | html_ref | markdown is required' });
    expect(check.shape({ subject: 's', type: 'action_required', markdown: 'm' })).toMatchObject({ ok: false, message: expect.stringMatching(/^action_required needs at least one action/) });
    expect(check.shape({ subject: 's', type: 'info', markdown: 'm', actions: [{ id: 'a', label: 'A' }] })).toEqual({ ok: false, message: 'actions are only allowed when type is action_required' });
    expect(check.shape({ subject: 's', type: 'action_required', markdown: 'm', actions: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] })).toEqual({ ok: false, message: 'action ids must be unique' });
    expect(check.shape({ subject: 's', type: 'action_required', markdown: 'm', actions: Array.from({ length: 13 }, (_, i) => ({ id: `a${i}`, label: 'x' })) })).toMatchObject({ ok: false, message: expect.stringMatching(/^at most 12 actions/) });
    expect(check.shape({ subject: ' Hi ', type: 'info', html: '<p>x</p>' })).toEqual({ ok: true, shape: { subject: 'Hi', lane: 'html', format: 'html' } });
    expect(check.shape({ subject: 'Hi', type: 'info', html_ref: 'r1' })).toEqual({ ok: true, shape: { subject: 'Hi', lane: 'html_ref', format: 'html' } });
  });

  it('caps each field in bytes, html at its own cap', () => {
    expect(check.oversize({ markdown: 'x'.repeat(LETTER_BODY_MAX_BYTES), text: 'ok' })).toBeNull();
    // A multi-byte body is counted in bytes, not chars.
    expect(check.oversize({ markdown: 'é'.repeat(LETTER_BODY_MAX_BYTES / 2 + 1) })).toEqual({ name: 'markdown', bytes: LETTER_BODY_MAX_BYTES + 2, max: LETTER_BODY_MAX_BYTES });
    expect(check.oversize({ html: 'x'.repeat(LETTER_BODY_MAX_BYTES + 1) })).toBeNull();
    expect(check.oversize({ text: 'x'.repeat(LETTER_BODY_MAX_BYTES + 1) })).toMatchObject({ name: 'text' });
  });

  it('works rebuilt from its own text, the way the source daemon inlines it', () => {
    const rebuilt = new Function(`return (${createLetterCheck.toString()})`)()() as ReturnType<typeof createLetterCheck>;
    for (const [, args] of MATRIX) {
      expect(rebuilt.opArgs(args)).toBe(check.opArgs(args));
      expect(rebuilt.shape(args)).toEqual(check.shape(args));
    }
    expect(rebuilt.oversize({ markdown: 'x'.repeat(LETTER_BODY_MAX_BYTES + 1) })).toEqual(check.oversize({ markdown: 'x'.repeat(LETTER_BODY_MAX_BYTES + 1) }));
    expect(rebuilt.taskRefs(['a', 5, '', 'b'])).toEqual(['a', 'b']);
  });
});

describe('sendLetterOnce: a letter a host saved while the server was away', () => {
  const seen: BusEvent[] = [];
  beforeEach(() => {
    fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true });
    seen.length = 0;
    bus.subscribe('test-letter-once', (e) => { seen.push(e); }, { global: true });
  });
  afterEach(() => bus.unsubscribe('test-letter-once'));
  const sent = () => seen.filter((e) => e.name === 'human-inbox:letter');

  it('keeps the host\'s id and the time it was written', async () => {
    const at = Date.now() - 2 * 3_600_000;
    const r = await sendLetter(letter(), { id: 'lt-mh0abc12-a1b2c3', createdAt: at });
    expect(r).toMatchObject({ id: 'lt-mh0abc12-a1b2c3', createdAt: at });
    expect((await getLetter('lt-mh0abc12-a1b2c3'))?.body).toBe('Two layouts, see below.');
    expect(sent()).toHaveLength(1);
  });

  it('never dates a letter later than now, and mints an id for a bad or taken one', async () => {
    const before = Date.now();
    const future = await sendLetter(letter(), { createdAt: before + 86_400_000 });
    expect(future.createdAt).toBeLessThanOrEqual(Date.now());
    expect(future.createdAt).toBeGreaterThanOrEqual(before);
    const bad = await sendLetter(letter(), { id: '../etc/passwd' });
    expect(bad.id).toMatch(LETTER_ID_RE);
    expect(bad.id).not.toBe('../etc/passwd');
    const first = await sendLetter(letter(), { id: 'lt-mh0abc12-ffff01' });
    const taken = await sendLetter(letter({ subject: 'Another' }), { id: 'lt-mh0abc12-ffff01' });
    expect(first.id).toBe('lt-mh0abc12-ffff01');
    expect(taken.id).not.toBe('lt-mh0abc12-ffff01');
    expect(taken.id).toMatch(LETTER_ID_RE);
    // The first letter's body is untouched by the second.
    expect((await getLetter(first.id))?.subject).toBe('Pick a layout');
  });

  it('sends one letter per op key: a second send answers the first, no new event', async () => {
    const a = await sendLetterOnce(letter(), { id: 'lt-mh0abc12-0p0001', opKey: 'op-0123456789abcdef' });
    const b = await sendLetterOnce(letter({ subject: 'Changed' }), { id: 'lt-mh0abc12-0p0002', opKey: 'op-0123456789abcdef' });
    expect(a.duplicate).toBe(false);
    expect(b).toMatchObject({ duplicate: true, letter: { id: 'lt-mh0abc12-0p0001', subject: 'Pick a layout' } });
    expect((await listLetters()).letters.map((l) => l.id)).toEqual(['lt-mh0abc12-0p0001']);
    expect(fs.readdirSync(humanInboxPaths.bodiesDir)).toEqual(['lt-mh0abc12-0p0001.md']);
    expect(sent()).toHaveLength(1);
  });

  it('two sends of one op at once write one letter and leave no stray body', async () => {
    const [a, b] = await Promise.all([
      sendLetterOnce(letter(), { opKey: 'op-race0000000000aa' }),
      sendLetterOnce(letter(), { opKey: 'op-race0000000000aa' }),
    ]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(a.letter.id).toBe(b.letter.id);
    expect((await listLetters()).letters).toHaveLength(1);
    expect(fs.readdirSync(humanInboxPaths.bodiesDir)).toEqual([`${a.letter.id}.md`]);
    expect(sent()).toHaveLength(1);
  });

  it('the op key survives a rewrite of the index (read, pin)', async () => {
    const a = await sendLetterOnce(letter(), { opKey: 'op-keep000000000001' });
    await setRead(a.letter.id, true);
    await setPinned(a.letter.id, true);
    const raw = JSON.parse(fs.readFileSync(humanInboxPaths.indexFile, 'utf-8'));
    expect(raw.letters[0].createdByOp).toBe('op-keep000000000001');
    expect((await findLetterByOp('op-keep000000000001'))?.id).toBe(a.letter.id);
    expect((await sendLetterOnce(letter(), { opKey: 'op-keep000000000001' })).duplicate).toBe(true);
    expect((await listLetters()).letters).toHaveLength(1);
  });

  it('a plain send (no op key) is never taken for a duplicate', async () => {
    await sendLetter(letter());
    await sendLetter(letter());
    expect((await listLetters()).letters).toHaveLength(2);
    expect(await findLetterByOp('')).toBeNull();
  });

  it('sendLetterAsCallerOnce answers an op it already sent before the sender and its budget are asked', async () => {
    triage.calls = 0;
    triage.refuse = false;
    const first = await sendLetterAsCallerOnce({ subject: 'S', type: 'info', markdown: 'm' }, undefined, { opKey: 'op-caller000000001' });
    expect(first.duplicate).toBe(false);
    expect(triage.calls).toBe(1);
    // The budget is spent now: the redrain of the letter already sent is still answered.
    triage.refuse = true;
    try {
      const again = await sendLetterAsCallerOnce({ subject: 'S', type: 'info', markdown: 'm' }, undefined, { opKey: 'op-caller000000001' });
      expect(again).toMatchObject({ duplicate: true, letter: { id: first.letter.id } });
      expect(triage.calls).toBe(1);
      await expect(sendLetterAsCallerOnce({ subject: 'S', type: 'info', markdown: 'm' }, undefined, { opKey: 'op-caller000000002' })).rejects.toThrow(/budget is spent/);
    } finally {
      triage.refuse = false;
    }
    expect(sent()).toHaveLength(1);
  });
});
