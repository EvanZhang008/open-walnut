/**
 * Upload an image File and insert it into the editor — the ONE path behind
 * clipboard paste, drag-drop (NotesEditor) and the toolbar's Image button.
 *
 * Vault surface (`notePath` set): the file is saved into an `_attachment/`
 * folder beside the note and inserted as an Obsidian `![[...]]` embed, so the
 * markdown on disk stays portable. Any other surface: chat image store +
 * `![](/api/images/…)`. Upload failure degrades to an inline data URL rather
 * than dropping the image.
 */

import type { Editor } from '@tiptap/core';
import { uploadNoteImage } from '@/api/notes';
import { uploadNoteAttachment } from '@/api/notes-v2';

export function insertImageFile(file: File, editor: Editor, notePath?: string): void {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const dataUrl = reader.result as string;
      if (!dataUrl?.includes(',')) return;
      const [header, base64] = dataUrl.split(',');
      if (!base64) return;
      const mediaType = header.match(/data:(.*?);/)?.[1] || 'image/png';
      // wikiEmbed is only in the schema when enableWikiLinks is on — guard so
      // a misconfigured surface degrades to the legacy path instead of throwing.
      // The toolbar's file dialog + upload can outlive the document (the user
      // switched notes meanwhile) — never insert into a destroyed editor.
      if (notePath && editor.schema.nodes.wikiEmbed) {
        const { path } = await uploadNoteAttachment(notePath, base64, mediaType);
        if (editor.isDestroyed) return;
        editor.chain().focus()
          .insertContent({ type: 'wikiEmbed', attrs: { target: path } })
          .run();
      } else {
        const url = await uploadNoteImage(base64, mediaType);
        if (editor.isDestroyed) return;
        editor.chain().focus().setImage({ src: url }).run();
      }
    } catch {
      if (editor.isDestroyed) return;
      const dataUrl = reader.result as string;
      if (dataUrl) editor.chain().focus().setImage({ src: dataUrl }).run();
    }
  };
  reader.onerror = () => { /* silently skip — user can retry */ };
  reader.readAsDataURL(file);
}
