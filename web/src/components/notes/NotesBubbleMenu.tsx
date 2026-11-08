/**
 * Selection format toolbar (bubble menu). Pure DOM overlay anchored to the
 * current text selection — it does NOT re-render the doc, so typing latency is
 * unaffected (the "no-jank" contract). Mark buttons (bold/italic/strike/code/
 * link) call existing marks directly; block "Turn into" (H1-H3) reuses the
 * shared block-transforms module so there is one conversion path, three
 * surfaces. Hidden inside tables/code blocks (table ops are out of R1 scope).
 */

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
// BubbleMenu lives under the `/menus` subpath in @tiptap/react 3.x (not the root export).
import { BubbleMenu } from '@tiptap/react/menus';
import { posToDOMRect, type Editor } from '@tiptap/core';
import { turnInto } from './block-transforms';
import { editLinkViaPrompt } from './link-prompt';
import { usePrompt } from '@/hooks/useConfirm';
import { RouteShownContext } from '@/contexts/RouteShownContext';
import { KEEP_SELECTION_ATTR } from '@/utils/selection-guard';
import { clippingAncestors } from '@/utils/clip-ancestors';
import { claimToolbarEscape } from '@/utils/file-card-escape';
import { useMenuPlacement, menuPlacementStyle, type MenuPlacementOptions } from '@/hooks/useMenuPlacement';

interface NotesBubbleMenuProps {
  editor: Editor;
  /**
   * Optional "Ask about this" action (the Files panel's quote-to-ask). When
   * set, an Ask button joins the toolbar and receives the selected plain text.
   * Notes surfaces leave it unset — their menu is unchanged.
   */
  onAsk?: (text: string) => void;
  /** `Ask here`: the selection becomes a question answered beside it (the Files
   *  tab's comment card). With it, the plain Ask reads `Quote in chat`. The
   *  range comes from the editor's own state: the DOM selection is not to be
   *  trusted from a menu button (ProseMirror may have collapsed it already). */
  onAskHere?: (range: Range) => void;
  /** `Comment`: a comment on the doc (its range and its text), its box opening at the words. */
  onComment?: (range: Range, text: string) => void;
}

/** The editor's selection as a DOM range (the DOM selection is not to be trusted
 *  from a menu button: ProseMirror may have collapsed it already). */
