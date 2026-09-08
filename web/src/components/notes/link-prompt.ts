/**
 * Set / clear the link on the current selection through the app's prompt
 * dialog — shared by the bubble menu and the format toolbar so both surfaces
 * agree on the one detail that is easy to get wrong: an EMPTY submit removes
 * the link (allowEmpty), a cancel leaves it alone.
 */

import type { Editor } from '@tiptap/core';
import type { PromptOptions } from '@/hooks/useConfirm';

type PromptFn = (opts: PromptOptions) => Promise<string | null>;

export async function editLinkViaPrompt(editor: Editor, prompt: PromptFn): Promise<void> {
  const prev = editor.getAttributes('link').href as string | undefined;
  const url = await prompt({
    title: 'Link URL',
    defaultValue: prev ?? 'https://',
    placeholder: 'https://…',
    confirmLabel: 'Apply',
    allowEmpty: true,
  });
  if (url === null || editor.isDestroyed) return; // cancelled
  if (url.trim() === '') {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }
  editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
}
