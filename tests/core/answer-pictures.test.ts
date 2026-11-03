/**
 * Pictures sent with a letter reply or a decision note reach the letter's session
 * (src/core/answer-pictures.ts). 2026-11-03, the user: every box he types to an AI in "should be
 * able to copy pictures". The turn keeps the pictures' file names, the delivery names the files
 * under the images header that leads the line (where the daemon turns them into image blocks), and
 * the Org thread capture reads them back off that line.
 *
 * WALNUT_HOME is an isolated tmpdir (createMockConstants). The session tracker and the message
 * queue are mocked: their real paths would reach a CLI.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-answer-pictures'));

const getSessionByClaudeId = vi.fn();
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: (...args: unknown[]) => getSessionByClaudeId(...args),
}));
const sendMessageToSession = vi.fn();
vi.mock('../../src/core/session-message-queue.js', () => ({
  sendMessageToSession: (...args: unknown[]) => sendMessageToSession(...args),
  enqueueMessage: vi.fn(),
}));
vi.mock('../../src/core/notifications/letter-bridge.js', () => ({
  ensureLetterBridge: () => {},
  mirrorLetterReadState: async () => {},
}));

import { IMAGES_DIR } from '../../src/constants.js';
import { cleanPictureNames, picturesHeader, saveAnswerPictures, withAnswerPictures } from '../../src/core/answer-pictures.js';
import { IMAGES_ATTACHED_LINE } from '../../src/core/sessions/cloud-images.js';
import { answerLetterAndDeliver, humanReplyAndDeliver, savePicturesOnce } from '../../src/core/human-inbox/letter-ops.js';
import { getLetter, humanInboxPaths, sendLetter } from '../../src/core/human-inbox/store.js';
import { userWordsOf } from '../../src/core/org/thread-capture.js';

// A real 1x1 PNG, so the upload path's compression has bytes to read.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SENDER = { sessionId: 'sess-origin-pics', host: 'workstation', taskTitle: 'Layout check' };

function picture(name: string): string {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.writeFileSync(path.join(IMAGES_DIR, name), Buffer.from(PNG_1X1, 'base64'));
  return name;
}

beforeEach(() => {
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true });
  getSessionByClaudeId.mockReset();
  sendMessageToSession.mockReset();
  getSessionByClaudeId.mockResolvedValue({ claudeSessionId: SENDER.sessionId, host: 'workstation' });
  sendMessageToSession.mockResolvedValue({ id: 'qm-1' });
});

describe('picture names a turn may keep', () => {
  it('plain names in the images folder only: no path, no traversal, at most five, no repeats', () => {
    expect(cleanPictureNames(['a.png', '../x.png', '/etc/passwd', 'sub/b.png', 'noext', 'a.png', 'c.jpg']))
      .toEqual(['a.png', 'c.jpg']);
    expect(cleanPictureNames(['1.png', '2.png', '3.png', '4.png', '5.png', '6.png'])).toHaveLength(5);
    expect(cleanPictureNames('a.png')).toEqual([]);
  });

  it('the header names only pictures still on disk, and is empty for none', async () => {
    const kept = picture('kept-1.png');
    const header = await picturesHeader([kept, 'gone-2.png']);
    expect(header).toBe(`${IMAGES_ATTACHED_LINE}\n- ${path.join(IMAGES_DIR, kept)}\n\n`);
    expect(await picturesHeader(['gone-2.png'])).toBe('');
    expect(await picturesHeader(undefined)).toBe('');
  });

  it('a body\'s pictures are saved, whether uploaded (imageRefs) or inline (the phone)', async () => {
    const uploaded = picture('up-1.png');
    expect(await saveAnswerPictures({ imageRefs: [{ filename: uploaded }] })).toEqual([uploaded]);
    const inline = await saveAnswerPictures({ images: [{ data: PNG_1X1, mediaType: 'image/png' }, { data: 'x', mediaType: 'text/plain' }] });
    expect(inline).toHaveLength(1);
    expect(fs.existsSync(path.join(IMAGES_DIR, inline[0]!))).toBe(true);
    expect(await saveAnswerPictures({})).toEqual([]);
  });
});

describe('a letter reply with pictures', () => {
  it('keeps the names on the turn and names the files at the head of the delivered line', async () => {
    const name = picture('reply-1.png');
    const letter = await sendLetter({ subject: 'Layout check', type: 'review', markdown: 'Is the header right?', sender: SENDER });
    await humanReplyAndDeliver(letter.id, { text: 'Not quite, see this', images: [name] });

    const [turn] = (await getLetter(letter.id))!.thread;
    expect(turn).toMatchObject({ from: 'human', text: 'Not quite, see this', images: [name] });
    const delivered = String(sendMessageToSession.mock.calls[0]![1]);
    expect(delivered.startsWith(`${IMAGES_ATTACHED_LINE}\n- ${path.join(IMAGES_DIR, name)}\n\n[Letter reply]`)).toBe(true);
    expect(delivered).toContain('The pictures named above');
    // The Org thread files his words with the picture, as a letter answer.
    expect(userWordsOf(delivered, { inChat: false })).toEqual({
      text: 'Not quite, see this', images: [path.join(IMAGES_DIR, name)], via: 'letter', about: 'Layout check', letter: letter.id,
    });
  });

  it('a picture alone is a reply; nothing at all is still refused', async () => {
    const name = picture('reply-2.png');
    const letter = await sendLetter({ subject: 'Screens', type: 'review', markdown: 'Send one?', sender: SENDER });
    await humanReplyAndDeliver(letter.id, { text: '', images: [name] });
    expect((await getLetter(letter.id))!.thread[0]).toMatchObject({ text: '', images: [name] });
    await expect(humanReplyAndDeliver(letter.id, { text: '  ' })).rejects.toThrow(/text is required/);
  });

  it('a retry of a picture-only reply names it by clientId alone, and its pictures go again from the record', async () => {
    const name = picture('reply-3.png');
    const letter = await sendLetter({ subject: 'Retry', type: 'review', markdown: 'Send one?', sender: SENDER });
    await humanReplyAndDeliver(letter.id, { text: '', images: [name], clientId: 'phone-1' });
    sendMessageToSession.mockClear();
    // The phone keeps no recorded turn's pictures: its Retry sends the id and nothing else.
    const retried = await humanReplyAndDeliver(letter.id, { text: '', clientId: 'phone-1' });
    expect(retried.letter.thread).toHaveLength(1);
    // An empty send under an id nothing holds is still refused.
    await expect(humanReplyAndDeliver(letter.id, { text: '', clientId: 'phone-2' })).rejects.toThrow(/text is required/);
    expect((await getLetter(letter.id))!.thread).toHaveLength(1);
  });

  it('a reply without pictures is delivered exactly as before', async () => {
    const letter = await sendLetter({ subject: 'Plain', type: 'review', markdown: 'ok?', sender: SENDER });
    await humanReplyAndDeliver(letter.id, { text: 'ok' });
    expect((await getLetter(letter.id))!.thread[0]!.images).toBeUndefined();
    expect(String(sendMessageToSession.mock.calls[0]![1]).startsWith('[Letter reply]')).toBe(true);
  });
});

describe('a decision note with pictures', () => {
  it('goes with the pick, on the turn and in the delivery', async () => {
    const name = picture('note-1.png');
    const letter = await sendLetter({
      subject: 'Pick a layout', type: 'action_required', markdown: 'Which one?', sender: SENDER,
      actions: [{ id: 'a', label: 'Layout A' }, { id: 'b', label: 'Layout B' }],
    });
    await answerLetterAndDeliver(letter.id, { actionId: 'b', freeText: 'B, but like this', images: [name] });
    const turn = (await getLetter(letter.id))!.thread.at(-1)!;
    expect(turn).toMatchObject({ from: 'human', text: 'Layout B: B, but like this', images: [name] });
    const delivered = String(sendMessageToSession.mock.calls[0]![1]);
    expect(delivered.startsWith(`${IMAGES_ATTACHED_LINE}\n- ${path.join(IMAGES_DIR, name)}\n\n`)).toBe(true);
    expect(delivered).toContain('choice: Layout B');
  });
});

describe('a question answer with pictures is one tool result', () => {
  const asked = { questions: [{ question: 'Which layout?' }, { question: 'Anything else?' }] };

  it('names the pictures at the head of the last question\'s answer, the other answers untouched', async () => {
    const name = picture('answer-1.png');
    const { answers, pictures } = await withAnswerPictures(
      { 'Which layout?': 'B', 'Anything else?': 'Make it like this' }, asked, { imageRefs: [{ filename: name }] }, async (t) => t,
    );
    expect(pictures).toBe(1);
    expect(answers['Which layout?']).toBe('B');
    expect(answers['Anything else?']).toBe(`${IMAGES_ATTACHED_LINE}\n- ${path.join(IMAGES_DIR, name)}\n\nMake it like this`);
  });

  it('inline pictures (the phone) are saved, and a remote host gets its own paths', async () => {
    const { answers } = await withAnswerPictures(
      { 'Which layout?': 'A' }, asked, { images: [{ data: PNG_1X1, mediaType: 'image/png' }] },
      async (t) => t.replaceAll(IMAGES_DIR, '/remote/images'),
    );
    const [line, picturePath, blank, words] = answers['Which layout?']!.split('\n');
    expect([line, blank, words]).toEqual([IMAGES_ATTACHED_LINE, '', 'A']);
    expect(picturePath).toMatch(/^- \/remote\/images\/[^/]+$/);
  });

  it('no pictures, or none that can be saved, leaves the answers as they were', async () => {
    const answers = { 'Which layout?': 'A' };
    expect(await withAnswerPictures(answers, asked, {}, async (t) => t)).toEqual({ answers, pictures: 0 });
    expect(await withAnswerPictures(answers, asked, { imageRefs: [{ filename: 'gone.png' }] }, async (t) => t)).toEqual({ answers, pictures: 0 });
    expect(await withAnswerPictures({}, asked, { imageRefs: [{ filename: picture('x.png') }] }, async (t) => t)).toEqual({ answers: {}, pictures: 0 });
  });
});

describe('a resend saves its pictures once', () => {
  const pictureCount = () => (fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR).length : 0);
  const inline = { images: [{ data: PNG_1X1, mediaType: 'image/png' }] };

  it('a reply resent under the same clientId saves no second copy', async () => {
    const letter = await sendLetter({ subject: 'Resend', type: 'review', markdown: 'Send one?', sender: SENDER });
    const body = { text: 'like this', clientId: 'phone-9', ...inline };
    const first = await savePicturesOnce(letter.id, body, { kind: 'reply' });
    expect(first).toHaveLength(1);
    await humanReplyAndDeliver(letter.id, { text: 'like this', clientId: 'phone-9', images: first });
    const before = pictureCount();
    expect(await savePicturesOnce(letter.id, body, { kind: 'reply' })).toEqual([]);
    expect(pictureCount()).toBe(before);
    const again = await humanReplyAndDeliver(letter.id, { text: 'like this', clientId: 'phone-9' });
    expect(again.letter.thread).toHaveLength(1);
    expect(again.letter.thread[0]!.images).toEqual(first);
    // A new reply (another clientId) saves its pictures.
    expect(await savePicturesOnce(letter.id, { ...body, clientId: 'phone-10' }, { kind: 'reply' })).toHaveLength(1);
  });

  it('an answer to a letter already answered saves none', async () => {
    const letter = await sendLetter({
      subject: 'Pick', type: 'action_required', markdown: 'Which?', sender: SENDER,
      actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    });
    expect(await savePicturesOnce(letter.id, inline, { kind: 'answer' })).toHaveLength(1);
    await answerLetterAndDeliver(letter.id, { actionId: 'a' });
    const before = pictureCount();
    expect(await savePicturesOnce(letter.id, inline, { kind: 'answer' })).toEqual([]);
    expect(pictureCount()).toBe(before);
  });
});
