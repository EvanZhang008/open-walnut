/**
 * Always-visible format toolbar (the row under the note's title bar).
 *
 * The bubble menu only appears once text is selected, which left people
 * hunting for tools that "must be somewhere" (user report, 2026-09-08). This row
 * is the discoverable surface: history, inline marks, a block-type picker,
 * list indent, insertables, clear formatting. Every action goes through the
 * same commands the bubble menu and slash menu use (block-transforms,
 * list-indent, image-insert, link-prompt) — one transform, now four surfaces.
 *
 * Rendering contract: this component re-renders on every editor transaction
 * via `useEditorState`, but it is a SIBLING of the editor (it lives in the
 * MarkdownEditorPanel shell, outside the scroll area), so those re-renders never
 * touch the ProseMirror tree. The selector returns a flat object and
 * useEditorState deep-compares it, so a keystroke that changes no button state
 * costs nothing beyond the selector itself.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { insertBlock, isActiveBlock, type BlockKind } from './block-transforms';
import { findListItemType, indentListItem, outdentListItem } from './extensions/list-indent';
import { insertImageFile } from './image-insert';
import { editLinkViaPrompt } from './link-prompt';
import { usePrompt } from '@/hooks/useConfirm';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';

interface NotesFormatToolbarProps {
  editor: Editor;
  /** Vault note path — routes the Image button's upload into `_attachment/`. */
  attachmentNotePath?: string;
}

/** Block kinds the picker offers, in menu order, with their display labels. */
const BLOCK_OPTIONS: ReadonlyArray<{ kind: BlockKind; label: string }> = [
  { kind: 'paragraph', label: 'Normal text' },
  { kind: 'h1', label: 'Heading 1' },
  { kind: 'h2', label: 'Heading 2' },
  { kind: 'h3', label: 'Heading 3' },
  { kind: 'bulletList', label: 'Bulleted list' },
  { kind: 'orderedList', label: 'Numbered list' },
  { kind: 'taskList', label: 'To-do list' },
  { kind: 'blockquote', label: 'Quote' },
  { kind: 'codeBlock', label: 'Code block' },
  { kind: 'callout', label: 'Callout' },
];

/**
 * Most specific first: a paragraph inside a list item is "Bulleted list", not
 * "Normal text"; a heading is never inside a list, so its order is free.
 */
const BLOCK_PROBE_ORDER: readonly BlockKind[] = [
  'codeBlock', 'callout', 'h1', 'h2', 'h3', 'taskList', 'bulletList', 'orderedList', 'blockquote', 'paragraph',
];

function activeBlockKind(editor: Editor): BlockKind {
  for (const kind of BLOCK_PROBE_ORDER) if (isActiveBlock(editor, kind)) return kind;
  return 'paragraph';
}

function blockLabel(kind: BlockKind): string {
  return BLOCK_OPTIONS.find((o) => o.kind === kind)?.label ?? 'Normal text';
}

