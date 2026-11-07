/**
 * What a chat composer holds attached: pictures and, where the box takes them,
 * any other file. Each one uploads the moment it is attached, with its own
 * progress, and a failed one can be retried or removed on its own; the message
 * can go once every one is up (the composer says what it waits for).
 *
 * - A picture (png, jpeg, gif, webp, and a HEIC photo turned into a JPEG) is read
 *   for its preview and uploaded to the images folder (`POST /api/images/upload`);
 *   the send then names it by that upload (`url`), so it is never sent twice.
 * - Any other file goes up in chunks to the host the message is for
 *   (api/file-upload.ts) and the send names its saved path under the
 *   `[Files attached …]` header.
 * - A box that takes pictures only (an answer box) ignores other files as before.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ImageAttachment } from '@/api/chat';
import { uploadImageWithProgress } from '@/api/image-upload';
import {
  FileUploadError, MAX_FILES, MAX_FILE_BYTES, formatBytes, newUploadId, safeUploadName, uploadFile,
  type UploadTarget,
} from '@/api/file-upload';
import { heicToJpeg, isHeicFile } from '@/utils/heic-to-jpeg';
import { KEPT_ATTACHMENTS_PREFIX } from '@/utils/kept-attachments-key';
import { IMAGE_TYPES, MAX_IMAGES, readImageFile } from './image-attachments';

/** A picture the images folder takes (its upload route refuses more: 10M base64 characters). */
export const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
/**
 * Uploads at once per composer. More share the browser's six connections to the
 * server with every other request the page makes, and on a slow link (the cloud
 * companion, a phone network) the whole page waits behind 2 MB chunks.
 */
const MAX_PARALLEL_UPLOADS = 2;

export type AttachmentStatus = 'preparing' | 'uploading' | 'done' | 'failed';

export interface ComposerAttachment {
  id: string;
  kind: 'image' | 'file';
  /** The name shown (and, for a file, the name saved on the host). */
  name: string;
  size: number;
  mediaType: string;
  status: AttachmentStatus;
  /** Bytes the server holds so far. */
  sent: number;
  error?: string;
  /** A picture's preview, with `url` once it is uploaded. */
  image?: ImageAttachment;
  /** A file's path on its host, once uploaded. */
  path?: string;
  /** A HEIC photo sent as a JPEG. */
  converted?: boolean;
  /** Its bytes are gone (the page closed before it was up): it can only be removed, and attached again. */
  orphan?: boolean;
}

/** What a kept attachment that was still uploading says when the box shows it again. */
export const ORPHAN_ERROR = 'Its upload stopped before it finished (the page closed or the box changed): remove it and attach it again';

/** The limits in a few words, for the "+" menu's attach row. */
export function attachmentLimitsShort(acceptsFiles: boolean): string {
  return acceptsFiles ? `${MAX_FILES} files (${formatBytes(MAX_FILE_BYTES)} each), ${MAX_IMAGES} images` : `Up to ${MAX_IMAGES} images`;
}

/** The limits a composer states, in its own words. */
export function attachmentLimitsText(acceptsFiles: boolean): string {
  return acceptsFiles
    ? `Up to ${MAX_FILES} files (${formatBytes(MAX_FILE_BYTES)} each) and ${MAX_IMAGES} images per message`
    : `Up to ${MAX_IMAGES} images per message`;
}

interface Held {
  kind: ComposerAttachment['kind'];
  file: File;
  abort?: AbortController;
  uploadId: string;
  target?: UploadTarget;
}

export interface ComposerAttachments {
  items: ComposerAttachment[];
  /** Read, convert and start uploading; answers a sentence about anything it left out, or null. */
  add: (files: FileList | readonly File[]) => Promise<string | null>;
  retry: (id: string) => void;
  remove: (id: string) => void;
  /** Forget them all (a sent message); uploads in flight stop. */
  clear: () => void;
  /** Put sent ones back after a send that failed (their uploads stay done). */
  restore: (items: ComposerAttachment[]) => void;
  /** A kept picture's bytes, read back from its upload (a send that inlines pictures needs them). */
  fillImage: (id: string, data: string) => void;
  /** Uploads not finished yet. */
  pending: number;
  failed: number;
  imageCount: number;
  fileCount: number;
}

