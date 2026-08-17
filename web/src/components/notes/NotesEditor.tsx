/**
 * Tiptap-based WYSIWYG markdown editor for global notes.
 * Renders markdown live as you type (like Notion).
 * Markdown is the storage format — tiptap handles the rendering.
 * Supports pasting images from clipboard (uploaded to server).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import { canJoin } from '@tiptap/pm/transform';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';
import { uploadNoteImage } from '@/api/notes';
import { uploadNoteAttachment } from '@/api/notes-v2';
import { entityRefsToMarkdownLinks } from '@/utils/markdown';
import { log } from '@/utils/log';
import { SlashCommandExtension } from './slash-commands/SlashCommandExtension';
import { SlashCommandPortal } from './slash-commands/SlashCommandPortal';
import type { SlashCommandState } from './slash-commands/types';
import type { WikiLinkState } from './wiki-link/WikiLinkExtension';
import { WikiLinkExtension } from './wiki-link/WikiLinkExtension';
import { WikiLinkAutocomplete } from './wiki-link/WikiLinkAutocomplete';
import { WikiLinkClickExtension } from './wiki-link/WikiLinkClickExtension';
import { WikiLinkDisambiguation } from './wiki-link/WikiLinkDisambiguation';
import { resolveWikiLinkTarget } from './wiki-link/resolve-wiki-link';
import { tableExtensions } from './extensions/table-kit';
import { ListAutoJoin } from './extensions/list-auto-join';
import { EmptyAwareTaskItem } from './extensions/empty-task-item';
import { normalizeForEditor } from './notes-content-preprocess';
import { TagNode } from './extensions/tag-node';
import { Callout } from './extensions/callout-node';
import { WikiEmbedNode } from './extensions/wiki-embed-node';
import { TagTrigger } from './extensions/tag-trigger';
import type { TagTriggerState } from './extensions/tag-trigger';
import { NotesBubbleMenu } from './NotesBubbleMenu';
import { TagAutocomplete } from './TagAutocomplete';
import type { TagSuggestion } from './TagAutocomplete';
import type { NoteListItem } from '@/api/notes-v2';
import type { Task } from '@open-walnut/core';
import './notes-editor.css';

interface NotesEditorProps {
  content: string;
  onDirty: (editor: Editor) => void;
  placeholder?: string;
  className?: string;
  /** Auto-focus when mounted */
  autoFocus?: boolean;
  /** Tasks for slash command /task search */
  tasks?: Task[];
  /** Currently focused task ID — pinned at top of search results */
  focusedTaskId?: string;
  /** Called when user clicks a task reference link in the editor */
  onTaskClick?: (taskId: string) => void;
  /** Enable wiki link [[ ]] support */
  enableWikiLinks?: boolean;
  /** Available notes for wiki link autocomplete */
  wikiLinkNotes?: NoteListItem[];
  /** Called when a wiki link is clicked */
  onWikiLinkClick?: (target: string) => void;
  /**
   * Enable the selection format toolbar (bubble menu). Off by default so the
   * compact home-popup surface can opt out.
   */
  enableBlockTools?: boolean;
  /**
   * Adds an "Ask about this" action to the bubble menu (the Files panel's
   * quote-to-ask). Receives the selected plain text. Notes surfaces leave it
   * unset. Requires enableBlockTools.
   */
  onAskSelection?: (text: string) => void;
  /** Frequency-ranked vault tags for #tag autocomplete (from GET /tags; empty = manual typing). */
  tagSuggestions?: TagSuggestion[];
  /**
   * Vault-relative path of the note being edited (e.g. `Areas/x/Foo.md`). When
   * set, pasted/dropped images are saved INTO THE VAULT (an `_attachment/`
   * folder beside the note) and inserted as Obsidian `![[...]]` embeds — so the
   * markdown on disk stays portable. Absent (task/memory/global surfaces) →
   * images fall back to the chat image store (`/api/images`) as before.
   */
  attachmentNotePath?: string;
}

/**
 * TaskList with tight attribute — fixes extra blank lines between checklist items.
 * MarkdownTightLists (from tiptap-markdown) only patches bulletList/orderedList
 * but misses taskList, so we replicate the same tight-attribute logic here.
 */
