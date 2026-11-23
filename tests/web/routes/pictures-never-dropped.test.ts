/**
 * A picture sent with a message is never dropped (2026-11-23, the user: "we should never cause
 * message loss"; messages and what they carry are never lost). Every picture of a send is kept,
 * in order, or the send is refused BEFORE anything is queued with an ImageAttachError the sender
 * sees (the composer keeps the words and the pictures). The old code filtered out an unsupported
 * type, cut the list at 5, skipped an oversized one, skipped a stale upload and skipped a failed
 * save, and the words went on alone, so the agent answered about a picture it never saw.
 *
 * The second half is a guard over the source: the send paths (web, phone, quick bar, API, letter
 * and Board answers) must go through the checked helpers in src/web/routes/images.ts, and none
 * may cut or filter a picture list on its own.
 *
 * WALNUT_HOME (and IMAGES_DIR under it) is an isolated tmpdir.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-pictures-never-dropped'));

import { IMAGES_DIR } from '../../../src/constants.js';
import {
  ImageAttachError, MAX_SESSION_IMAGES, checkImagePayloads, checkImageRefNames, processAndSaveImages,
  resolveImageRefs, saveSessionPictures,
} from '../../../src/web/routes/images.js';
import { sessionImagesOf } from '../../../src/web/routes/session-send-v1.js';
import { inlineAnswerPictures, saveAnswerPictures } from '../../../src/core/answer-pictures.js';

// A real 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pic = (mediaType = 'image/png') => ({ data: PNG, mediaType });
const pics = (n: number) => Array.from({ length: n }, () => pic());

function upload(name: string): string {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.writeFileSync(path.join(IMAGES_DIR, name), Buffer.from(PNG, 'base64'));
  return name;
}

async function refusal(p: Promise<unknown> | (() => unknown)): Promise<ImageAttachError> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    expect(err).toBeInstanceOf(ImageAttachError);
    return err as ImageAttachError;
  }
  throw new Error('expected the send to be refused, it went');
}

afterEach(() => vi.restoreAllMocks());

describe('a picture list is kept whole or refused, never shortened', () => {
  it('every picture comes back, in order', () => {
    const list = [pic('image/png'), pic('image/jpeg'), pic('image/gif'), pic('image/webp')];
    expect(checkImagePayloads(list)).toEqual(list);
    expect(checkImagePayloads(undefined)).toEqual([]);
    expect(checkImagePayloads([])).toEqual([]);
  });

  it('one past the cap refuses the whole send, it is never cut to the cap', async () => {
    const err = await refusal(() => checkImagePayloads(pics(6)));
    expect(err.code).toBe('too_many_images');
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/6 pictures.*at most 5/);
  });

  it('a type the session cannot read refuses the send and names the picture', async () => {
    const err = await refusal(() => checkImagePayloads([pic(), pic('image/heic')]));
    expect(err.code).toBe('image_unsupported_type');
    expect(err.message).toMatch(/Picture 2 of 2 is image\/heic/);
  });

  it('an entry with no picture data refuses the send (it was filtered out before)', async () => {
    expect((await refusal(() => checkImagePayloads([pic(), { mediaType: 'image/png' }]))).code).toBe('image_invalid');
    expect((await refusal(() => checkImagePayloads([pic(), { data: '', mediaType: 'image/png' }]))).code).toBe('image_invalid');
    expect((await refusal(() => checkImagePayloads('not a list'))).code).toBe('image_invalid');
  });

  it('a ref naming no upload refuses the send', async () => {
    expect((await refusal(() => checkImageRefNames([{ filename: '../../etc/passwd' }]))).code).toBe('image_invalid');
  });
});

describe('a message to a session keeps every picture', () => {
  it('more than five pictures all reach the session: it reads them by path, so none is cut', async () => {
    const paths = await saveSessionPictures(pics(8), undefined);
    expect(paths).toHaveLength(8);
    expect(MAX_SESSION_IMAGES).toBe(20);
    for (const p of paths) expect(fs.existsSync(p)).toBe(true);
    expect(sessionImagesOf(pics(8))).toHaveLength(8);
    // Past the sanity bound the send is refused, still never shortened.
    expect((await refusal(() => sessionImagesOf(pics(MAX_SESSION_IMAGES + 1)))).code).toBe('too_many_images');
  });

  it('an oversized picture is shrunk to fit and kept, never skipped', async () => {
    // A real 3000x3000 noise PNG: past the old 14,000,000-char base64 ceiling, which used to
    // filter it out without a word. It is downscaled and recompressed, then saved.
    const sharp = (await import('sharp')).default;
    const raw = Buffer.alloc(3000 * 3000 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
    const png = await sharp(raw, { raw: { width: 3000, height: 3000, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    const big = png.toString('base64');
    expect(big.length).toBeGreaterThan(14_000_000);
    const [saved] = await saveSessionPictures([{ data: big, mediaType: 'image/png' }], undefined);
    expect(saved).toMatch(/\.jpg$/);
    expect(fs.statSync(saved!).size).toBeLessThan(5_000_000);
  }, 60_000);

  it('a picture that cannot be shrunk to fit refuses the send with 413, naming it', async () => {
    // Bytes sharp cannot read stay as they came, past the per-picture limit.
    const unreadable = Buffer.alloc(5 * 1024 * 1024, 7).toString('base64');
    const before = fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR).length : 0;
    const err = await refusal(saveSessionPictures([pic(), { data: unreadable, mediaType: 'image/png' }], undefined));
    expect(err.code).toBe('image_too_large');
    expect(err.status).toBe(413);
    expect(err.message).toMatch(/Picture 2 of 2 is 5 MB even after shrinking it/);
    // The picture this send already wrote is removed again.
    expect(fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR).length : 0).toBe(before);
  }, 30_000);

  it('uploaded refs all resolve, or a stale one refuses the send (it was skipped before)', async () => {
    const a = upload('1700000000001-aaaaaaaaaaaa.png');
    const b = upload('1700000000002-bbbbbbbbbbbb.png');
    expect(await saveSessionPictures(undefined, [{ filename: a }, { filename: b }]))
      .toEqual([path.join(IMAGES_DIR, a), path.join(IMAGES_DIR, b)]);
    const err = await refusal(saveSessionPictures(undefined, [{ filename: a }, { filename: '1700000000003-cccccccccccc.png' }]));
    expect(err.code).toBe('image_not_found');
    expect(err.message).toMatch(/Picture 2 of 2 is no longer on the server/);
    await expect(resolveImageRefs([{ filename: '1700000000003-cccccccccccc.png' }])).rejects.toBeInstanceOf(ImageAttachError);
  });

  it('a save that fails refuses the send with the reason (it was logged and skipped before)', async () => {
    const before = fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR).length : 0;
    const write = fsp.writeFile.bind(fsp);
    let calls = 0;
    // The first write lands, the second fails: the first is removed again, nothing is left.
    vi.spyOn(fsp, 'writeFile').mockImplementation(async (...args: Parameters<typeof fsp.writeFile>) => {
      if (++calls === 2) throw new Error('ENOSPC: no space left on device');
      return write(...args);
    });
    const err = await refusal(saveSessionPictures([pic(), { data: Buffer.from('second').toString('base64'), mediaType: 'image/png' }], undefined));
    expect(err.code).toBe('image_save_failed');
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/ENOSPC/);
    expect(calls).toBe(2);
    expect(fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR).length : 0).toBe(before);
  });
});

describe('the main chat (model image blocks) refuses past its cap instead of cutting', () => {
  it('five go as blocks; six refuse', async () => {
    const five = await processAndSaveImages(pics(5));
    expect(five?.savedImages).toHaveLength(5);
    expect(five?.imageContentBlocks).toHaveLength(5);
    expect((await refusal(processAndSaveImages(pics(6)))).code).toBe('too_many_images');
    expect(await processAndSaveImages(undefined)).toBeNull();
  });
});

describe('answer pictures (letters, Board threads and choices) are kept whole or refused', () => {
  it('a good picture beside a bad one refuses the answer, never sends the good one alone', async () => {
    expect((await refusal(saveAnswerPictures({ images: [pic(), { data: 'x', mediaType: 'text/plain' }] }))).code).toBe('image_unsupported_type');
    expect((await refusal(saveAnswerPictures({ images: pics(6) }))).code).toBe('too_many_images');
    expect((await refusal(saveAnswerPictures({ imageRefs: ['1700000000009-dddddddddddd.png'] }))).code).toBe('image_not_found');
    expect((await refusal(inlineAnswerPictures({ imageRefs: ['1700000000009-dddddddddddd.png'] }))).code).toBe('image_not_found');
    expect((await refusal(inlineAnswerPictures({ images: pics(6) }))).code).toBe('too_many_images');
    expect(await saveAnswerPictures({ images: [pic(), { data: Buffer.from('another picture').toString('base64'), mediaType: 'image/png' }] })).toHaveLength(2);
  });
});

// ── Guard over the source: where a picture list may be cut, filtered or skipped ──

const ROOT = path.resolve(import.meta.dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== '__tests__' && entry.name !== 'node_modules') out.push(...sourceFiles(rel)); continue; }
    if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

describe('guard: the drop sites stay closed', () => {
  it('no server code cuts a picture list to a cap', () => {
    // `.slice(0, MAX_…)` on a picture list is how five of six pictures went and the sixth vanished.
    const cut = /\.slice\(0,\s*(MAX_SESSION_IMAGES|MAX_IMAGES_PER_MESSAGE|MAX_ANSWER_PICTURES|MAX_IMAGES|maxImagesPerMessage\(\))\)/;
    const hits = sourceFiles('src').filter((f) => cut.test(read(f)));
    expect(hits).toEqual([]);
  });

  it('only images.ts writes a picture to disk, so every save is the checked, all-or-nothing one', () => {
    const callers = sourceFiles('src').filter((f) => /\bsaveImageToDisk\(/.test(read(f)));
    expect(callers).toEqual([path.join('src', 'web', 'routes', 'images.ts')]);
  });

  it('every send path takes its pictures through the checked helpers', () => {
    // [file, what it must call]: one row per entry point found on 2026-11-23.
    const sites: Array<[string, RegExp]> = [
      // The web console's session composer (WS session:send).
      ['src/web/routes/session-chat.ts', /await saveSessionPictures\(data\.images, data\.imageRefs\)/],
      // The phone's session send (primary and companion).
      ['src/web/routes/session-send-v1.ts', /images = sessionImagesOf\(req\.body\?\.images\)/],
      ['src/web/routes/session-send-v1.ts', /savedPaths = \(await savePicturesToDisk\(images\)\)/],
      ['src/web/routes/session-send-v1.ts', /images = await compressImagesInMemory\(images\)[\s\S]*fitsImageSaveLimits/],
      // The quick bar, Ask Main and a task's chat.
      ['src/web/routes/quick-input-v1.ts', /sessionImagesOf\(req\.body\?\.images\)/],
      ['src/web/routes/quick-input-v1.ts', /withImagePaths\(text, \(await savePicturesToDisk\(images\)\)/],
      // Talk to CEO.
      ['src/web/routes/content-v1.ts', /const images = sessionImagesOf\(req\.body\?\.images\)/],
      // Quick start, side threads and fork.
      ['src/web/routes/sessions.ts', /processAndSaveImages\(images, MAX_SESSION_IMAGES\)/],
      // The main agent's chat over the API.
      ['src/web/routes/api-v1.ts', /images = checkImagePayloads\(req\.body\?\.images\)/],
      // Letter and Board answers.
      ['src/core/answer-pictures.ts', /checkImagePayloads\(body\.images, MAX_ANSWER_PICTURES\)/],
      ['src/core/answer-pictures.ts', /checkImageRefNames\(body\.imageRefs, MAX_ANSWER_PICTURES\)/],
      // A picture a remote host would not take is named with the reason, not passed on bare.
      ['src/providers/remote-session-manager.ts', /rewriteShipped\(rewritten, new Map\(\), imageFailed\)/],
      // ... and the sender is told in the session chat.
      ['src/providers/remote-session-manager.ts', /this\.tellUndelivered\(imageFailed\)/],
      ['src/providers/remote-session-manager.ts', /if \(!this\.conn\?\.connected\) return this\.markUndelivered\(message, LINK_DOWN_REASON\)/],
      // A web answer box says what it did not take, and a read from before a clear never lands.
      ['web/src/components/common/image-attachments.ts', /setNotice\(leftOutNotice\(left\)\)/],
      ['web/src/components/common/image-attachments.ts', /if \(gen !== generation\.current\) return;/],
      ['web/src/components/common/PictureStrip.tsx', /pictures\.notice/],
      // A session retry whose upload is gone uploads the pictures again instead of failing forever.
      ['web/src/hooks/useSessionSend.ts', /isStaleImageRefError\(e\.message\) \? withoutUploadedNames\(failedMsg\.images\)/],
      // A queued main-chat message refused when it went out keeps its bubble, with the reason and Retry.
      ['web/src/hooks/useChat.ts', /if \(outcome === 'failed'\) markQueuedFailed\(next, lastSendErrorRef\.current\)/],
      ['web/src/components/chat/PluginChatView.tsx', /onRetry=\{message\.failed/],
      ['web/src/components/notes/NotesChat.tsx', /onRetry=\{msg\.failed/],
    ];
    for (const [file, must] of sites) expect(read(file), file).toMatch(must);
    expect(read('src/web/routes/sessions.ts').match(/processAndSaveImages\(images, MAX_SESSION_IMAGES\)/g)).toHaveLength(3);
    // The phone's companion path refuses an oversized picture BEFORE it stops the running turn.
    const v1 = read('src/web/routes/session-send-v1.ts');
    expect(v1.indexOf('images = await compressImagesInMemory(images)')).toBeGreaterThan(0);
    expect(v1.indexOf('images = await compressImagesInMemory(images)')).toBeLessThan(v1.indexOf("callPrimaryControl('interrupt'"));
    // The old silent filters are gone.
    expect(read('src/web/routes/session-send-v1.ts')).not.toMatch(/extractValidImages/);
    expect(read('src/web/routes/session-chat.ts')).not.toMatch(/MAX_IMAGE_BASE64_LENGTH|Failed to save session image/);
    expect(read('src/web/routes/quick-input-v1.ts')).not.toMatch(/quick input image not saved/);
  });
});
