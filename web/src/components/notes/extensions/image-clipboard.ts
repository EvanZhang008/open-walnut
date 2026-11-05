/**
 * An image copied from one vault note keeps pointing at its file when pasted
 * into another.
 *
 * A markdown image's path is relative to its note (`![](photo.png)`). Copied as
 * HTML, its painted URL carries the source note and ResolvedImage's parse rule
 * rewrites it for the target (`unproxyImageSrc`). Copied as plain text only (the
 * markdown, which is all some engines hand a paste: Linux WebKit, 2026-11-05
 * review), the path arrives as written in the SOURCE note and named nothing from
 * the target. So every copy also carries the source note under its own type,
 * and a plain-text paste into another note rebases each relative image path.
 * Some engines drop a custom type on the way (Linux WebKit hands a paste only
 * text/plain): the last copy made here is also remembered with its text, and a
 * paste of exactly that text counts as coming from that note.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { imageSrcForFile, rebaseImageSrc, vaultFileOf } from './resolved-image';
import { drawnUrl } from '../image-load';

/** Clipboard type holding the vault path of the note a copy came from. */
export const NOTE_CLIPBOARD_TYPE = 'application/x-walnut-note-path';
/**
 * Clipboard type holding, for each copied image that drew, the vault file it
 * drew (`{ src: file }`). A path written relative to the note may have drawn the
 * same path from the vault's root instead (2026-11-05 review): rebased as
 * written, the paste named a file that is not there.
 */
export const NOTE_FILES_CLIPBOARD_TYPE = 'application/x-walnut-note-files';

/** Vault file each image of `slice` drew in note `note`, by src. */
export function drawnFilesOf(slice: Slice, note: string): Record<string, string> {
  const files: Record<string, string> = {};
  slice.content.descendants((node) => {
    const src = node.type.name === 'image' ? node.attrs.src : null;
    if (typeof src !== 'string' || !src) return;
    const url = drawnUrl(note, src);
    const file = url ? vaultFileOf(url) : null;
    if (file) files[src] = file;
  });
  return files;
}

/**
 * `slice` with each image's src rebased from `fromNote` to `toNote`: to the file
 * it drew when that is known (`files`), else the path as written.
 */
export function rebaseSliceImages(slice: Slice, fromNote: string, toNote: string, files: Record<string, string> = {}): Slice {
  const map = (fragment: Fragment): Fragment => {
    const nodes: PMNode[] = [];
    fragment.forEach((node) => {
      if (node.type.name === 'image' && typeof node.attrs.src === 'string') {
        const named = Object.prototype.hasOwnProperty.call(files, node.attrs.src) ? files[node.attrs.src] : '';
        const file = typeof named === 'string' && !named.split('/').includes('..') ? named : '';
        const src = file ? imageSrcForFile(file, toNote) : rebaseImageSrc(node.attrs.src, fromNote, toNote);
        nodes.push(node.type.create({ ...node.attrs, src }, node.content, node.marks));
      } else if (node.content.size) {
        nodes.push(node.copy(map(node.content)));
      } else {
        nodes.push(node);
      }
    });
    return Fragment.from(nodes);
  };
  return new Slice(map(slice.content), slice.openStart, slice.openEnd);
}

/** The last copy or cut made in a notes editor: its plain text, its note and the files its images drew. */
let lastCopy: { text: string; note: string; files: Record<string, string> } | null = null;

export const ImageClipboard = Extension.create({
  name: 'imageClipboard',

  addProseMirrorPlugins() {
    const editor = this.editor;
    const notePath = () => editor.storage.image?.notePath?.trim() || '';
    return [
      new Plugin({
        key: new PluginKey('imageClipboard'),
        // A plugin view's listener is added after ProseMirror's own copy handler,
        // which clears the clipboard first: so the tag survives it.
        view(view) {
          // The selection as it was before ProseMirror's own handler ran: a cut
          // deletes it first (2026-11-05 review: a cut image lost the file it drew).
          let before: Slice | null = null;
          const grab = (e: Event) => {
            if (e.target instanceof Node && view.dom.contains(e.target)) before = view.state.selection.content();
          };
          const tag = (e: ClipboardEvent) => {
            const slice = before ?? view.state.selection.content();
            before = null;
            const note = notePath();
            if (!note || !e.clipboardData) return;
            const files = drawnFilesOf(slice, note);
            try {
              e.clipboardData.setData(NOTE_CLIPBOARD_TYPE, note);
              e.clipboardData.setData(NOTE_FILES_CLIPBOARD_TYPE, JSON.stringify(files));
            } catch { /* read-only clipboard */ }
            // What a plain-text paste will carry: the editor's own text for the
            // selection (an engine may not let this listener read the clipboard).
            let text = e.clipboardData.getData('text/plain');
            if (!text) {
              const serialize = view.someProp('clipboardTextSerializer');
              text = serialize ? serialize(slice, view) : '';
            }
            lastCopy = text.trim() ? { text: text.trim(), note, files } : null;
          };
          const doc = view.dom.ownerDocument;
          doc.addEventListener('copy', grab, true);
          doc.addEventListener('cut', grab, true);
          view.dom.addEventListener('copy', tag);
          view.dom.addEventListener('cut', tag);
          return {
            destroy() {
              doc.removeEventListener('copy', grab, true);
              doc.removeEventListener('cut', grab, true);
              view.dom.removeEventListener('copy', tag);
              view.dom.removeEventListener('cut', tag);
            },
          };
        },
        props: {
          handlePaste(view, event, slice) {
            const data = event.clipboardData;
            const text = data?.getData('text/plain') ?? '';
            const remembered = lastCopy && text.trim() && text.trim() === lastCopy.text ? lastCopy : null;
            const from = data?.getData(NOTE_CLIPBOARD_TYPE) || remembered?.note || '';
            const here = notePath();
            // HTML carries the source in each painted URL; only plain text needs this.
            if (!from || !here || from === here || data?.getData('text/html')) return false;
            let files: Record<string, string> = remembered?.files ?? {};
            try {
              const tagged = data?.getData(NOTE_FILES_CLIPBOARD_TYPE);
              if (tagged) files = JSON.parse(tagged) as Record<string, string>;
            } catch { /* not ours */ }
            view.dispatch(view.state.tr.replaceSelection(rebaseSliceImages(slice, from, here, files)).scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});