const TightTaskList = TaskList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      tight: {
        default: true,
        // Always tight — task lists should never have blank lines between items.
        // The original check `!element.querySelector('p')` returned false for
        // "loose" lists (markdown with blank lines between items), setting tight=false
        // and causing prosemirror-markdown to re-insert blank lines on every save.
        parseHTML: () => true,
        renderHTML: attributes => ({
          'data-tight': attributes.tight ? 'true' : null,
        }),
      },
    };
  },
});

/**
 * Extract relative task path from href — handles both "/tasks/ID" and
 * "http://localhost:3456/tasks/ID" (browser resolves relative→absolute on paste).
 */
function extractTaskPath(href: string): string | null {
  const idx = href.indexOf('/tasks/');
  return idx >= 0 ? href.slice(idx) : null;
}

/** Link extension: adds class="task-link" to /tasks/ hrefs, strips target for internal links */
const TaskAwareLink = Link.extend({
  renderHTML({ HTMLAttributes }) {
    const href = HTMLAttributes.href || '';
    const taskPath = extractTaskPath(href);
    if (!taskPath) {
      // External link — force new-tab open with noopener/noreferrer
      return ['a', { ...HTMLAttributes, target: '_blank', rel: 'noopener noreferrer nofollow' }, 0];
    }
    // Normalize to relative path + strip target/rel — we handle navigation ourselves
    const attrs: Record<string, unknown> = { ...HTMLAttributes, href: taskPath, class: 'task-link' };
    delete attrs.target;
    delete attrs.rel;
    return ['a', attrs, 0];
  },
});

/** Check if a string is a safe HTTP(S) URL — rejects javascript:, data:, file:, etc. */
function isUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * When sinkListItem fails (item is first in its list), try joining the
 * current list with the nearest previous same-type list — removing any
 * empty paragraphs between them — then retry sink.
 *
 * This handles the common case where blank lines in notes split a single
 * logical task list into multiple ProseMirror taskList nodes.
 */
function tryJoinPreviousListAndSink(editor: Editor, listItemType: string): boolean {
  try {
  const { state } = editor;
  const { $from } = state.selection;

  // Find the containing list node
  let listDepth = 0;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d).type.name;
    if (n === 'taskList' || n === 'bulletList' || n === 'orderedList') {
      listDepth = d;
      break;
    }
  }
  if (!listDepth || $from.index(listDepth) !== 0) return false;

  const listType = $from.node(listDepth).type;
  const parent = $from.node(listDepth - 1);
  const listIdx = $from.index(listDepth - 1);
  if (listIdx === 0) return false;

  // Only join with the IMMEDIATELY previous sibling if it's the same list type,
  // or if there's exactly one empty block between them (single blank line).
  // Multiple empty blocks = intentional separation, don't join.
  const prevSibling = parent.child(listIdx - 1);
  let prevListIdx: number;

  if (prevSibling.type === listType) {
    // Immediately adjacent same-type list — join directly
    prevListIdx = listIdx - 1;
  } else if (
    prevSibling.content.size === 0 &&
    listIdx >= 2 &&
    parent.child(listIdx - 2).type === listType
  ) {
    // One empty block gap (single blank line) — join across it
    prevListIdx = listIdx - 2;
  } else {
    return false; // too far apart or non-matching
  }

  // Calculate gap: from end of prevList to start of our list
  const contentStart = $from.start(listDepth - 1);
  let offset = 0;
  for (let i = 0; i <= prevListIdx; i++) offset += parent.child(i).nodeSize;
  const gapStart = contentStart + offset; // right after prevList

  let listOffset = 0;
  for (let i = 0; i < listIdx; i++) listOffset += parent.child(i).nodeSize;
  const gapEnd = contentStart + listOffset; // right before our list

  const { tr } = state;

  // Delete empty paragraphs between the two lists
  if (gapStart < gapEnd) tr.delete(gapStart, gapEnd);

  // Join the now-adjacent same-type lists
  const joinAt = tr.mapping.map(gapStart);
  // canJoin is a free function in prosemirror-transform, not a Node method.
  if (!canJoin(tr.doc, joinAt)) return false;
  tr.join(joinAt);
  editor.view.dispatch(tr);

  // Retry sink — now the item has a previous sibling
  const sunk = editor.commands.sinkListItem(listItemType);
  if (sunk) detachListItemChildren(editor);
  return sunk;
  } catch (err) {
    log.warn('notes', 'tryJoinPreviousListAndSink failed', { error: String(err) });
    return false;
  }
}

