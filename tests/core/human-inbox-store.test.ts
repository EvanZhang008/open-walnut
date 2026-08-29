/**
 * Unit tests for the Human Inbox letter store (durable documents from agents).
 *
 * Contract under test (docs/plan/human-inbox-todo.md → frozen contract):
 *   - sendLetter validates hard (subject, type, exactly one body, actions only
 *     on action_required) and persists envelope → index.json, body → bodies/.
 *   - getLetter returns the record plus body content; a missing body file still
 *     yields a readable letter with an inline note.
 *   - read / pinned / archived toggles; the archived filter; unreadCount counts
 *     the LIVE feed only.
 *   - answerLetter records the choice once (409 on a second) and threads it.
 *   - agentReply flips the letter unread.
 *   - a corrupt or junk-filled index never throws at a caller.
 *   - 'human-inbox:letter' fires on send and on agent reply.
 *
 * WALNUT_HOME is redirected to an isolated tmpdir via createMockConstants, so
 * nothing here touches real data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { bus, type BusEvent } from '../../src/core/event-bus.js';
import { eventData } from '../../src/core/event-types.js';
import {
  LetterError,
  agentReply,
  answerLetter,
  getLetter,
  humanReply,
  humanInboxPaths,
  listLetters,
  sendLetter,
  setArchived,
  setPinned,
  setRead,
} from '../../src/core/human-inbox/store.js';
import {
  LETTER_BODY_MAX_BYTES,
  LETTER_HTML_MAX_BYTES,
  type LetterSender,
  type NewLetter,
} from '../../src/core/human-inbox/types.js';

const SENDER: LetterSender = {
  sessionId: 'sess-abc123',
  sessionTitle: 'Sync freeze investigation',
  taskId: 'task-42',
  taskTitle: 'Fix the sync freeze',
  project: 'marina',
  host: 'workstation',
};

function letterInput(overrides: Partial<NewLetter> = {}): NewLetter {
  return {
    subject: 'Root cause of the sync freeze',
    type: 'review',
    markdown: '## Summary\n\nThe rebase was orphaned. See `docs/report.md`.',
    sender: SENDER,
    ...overrides,
  };
}

/** Two sends in the same millisecond have no defined order — space them out. */
const tick = () => new Promise(resolve => setTimeout(resolve, 3));

beforeEach(() => {
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true });
});

