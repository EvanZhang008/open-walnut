/**
 * Seeing a note's picture large: markdown images and `![[embeds]]` alike.
 *
 * Reading (a read-only editor, the phone's reading mode) a click opens it. In an
 * editable note a click SELECTS the picture, as it does any object you can
 * delete, move or copy; a click on the picture already selected, a double click,
 * or Enter on a selected picture opens it (2026-11-05 review: zoom on every click
 * left no way to select an image, and Enter on a selected one deleted it).
 *
 * The click is handled here, not left to ProseMirror: its own leaf click missed a
 * React node view (an `![[embed]]`) once the note had been edited, so the embed
 * could not be selected at all, and a double click left WebKit's native
 * selection box painted over the picture. Only a press on the picture itself
 * counts, never the line beside it.
 *
 * While open, the zoom holds the keyboard (Lightbox), so a key never edits the
 * note behind it. On close the caret sits right after the picture, where it was,
 * so a key typed next never replaces it (the start of the next line was tried:
 * typing then glued words onto the next paragraph or into a heading). A picture
 * that failed to load (its missing card shows) opens nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

export interface ZoomedImage {
  src: string;
  alt: string;
  /** Document position just after the picture, where the caret goes on close. */
  after: number | null;
}

/** The loaded <img> a node view shows, or null for a card, a PDF or a failed load. */
function shownImage(el: Element | null | undefined): HTMLImageElement | null {
  const img = el instanceof HTMLImageElement ? el : el?.querySelector?.('img') ?? null;
  if (!(img instanceof HTMLImageElement)) return null;
  if (img.hidden || !img.complete || img.naturalWidth === 0) return null;
  if (img.classList.contains('ProseMirror-separator')) return null;
  return img;
}

/** The file a picture URL shows, for a picture with no alt text. */
function nameOf(src: string): string {
  try {
    const url = new URL(src, 'http://x');
    const path = url.searchParams.get('path') ?? url.pathname;
    const base = path.split('|')[0].split('/').pop() ?? '';
    return decodeURIComponent(base);
  } catch {
    return '';
  }
}

function zoomOf(img: HTMLImageElement, after: number | null): ZoomedImage | null {
  const src = img.getAttribute('data-lightbox-src') || img.currentSrc || img.src;
  return src ? { src, alt: img.alt || nameOf(src), after } : null;
}

export function useImageZoom(editor: Editor | null, readOnly: boolean) {
  const [zoomed, setZoomed] = useState<ZoomedImage | null>(null);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const view = editor.view;
    const root = view.dom;
    /** Position of the atom whose DOM holds `el`, or null. */
    const posOf = (el: Element): number | null => {
      // A position inside a leaf's view may land before or after the leaf.
      const isPictureAt = (p: number) => {
        const node = p >= 0 ? view.state.doc.nodeAt(p) : null;
        if (!node || (node.type.name !== 'image' && node.type.name !== 'wikiEmbed')) return false;
        const dom = view.nodeDOM(p);
        return !!dom && (dom === el || dom.contains(el));
      };
      try {
        const pos = view.posAtDOM(el, 0);
        if (isPictureAt(pos)) return pos;
        if (isPictureAt(pos - 1)) return pos - 1;
        return null;
      } catch {
        return null;
      }
    };
    const afterOf = (el: Element): number | null => {
      const pos = posOf(el);
      const node = pos == null ? null : view.state.doc.nodeAt(pos);
      return pos != null && node ? pos + node.nodeSize : null;
    };
    /** The loaded picture under the pointer, only when the press is on the picture itself. */
    const pictureAt = (e: MouseEvent): HTMLImageElement | null => {
      const img = shownImage((e.target as Element | null)?.closest?.('img'));
      if (!img || !root.contains(img)) return null;
      const r = img.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom ? img : null;
    };
    const isSelected = (img: HTMLImageElement) => {
      const sel = view.state.selection;
      return sel instanceof NodeSelection && posOf(img) === sel.from;
    };
    const open = (img: HTMLImageElement, e: Event) => {
      const z = zoomOf(img, afterOf(img));
      if (!z) return;
      e.preventDefault();
      setZoomed(z);
    };
    // Recorded at the press, before it changes the selection: a click on the
    // picture that was ALREADY selected opens it.
    let pressedSelected = false;
    const onDown = (e: MouseEvent) => {
      pressedSelected = false;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const img = pictureAt(e);
      if (!img) return;
      // No native press on a picture: no drag ghost, no WebKit selection box.
      e.preventDefault();
      if (readOnly || !editor.isEditable) return;
      pressedSelected = isSelected(img);
      const pos = posOf(img);
      if (pos != null && !pressedSelected) {
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
      }
      view.focus();
    };
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const img = pictureAt(e);
      if (!img) return;
      if (readOnly || !editor.isEditable || pressedSelected) open(img, e);
    };
    const onDouble = (e: MouseEvent) => {
      const img = pictureAt(e);
      if (img) open(img, e);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.isComposing) return;
      const sel = view.state.selection;
      if (!(sel instanceof NodeSelection)) return;
      const img = shownImage(view.nodeDOM(sel.from) as Element | null);
      if (!img) return;
      const z = zoomOf(img, sel.to);
      if (!z) return;
      e.preventDefault();
      e.stopPropagation();
      setZoomed(z);
    };
    // Capture: ahead of ProseMirror's own press handling on the same element.
    root.addEventListener('mousedown', onDown, true);
    root.addEventListener('click', onClick);
    root.addEventListener('dblclick', onDouble);
    root.addEventListener('keydown', onKey, true);
    return () => {
      root.removeEventListener('mousedown', onDown, true);
      root.removeEventListener('click', onClick);
      root.removeEventListener('dblclick', onDouble);
      root.removeEventListener('keydown', onKey, true);
    };
  }, [editor, readOnly]);

  const close = useCallback(() => {
    const after = zoomed?.after;
    setZoomed(null);
    if (!editor || editor.isDestroyed) return;
    const { state, view } = editor;
    if (after != null && after <= state.doc.content.size) {
      try {
        view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, after)));
      } catch { /* the document changed under the zoom: leave the selection */ }
    }
    if (editor.isEditable) view.focus();
  }, [editor, zoomed]);

  return { zoomed, closeZoom: close };
}