/**
 * Detach nested child list from the list item at cursor,
 * making them siblings after the current item.
 * Enables per-line Tab indentation: only the current item moves, not children.
 */
function detachListItemChildren(editor: Editor): boolean {
  try {
    const { state } = editor;
    const { $from } = state.selection;

    let depth = $from.depth;
    while (depth > 0) {
      const name = $from.node(depth).type.name;
      if (name === 'taskItem' || name === 'listItem') break;
      depth--;
    }
    if (depth === 0) return false;

    const item = $from.node(depth);
    const itemPos = $from.before(depth);
    const itemEnd = $from.after(depth);

    // Find nested list (taskList, bulletList, orderedList) within this item
    let nestedList: ReturnType<typeof item.child> | null = null;
    let offsetInItem = 1; // +1 for item open tag

    for (let i = 0; i < item.childCount; i++) {
      const child = item.child(i);
      const t = child.type.name;
      if (t === 'taskList' || t === 'bulletList' || t === 'orderedList') {
        nestedList = child;
        break;
      }
      offsetInItem += child.nodeSize;
    }

    if (!nestedList || nestedList.childCount === 0) return false;

    const children: ReturnType<typeof item.child>[] = [];
    nestedList.forEach(child => children.push(child));

    const nestedPos = itemPos + offsetInItem;
    const { tr } = state;

    // Validate positions before mutating
    if (nestedPos < 0 || nestedPos + nestedList.nodeSize > state.doc.content.size + 2) {
      log.warn('notes', 'detachListItemChildren: position out of bounds', {
        nestedPos, nestedSize: nestedList.nodeSize, docSize: state.doc.content.size,
      });
      return false;
    }

    // Remove nested list from inside the item
    tr.delete(nestedPos, nestedPos + nestedList.nodeSize);

    // Insert children as siblings after the (now shorter) item
    let insertPos = tr.mapping.map(itemEnd);
    for (const child of children) {
      tr.insert(insertPos, child);
      insertPos += child.nodeSize;
    }

    // Validate resulting document before dispatch
    try { tr.doc.check(); } catch (checkErr) {
      log.warn('notes', 'detachListItemChildren: invalid doc after transform, aborting', {
        error: String(checkErr),
      });
      return false;
    }

    editor.view.dispatch(tr);
    return true;
  } catch (err) {
    log.warn('notes', 'detachListItemChildren failed', { error: String(err) });
    return false;
  }
}

