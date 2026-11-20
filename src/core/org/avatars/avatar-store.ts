/**
 * Setting a task's Org avatar (Task.org_avatar), and drawing new ones with the model.
 *
 *  - set   a preset ("<character>:<colour>"), an SVG of its own, or a PNG/JPEG/WebP data URL (an
 *          upload, cut square and made small by the page); reset clears it back to the default.
 *          The user and any agent set it the same way (org_avatar_set); each write names who.
 *  - draw  one short call to the user's own main model (model.ts sendMessage, as the drawing
 *          editor's diagrams do): three SVG avatars in the Org style for a description, checked
 *          like a set SVG. Nothing is written; the person picks one and sets it.
 *
 * A picture is shown only through <img> (and turned into a PNG for the phone by sharp), where an
 * SVG runs no script and loads nothing; the checks below refuse such parts anyway, so a stored
 * picture never carries them.
 */
import type { Task } from '../../types.js';
import { log } from '../../../logging/index.js';
import { OrgError } from '../org-store.js';
import type { OrgWriter } from '../org-node-edit.js';
import { AVATAR_CHARACTERS, parsePreset } from './avatar-art.js';
import { IMAGE_DATA_URL } from './avatar-assign.js';

/** The file a data URL's bytes really are, by their first bytes (its label can say anything). */
function imageBytesKind(dataUrl: string): 'png' | 'jpeg' | 'webp' | null {
  const b = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1, dataUrl.indexOf(',') + 1 + 24), 'base64');
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export const MAX_AVATAR_SVG = 24_000;
/** An upload is made 128 px WebP (or PNG, JPEG) by the page: a few KB, carried on every task list. */
export const MAX_AVATAR_IMAGE = 48_000;
export const MAX_AVATAR_PROMPT = 400;
/** The only elements a picture may hold: shapes, paint and simple filters. Never one that loads
 *  or includes anything (image, use, feImage, xi:include, foreignObject, script). */
const SVG_ELEMENTS = new Set(['svg', 'g', 'defs', 'clippath', 'mask', 'path', 'circle', 'ellipse', 'rect', 'line',
  'polyline', 'polygon', 'lineargradient', 'radialgradient', 'stop', 'pattern', 'symbol', 'marker', 'title', 'desc',
  'text', 'tspan', 'style', 'filter', 'fegaussianblur', 'feoffset', 'feblend', 'feflood', 'fecomposite', 'femerge',
  'femergenode', 'fecolormatrix', 'fedropshadow', 'femorphology']);
/** Script, event handlers, imports, any reference that is not to a part of the picture itself, and
 *  any backslash (a CSS escape such as u\72l( would hide a url( from these checks). */
