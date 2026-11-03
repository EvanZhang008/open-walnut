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
import { cleanPictureNames, picturesHeader, saveAnswerPictures } from '../../src/core/answer-pictures.js';
import { IMAGES_ATTACHED_LINE } from '../../src/core/sessions/cloud-images.js';
import { answerLetterAndDeliver, humanReplyAndDeliver } from '../../src/core/human-inbox/letter-ops.js';
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