function selectionRange(editor: Editor): Range | null {
  const { from, to } = editor.state.selection;
  if (from === to) return null;
  const start = editor.view.domAtPos(from);
  const end = editor.view.domAtPos(to);
  const range = editor.view.dom.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

export function NotesBubbleMenu({ editor, onAsk, onAskHere, onComment }: NotesBubbleMenuProps) {
  const prompt = usePrompt();
  const shown = useContext(RouteShownContext) !== false;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  // Only show for a non-empty text selection that is NOT inside a table cell or
  // code block (those have their own editing model / no inline marks).
  const shouldShow = useCallback(({ editor: ed, from, to }: { editor: Editor; from: number; to: number }) => {
    if (from === to) return false;
    if (ed.isActive('codeBlock')) return false;
    if (ed.isActive('table') || ed.isActive('tableCell') || ed.isActive('tableHeader')) return false;
    // Hide for selections that span only atomic/empty content.
    return ed.state.doc.textBetween(from, to, ' ').trim().length > 0;
  }, []);

  const setLink = useCallback(() => { void editLinkViaPrompt(editor, prompt); }, [editor, prompt]);
  const portalRef = useRef<HTMLDivElement | null>(null);
  const appendTo = useCallback(() => {
    const document = editor.view.dom.ownerDocument;
    const host = portalRef.current ?? document.createElement('div');
    portalRef.current = host;
    if (!host.isConnected) document.body.append(host);
    return host;
  }, [editor]);
  useEffect(() => () => portalRef.current?.remove(), []);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useMemo(() => ({ current: editor.view.dom }), [editor]);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<MenuPlacementOptions['anchorPoint']>(null);
  const passageVisibleRef = useRef(true);
  /** The editor's visible box (its clipping ancestors and the viewport): the menu stays inside it. */
  const clipRef = useRef<{ left: number; right: number } | null>(null);
  const readAnchor = useCallback(() => {
    if (editor.isDestroyed) return;
    const rect = posToDOMRect(editor.view, editor.state.selection.from, editor.state.selection.to);
    let top = 0, bottom = window.innerHeight, left = 0, right = window.innerWidth;
    // Only the ancestors that really clip the editor: a viewport-fixed sheet escapes its former
    // column's overflow (utils/clip-ancestors.ts).
    for (const clip of clippingAncestors(editor.view.dom)) {
      const box = clip.el.getBoundingClientRect();
      if (clip.y) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      if (clip.x) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
    }
    clipRef.current = { left, right };
    passageVisibleRef.current = getComputedStyle(editor.view.dom).visibility === 'visible'
      && rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right;
    setAnchor({ x: (rect.left + rect.right) / 2, y: rect.top, bottom: rect.bottom });
  }, [editor]);
  const placement = useMenuPlacement(open, editorRef, menuRef, {
    anchorPoint: anchor, align: 'center', preferSide: 'up', gap: 8, minHeight: 34,
  });
  const placementRef = useRef(placement);
  placementRef.current = placement;
  const place = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const style = menuPlacementStyle(placementRef.current);
    menu.style.position = 'fixed';
    menu.style.top = `${style.top}px`;
    menu.style.right = style.right === undefined ? '' : `${style.right}px`;
    menu.style.left = style.left === undefined ? '' : `${style.left}px`;
    menu.style.maxHeight = style.maxHeight === undefined ? '' : `${style.maxHeight}px`;
    // Inside the editor's own visible box, not only the window: never past a sheet's edge or
    // over the file tree beside it (2026-11-10 review, utils/toolbar-bounds.ts for the pill).
    const clip = clipRef.current;
    const r = clip ? menu.getBoundingClientRect() : null;
    if (clip && r && r.width && r.width + 8 <= clip.right - clip.left) {
      const at = Math.max(clip.left + 4, Math.min(r.left, clip.right - r.width - 4));
      // Move by the difference: `left` is in the menu's containing block, which is the window
      // only while nothing around the portal makes one, while `at` is in window coordinates.
      if (Math.abs(at - r.left) > 0.5) {
        const base = parseFloat(getComputedStyle(menu).left);
        menu.style.left = `${Math.round((Number.isFinite(base) ? base : r.left) + at - r.left)}px`;
        menu.style.right = '';
      }
    }
    const visible = passageVisibleRef.current && shownRef.current;
    menu.style.visibility = visible ? 'visible' : 'hidden';
    menu.style.pointerEvents = visible ? style.pointerEvents ?? '' : 'none';
  }, []);
  useLayoutEffect(() => { if (shown && open) readAnchor(); }, [shown, open, readAnchor]);
  // One Escape closes the toolbar and only the toolbar (the selection collapses to its end):
  // not a card under it, not the sheet around it (utils/file-card-escape.ts).
  useEffect(() => {
    if (!open) return;
    return claimToolbarEscape(
      () => !editor.isDestroyed && menuRef.current?.style.visibility !== 'hidden' && !editor.state.selection.empty,
      () => { if (!editor.isDestroyed) editor.commands.setTextSelection(editor.state.selection.to); },
    );
  }, [editor, open]);
  useLayoutEffect(place, [place, placement, anchor, shown]);
  const options = useMemo(() => ({
    strategy: 'fixed' as const,
    placement: 'top' as const,
    offset: false,
    flip: false,
    shift: false,
    onShow: () => { readAnchor(); setOpen(true); },
    onHide: () => setOpen(false),
    onUpdate: place,
  }), [readAnchor, place]);
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(readAnchor);
    };
    const document = editor.view.dom.ownerDocument;
    document.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    editor.on('selectionUpdate', update);
    const observer = new ResizeObserver(update);
    observer.observe(editor.view.dom);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      editor.off('selectionUpdate', update);
      observer.disconnect();
    };
  }, [editor, open, readAnchor]);

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="notesBubbleMenu"
      shouldShow={shouldShow}
      className="notes-bubble-menu"
      // Its buttons are chrome, never the note's text (utils/find-doc.ts).
      data-find-skip=""
      ref={menuRef}
      appendTo={appendTo}
      options={options}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="notes-bubble-actions" {...{ [KEEP_SELECTION_ATTR]: '' }} onPointerDown={(event) => event.stopPropagation()}>
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

      {(onAsk || onAskHere || onComment) && <span className="notes-bubble-sep" />}
      {onComment && (
        <button
          type="button"
          className="notes-bubble-btn notes-bubble-ask"
          data-testid="bubble-comment"
          onMouseDown={(e) => {
            e.preventDefault();
            const range = selectionRange(editor);
            if (!range) return;
            const { from, to } = editor.state.selection;
            onComment(range, editor.state.doc.textBetween(from, to, '\n'));
            // The comment's box takes the keyboard; the menu goes with the selection.
            editor.commands.setTextSelection(to);
          }}
          title="Comment on this passage, right at its words"
        >Comment</button>
      )}
      {onAskHere && (
        <button
          type="button"
          className="notes-bubble-btn notes-bubble-ask"
          data-testid="bubble-ask-here"
          onMouseDown={(e) => {
            e.preventDefault();
            const range = selectionRange(editor);
            if (!range) return;
            const { to } = editor.state.selection;
            onAskHere(range);
            // The question's card takes the keyboard; the editor keeps the caret
            // at the end of the passage and the menu goes with the selection.
            editor.commands.setTextSelection(to);
          }}
          title="A question about this passage, answered beside it"
        >Ask here</button>
      )}
      {onAsk && (
        <button
          type="button"
          className="notes-bubble-btn notes-bubble-ask"
          data-testid="bubble-ask-quote"
          onMouseDown={(e) => {
            e.preventDefault();
            const { from, to } = editor.state.selection;
            const text = editor.state.doc.textBetween(from, to, '\n').trim();
            if (text) onAsk(text);
          }}
          title={onAskHere ? 'Quote this passage in the chat' : 'Ask the session about this selection'}
        >{onAskHere ? 'Quote in chat' : 'Ask'}</button>
      )}
      </div>
    </BubbleMenu>
  );
}