const UNSAFE_SVG = /\\|\son[a-z]+\s*=|javascript:|@import|(?:href|src)\s*=(?!\s*["']?\s*#)|url\((?!\s*["']?\s*#)/i;

export interface AvatarInput { preset?: unknown; svg?: unknown; image?: unknown; reset?: unknown }

/** The SVG checks: one <svg> element, small, with nothing that runs or loads. */
export function checkAvatarSvg(raw: unknown): string {
  if (typeof raw !== 'string') throw new OrgError('bad_avatar', 400, '`svg` is SVG text.');
  const svg = raw.trim();
  if (svg.length > MAX_AVATAR_SVG) throw new OrgError('bad_avatar', 413, `The SVG is ${svg.length} characters; at most ${MAX_AVATAR_SVG}.`);
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>$/i.test(svg)) throw new OrgError('bad_avatar', 400, 'The SVG must be one <svg>…</svg> element.');
  if (!/viewBox\s*=/i.test(svg)) throw new OrgError('bad_avatar', 400, 'The SVG needs a viewBox (a square one, e.g. "0 0 100 100").');
  // No DOCTYPE, entity, CDATA or processing instruction (a renderer may resolve them); comments are fine.
  const tags = [...svg.matchAll(/<\s*\/?\s*([^\s>/]+)/g)].map((m) => m[1]!.toLowerCase());
  if (/<[!?](?!--)/.test(svg) || tags.some((t) => !t.startsWith('!--') && !SVG_ELEMENTS.has(t)) || UNSAFE_SVG.test(svg)) throw new OrgError('bad_avatar', 400, 'The SVG may hold only shapes: no script, event handlers, embedded or linked images, or links out.');
  return svg;
}

/** The stored value for an input, or null for a reset. */
export function avatarValue(input: AvatarInput, writer: OrgWriter, now = new Date()): NonNullable<Task['org_avatar']> | null {
  const given = (['preset', 'svg', 'image'] as const).filter((k) => input[k] !== undefined && input[k] !== null && input[k] !== '');
  if (input.reset === true) {
    if (given.length) throw new OrgError('bad_avatar', 400, 'Give `reset` alone.');
    return null;
  }
  if (given.length !== 1) throw new OrgError('bad_avatar', 400, 'Give one of `preset`, `svg`, `image`, or `reset: true`.');
  const stamp = { at: now.toISOString(), by: writer.by === 'human' ? 'human' : (writer.byName ?? String(writer.by)) };
  const kind = given[0]!;
  if (kind === 'preset') {
    if (typeof input.preset !== 'string' || !parsePreset(input.preset)) {
      throw new OrgError('bad_avatar', 400, `Unknown preset "${String(input.preset)}": "<character>:<colour 0-13>", characters ${AVATAR_CHARACTERS.map((c) => c.id).join(', ')}.`);
    }
    return { preset: input.preset, ...stamp };
  }
  if (kind === 'svg') return { svg: checkAvatarSvg(input.svg), ...stamp };
  const image = typeof input.image === 'string' ? input.image.trim() : '';
  if (!IMAGE_DATA_URL.test(image)) throw new OrgError('bad_avatar', 400, '`image` is a PNG, JPEG or WebP data URL (data:image/png;base64,...).');
  const labelled = IMAGE_DATA_URL.exec(image)?.[1];
  if (imageBytesKind(image) !== labelled) throw new OrgError('bad_avatar', 400, `The image's bytes are not a ${labelled?.toUpperCase()} picture.`);
  if (image.length > MAX_AVATAR_IMAGE) throw new OrgError('bad_avatar', 413, `The image is ${image.length} characters; at most ${MAX_AVATAR_IMAGE} (make it 256 px or smaller).`);
  return { image, ...stamp };
}

/** Set (or reset) one task's avatar. */
export async function setOrgAvatar(taskId: string, input: AvatarInput, writer: OrgWriter): Promise<Task> {
  const value = avatarValue(input, writer);
  const tm = await import('../../task-manager.js');
  const task = await tm.getTask(taskId).catch(() => null);
  if (!task) throw new OrgError('not_found', 404, `No task "${taskId}".`);
  if (!value && !task.org_avatar) return task;
  await tm.updateTaskRaw(task.id, { org_avatar: value as Task['org_avatar'] }, { emitEvent: true, source: 'api' });
  log.task.info('org: avatar set', { taskId: task.id, kind: value ? Object.keys(value).find((k) => k !== 'at' && k !== 'by') : 'reset', by: value?.by });
  return tm.getTask(task.id);
}

// ── Drawing ──

export const avatarDrawTuning = { deadlineMs: 120_000 };

const DRAW_SYSTEM = `You draw small, cute avatar icons as SVG for an app's org page, where they show at 34 px.
The house style: a square 100x100 viewBox, a soft pastel background filling it (a rect with rx="22"),
ONE fat round blob as the body (wider than tall, sitting low, slightly tilted), a simple face (two dark
oval eyes, a short curved mouth, soft white blush), and one or two small, bold features that say what
the character is about. Flat shapes only, few of them, no text, no gradients, no filters, no images,
no external references, no <use>. Use only svg, g, defs, clipPath, path, circle, ellipse, rect, line,
polyline and polygon. Keep each SVG under 4000 characters.
Answer with exactly three different SVGs, each a complete <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">…</svg>
element, one after another, and nothing else.`;

/** The <svg> elements in a reply that pass the checks, at most three. */
export function svgsInReply(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<svg[\s>][\s\S]*?<\/svg>/gi)) {
    try { out.push(checkAvatarSvg(m[0])); } catch { /* a bad one is left out */ }
    if (out.length === 3) break;
  }
  return out;
}

/** Three avatars drawn for `prompt` (the node's name helps the model). */
export async function drawOrgAvatars(input: { prompt?: unknown; name?: unknown; taskId?: unknown }, opts: { signal?: AbortSignal } = {}): Promise<string[]> {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  if (!prompt && !name) throw new OrgError('bad_prompt', 400, 'Say what to draw (`prompt`), or name the node (`name`).');
  if (prompt.length > MAX_AVATAR_PROMPT) throw new OrgError('bad_prompt', 400, `The description is ${prompt.length} characters; at most ${MAX_AVATAR_PROMPT}.`);
  const timeout = AbortSignal.timeout(avatarDrawTuning.deadlineMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const { sendMessage } = await import('../../../model/model.js');
  const { replyText } = await import('../../../model/reply-text.js');
  const ask = `${name ? `The node is called "${name}". ` : ''}${prompt ? `Draw: ${prompt}` : 'Draw a character that fits its name.'}`;
  let lastProblem = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let text = '';
    try {
      const result = await sendMessage({
        system: DRAW_SYSTEM,
        messages: [{ role: 'user', content: ask }],
        config: { maxTokens: 8192 },
        signal,
        purpose: 'interactive',
        usage: { source: 'avatar', ...(typeof input.taskId === 'string' && input.taskId ? { taskId: input.taskId } : {}) },
      });
      if (result.aborted) throw new Error('aborted');
      text = replyText(result);
    } catch (err) {
      if (timeout.aborted) throw new OrgError('draw_timeout', 504, `The model did not answer within ${Math.round(avatarDrawTuning.deadlineMs / 1000)} s.`);
      if (opts.signal?.aborted) throw new OrgError('draw_cancelled', 503, 'The drawing was cancelled.');
      throw new OrgError('draw_failed', 502, `The model call failed: ${(err as Error).message}`);
    }
    const svgs = svgsInReply(text);
    if (svgs.length) return svgs;
    lastProblem = text ? 'its answer held no usable SVG' : 'it answered nothing';
    log.task.warn('org: avatar draw answer unusable', { attempt, problem: lastProblem, chars: text.length });
  }
  throw new OrgError('draw_failed', 502, `The model could not draw an avatar: ${lastProblem}.`);
}