describe('human inbox store — send, list, get', () => {
  it('sends a letter, lists the envelope, and reads the body back', async () => {
    const record = await sendLetter(letterInput());

    expect(record.id).toMatch(/^lt-[0-9a-z]+-[0-9a-f]{6}$/);
    expect(record.read).toBe(false);
    expect(record.pinned).toBe(false);
    expect(record.archived).toBe(false);
    expect(record.bodyFormat).toBe('markdown');
    // Preview derived from the body: markdown markup stripped to plain words.
    expect(record.textPreview).toBe('Summary The rebase was orphaned. See docs/report.md.');
    expect(record.sender.taskTitle).toBe('Fix the sync freeze');

    const { letters, unreadCount } = await listLetters();
    expect(letters).toHaveLength(1);
    expect(unreadCount).toBe(1);
    // The index carries the envelope only — never the body.
    expect(letters[0]).not.toHaveProperty('body');

    const detail = await getLetter(record.id);
    expect(detail?.body).toContain('The rebase was orphaned');
    expect(detail?.bodyMissing).toBeUndefined();
    expect(detail?.thread).toEqual([]);

    // Persisted in the versioned envelope, body in its own file.
    const raw = JSON.parse(fs.readFileSync(humanInboxPaths.indexFile, 'utf-8'));
    expect(raw.version).toBe(1);
    expect(raw.letters).toHaveLength(1);
    expect(fs.existsSync(path.join(humanInboxPaths.bodiesDir, `${record.id}.md`))).toBe(true);
  });

  it('stores an html letter and prefers an explicit text preview', async () => {
    const record = await sendLetter(letterInput({
      markdown: undefined,
      html: '<h1>Migration done</h1><style>h1{color:red}</style><p>42 files, tests green.</p>',
      text: '42 files migrated, all tests green',
      type: 'completion',
    }));
    expect(record.bodyFormat).toBe('html');
    expect(record.textPreview).toBe('42 files migrated, all tests green');
    const detail = await getLetter(record.id);
    expect(detail?.body).toContain('<h1>Migration done</h1>');
  });

  it('derives an html preview without style/script text when no text is given', async () => {
    const record = await sendLetter(letterInput({
      markdown: undefined,
      html: '<style>p{color:red}</style><p>Disk is at 70%.</p><p>No action needed.</p>',
      type: 'info',
    }));
    expect(record.textPreview).toBe('Disk is at 70%. No action needed.');
  });

  it('returns null for an unknown id and for a traversal attempt', async () => {
    expect(await getLetter('lt-abc-000000')).toBeNull();
    expect(await getLetter('../../../etc/passwd')).toBeNull();
  });

  it('keeps the letter readable when its body file is gone', async () => {
    const record = await sendLetter(letterInput());
    fs.rmSync(path.join(humanInboxPaths.bodiesDir, `${record.id}.md`));

    const { letters } = await listLetters();
    expect(letters).toHaveLength(1);

    const detail = await getLetter(record.id);
    expect(detail?.bodyMissing).toBe(true);
    expect(detail?.body).toContain('missing');
  });

  it('sorts pinned first, then newest', async () => {
    const first = await sendLetter(letterInput({ subject: 'oldest' }));
    await tick();
    const second = await sendLetter(letterInput({ subject: 'newest' }));
    await tick();

    let { letters } = await listLetters();
    expect(letters.map(l => l.id)).toEqual([second.id, first.id]);

    await setPinned(first.id, true);
    ({ letters } = await listLetters());
    expect(letters.map(l => l.id)).toEqual([first.id, second.id]);
  });
});