export function NotesFormatToolbar({ editor, attachmentNotePath }: NotesFormatToolbarProps) {
  const prompt = usePrompt();
  const s = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!ed || ed.isDestroyed) return null;
      const inCode = ed.isActive('codeBlock');
      const inTable = ed.isActive('table');
      return {
        bold: ed.isActive('bold'),
        italic: ed.isActive('italic'),
        strike: ed.isActive('strike'),
        code: ed.isActive('code'),
        link: ed.isActive('link'),
        block: activeBlockKind(ed),
        canUndo: ed.can().undo(),
        canRedo: ed.can().redo(),
        // Inline marks have no meaning inside a code block; block conversion is
        // meaningless inside a table cell (cells only hold paragraphs).
        marksOff: inCode,
        blocksOff: inTable,
        inList: findListItemType(ed) !== null,
      };
    },
  });

  const run = useCallback((fn: (ed: Editor) => void) => () => {
    if (editor.isDestroyed) return;
    fn(editor);
  }, [editor]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const onPickImage = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file && !editor.isDestroyed) insertImageFile(file, editor, attachmentNotePath);
  }, [editor, attachmentNotePath]);

  if (!s) return null;

  return (
    <div className="notes-format-toolbar" role="toolbar" aria-label="Formatting">
      <ToolbarButton title="Undo (⌘Z)" disabled={!s.canUndo} onClick={run((ed) => ed.chain().focus().undo().run())}>
        {ICON_UNDO}
      </ToolbarButton>
      <ToolbarButton title="Redo (⌘⇧Z)" disabled={!s.canRedo} onClick={run((ed) => ed.chain().focus().redo().run())}>
        {ICON_REDO}
      </ToolbarButton>

      <span className="notes-format-sep" />

      <ToolbarButton title="Bold (⌘B)" active={s.bold} disabled={s.marksOff} onClick={run((ed) => ed.chain().focus().toggleBold().run())}>
        <strong>B</strong>
      </ToolbarButton>
      <ToolbarButton title="Italic (⌘I)" active={s.italic} disabled={s.marksOff} onClick={run((ed) => ed.chain().focus().toggleItalic().run())}>
        <em>I</em>
      </ToolbarButton>
      <ToolbarButton title="Strikethrough (⌘⇧S)" active={s.strike} disabled={s.marksOff} onClick={run((ed) => ed.chain().focus().toggleStrike().run())}>
        <s>S</s>
      </ToolbarButton>
      <ToolbarButton title="Inline code" active={s.code} disabled={s.marksOff} onClick={run((ed) => ed.chain().focus().toggleCode().run())}>
        <code>{'<>'}</code>
      </ToolbarButton>

      <span className="notes-format-sep" />

      <BlockPicker editor={editor} current={s.block} disabled={s.blocksOff} />

      <span className="notes-format-sep" />

      <ToolbarButton
        title="Indent (Tab)"
        disabled={!s.inList}
        onClick={run((ed) => { ed.commands.focus(); const t = findListItemType(ed); if (t) indentListItem(ed, t); })}
      >
        {ICON_INDENT}
      </ToolbarButton>
      <ToolbarButton
        title="Outdent (⇧Tab)"
        disabled={!s.inList}
        onClick={run((ed) => { ed.commands.focus(); const t = findListItemType(ed); if (t) outdentListItem(ed, t); })}
      >
        {ICON_OUTDENT}
      </ToolbarButton>

      <span className="notes-format-sep" />

      <ToolbarButton title="Link" active={s.link} disabled={s.marksOff} onClick={run((ed) => { void editLinkViaPrompt(ed, prompt); })}>
        {ICON_LINK}
      </ToolbarButton>
      <ToolbarButton title="Image" disabled={s.marksOff} onClick={() => fileInputRef.current?.click()}>
        {ICON_IMAGE}
      </ToolbarButton>
      <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onPickImage} />
      <ToolbarButton title="Table" disabled={s.blocksOff || s.marksOff} onClick={run((ed) => insertBlock(ed, 'table'))}>
        {ICON_TABLE}
      </ToolbarButton>
      <ToolbarButton title="Divider" disabled={s.blocksOff || s.marksOff} onClick={run((ed) => insertBlock(ed, 'divider'))}>
        {ICON_DIVIDER}
      </ToolbarButton>

      <span className="notes-format-sep" />

      <ToolbarButton
        title="Clear formatting"
        onClick={run((ed) => ed.chain().focus().unsetAllMarks().clearNodes().run())}
      >
        {ICON_CLEAR}
      </ToolbarButton>
    </div>
  );
}

/**
 * mousedown is only prevented (so the click never moves focus, and with it the
 * selection, out of the editor before the command reads it); the action runs on
 * click, which is also what Enter/Space on a focused button fire.
 */
const keepEditorFocus = (e: React.MouseEvent) => e.preventDefault();