let seq = 0;
const nextId = () => `att-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function isPictureFile(file: File): boolean {
  return IMAGE_TYPES.has(file.type);
}

/**
 * The attachments of one composer. `target` is where files go (null: the box
 * takes pictures only). A target that changes (another session) drops the
 * files uploaded for the previous one, which live on that session's host.
 */
export function useComposerAttachments(target: UploadTarget | null): ComposerAttachments {
  const [items, setItems] = useState<ComposerAttachment[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const held = useRef(new Map<string, Held>());
  const targetRef = useRef(target);
  targetRef.current = target;
  const targetKey = target ? (target.sessionId ?? '__unbound__') : null;
  // Files given to add() and not yet read (a HEIC conversion, a picture's
  // preview): counted as pending, so a send made meanwhile waits for them.
  const [reading, setReading] = useState(0);
  // Moves on with every clear and change of target: a read that finishes after
  // it belongs to a box that has moved on, and is dropped.
  const generation = useRef(0);

  const patch = useCallback((id: string, next: Partial<ComposerAttachment>) => {
    setItems((curr) => curr.map((a) => (a.id === id ? { ...a, ...next } : a)));
  }, []);

  // Waiting to upload, in the order attached, and the ids uploading now.
  const waiting = useRef<ComposerAttachment[]>([]);
  const running = useRef(new Set<string>());
  const runRef = useRef<(item: ComposerAttachment) => void>(() => {});

  const pump = useCallback(() => {
    while (running.current.size < MAX_PARALLEL_UPLOADS && waiting.current.length > 0) {
      const next = waiting.current.shift()!;
      if (!held.current.has(next.id)) continue;
      running.current.add(next.id);
      runRef.current(next);
    }
  }, []);

  /** Queue an upload (again, for a retry); it starts once fewer than MAX_PARALLEL_UPLOADS run. */
  const start = useCallback((item: ComposerAttachment) => {
    const h = held.current.get(item.id);
    if (!h) return;
    h.abort?.abort();
    h.abort = undefined;
    running.current.delete(item.id);
    waiting.current = waiting.current.filter((w) => w.id !== item.id);
    patch(item.id, { status: 'preparing', sent: 0, error: undefined });
    waiting.current.push(item);
    pump();
  }, [patch, pump]);

  const run = useCallback((item: ComposerAttachment) => {
    const h = held.current.get(item.id);
    if (!h) { running.current.delete(item.id); pump(); return; }
    const abort = new AbortController();
    h.abort = abort;
    // The slot frees once this try ends, however it ends (a remove aborts it).
    const settle = () => { if (running.current.delete(item.id)) pump(); };
    abort.signal.addEventListener('abort', settle, { once: true });
    patch(item.id, { status: 'uploading', sent: 0, error: undefined });
    let last = 0;
    const onProgress = (sent: number) => {
      // A re-render per progress event floods React on a fast link: every 1%.
      if (sent !== item.size && sent - last < Math.max(1, item.size / 100)) return;
      last = sent;
      if (!abort.signal.aborted) patch(item.id, { sent });
    };
    const done = (result: Partial<ComposerAttachment>) => {
      settle();
      if (abort.signal.aborted || !held.current.has(item.id)) return;
      patch(item.id, { status: 'done', sent: item.size, ...result });
    };
    const fail = (err: unknown) => {
      settle();
      if (abort.signal.aborted || !held.current.has(item.id)) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const message = err instanceof FileUploadError || err instanceof Error ? err.message : 'Upload failed';
      patch(item.id, { status: 'failed', error: message });
    };
    if (item.kind === 'image' && item.image) {
      const image = item.image;
      uploadImageWithProgress(image, { signal: abort.signal, onProgress })
        .then((url) => done({ image: { ...image, url } }), fail);
      return;
    }
    const to = targetRef.current;
    if (!to) { fail(new Error('This box cannot take files')); return; }
    h.target = to;
    uploadFile(h.file, to, { uploadId: h.uploadId, name: item.name, signal: abort.signal, onProgress })
      .then((path) => done({ path }), fail);
  }, [patch, pump]);
  runRef.current = run;

  // One add at a time: each awaits reads and conversions before it takes a place,
  // so two quick adds (a drop and a paste, eight pastes) running side by side
  // would each see room under the limits and together go past them.
  const adding = useRef<Promise<unknown>>(Promise.resolve());

  const addNow = useCallback(async (list: readonly File[], gen: number): Promise<string | null> => {
    const files = list;
    const acceptsFiles = !!targetRef.current;
    let unread = files.length;
    const readOne = () => { unread--; setReading((n) => Math.max(0, n - 1)); };
    try {
      const left: string[] = [];
      const countOf = (kind: Held['kind']) => [...held.current.values()].filter((h) => h.kind === kind).length;
      for (const original of files) {
        if (gen !== generation.current) break;
        let file = original;
        let converted = false;
        if (isHeicFile(file)) {
          const jpeg = await heicToJpeg(file);
          if (jpeg) { file = jpeg; converted = true; }
        }
        if (gen !== generation.current) break;
        const picture = isPictureFile(file) && file.size <= MAX_IMAGE_BYTES;
        if (picture && countOf('image') < MAX_IMAGES) {
          const image = await readImageFile(file);
          if (gen !== generation.current) break;
          readOne();
          if (!image) { left.push(`${original.name || 'A picture'} could not be read`); continue; }
          const item: ComposerAttachment = {
            id: nextId(), kind: 'image', name: image.name, size: file.size, mediaType: image.mediaType,
            status: 'preparing', sent: 0, image, ...(converted ? { converted } : {}),
          };
          held.current.set(item.id, { kind: 'image', file, uploadId: '' });
          setItems((curr) => [...curr, item]);
          start(item);
          continue;
        }
        readOne();
        // A picture past the image limits still goes, as a file, where the box takes files.
        if (!acceptsFiles) {
          left.push(picture ? `Only ${MAX_IMAGES} images fit in one message`
            : isPictureFile(file) ? `${original.name || 'That picture'} is over ${formatBytes(MAX_IMAGE_BYTES)}`
              : `${original.name || 'That file'} is not a picture; this box takes pictures only`);
          continue;
        }
        if (countOf('file') >= MAX_FILES) { left.push(`Only ${MAX_FILES} files fit in one message`); continue; }
        if (file.size > MAX_FILE_BYTES) { left.push(`${original.name} is over ${formatBytes(MAX_FILE_BYTES)}`); continue; }
        const item: ComposerAttachment = {
          id: nextId(), kind: 'file', name: safeUploadName(file.name || 'file'), size: file.size,
          mediaType: file.type || 'application/octet-stream', status: 'preparing', sent: 0,
          ...(converted ? { converted } : {}),
        };
        held.current.set(item.id, { kind: 'file', file, uploadId: newUploadId() });
        setItems((curr) => [...curr, item]);
        start(item);
      }
      if (gen !== generation.current) return null;
      if (left.length === 0) return null;
      // One sentence per kind of reason, not one per file.
      return [...new Set(left)].join('. ');
    } finally {
      // The ones never reached (the box moved on) are no longer being read.
      if (unread > 0) setReading((n) => Math.max(0, n - unread));
    }
  }, [start]);

  const add = useCallback((list: FileList | readonly File[]): Promise<string | null> => {
    const files = Array.from(list);
    if (files.length === 0) return Promise.resolve(null);
    const gen = generation.current;
    setReading((n) => n + files.length);
    const turn = adding.current.then(() => addNow(files, gen));
    adding.current = turn.catch(() => undefined);
    return turn;
  }, [addNow]);

  const retry = useCallback((id: string) => {
    const item = itemsRef.current.find((a) => a.id === id);
    const h = held.current.get(id);
    if (!item || !h || item.orphan) return;
    // A new id: the host may hold a finished or broken copy under the old one.
    if (item.kind === 'file') h.uploadId = newUploadId();
    start(item);
  }, [start]);

  // Each forgets before it aborts: an abort frees a slot, and the next upload
  // must come from what is still attached.
  const remove = useCallback((id: string) => {
    const h = held.current.get(id);
    held.current.delete(id);
    waiting.current = waiting.current.filter((w) => w.id !== id);
    h?.abort?.abort();
    setItems((curr) => curr.filter((a) => a.id !== id));
  }, []);

  const clear = useCallback(() => {
    generation.current++;
    const all = [...held.current.values()];
    held.current.clear();
    waiting.current = [];
    for (const h of all) h.abort?.abort();
    setItems([]);
  }, []);

  const restore = useCallback((back: ComposerAttachment[]) => {
    for (const a of back) if (!held.current.has(a.id)) held.current.set(a.id, { kind: a.kind, file: new File([], a.name), uploadId: '' });
    setItems((curr) => [...back.filter((a) => !curr.some((c) => c.id === a.id)), ...curr]);
  }, []);

  // Files uploaded for one session live on its host: another target drops them.
  const lastTargetKey = useRef(targetKey);
  useEffect(() => {
    if (lastTargetKey.current === targetKey) return;
    lastTargetKey.current = targetKey;
    generation.current++;
    const stale = itemsRef.current.filter((a) => a.kind === 'file');
    if (stale.length === 0) return;
    waiting.current = waiting.current.filter((w) => w.kind !== 'file');
    for (const a of stale) { const h = held.current.get(a.id); held.current.delete(a.id); h?.abort?.abort(); }
    setItems((curr) => curr.filter((a) => a.kind !== 'file'));
  }, [targetKey]);

  // Unmount: nothing keeps uploading for a box that is gone.
  useEffect(() => () => {
    waiting.current = [];
    const all = [...held.current.values()];
    held.current.clear();
    for (const h of all) h.abort?.abort();
  }, []);

  const fillImage = useCallback((id: string, data: string) => {
    setItems((curr) => curr.map((a) => (a.id === id && a.image && !a.image.data ? { ...a, image: { ...a.image, data } } : a)));
  }, []);

  return useMemo(() => ({
    items, add, retry, remove, clear, restore, fillImage,
    pending: items.filter((a) => a.status === 'preparing' || a.status === 'uploading').length + reading,
    failed: items.filter((a) => a.status === 'failed').length,
    imageCount: items.filter((a) => a.kind === 'image').length,
    fileCount: items.filter((a) => a.kind === 'file').length,
  }), [items, add, retry, remove, clear, restore, fillImage, reading]);
}

/** The pictures of a send, each named by its upload. */
export function sentImages(items: readonly ComposerAttachment[]): ImageAttachment[] {
  return items.filter((a) => a.kind === 'image' && a.image).map((a) => a.image!);
}

/** The files of a send, by their saved paths. */
export function sentFilePaths(items: readonly ComposerAttachment[]): string[] {
  return items.filter((a) => a.kind === 'file' && a.path).map((a) => a.path!);
}

/**
 * The uploaded ones as a draft keeps them over a reload: a picture by its upload
 * (its preview read back from there), a file by its saved path. One still
 * uploading or failed is not kept: its bytes are only in this page.
 */
export function savedAttachments(items: readonly ComposerAttachment[]): ComposerAttachment[] {
  return items.flatMap((a): ComposerAttachment[] => {
    const up = a.status === 'done' && (a.kind === 'file' ? !!a.path : !!a.image?.url);
    if (up) return [a.image ? { ...a, image: { ...a.image, data: '' } } : { ...a }];
    // Not up yet: kept by name only, so a reload says it is missing instead of
    // sending the words without it.
    const { image: _image, path: _path, ...rest } = a;
    return [{ ...rest, status: 'failed', sent: 0, error: ORPHAN_ERROR, orphan: true }];
  });
}

/** Kept attachments read back from storage; anything not in that shape is left out. */
export function parseSavedAttachments(raw: string | null): ComposerAttachment[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((a): a is ComposerAttachment => {
      if (!a || typeof a !== 'object') return false;
      const c = a as ComposerAttachment;
      if (typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.size !== 'number') return false;
      if (c.kind !== 'file' && c.kind !== 'image') return false;
      if (c.orphan === true) return c.status === 'failed';
      if (c.status !== 'done') return false;
      return c.kind === 'file' ? typeof c.path === 'string' : typeof c.image?.url === 'string';
    }).slice(0, MAX_FILES + MAX_IMAGES);
  } catch {
    return [];
  }
}

/**
 * Where a draft's uploaded attachments are kept, beside its words: on this
 * device only (not a `draft:` key, so the words' mirror never takes them for
 * text). A reload, or a visit to another session and back, finds them again.
 */
export function keptAttachmentsKey(draftKey: string | null | undefined): string | null {
  return draftKey ? KEPT_ATTACHMENTS_PREFIX + draftKey : null;
}

/** Pictures in the box that go as files (past the picture count or size), said once under the strip. */
export function picturesAsFilesText(items: readonly ComposerAttachment[]): string | null {
  const n = items.filter((a) => a.kind === 'file' && a.mediaType.startsWith('image/')).length;
  if (n === 0) return null;
  const why = `a message shows ${MAX_IMAGES} pictures, each up to ${formatBytes(MAX_IMAGE_BYTES)}`;
  return n === 1 ? `One picture goes as a file (${why})` : `${n} pictures go as files (${why})`;
}
