/**
 * Pictures a person attaches to words for an AI: one rule set for every box that takes them
 * (the chat composer, ChatInput, and every answer box, AnswerBox; 2026-11-03, the user: "the follow up
 * in org thread or anywhere ... should be able to copy pictures"). Same types, same limit, same read,
 * same paste rule, so a picture that the chat takes is taken everywhere and nowhere else differs.
 */
import { useCallback, useMemo, useState } from 'react';
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
  /** Reads and appends what fits under MAX_IMAGES; files that are not pictures are ignored. */
  add: (files: FileList | readonly File[]) => void;
  remove: (index: number) => void;
  clear: () => void;
  /** Put pictures back (a failed send restores what it took). */
  set: (images: ImageAttachment[]) => void;
  full: boolean;
}

export function useImageAttachments(): ImageAttachments {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  // The reads start here, never inside a state updater: React may run an updater twice, and a read
  // started there appended every picture twice (the ChatInput bug this rule came from).
  const add = useCallback((files: FileList | readonly File[]) => {
    for (const file of imageFilesOf(files)) {
      void readImageFile(file).then((img) => {
        if (img) setImages((curr) => (curr.length >= MAX_IMAGES ? curr : [...curr, img]));
      });
    }
  }, []);
  const remove = useCallback((index: number) => setImages((curr) => curr.filter((_, i) => i !== index)), []);
  const clear = useCallback(() => setImages([]), []);
  const set = useCallback((next: ImageAttachment[]) => setImages(next.slice(0, MAX_IMAGES)), []);
  return useMemo(() => ({ images, add, remove, clear, set, full: images.length >= MAX_IMAGES }), [images, add, remove, clear, set]);
}