export function NotesEditor({ content, onDirty, placeholder, className, autoFocus, tasks, focusedTaskId, onTaskClick, enableWikiLinks, wikiLinkNotes, onWikiLinkClick, enableBlockTools, onAskSelection, tagSuggestions, attachmentNotePath }: NotesEditorProps) {
  const isExternalUpdate = useRef(false);
  const editorRef = useRef<Editor | null>(null);
  /**
   * Tracks whether this editor instance was the source of recent changes.
   * Set true on user edit (onUpdate), checked/reset in the sync effect.
   * Prevents the save-sync loop: after this editor saves, the content prop
   * updates but setContent() is skipped since we already have correct content.
   */
  const isSourceRef = useRef(false);
  const [slashState, setSlashState] = useState<SlashCommandState & { atBlockStart?: boolean }>({ phase: 'closed' });
  const [wikiLinkState, setWikiLinkState] = useState<WikiLinkState>({ phase: 'closed' });
  const [tagState, setTagState] = useState<TagTriggerState>({ phase: 'closed' });
  /**
   * When a clicked bare `[[Title]]` resolves to MORE THAN ONE note, hold the
   * candidates so the disambiguation picker can render (§2.2 ambiguous edge).
   */
  const [disambig, setDisambig] = useState<{ target: string; candidates: NoteListItem[] } | null>(null);
  // Ref so ProseMirror's handleClick closure always sees the latest callback
  const onTaskClickRef = useRef(onTaskClick);
  onTaskClickRef.current = onTaskClick;
  // Refs so the wiki-link click plugin (built once) always sees the latest
  // note list + navigate callback without rebuilding the editor.
  const wikiLinkNotesRef = useRef(wikiLinkNotes);
  wikiLinkNotesRef.current = wikiLinkNotes;
  const onWikiLinkClickRef = useRef(onWikiLinkClick);
  onWikiLinkClickRef.current = onWikiLinkClick;

  /**
   * Resolve a clicked wiki-link target → navigate, or open a disambiguation
   * picker for the ambiguous (same-name) case. Mirrors the backend resolution
   * order (path form first, then title/basename). The id is display-only here;
   * navigation is by `path` and the id NEVER appears in link text (§2.2/§3.5).
   */
  const handleWikiLinkNavigate = useCallback((target: string) => {
    const notes = wikiLinkNotesRef.current ?? [];
    const navigate = onWikiLinkClickRef.current;
    const res = resolveWikiLinkTarget(target, notes);
    if (res.kind === 'resolved') {
      navigate?.(res.note.path);
    } else if (res.kind === 'ambiguous') {
      setDisambig({ target, candidates: res.candidates });
    } else {
      // Unresolved — navigate by name so the editor can open/create it
      // (the backend assigns an id on first save; never an id in link text).
      navigate?.(target.includes('/') ? `${target}.md` : `${target}.md`);
    }
  }, []);

  // Ref so the paste/drop closures (built once) always see the current path.
  const attachmentNotePathRef = useRef(attachmentNotePath);
  attachmentNotePathRef.current = attachmentNotePath;

  /**
   * Upload a File (image blob), insert into editor.
   * Vault surface (attachmentNotePath set): save into `_attachment/` beside the
   * note and insert an Obsidian `![[...]]` embed — portable markdown on disk.
   * Non-vault surface: chat image store + `![](/api/images/…)` (legacy path).
   */
  const handleImageUpload = useCallback(async (file: File, editor: Editor) => {
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
        const notePath = attachmentNotePathRef.current;
        if (notePath && editor.schema.nodes.wikiEmbed) {
          const { path } = await uploadNoteAttachment(notePath, base64, mediaType);
          editor.chain().focus()
            .insertContent({ type: 'wikiEmbed', attrs: { target: path } })
            .run();
        } else {
          const url = await uploadNoteImage(base64, mediaType);
          editor.chain().focus().setImage({ src: url }).run();
        }
      } catch {
        // Upload failed — insert as inline data URL as fallback
        const dataUrl = reader.result as string;
        if (dataUrl) editor.chain().focus().setImage({ src: dataUrl }).run();
      }
    };
    reader.onerror = () => { /* silently skip — user can retry paste */ };
    reader.readAsDataURL(file);
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Disable built-in link — we use TaskAwareLink with custom renderHTML
        link: false,
      }),
      TightTaskList,
      // Merge adjacent same-type lists eagerly — markdown can't express the
      // split, so the editor must not show one (numbering restarting at 1).
      ListAutoJoin,
      // Empty-aware so a bare `- [ ]` orphan checkbox round-trips byte-clean
      // (see empty-task-item.ts + notes-content-preprocess.ts).
      EmptyAwareTaskItem.configure({
        nested: true,
      }),
      Placeholder.configure({
        placeholder: placeholder ?? 'Write your notes here... (Markdown supported)',
      }),
      Image.configure({
        inline: true,
        allowBase64: true,
      }),
      Markdown.configure({
        html: true, // needed for <img> tags in markdown
        transformPastedText: true,
        transformCopiedText: true,
      }),
      TaskAwareLink.configure({
        openOnClick: false, // we handle clicks ourselves (task-link SPA routing + external new-tab)
        autolink: true, // auto-detect typed URLs as links
        linkOnPaste: true, // pasted URLs become links (including wrap-selection)
        defaultProtocol: 'https',
        HTMLAttributes: {
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
        },
      }),
      SlashCommandExtension.configure({
        onStateChange: setSlashState,
      }),
      // Notion block nodes — tables (owned GFM serializer), #tag chip, callout.
      ...tableExtensions,
      TagNode,
      Callout,
      TagTrigger.configure({
        onStateChange: setTagState,
      }),
      ...(enableWikiLinks ? [
        WikiLinkExtension.configure({
          onStateChange: setWikiLinkState,
        }),
        // Render [[Title]] as a clickable inline link; click → id-keyed resolve
        // + navigate (or disambiguation picker). No extra node — disk bytes stay
        // plain [[Title]], so the byte-clean round-trip is untouched (§3.5).
        WikiLinkClickExtension.configure({
          onLinkClick: handleWikiLinkNavigate,
        }),
        // Render ![[attachment]] embeds inline (image / PDF / click-card). Atom
        // inline node with a literal-write serialize + a parse rule registered
        // before markdown-it's image rule, so disk bytes stay `![[...]]`
        // (byte-clean round-trip — see wiki-embed-node.ts).
        WikiEmbedNode,
      ] : []),
    ],
    content: normalizeForEditor(entityRefsToMarkdownLinks(content)),
    // 'start', NOT 'end' — focusing 'end' scrolls every opened note to the
    // BOTTOM (user-reported). The shell restores the remembered per-doc scroll
    // after mount (MarkdownEditorPanel scroll memory), so top is only the
    // first-visit default.
    autofocus: autoFocus ? 'start' : false,
    onUpdate: ({ editor }) => {
      if (isExternalUpdate.current) return;
      // Mark this editor as the source — prevents save-sync loop
      isSourceRef.current = true;
      onDirty(editor);
    },
    editorProps: {
      // Intercept clicks on anchors at the ProseMirror level
      handleClick: (view, pos, event) => {
        const target = event.target as HTMLElement;
        const anchor = target.closest('a');
        const href = anchor?.getAttribute('href');
        const taskPath = href ? extractTaskPath(href) : null;
        if (taskPath && onTaskClickRef.current) {
          event.preventDefault();
          const taskId = taskPath.slice('/tasks/'.length);
          if (taskId) onTaskClickRef.current(taskId);
          return true; // tell ProseMirror we handled it
        }
        // External link — open in new tab (openOnClick is disabled so we do it manually)
        if (href && isUrl(href)) {
          event.preventDefault();
          window.open(href, '_blank', 'noopener,noreferrer');
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        // Image paste (takes priority over URL detection)
        const items = event.clipboardData?.items;
        if (items) {
          for (const item of items) {
            if (item.type.startsWith('image/')) {
              event.preventDefault();
              const file = item.getAsFile();
              if (file && editorRef.current) {
                handleImageUpload(file, editorRef.current);
              }
              return true;
            }
          }
        }
        // Paste text containing entity refs → convert to markdown links
        // (URL auto-linking on paste is handled natively by TaskAwareLink's linkOnPaste)
        {
          const clipText = event.clipboardData?.getData('text/plain') ?? '';
          if ((clipText.includes('<task-ref') || clipText.includes('<session-ref')) && editorRef.current) {
            event.preventDefault();
            const converted = entityRefsToMarkdownLinks(clipText);
            editorRef.current.commands.insertContent(converted);
            return true;
          }
        }
        return false;
      },
      handleDrop: (view, event) => {
        const files = event.dataTransfer?.files;
        if (!files?.length) return false;
        for (const file of files) {
          if (file.type.startsWith('image/')) {
            event.preventDefault();
            if (editorRef.current) {
              handleImageUpload(file, editorRef.current);
            }
            return true;
          }
        }
        return false;
      },
      // ArrowUp/Down fix + per-line Tab indent
      handleKeyDown: (_view, event) => {
        // Fix ArrowUp skipping nested children of previous sibling.
        // Browser jumps from item 4 to item 1, skipping nested items 2-3.
        if (event.key === 'ArrowUp' && editorRef.current) {
          if (!_view.endOfTextblock('up')) return false;
          const { state } = _view;
          const { $from } = state.selection;
          let liDepth = 0;
          for (let d = $from.depth; d > 0; d--) {
            const n = $from.node(d).type.name;
            if (n === 'taskItem' || n === 'listItem') { liDepth = d; break; }
          }
          if (!liDepth) return false;
          const listDepth = liDepth - 1;
          const itemIdx = $from.index(listDepth);
          if (itemIdx === 0) return false;
          // Check if previous sibling has nested list children
          const prevItem = $from.node(listDepth).child(itemIdx - 1);
          let hasNested = false;
          for (let i = prevItem.childCount - 1; i >= 0; i--) {
            const t = prevItem.child(i).type.name;
            if (t === 'taskList' || t === 'bulletList' || t === 'orderedList') {
              hasNested = true; break;
            }
          }
          if (!hasNested) return false;
          // Move to end of last nested child instead of skipping to parent
          const itemStart = $from.before(liDepth);
          const sel = Selection.near(state.doc.resolve(Math.max(0, itemStart - 1)), -1);
          if (sel && sel.from < itemStart) {
            _view.dispatch(state.tr.setSelection(sel).scrollIntoView());
            return true;
          }
          return false;
        }

        if (event.key !== 'Tab') return false;
        const { $from } = _view.state.selection;
        // Tab-precedence (§6): inside a table, let the table extension's keymap
        // claim Tab/Shift+Tab for cell navigation. Outside a table, the existing
        // list-indent logic below is untouched.
        for (let d = $from.depth; d > 0; d--) {
          const n = $from.node(d).type.name;
          if (n === 'table' || n === 'tableCell' || n === 'tableHeader') return false;
        }
        let listItemType: string | null = null;
        for (let d = $from.depth; d > 0; d--) {
          const name = $from.node(d).type.name;
          if (name === 'taskItem' || name === 'listItem') {
            listItemType = name;
            break;
          }
        }
        if (!editorRef.current) return false;
        if (!listItemType) {
          // Tab trap outside lists: never move focus out of the editor.
          // (Slash-menu / tag / wiki-link popups grab Tab at the document
          // capture phase with stopPropagation, so they never reach here.)
          event.preventDefault();
          if (!event.shiftKey) {
            // insertText via a raw transaction, NOT commands.insertContent('\t')
            // — the latter parses its string arg as HTML, where '\t' is
            // collapsible whitespace and gets dropped.
            _view.dispatch(_view.state.tr.insertText('\t').scrollIntoView());
          }
          return true;
        }
        event.preventDefault();
        if (event.shiftKey) {
          editorRef.current.commands.liftListItem(listItemType);
        } else {
          // Sink first (standard — moves item with children), then detach children
          const sunk = editorRef.current.commands.sinkListItem(listItemType);
          if (sunk) {
            detachListItemChildren(editorRef.current);
          } else {
            // Sink failed — item is likely first in a split list.
            // Join with previous same-type list, then retry.
            tryJoinPreviousListAndSink(editorRef.current, listItemType);
          }
        }
        return true;
      },
    },
  });

  // Keep editorRef in sync
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // Tell the ![[embed]] NodeView which note it is rendering inside, so it can
  // send `?note=` and let the server break duplicate-filename ties by proximity
  // (the same image name lives in many `_attachment/` folders in a real vault).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const storage = editor.storage.wikiEmbed;
    if (storage) storage.notePath = attachmentNotePath || '';
  }, [editor, attachmentNotePath]);

  // Sync external content changes (e.g. initial load, popup↔inline sync).
  // Uses isSourceRef to break the save-sync loop: when THIS editor was the
  // source of the save, skip setContent() — the editor already has correct content.
  // Only apply setContent() for genuine external changes (initial load, other editor saved).
  useEffect(() => {
    if (!editor) return;
    // A destroyed editor has already torn down `storage`, so reading
    // `storage.markdown.getMarkdown()` below would throw a render-killing
    // TypeError. This effect CAN run against a dead editor: `content` changing in
    // the same commit that unmounts the editor (the todo panel's Notes tab being
    // switched away while a save settles) fires it after `destroy()`. There's
    // nothing to sync into an editor that's gone.
    if (editor.isDestroyed) return;

    // This editor was the source of changes — the content update came from
    // our own save. Editor already has correct content, skip setContent().
    if (isSourceRef.current) {
      isSourceRef.current = false;
      return;
    }

    const currentMd = editor.storage.markdown.getMarkdown();
    const preprocessed = entityRefsToMarkdownLinks(content);
    if (currentMd !== preprocessed) {
      log.info('notes', 'external content sync applied', {
        currentLen: currentMd.length, newLen: preprocessed.length,
      });

      // Save scroll position before replacing doc
      const scrollEl = editor.view.dom.closest('.global-notes-body, .notes-popup-body') as HTMLElement | null;
      const savedScroll = scrollEl?.scrollTop ?? 0;

      // Save cursor position
      const { from, to } = editor.state.selection;
      isExternalUpdate.current = true;
      // TipTap 3.x: second arg is an options object (was a boolean emitUpdate in 2.x).
      // Normalize on the way IN (orphan-checkbox ZWSP) so the editor parses it;
      // the comparison above stays on the bare form so unchanged notes don't
      // trigger a spurious re-render (the serializer emits the bare form).
      editor.commands.setContent(normalizeForEditor(preprocessed), { emitUpdate: false });
      // Restore cursor, clamped to new doc size
      const maxPos = editor.state.doc.content.size;
      editor.commands.setTextSelection({
        from: Math.min(from, maxPos),
        to: Math.min(to, maxPos),
      });
      isExternalUpdate.current = false;

      // Restore scroll after DOM update
      if (scrollEl) {
        requestAnimationFrame(() => { scrollEl.scrollTop = savedScroll; });
      }
    }
  }, [content, editor]);

  // Cleanup
  useEffect(() => {
    return () => {
      editor?.destroy();
    };
  }, [editor]);

  const handleSlashClose = useCallback(() => {
    setSlashState({ phase: 'closed' });
  }, []);

  const handleTagClose = useCallback(() => {
    setTagState({ phase: 'closed' });
  }, []);

  // Insert a #tag atomic node, replacing the typed `#query` range.
  const handleTagSelect = useCallback((slug: string) => {
    if (!editor || tagState.phase !== 'searching') return;
    const { range } = tagState;
    const docSize = editor.state.doc.content.size;
    if (range.from >= docSize || range.to > docSize) { handleTagClose(); return; }
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContent([{ type: 'tag', attrs: { name: slug } }, { type: 'text', text: ' ' }])
      .run();
    handleTagClose();
  }, [editor, tagState, handleTagClose]);

  const handleWikiLinkClose = useCallback(() => {
    setWikiLinkState({ phase: 'closed' });
  }, []);

  const handleWikiLinkSelect = useCallback((note: NoteListItem) => {
    if (!editor || wikiLinkState.phase !== 'searching') return;
    const { range } = wikiLinkState;
    const docSize = editor.state.doc.content.size;
    if (range.from >= docSize || range.to > docSize) { handleWikiLinkClose(); return; }

    // Obsidian-native authoring (§2.2/§3.5): insert the bare [[Title]] form, but
    // when the chosen note shares a basename with another note, insert the
    // PATH form [[folder/Title]] so the link is unambiguous (still 100%
    // Obsidian-portable). NEVER write an id into link text.
    const notes = wikiLinkNotesRef.current ?? [];
    const sameName = notes.filter(
      (n) => n.name.toLowerCase() === note.name.toLowerCase(),
    );
    const linkText = sameName.length > 1
      ? note.path.replace(/\.md$/i, '')   // path form disambiguates
      : note.name;                        // bare title is unambiguous

    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContent(`[[${linkText}]] `)
      .run();
    handleWikiLinkClose();
  }, [editor, wikiLinkState, handleWikiLinkClose]);

  const handleWikiLinkCreate = useCallback((name: string) => {
    if (!editor || wikiLinkState.phase !== 'searching') return;
    const { range } = wikiLinkState;
    const docSize = editor.state.doc.content.size;
    if (range.from >= docSize || range.to > docSize) { handleWikiLinkClose(); return; }

    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContent(`[[${name}]] `)
      .run();
    handleWikiLinkClose();
    // Navigate to the new note
    if (onWikiLinkClick) onWikiLinkClick(`${name}.md`);
  }, [editor, wikiLinkState, handleWikiLinkClose, onWikiLinkClick]);

  return (
    <>
      <EditorContent
        editor={editor}
        className={`notes-editor ${className ?? ''}`}
      />
      {/* Selection format toolbar (opt-in per surface). */}
      {editor && enableBlockTools && <NotesBubbleMenu editor={editor} onAsk={onAskSelection} />}
      {editor && slashState.phase !== 'closed' && (
        <SlashCommandPortal
          editor={editor}
          state={slashState}
          tasks={tasks ?? []}
          focusedTaskId={focusedTaskId}
          wikiLinkNotes={wikiLinkNotes}
          onClose={handleSlashClose}
        />
      )}
      {editor && tagState.phase === 'searching' && (
        <TagAutocomplete
          editor={editor}
          state={tagState}
          tags={tagSuggestions ?? []}
          onClose={handleTagClose}
          onSelect={handleTagSelect}
        />
      )}
      {editor && wikiLinkState.phase === 'searching' && enableWikiLinks && wikiLinkNotes && (
        <WikiLinkAutocomplete
          editor={editor}
          state={wikiLinkState}
          notes={wikiLinkNotes}
          onClose={handleWikiLinkClose}
          onSelect={handleWikiLinkSelect}
          onCreateNew={handleWikiLinkCreate}
        />
      )}
      {disambig && (
        <WikiLinkDisambiguation
          target={disambig.target}
          candidates={disambig.candidates}
          onPick={(note) => {
            setDisambig(null);
            onWikiLinkClickRef.current?.(note.path);
          }}
          onClose={() => setDisambig(null)}
        />
      )}
    </>
  );
}
