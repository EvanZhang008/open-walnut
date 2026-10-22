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
import { validateNewItems } from '../../src/core/human-inbox/item-schema.js';
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
type Item = NonNullable<NewLetter['items']>[number];
const item = (id = 'mail-1', over: Partial<Item> = {}): Item => ({
  id, subject: 'Account notice', summary: 'The account needs review.',
  source: { kind: 'mail', account: 'account-1', message: `message-${id}` },
  actions: [{ id: `${id}:read`, kind: 'op', intent: 'mark_read' }], ...over,
});
const eightActions = (id: string): Item['actions'] => [
  ...(['mark_read', 'find_task', 'create_task', 'attach_task'] as const).map(intent => ({ id: `${id}:${intent}`, kind: 'op' as const, intent })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `${id}:reply-${i}`, kind: 'reply_ai' as const, label: 'Ask AI', question: 'What should I do?' })),
];
const withItems = (items: unknown, extra: Record<string, unknown> = {}) => ({ subject: 'Digest', type: 'info', markdown: 'Independent messages.', items, ...extra });
// Schema acceptance is separate from the store's cross-item and legacy-button ID checks.
type ItemCase = [name: string, args: Record<string, unknown>, schema: boolean, unique: boolean];
const ITEM_MATRIX: ItemCase[] = [
  ['typed info', withItems([item()]), true, true],
  ['typed review', withItems([item()], { type: 'review' }), true, true],
  ['typed decision and legacy option', withItems([item()], { type: 'action_required', actions: [{ id: 'decision-1', label: 'Continue' }] }), true, true],
  ['no items', withItems([]), true, true],
  ['zero item actions', withItems([item('mail-1', { actions: [] })]), true, true],
  ['eight item actions', withItems([item('mail-1', { actions: eightActions('mail-1') })]), true, true],
  ['nine item actions', withItems([item('mail-1', { actions: [...eightActions('mail-1'), { id: 'reply-9', kind: 'reply_ai', label: 'Ask', question: 'Why?' }] })]), false, false],
  ['empty optional display and sender', withItems([item('mail-1', { display: { sender: {} } })]), true, true],
  ['safe display and observation', withItems([item('mail-1', { display: { sender: { name: 'Sender', address: 'sender@example.test' }, sentAt: '2024-02-29T12:30:59.123+05:30', accountLabel: 'Personal', accountHint: 'Account notice' }, readObservation: { read: false, observedAt: '2026-10-22T12:30Z' } })]), true, true],
  ['sanitized item and reply text', withItems([item('mail-1', { subject: ' \u0000\u{4e2d}\u{6587}\u007f ', summary: '\u0001Summary\t\n', display: { sender: { name: '\u0000', address: '\u007f' }, accountLabel: '\u000b', accountHint: '\u000c' }, actions: [{ id: 'ask-1', kind: 'reply_ai', label: ' \u0000Ask\u007f ', question: ' \u0001Why?\u001f ' }] })]), true, true],
  ['null items', withItems(null), false, false],
  ['items object', withItems({}), false, false],
  ['items string', withItems('mail-1'), false, false],
  ['null item', withItems([null]), false, false],
  ['list item', withItems([[]]), false, false],
  ['number item', withItems([1]), false, false],
  ['null item actions', withItems([{ ...item(), actions: null }]), false, false],
  ['non-list item actions', withItems([{ ...item(), actions: {} }]), false, false],
  ['null typed action', withItems([{ ...item(), actions: [null] }]), false, false],
  ['list typed action', withItems([{ ...item(), actions: [[]] }]), false, false],
  ['unknown action kind', withItems([{ ...item(), actions: [{ id: 'a1', kind: 'tool', intent: 'mark_read' }] }]), false, false],
  ['unknown op intent', withItems([{ ...item(), actions: [{ id: 'a1', kind: 'op', intent: 'send_mail' }] }]), false, false],
  ['duplicate op intent', withItems([item('mail-1', { actions: [{ id: 'a1', kind: 'op', intent: 'mark_read' }, { id: 'a2', kind: 'op', intent: 'mark_read' }] })]), false, false],
  ['duplicate reply id inside item', withItems([item('mail-1', { actions: [{ id: 'ask-1', kind: 'reply_ai', label: 'Ask', question: 'Why?' }, { id: 'ask-1', kind: 'reply_ai', label: 'Ask again', question: 'How?' }] })]), false, false],
  ['duplicate item ids', withItems([item('same', { actions: [] }), item('same', { actions: [] })]), true, false],
  ['action id equals its item', withItems([item('same', { actions: [{ id: 'same', kind: 'op', intent: 'mark_read' }] })]), true, false],
  ['op and reply share an id', withItems([item('mail-1', { actions: [{ id: 'a1', kind: 'op', intent: 'mark_read' }, { id: 'a1', kind: 'reply_ai', label: 'Ask', question: 'Why?' }] })]), true, false],
  ['action ids repeat across items', withItems([item(), item('mail-2', { actions: [{ id: 'mail-1:read', kind: 'op', intent: 'find_task' }] })]), true, false],
  ['later item id equals earlier action', withItems([item(), item('mail-1:read', { actions: [] })]), true, false],
  ['later action id equals earlier item', withItems([item('mail-1', { actions: [] }), item('mail-2', { actions: [{ id: 'mail-1', kind: 'op', intent: 'mark_read' }] })]), true, false],
  ['legacy button collides with item', withItems([item()], { type: 'action_required', actions: [{ id: 'mail-1', label: 'Continue' }] }), true, false],
  ['legacy button collides with item action', withItems([item()], { type: 'action_required', actions: [{ id: 'mail-1:read', label: 'Continue' }] }), true, false],
];
for (const size of [30, 100, 101]) ITEM_MATRIX.push([
  `${size} dense items`, withItems(Array.from({ length: size }, (_, i) => item(`dense-${i}`, {
    subject: `Message ${i}: ${'s'.repeat(950)}`, summary: 'Summary '.repeat(1900),
    display: { sender: { name: 'Sender', address: 'sender@example.test' }, accountLabel: 'Personal' }, actions: eightActions(`dense-${i}`),
  }))), size <= 100, size <= 100,
]);
for (const field of ['id', 'subject', 'summary', 'source', 'actions']) {
  const incomplete: Record<string, unknown> = { ...item() };
  delete incomplete[field];
  ITEM_MATRIX.push([`missing item ${field}`, withItems([incomplete]), false, false]);
}
for (const key of ['tool', 'args', 'target', 'label', 'receipts', 'unavailableReason', 'unknown']) {
  ITEM_MATRIX.push([`extra item ${key}`, withItems([{ ...item(), [key]: {} }]), false, false]);
  ITEM_MATRIX.push([`extra op action ${key}`, withItems([{ ...item(), actions: [{ id: 'a1', kind: 'op', intent: 'mark_read', [key]: {} }] }]), false, false]);
  ITEM_MATRIX.push([`extra reply action ${key}`, withItems([{ ...item(), actions: [{ id: 'a1', kind: 'reply_ai', label: 'Ask', question: 'Why?', [key]: {} }] }]), false, false]);
}
for (const value of [null, [], 'text', 1]) {
  for (const field of ['source', 'display', 'readObservation']) ITEM_MATRIX.push([`${field} is ${JSON.stringify(value)}`, withItems([{ ...item(), [field]: value }]), false, false]);
  ITEM_MATRIX.push([`sender is ${JSON.stringify(value)}`, withItems([{ ...item(), display: { sender: value } }]), false, false]);
}
for (const definition of [
  { source: { ...item().source, unknown: 1 } }, { source: { ...item().source, kind: 'calendar' } },
  { display: { unknown: 1 } }, { display: { sender: { unknown: 1 } } },
  { readObservation: { read: false, observedAt: '2026-10-22T12:30Z', unknown: 1 } },
  { readObservation: { read: 'false', observedAt: '2026-10-22T12:30Z' } },
  { readObservation: { read: false } }, { readObservation: { observedAt: '2026-10-22T12:30Z' } },
]) ITEM_MATRIX.push([`invalid nested ${JSON.stringify(definition)}`, withItems([{ ...item(), ...definition }]), false, false]);
for (const id of ['A', 'a._:-9', `a${'x'.repeat(127)}`, '', `a${'x'.repeat(128)}`, '_bad', '../bad', 'space id', '\u{4e2d}\u{6587}', 'a\u0000']) {
  const valid = ['A', 'a._:-9', `a${'x'.repeat(127)}`].includes(id);
  ITEM_MATRIX.push([`item id ${JSON.stringify(id)}`, withItems([item(id, { actions: [] })]), valid, valid]);
  ITEM_MATRIX.push([`action id ${JSON.stringify(id)}`, withItems([item('mail-1', { actions: [{ id, kind: 'op', intent: 'mark_read' }] })]), valid, valid]);
}
for (const [field, max] of [['account', 1024], ['message', 4096]] as const) {
  for (const value of ['', ' ', 'x'.repeat(max), 'x'.repeat(max + 1), null, 5]) {
    const valid = typeof value === 'string' && value.length > 0 && value.length <= max;
    ITEM_MATRIX.push([`source ${field} size/type ${typeof value}:${typeof value === 'string' ? value.length : value}`, withItems([{ ...item(), source: { ...item().source, [field]: value } }]), valid, valid]);
  }
  const missing = { ...item().source } as Record<string, unknown>;
  delete missing[field];
  ITEM_MATRIX.push([`missing source ${field}`, withItems([{ ...item(), source: missing }]), false, false]);
  for (let code = 0; code <= 32; code++) {
    const value = `before${String.fromCharCode(code === 32 ? 127 : code)}after`;
    ITEM_MATRIX.push([`source ${field} control ${code}`, withItems([{ ...item(), source: { ...item().source, [field]: value } }]), false, false]);
  }
}
const TEXT_FIELDS: Array<[string, number, boolean, (value: unknown) => unknown]> = [
  ['subject', 1000, true, value => ({ ...item(), subject: value })],
  ['summary', 16000, false, value => ({ ...item(), summary: value })],
  ['label', 200, true, value => ({ ...item(), actions: [{ id: 'ask-1', kind: 'reply_ai', label: value, question: 'Why?' }] })],
  ['question', 4000, true, value => ({ ...item(), actions: [{ id: 'ask-1', kind: 'reply_ai', label: 'Ask', question: value }] })],
  ['sender.name', 300, false, value => ({ ...item(), display: { sender: { name: value } } })],
  ['sender.address', 500, false, value => ({ ...item(), display: { sender: { address: value } } })],
  ['accountLabel', 300, false, value => ({ ...item(), display: { accountLabel: value } })],
  ['accountHint', 1000, false, value => ({ ...item(), display: { accountHint: value } })],
];
for (const [field, max, nonempty, make] of TEXT_FIELDS) {
  for (const [label, value, valid] of [
    ['empty', '', !nonempty], ['cleaned empty', ' \u0000\u007f ', !nonempty],
    ['tab/newline only', '\t\n\r', !nonempty], ['maximum', 'x'.repeat(max), true],
    ['over maximum', 'x'.repeat(max + 1), false], ['pre-clean cap', `x${'\u0000'.repeat(max)}`, false],
    ['UTF-16 maximum', '\u{1f600}'.repeat(max / 2), true],
    ['UTF-16 over maximum', '\u{1f600}'.repeat(max / 2 + 1), false],
    ['null', null, false], ['number', 1, false],
  ] as const) ITEM_MATRIX.push([`${field} ${label}`, withItems([make(value)]), valid, valid]);
}
const DATES: Array<[string, boolean]> = [
  ['2024-02-29T12:30Z', true], ['2000-02-29T00:00:00Z', true], ['0000-02-29T00:00Z', true],
  ['2026-10-22T12:30:59.123456789Z', true], ['2026-10-22T12:30+23:59', true], ['2026-10-22T12:30-00:00', true],
  ['2026-10-22T12:30+05:30', true], ['1900-02-29T12:30Z', false], ['2025-02-29T12:30Z', false],
  ['2026-04-31T12:30Z', false], ['2026-01-32T12:30Z', false], ['2026-00-01T12:30Z', false],
  ['2026-13-01T12:30Z', false], ['2026-01-00T12:30Z', false], ['2026-10-22T24:00Z', false],
  ['2026-10-22T12:60Z', false], ['2026-10-22T12:30:60Z', false], ['2026-10-22T12:30.5Z', false],
  ['2026-10-22T12:30:00.Z', false], ['2026-10-22T12:30:00,5Z', false], ['2026-10-22T12:30', false],
  ['2026-10-22T12:30+0530', false], ['2026-10-22T12:30+05', false], ['2026-10-22T12:30+24:00', false],
  ['2026-10-22T12:30+00:60', false], ['2026-10-22t12:30z', false], ['2026-10-22 12:30Z', false],
  ['2026-1-2T12:30Z', false], ['+02026-10-22T12:30Z', false], ['2026-10-22T1:30Z', false],
  ['2026-10-22T12:30Z\u0000', false], [' 2026-10-22T12:30Z', false],
];
for (const [value, valid] of [...DATES, [null, false], [5, false]] as const) {
  ITEM_MATRIX.push([`sentAt ${JSON.stringify(value)}`, withItems([{ ...item(), display: { sentAt: value } }]), valid, valid]);
  ITEM_MATRIX.push([`observedAt ${JSON.stringify(value)}`, withItems([{ ...item(), readObservation: { read: true, observedAt: value } }]), valid, valid]);
}

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

  it.each(ITEM_MATRIX)('typed item schema agrees with the op parse: %s', (_label, args, accepted) => {
    const parsed = parseOpArgs(getOp('human_inbox_send')!, args);
    const mine = check.opArgs(args);
    expect(parsed.ok).toBe(accepted);
    expect(mine === null).toBe(accepted);
    if (mine) expect(mine).toMatch(/^Invalid arguments for human_inbox_send: .*items/);
  });

  it.each(ITEM_MATRIX)('typed item shape agrees with the store IDs: %s', (_label, args, _schema, accepted) => {
    let storeAccepts = true;
    try {
      validateNewItems(args.items, { items: [], thread: [], actions: args.actions as NewLetter['actions'] });
    } catch { storeAccepts = false; }
    expect(storeAccepts).toBe(accepted);
    expect(check.shape(args).ok).toBe(accepted);
  });

  it('reports the nested field and leaves raw definitions for the server drain to clean', () => {
    const args = withItems([item('mail-1', { subject: ' \u0000Notice\u007f ', actions: [] })]);
    const original = JSON.stringify(args);
    expect(check.opArgs(args)).toBeNull();
    expect(check.shape(args).ok).toBe(true);
    expect(JSON.stringify(args)).toBe(original);
    expect(validateNewItems(args.items)![0].subject).toBe('Notice');
    expect(check.opArgs(withItems([{ ...item(), actions: [{ id: 'a1', kind: 'op', intent: 'mark_read', tool: 'run' }] }]))).toMatch(/items\.0\.actions\.0\.tool/);
  });

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
    for (const [label, args] of [...MATRIX, ...ITEM_MATRIX]) {
      expect(rebuilt.opArgs(args), label).toBe(check.opArgs(args));
      expect(rebuilt.shape(args), label).toEqual(check.shape(args));
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

  it('keeps typed items and deduplicates only the same op key', async () => {
    const typed = letter({ items: [item('mail-1', { subject: ' \u0000Notice\u007f ', actions: eightActions('mail-1') })] });
    const first = await sendLetterOnce(typed, { opKey: 'op-items0000000001' });
    const again = await sendLetterOnce(letter({ subject: 'Changed', items: [item('mail-2')] }), { opKey: 'op-items0000000001' });
    const other = await sendLetterOnce(typed, { opKey: 'op-items0000000002' });
    expect(first.duplicate).toBe(false);
    expect(again).toMatchObject({ duplicate: true, letter: { id: first.letter.id, items: [{ id: 'mail-1', subject: 'Notice' }] } });
    expect(other.duplicate).toBe(false);
    expect(other.letter.id).not.toBe(first.letter.id);
    await setRead(first.letter.id, true);
    await setPinned(first.letter.id, true);
    expect((await findLetterByOp('op-items0000000001'))?.items?.[0].actions).toEqual(eightActions('mail-1'));
    expect((await getLetter(first.letter.id))?.items?.[0]).toMatchObject({ id: 'mail-1', subject: 'Notice', source: typed.items![0].source });
    expect((await listLetters()).letters).toHaveLength(2);
    expect(sent()).toHaveLength(2);
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
