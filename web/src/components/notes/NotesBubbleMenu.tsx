/**
 * Selection format toolbar (bubble menu). Pure DOM overlay anchored to the
 * current text selection — it does NOT re-render the doc, so typing latency is
 * unaffected (the "no-jank" contract). Mark buttons (bold/italic/strike/code/
 * link) call existing marks directly; block "Turn into" (H1-H3) reuses the
 * shared block-transforms module so there is one conversion path, three
 * surfaces. Hidden inside tables/code blocks (table ops are out of R1 scope).
 */

import { useCallback } from 'react';
// BubbleMenu lives under the `/menus` subpath in @tiptap/react 3.x (not the root export).
import { BubbleMenu } from '@tiptap/react/menus';
import type { Editor } from '@tiptap/core';
import { turnInto } from './block-transforms';
import { usePrompt } from '@/hooks/useConfirm';

interface NotesBubbleMenuProps {
  editor: Editor;
  /**
   * Optional "Ask about this" action (the Files panel's quote-to-ask). When
   * set, an Ask button joins the toolbar and receives the selected plain text.
   * Notes surfaces leave it unset — their menu is unchanged.
   */
  onAsk?: (text: string) => void;
}

export function NotesBubbleMenu({ editor, onAsk }: NotesBubbleMenuProps) {
  const prompt = usePrompt();
  // Only show for a non-empty text selection that is NOT inside a table cell or
  // code block (those have their own editing model / no inline marks).
  const shouldShow = useCallback(({ editor: ed, from, to }: { editor: Editor; from: number; to: number }) => {
    if (from === to) return false;
    if (ed.isActive('codeBlock')) return false;
    if (ed.isActive('table') || ed.isActive('tableCell') || ed.isActive('tableHeader')) return false;
    // Hide for selections that span only atomic/empty content.
    return ed.state.doc.textBetween(from, to, ' ').trim().length > 0;
  }, []);

  const setLink = useCallback(async () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    // allowEmpty: clearing the field removes the link.
    const url = await prompt({ title: 'Link URL', defaultValue: prev ?? 'https://', placeholder: 'https://…', confirmLabel: 'Apply', allowEmpty: true });
    if (url === null) return; // cancelled
    if (url.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  }, [editor, prompt]);

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="notesBubbleMenu"
      shouldShow={shouldShow}
      className="notes-bubble-menu"
      options={{ placement: 'top', offset: 8 }}
    >
      <button
        type="button"
        className={`notes-bubble-btn ${editor.isActive('bold') ? 'active' : ''}`}
        onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }}
        title="Bold (Cmd+B)"
      ><strong>B</strong></button>
      <button
        type="button"
        className={`notes-bubble-btn ${editor.isActive('italic') ? 'active' : ''}`}
        onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }}
        title="Italic (Cmd+I)"
      ><em>i</em></button>
      <button
        type="button"
        className={`notes-bubble-btn ${editor.isActive('strike') ? 'active' : ''}`}
        onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleStrike().run(); }}
        title="Strikethrough"
      ><s>S</s></button>
      <button
        type="button"
        className={`notes-bubble-btn ${editor.isActive('code') ? 'active' : ''}`}
        onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleCode().run(); }}
        title="Inline code"
      ><code>{'</>'}</code></button>
      <button
        type="button"
        className={`notes-bubble-btn ${editor.isActive('link') ? 'active' : ''}`}
        onMouseDown={(e) => { e.preventDefault(); setLink(); }}
        title="Link"
      >🔗</button>

      <span className="notes-bubble-sep" />

      <button
        type="button"
        className={`notes-bubble-btn ${editor.isActive('heading', { level: 1 }) ? 'active' : ''}`}
        onMouseDown={(e) => { e.preventDefault(); turnInto(editor, 'h1'); }}
        title="Heading 1"
      >H1</button>
      <button
        type="button"
        className={`notes-bubble-btn ${editor.isActive('heading', { level: 2 }) ? 'active' : ''}`}
        onMouseDown={(e) => { e.preventDefault(); turnInto(editor, 'h2'); }}
        title="Heading 2"
      >H2</button>
      <button
        type="button"
        className={`notes-bubble-btn ${editor.isActive('heading', { level: 3 }) ? 'active' : ''}`}
        onMouseDown={(e) => { e.preventDefault(); turnInto(editor, 'h3'); }}
        title="Heading 3"
      >H3</button>

      {onAsk && (
        <>
          <span className="notes-bubble-sep" />
          <button
            type="button"
            className="notes-bubble-btn notes-bubble-ask"
            onMouseDown={(e) => {
              e.preventDefault();
              const { from, to } = editor.state.selection;
              const text = editor.state.doc.textBetween(from, to, '\n').trim();
              if (text) onAsk(text);
            }}
            title="Ask the session about this selection"
          >Ask</button>
        </>
      )}
    </BubbleMenu>
  );
}
