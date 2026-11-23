/**
 * Pictures a person attaches to words for an AI: one rule set for every box that takes them
 * (the chat composer, ChatInput, and every answer box, AnswerBox; 2026-11-03, the user: "the follow up
 * in org thread or anywhere ... should be able to copy pictures"). Same types, same limit, same read,
 * same paste rule, so a picture that the chat takes is taken everywhere and nowhere else differs.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ImageAttachment } from '@/api/chat';
import { isOfficeClipboardHtml } from '@/utils/html-to-markdown';

export const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const IMAGE_ACCEPT = [...IMAGE_TYPES].join(',');
/** Pictures per message (the server keeps the same cap, MAX_IMAGES_PER_MESSAGE). */
export const MAX_IMAGES = 5;

export function imageFilesOf(files: FileList | readonly File[] | null | undefined): File[] {
  return files ? Array.from(files).filter((f) => IMAGE_TYPES.has(f.type)) : [];
}

/**
 * The pictures of a paste, or none. Excel, Word and PowerPoint put a picture of the selection
 * beside the real HTML: for an Office clipboard the text is what was copied, so no picture.
 */
export function pastedImageFiles(e: { clipboardData?: DataTransfer | null }): File[] {
  if (isOfficeClipboardHtml(e.clipboardData?.getData('text/html'))) return [];
  return imageFilesOf(e.clipboardData?.files);
}

/** One file as an attachment (raw base64, no data-URL prefix), or null when it cannot be read. */
export function readImageFile(file: File): Promise<ImageAttachment | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result ?? '').split(',')[1];
      resolve(base64 ? { data: base64, mediaType: file.type, name: file.name || 'pasted-image' } : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** The pictures held by one answer box, owned by the box's owner (it sends and clears them). */
export interface ImageAttachments {
  images: ImageAttachment[];
  /**
   * Reads and appends what fits under MAX_IMAGES. Anything it does not take (one past the limit,
   * a file that is not a PNG, JPEG, GIF or WebP picture, one that cannot be read) is said in
   * `notice`, never left out without a word.
   */
  add: (files: FileList | readonly File[]) => void;
  remove: (index: number) => void;
  clear: () => void;
  /** Put pictures back (a failed send restores what it took). */
  set: (images: ImageAttachment[]) => void;
  full: boolean;
  /** What the last add left out and why, shown beside the box (PictureStrip); null when it took everything. */
  notice: string | null;
}

/**
 * The sentence for what an add left out: one per reason, not one per file. Exported for its test.
 */
export function leftOutNotice(left: { over: number; notPictures: string[]; unreadable: string[] }): string | null {
  const parts: string[] = [];
  if (left.over > 0) parts.push(`Only ${MAX_IMAGES} pictures fit in one message; ${left.over === 1 ? '1 was' : `${left.over} were`} not added`);
  if (left.notPictures.length > 0) parts.push(`${left.notPictures.join(', ')} ${left.notPictures.length === 1 ? 'is' : 'are'} not a PNG, JPEG, GIF or WebP picture`);
  if (left.unreadable.length > 0) parts.push(`${left.unreadable.join(', ')} could not be read`);
  return parts.length > 0 ? `${parts.join('. ')}.` : null;
}

export function useImageAttachments(): ImageAttachments {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // The pictures held plus the reads still out, so an add knows what fits before its reads land.
  // Kept by add, remove, clear and set alone (every change to the pictures goes through them).
  const held = useRef(0);
  // Bumped by clear and set: a read that started before them belongs to a message that is gone
  // (sent, or put back) and must not land in the box that follows.
  const generation = useRef(0);
  // The reads start here, never inside a state updater: React may run an updater twice, and a read
  // started there appended every picture twice (the ChatInput bug this rule came from).
  const add = useCallback((files: FileList | readonly File[]) => {
    const all = files ? Array.from(files) : [];
    const left = { over: 0, notPictures: [] as string[], unreadable: [] as string[] };
    const reads: Array<Promise<void>> = [];
    const gen = generation.current;
    for (const file of all) {
      if (!IMAGE_TYPES.has(file.type)) { left.notPictures.push(file.name || 'That file'); continue; }
      if (held.current >= MAX_IMAGES) { left.over++; continue; }
      held.current++;
      reads.push(readImageFile(file).then((img) => {
        if (gen !== generation.current) return;
        if (!img) { held.current--; left.unreadable.push(file.name || 'A picture'); return; }
        setImages((curr) => [...curr, img]);
      }));
    }
    setNotice(leftOutNotice(left));
    if (reads.length > 0) void Promise.all(reads).then(() => { if (gen === generation.current && left.unreadable.length > 0) setNotice(leftOutNotice(left)); });
  }, []);
  const remove = useCallback((index: number) => {
    setImages((curr) => curr.filter((_, i) => i !== index));
    held.current = Math.max(0, held.current - 1);
    setNotice(null);
  }, []);
  const clear = useCallback(() => { generation.current++; setImages([]); held.current = 0; setNotice(null); }, []);
  const set = useCallback((next: ImageAttachment[]) => {
    // A restore after a failed send puts back what it took: never more than the box ever held.
    const kept = next.slice(0, MAX_IMAGES);
    generation.current++;
    setImages(kept);
    held.current = kept.length;
    setNotice(next.length > MAX_IMAGES ? leftOutNotice({ over: next.length - MAX_IMAGES, notPictures: [], unreadable: [] }) : null);
  }, []);
  return useMemo(() => ({ images, add, remove, clear, set, full: images.length >= MAX_IMAGES, notice }), [images, add, remove, clear, set, notice]);
}
