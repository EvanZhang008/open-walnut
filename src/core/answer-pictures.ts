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

/** Pictures per message, the chat's cap (MAX_IMAGES_PER_MESSAGE in web/routes/images.ts). */
export const MAX_ANSWER_PICTURES = 5;
const NAME_RE = /^[\w.-]{1,200}\.(?:png|jpe?g|gif|webp)$/i;
const MAX_INLINE_BASE64 = 14_000_000;
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

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

/** A request body's pictures, saved: the file names, in order (none when it carries none). */
export async function saveAnswerPictures(body: { images?: unknown; imageRefs?: unknown }): Promise<string[]> {
  // Never throws: the words are the answer, and a picture that cannot be saved (a corrupt one, a
  // full disk) must not cost them (the record goes first, letter-ops.ts). Logged, then left out.
  try {
    // Uploaded names: already on disk, only checked.
    if (Array.isArray(body.imageRefs) && body.imageRefs.length > 0) {
      const names = cleanPictureNames(body.imageRefs.map((r) => (r && typeof r === 'object' ? (r as { filename?: unknown }).filename : r)));
      const kept: string[] = [];
      for (const n of names) if (await isPictureFile(n)) kept.push(n);
      return kept;
    }
    const inline = Array.isArray(body.images) ? body.images.filter(isInlinePicture) : [];
    if (inline.length === 0) return [];
    const { processAndSaveImages } = await import('../web/routes/images.js');
    const saved = await processAndSaveImages(inline.slice(0, MAX_ANSWER_PICTURES));
    return cleanPictureNames(saved?.savedImages.map((s) => s.filename) ?? []);
  } catch (err) {
    const { log } = await import('../logging/index.js');
    log.web.warn('answer pictures not saved; the words go without them', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

async function isPictureFile(name: string): Promise<boolean> {
  return fsp.stat(path.join(IMAGES_DIR, name)).then((s) => s.isFile(), () => false);
}

/**
 * The companion's half: its own uploads (`imageRefs`) are files on THIS box, which the Mac
 * cannot read, so they travel to the Mac inline, with the phone's inline ones.
 */
export async function inlineAnswerPictures(body: { images?: unknown; imageRefs?: unknown }): Promise<Array<{ data: string; mediaType: string }>> {
  const out: Array<{ data: string; mediaType: string }> = [];
  if (Array.isArray(body.imageRefs) && body.imageRefs.length > 0) {
    const { resolveImageRefs } = await import('../web/routes/images.js');
    const got = await resolveImageRefs(body.imageRefs).catch(() => null);
    for (const b of got?.imageContentBlocks ?? []) out.push({ data: b.source.data, mediaType: b.source.media_type });
  } else if (Array.isArray(body.images)) {
    for (const img of body.images) if (isInlinePicture(img)) out.push({ data: img.data, mediaType: img.mediaType });
  }
  return out.slice(0, MAX_ANSWER_PICTURES);
}

function isInlinePicture(img: unknown): img is { data: string; mediaType: string } {
  const i = img as { data?: unknown; mediaType?: unknown } | null;
  return !!i && typeof i.data === 'string' && i.data.length > 0 && i.data.length <= MAX_INLINE_BASE64
    && typeof i.mediaType === 'string' && INLINE_TYPES.has(i.mediaType);
}

/** The images header naming the pictures that are still on disk, or '' for none. */
export async function picturesHeader(names: readonly string[] | undefined): Promise<string> {
  const paths: string[] = [];
  for (const n of cleanPictureNames(names ?? [])) {
    const p = path.join(IMAGES_DIR, n);
    if (await isPictureFile(n)) paths.push(p);
  }
  if (paths.length === 0) return '';
  // Loaded here, not at the top: the store imports this file for cleanPictureNames.
  const { IMAGES_ATTACHED_LINE } = await import('./sessions/cloud-images.js');
  return `${IMAGES_ATTACHED_LINE}\n${paths.map((p) => `- ${p}`).join('\n')}\n\n`;
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
