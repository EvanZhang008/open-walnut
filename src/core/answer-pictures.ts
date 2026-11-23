/**
 * Pictures the person sends with words that go to a session outside the chat: a letter answer or
 * reply, a Board thread message or choice answer (2026-11-03, the user: every box he types to an AI
 * in "should be able to copy pictures"). They come as the chat's pictures do: `imageRefs`
 * (the web uploads first through POST /api/images/upload, so no bytes ride a socket) or inline
 * `images` (the phone posts base64, as it does to a session). They are saved where every session
 * picture lives (IMAGES_DIR), the stored turn keeps their file names (`ThreadEntry.images`, `BoardMessage.images`, read back
 * through GET /api/images/<name>), and the delivery names the files under the images header, so the
 * session's host gets them as it gets a chat picture (the daemon adds them as image blocks).
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import { IMAGES_DIR } from '../constants.js';
import { attachmentHeaderBlock } from '../lib/attachment-headers.js';

/** Pictures per message, the chat's cap (MAX_IMAGES_PER_MESSAGE in web/routes/images.ts). */
export const MAX_ANSWER_PICTURES = 5;
const NAME_RE = /^[\w.-]{1,200}\.(?:png|jpe?g|gif|webp)$/i;

/** The picture file names a stored turn may carry: plain names in IMAGES_DIR, never a path. */
export function cleanPictureNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const n of raw) {
    if (typeof n === 'string' && NAME_RE.test(n) && !n.includes('..') && !n.startsWith('.') && !out.includes(n)) out.push(n);
    if (out.length >= MAX_ANSWER_PICTURES) break;
  }
  return out;
}

/**
 * A request body's pictures, saved: the file names, in order (none when it carries none).
 *
 * Every picture is kept or this throws ImageAttachError (web/routes/images.ts) naming the one
 * that cannot go: a bad entry, more than MAX_ANSWER_PICTURES, an upload no longer on disk, a
 * save that failed. Every caller runs it before anything is recorded, so the answer is refused
 * with the reason and the box keeps the words and the pictures (2026-11-23, the user: messages,
 * and what they carry, are never lost). Before, a picture that could not be saved was logged
 * and left out, and the words went on without it.
 */
export async function saveAnswerPictures(body: { images?: unknown; imageRefs?: unknown }): Promise<string[]> {
  const { ImageAttachError, checkImageRefNames, checkImagePayloads, savePicturesToDisk } = await import('../web/routes/images.js');
  // Uploaded names: already on disk, only checked.
  if (Array.isArray(body.imageRefs) && body.imageRefs.length > 0) {
    const names = checkImageRefNames(body.imageRefs, MAX_ANSWER_PICTURES);
    for (const [i, n] of names.entries()) {
      const which = names.length === 1 ? 'The picture' : `Picture ${i + 1} of ${names.length}`;
      if (cleanPictureNames([n]).length === 0) throw new ImageAttachError('image_invalid', `${which} names no uploaded picture. Attach it again.`);
      if (!(await isPictureFile(n))) throw new ImageAttachError('image_not_found', `${which} is no longer on the server. Remove it and attach it again.`);
    }
    return [...new Set(names)];
  }
  const inline = checkImagePayloads(body.images, MAX_ANSWER_PICTURES);
  if (inline.length === 0) return [];
  return [...new Set((await savePicturesToDisk(inline)).map((s) => s.filename))];
}

async function isPictureFile(name: string): Promise<boolean> {
  return fsp.stat(path.join(IMAGES_DIR, name)).then((s) => s.isFile(), () => false);
}

/**
 * The companion's half: its own uploads (`imageRefs`) are files on THIS box, which the Mac
 * cannot read, so they travel to the Mac inline, with the phone's inline ones. All or an
 * ImageAttachError, as saveAnswerPictures: never a shorter list than was sent.
 */
export async function inlineAnswerPictures(body: { images?: unknown; imageRefs?: unknown }): Promise<Array<{ data: string; mediaType: string }>> {
  const { checkImagePayloads, resolveImageRefs } = await import('../web/routes/images.js');
  if (Array.isArray(body.imageRefs) && body.imageRefs.length > 0) {
    const got = await resolveImageRefs(body.imageRefs, MAX_ANSWER_PICTURES);
    return (got?.imageContentBlocks ?? []).map((b) => ({ data: b.source.data, mediaType: b.source.media_type }));
  }
  return checkImagePayloads(body.images, MAX_ANSWER_PICTURES);
}

/** The images header naming the pictures that are still on disk, or '' for none. */
export async function picturesHeader(names: readonly string[] | undefined): Promise<string> {
  const paths: string[] = [];
  for (const n of cleanPictureNames(names ?? [])) {
    const p = path.join(IMAGES_DIR, n);
    if (await isPictureFile(n)) paths.push(p);
  }
  if (paths.length === 0) return '';
  return attachmentHeaderBlock('images', paths);
}

/**
 * An AskUserQuestion answer set with its pictures in it: the pictures saved, and the images header
 * naming them put in front of the LAST question's answer (the card offers its pictures beside that
 * one), so they reach the model in the same tool result as the words. `prepare` makes the header
 * right for the session's host: a remote host gets the files uploaded and the paths rewritten
 * (SessionManager.prepareOutbound). No picture saved = the answers as they came.
 */
export async function withAnswerPictures(
  answers: Record<string, string>,
  toolInput: Record<string, unknown> | undefined,
  pictures: { images?: unknown; imageRefs?: unknown },
  prepare: (text: string) => Promise<string>,
): Promise<{ answers: Record<string, string>; pictures: number }> {
  const keys = Object.keys(answers);
  if (keys.length === 0) return { answers, pictures: 0 };
  const names = await saveAnswerPictures(pictures);
  const header = await picturesHeader(names);
  if (!header) return { answers, pictures: 0 };
  const asked = Array.isArray(toolInput?.questions)
    ? (toolInput!.questions as Array<{ question?: unknown }>).map((q) => q?.question).filter((q): q is string => typeof q === 'string')
    : [];
  const last = [...asked].reverse().find((q) => q in answers) ?? keys[keys.length - 1];
  const shown = await prepare(header).catch(() => header);
  return { answers: { ...answers, [last]: `${shown}${answers[last]}` }, pictures: header.split('\n').filter((l) => l.startsWith('- ')).length };
}