function ToolbarButton({ title, active, disabled, onClick, children }: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`notes-format-btn${active ? ' active' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onMouseDown={keepEditorFocus}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * "Normal text ▾" block-type picker. A portalled, useMenuPlacement-placed menu
 * (never a native <select> — see web/src/AGENTS.md "Menus & overlays").
 */
function BlockPicker({ editor, current, disabled }: { editor: Editor; current: BlockKind; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  // 'center': the 190px menu spreads evenly around the ~118px trigger, so it
  // reads as attached (right-aligned would hang under the mark buttons).
  const placement = useMenuPlacement(open, btnRef, menuRef, { align: 'center', onAnchorLost: close });

  // Outside click / Escape closes. The menu is portalled, so "outside" is
  // "not in the menu and not the trigger".
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);

  const pick = (kind: BlockKind) => {
    close();
    if (editor.isDestroyed) return;
    // The checked row is a confirmation, not a toggle: insertBlock's list /
    // quote / code commands are toggles and would strip the formatting.
    if (kind === current) return;
    insertBlock(editor, kind);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="notes-format-block-btn"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Turn into…"
        onMouseDown={keepEditorFocus}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="notes-format-block-label">{blockLabel(current)}</span>
        {ICON_CHEVRON}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="notes-format-block-menu"
          role="menu"
          // 10002: above the Global Notes popup overlay (z 10000), where the
          // hook's default 9999 would paint the menu UNDER the popup card. Same
          // layer the bubble menu uses.
          style={{ ...menuPlacementStyle(placement), zIndex: 10002 }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {BLOCK_OPTIONS.map((o) => (
            <button
              key={o.kind}
              type="button"
              role="menuitemradio"
              aria-checked={o.kind === current}
              className={`notes-format-block-item${o.kind === current ? ' active' : ''}`}
              onMouseDown={keepEditorFocus}
              onClick={() => pick(o.kind)}
            >
              <span className={`notes-format-block-sample sample-${o.kind}`}>{o.label}</span>
              {o.kind === current && <span className="notes-format-block-check">✓</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

// ── Icons (16-grid, stroke, currentColor — same idiom as common/Icons.tsx) ──
const svgProps = { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

const ICON_UNDO = <svg {...svgProps}><path d="M5.5 4.5 2.5 7.5l3 3" /><path d="M2.5 7.5h6.5a3.5 3.5 0 0 1 0 7H8" /></svg>;
const ICON_REDO = <svg {...svgProps}><path d="m10.5 4.5 3 3-3 3" /><path d="M13.5 7.5H7a3.5 3.5 0 0 0 0 7h1" /></svg>;
const ICON_INDENT = <svg {...svgProps}><path d="M2 3.5h12M7 8h7M2 12.5h12" /><path d="m2.5 6.5 2 1.5-2 1.5" /></svg>;
const ICON_OUTDENT = <svg {...svgProps}><path d="M2 3.5h12M7 8h7M2 12.5h12" /><path d="m4.5 6.5-2 1.5 2 1.5" /></svg>;
const ICON_LINK = <svg {...svgProps}><path d="M6.5 9.5a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-1 1" /><path d="M9.5 6.5a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l1-1" /></svg>;
const ICON_IMAGE = <svg {...svgProps}><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="6" cy="6.5" r="1.2" /><path d="m2.5 12 3.5-3.5 2.5 2.5 2-2 3 3" /></svg>;
const ICON_TABLE = <svg {...svgProps}><rect x="2" y="3" width="12" height="10" rx="1" /><path d="M2 7h12M2 10.5h12M7 3v10" /></svg>;
const ICON_DIVIDER = <svg {...svgProps}><path d="M2 8h12" /><path d="M4 4h8M4 12h8" opacity="0.4" /></svg>;
const ICON_CLEAR = <svg {...svgProps}><path d="M4 12.5h8" /><path d="m9.5 3.5 3 3-5.5 5.5H4v-3z" /><path d="m3 3 10 10" opacity="0.6" /></svg>;
const ICON_CHEVRON = <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 6 8 10 12 6" /></svg>;