describe('human inbox store — validation', () => {
  const expectInvalid = async (input: NewLetter, match: RegExp) => {
    await expect(sendLetter(input)).rejects.toThrow(match);
    await expect(sendLetter(input)).rejects.toMatchObject({ code: 'invalid', status: 400 });
  };

  it('rejects an empty subject', async () => {
    await expectInvalid(letterInput({ subject: '   ' }), /subject is required/);
  });

  it('rejects an unknown type', async () => {
    await expectInvalid(
      letterInput({ type: 'urgent' as NewLetter['type'] }),
      /type must be one of/,
    );
  });

  it('requires exactly one of html | markdown', async () => {
    await expectInvalid(letterInput({ markdown: undefined }), /exactly one of html \| markdown/);
    await expectInvalid(letterInput({ html: '<p>hi</p>' }), /exactly one of html \| markdown/);
  });

  it('allows actions only on action_required, and each needs id + label', async () => {
    await expectInvalid(
      letterInput({ type: 'completion', actions: [{ id: 'a', label: 'A' }] }),
      /only allowed when type is action_required/,
    );
    await expectInvalid(
      letterInput({ type: 'action_required', actions: [{ id: 'a', label: '' }] }),
      /non-empty id and label/,
    );
    await expectInvalid(
      letterInput({ type: 'action_required', actions: [] }),
      /non-empty array/,
    );
    await expectInvalid(
      letterInput({
        type: 'action_required',
        actions: [{ id: 'a', label: 'A' }, { id: 'a', label: 'Also A' }],
      }),
      /unique/,
    );
  });

  it('rejects a markdown body over the 200KB prose cap and writes nothing', async () => {
    const huge = 'x'.repeat(LETTER_BODY_MAX_BYTES + 1);
    await expect(sendLetter(letterInput({ markdown: huge }))).rejects.toThrow(/letter cap/);
    // Just under the cap is accepted.
    const ok = await sendLetter(letterInput({ markdown: 'y'.repeat(LETTER_BODY_MAX_BYTES) }));
    expect(ok.id).toBeTruthy();
    const { letters } = await listLetters();
    expect(letters).toHaveLength(1);
  });

  /**
   * The whole point of the html cap: an audio digest embeds its podcast as a
   * base64 data URI, which is 2-5MB — far over the prose cap the same letter's
   * markdown would be held to. Stored BYTE-IDENTICAL, since a body silently
   * truncated mid-base64 is an audio player that renders and never plays.
   */
  it('accepts an html body far over the prose cap and stores it verbatim', async () => {
    const audio = 'A'.repeat(3 * 1024 * 1024);
    const html = `<h1>Daily digest</h1><audio controls src="data:audio/mpeg;base64,${audio}"></audio>`;
    const record = await sendLetter(letterInput({
      markdown: undefined, html, text: 'Your Thursday digest, 4 minutes.',
    }));
    expect(record.bodyFormat).toBe('html');
    // The envelope stays tiny — the base64 never leaks into the preview.
    expect(record.textPreview).toBe('Your Thursday digest, 4 minutes.');

    const detail = await getLetter(record.id);
    expect(detail?.body).toBe(html);
    expect(Buffer.byteLength(detail!.body, 'utf-8')).toBeGreaterThan(3 * 1024 * 1024);
  });

  /**
   * A long podcast, and a clip, are both bigger than the ORIGINAL 10MB media cap
   * — this is the case that made the cap look arbitrary from the outside. Anchored
   * at a fixed 12MB rather than a fraction of the constant so lowering the cap
   * back under a real digest fails here instead of passing quietly.
   */
  it('accepts a 12MB html body carrying inline video (over the original 10MB cap)', async () => {
    const clip = 'V'.repeat(12 * 1024 * 1024);
    const html = `<h1>Daily digest</h1><video controls src="data:video/mp4;base64,${clip}"></video>`;
    expect(Buffer.byteLength(html, 'utf-8')).toBeLessThanOrEqual(LETTER_HTML_MAX_BYTES);
    const record = await sendLetter(letterInput({
      markdown: undefined, html, text: 'Digest with a clip.',
    }));
    const detail = await getLetter(record.id);
    expect(detail?.body).toBe(html);
    // Byte-identical: a body clipped mid-base64 is a player that never plays.
    expect(Buffer.byteLength(detail!.body, 'utf-8')).toBe(Buffer.byteLength(html, 'utf-8'));
    expect(record.textPreview).toBe('Digest with a clip.');
  }, 60_000);

  it('still rejects an html body over the media cap', async () => {
    const huge = 'x'.repeat(LETTER_HTML_MAX_BYTES + 1);
    await expect(sendLetter(letterInput({ markdown: undefined, html: huge })))
      .rejects.toThrow(/letter cap/);
    expect((await listLetters()).letters).toHaveLength(0);
  }, 60_000);

  it('throws a not_found LetterError when mutating an unknown letter', async () => {
    await expect(setRead('lt-abc-000000', true)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    await expect(setPinned('../evil', true)).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('human inbox store — human state', () => {
  it('toggles read, pinned and archived; unreadCount counts the live feed only', async () => {
    const record = await sendLetter(letterInput());

    expect((await setRead(record.id, true)).read).toBe(true);
    expect((await listLetters()).unreadCount).toBe(0);
    expect((await setRead(record.id, false)).read).toBe(false);
    expect((await listLetters()).unreadCount).toBe(1);

    expect((await setPinned(record.id, true)).pinned).toBe(true);
    expect((await setPinned(record.id, false)).pinned).toBe(false);

    await setArchived(record.id, true);
    const live = await listLetters();
    expect(live.letters).toHaveLength(0);
    // Still unread, but archived — the badge must not count it.
    expect(live.unreadCount).toBe(0);

    const archived = await listLetters({ archived: true });
    expect(archived.letters.map(l => l.id)).toEqual([record.id]);

    await setArchived(record.id, false);
    expect((await listLetters()).letters).toHaveLength(1);
  });

  it('records a human free-text reply in the thread and un-archives the letter', async () => {
    const record = await sendLetter(letterInput());
    await setArchived(record.id, true);

    const updated = await humanReply(record.id, { text: 'Does this explain Tuesday too?' });
    expect(updated.archived).toBe(false);
    expect(updated.read).toBe(true);
    expect(updated.thread).toHaveLength(1);
    expect(updated.thread[0]).toMatchObject({ from: 'human', text: 'Does this explain Tuesday too?' });

    await expect(humanReply(record.id, { text: '  ' })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('human inbox store — action_required answers', () => {
  const actionLetter = () => letterInput({
    type: 'action_required',
    subject: 'Option A or B?',
    actions: [
      { id: 'a', label: 'Keep the old schema', description: 'Lower risk' },
      { id: 'b', label: 'Migrate now' },
    ],
  });

  it('records the answer, threads it, and refuses a second answer', async () => {
    const record = await sendLetter(actionLetter());
    expect(record.actions).toHaveLength(2);

    const answered = await answerLetter(record.id, { actionId: 'b', freeText: 'after the tests pass' });
    expect(answered.answered).toMatchObject({
      actionId: 'b',
      label: 'Migrate now',
      freeText: 'after the tests pass',
    });
    expect(answered.answered?.at).toBeGreaterThan(0);
    expect(answered.read).toBe(true);
    expect(answered.thread).toHaveLength(1);
    expect(answered.thread[0]).toMatchObject({ from: 'human' });
    expect(answered.thread[0].text).toContain('Migrate now');
    expect(answered.thread[0].text).toContain('after the tests pass');

    await expect(answerLetter(record.id, { actionId: 'a' })).rejects.toMatchObject({
      code: 'already_answered',
      status: 409,
    });
  });

  it('rejects an unknown actionId with 400 and leaves the letter unanswered', async () => {
    const record = await sendLetter(actionLetter());
    await expect(answerLetter(record.id, { actionId: 'c' })).rejects.toMatchObject({
      code: 'invalid',
      status: 400,
    });
    const detail = await getLetter(record.id);
    expect(detail?.answered).toBeUndefined();
    expect(detail?.thread).toEqual([]);
  });

  it('answering an archived letter un-archives it', async () => {
    const record = await sendLetter(actionLetter());
    await setArchived(record.id, true);
    const answered = await answerLetter(record.id, { actionId: 'a' });
    expect(answered.archived).toBe(false);
  });
});

describe('human inbox store — agent replies', () => {
  it('appends the turn, flips the letter unread, and stores a rich body file', async () => {
    const record = await sendLetter(letterInput());
    await setRead(record.id, true);

    const replied = await agentReply(record.id, {
      text: 'Yes — same orphaned rebase.',
      markdown: '### Tuesday\n\nSame root cause.',
    });
    expect(replied.read).toBe(false);
    expect(replied.thread).toHaveLength(1);
    expect(replied.thread[0]).toMatchObject({
      from: 'agent',
      bodyFormat: 'markdown',
      bodyFile: `${record.id}.r0.md`,
    });

    const detail = await getLetter(record.id);
    expect(detail?.thread[0].body).toContain('Same root cause');
    expect(detail?.thread[0].bodyMissing).toBeUndefined();
  });

  it('accepts a plain-text-only reply and rejects both bodies at once', async () => {
    const record = await sendLetter(letterInput());
    const replied = await agentReply(record.id, { text: 'Done.' });
    expect(replied.thread[0].bodyFile).toBeUndefined();

    await expect(agentReply(record.id, {
      text: 'x', html: '<p>a</p>', markdown: 'a',
    })).rejects.toMatchObject({ code: 'invalid' });
    await expect(agentReply(record.id, { text: '' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('flags a rich reply whose body file vanished instead of failing the read', async () => {
    const record = await sendLetter(letterInput());
    await agentReply(record.id, { text: 'see body', markdown: '# gone' });
    fs.rmSync(path.join(humanInboxPaths.bodiesDir, `${record.id}.r0.md`));

    const detail = await getLetter(record.id);
    expect(detail?.thread[0].bodyMissing).toBe(true);
    expect(detail?.thread[0].body).toBeUndefined();
  });
});

describe('human inbox store — corrupt index resilience', () => {
  it('recovers from an unparseable index, keeping the bad file aside', async () => {
    fs.mkdirSync(humanInboxPaths.dir, { recursive: true });
    fs.writeFileSync(humanInboxPaths.indexFile, '{ this is not json', 'utf-8');

    // A read never throws…
    await expect(listLetters()).resolves.toMatchObject({ letters: [], unreadCount: 0 });
    // …and a write still lands.
    const record = await sendLetter(letterInput());
    expect((await listLetters()).letters.map(l => l.id)).toEqual([record.id]);
    expect(fs.existsSync(`${humanInboxPaths.indexFile}.corrupt`)).toBe(true);
  });

  it('drops junk records and repairs partial ones instead of throwing', async () => {
    fs.mkdirSync(humanInboxPaths.dir, { recursive: true });
    fs.writeFileSync(humanInboxPaths.indexFile, JSON.stringify({
      version: 1,
      letters: [
        null,
        { subject: 'no id at all' },
        { id: 'not-a-letter-id', subject: 'bad id' },
        // Partial but identifiable: everything else gets a sane default.
        { id: 'lt-abc-def123', type: 'nonsense', thread: [{ from: 'alien' }, { from: 'human', text: 'hi' }] },
      ],
    }), 'utf-8');

    const { letters } = await listLetters();
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
      id: 'lt-abc-def123',
      subject: '(no subject)',
      type: 'info',
      bodyFormat: 'markdown',
      read: false,
      pinned: false,
      archived: false,
      sender: { sessionId: 'external', host: 'local' },
    });
    expect(letters[0].thread).toEqual([{ from: 'human', text: 'hi', at: 0 }]);
  });

  it('treats a wrong-version index as empty rather than failing', async () => {
    fs.mkdirSync(humanInboxPaths.dir, { recursive: true });
    fs.writeFileSync(humanInboxPaths.indexFile, JSON.stringify({ version: 99, letters: 'nope' }), 'utf-8');
    await expect(listLetters()).resolves.toMatchObject({ letters: [] });
  });
});

describe('human inbox store — bus events', () => {
  const seen: BusEvent[] = [];

  beforeEach(() => {
    seen.length = 0;
    bus.subscribe('test-human-inbox', (event) => { seen.push(event); }, { global: true });
  });
  afterEach(() => {
    bus.unsubscribe('test-human-inbox');
  });

  it('emits an envelope-only event on send and on agent reply', async () => {
    const record = await sendLetter(letterInput({
      type: 'action_required',
      actions: [{ id: 'a', label: 'Go' }],
      text: 'Two options, need a call',
    }));

    const newEvents = seen.filter(e => e.name === 'human-inbox:letter');
    expect(newEvents).toHaveLength(1);
    const payload = eventData<'human-inbox:letter'>(newEvents[0]);
    expect(payload).toEqual({
      letterId: record.id,
      subject: record.subject,
      type: 'action_required',
      textPreview: record.textPreview,
      senderSessionId: SENDER.sessionId,
      senderTitle: SENDER.sessionTitle,
      host: SENDER.host,
      kind: 'new',
    });
    // The body must never ride the event (push payloads would leak otherwise).
    expect(JSON.stringify(payload)).not.toContain('rebase');

    seen.length = 0;
    await agentReply(record.id, { text: 'Picked A, proceeding.' });
    const replyEvents = seen.filter(e => e.name === 'human-inbox:letter');
    expect(replyEvents).toHaveLength(1);
    expect(eventData<'human-inbox:letter'>(replyEvents[0])).toMatchObject({
      letterId: record.id,
      kind: 'reply',
      textPreview: 'Picked A, proceeding.',
    });
  });

  it('does not emit on human-side state changes', async () => {
    const record = await sendLetter(letterInput());
    seen.length = 0;
    await setRead(record.id, true);
    await setPinned(record.id, true);
    await setArchived(record.id, true);
    await humanReply(record.id, { text: 'noted' });
    expect(seen.filter(e => e.name === 'human-inbox:letter')).toHaveLength(0);
  });
});

describe('human inbox store — error type', () => {
  it('exports LetterError so routes can map code → status', async () => {
    const err = await sendLetter(letterInput({ subject: '' })).catch(e => e);
    expect(err).toBeInstanceOf(LetterError);
    expect(err.status).toBe(400);
  });
});
