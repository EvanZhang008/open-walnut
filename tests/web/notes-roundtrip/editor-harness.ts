/**
 * Headless markdown round-trip harness — drives the EXACT serializer + parser
 * that the live `NotesEditor` uses, without mounting a ProseMirror EditorView.
 *
 * `NotesEditor.tsx` wires `tiptap-markdown`'s `Markdown` extension; that
 * extension builds a `MarkdownSerializer` + `MarkdownParser` from the editor's
 * resolved extensions and their `storage.markdown` specs (see
 * `tiptap-markdown/src/serialize|parse`). We reconstruct the same pipeline:
 *
 *   - `getSchema(extensions)`            → the real ProseMirror schema
 *   - `resolveExtensions(extensions)`    → each ext with `.storage.markdown` populated
 *   - a minimal `fakeEditor` exposing `{ schema, extensionManager.extensions, options }`
 *     — the only surface MarkdownSerializer/MarkdownParser read.
 *
 * Round-trip = the same path the editor takes on load→save:
 *   md ─parser.parse()→ HTML ─generateJSON(schema)→ PM-JSON ─nodeFromJSON→ doc
 *      ─serializer.serialize(doc)→ md
 *
 * The extension set MUST mirror `NotesEditor.tsx` exactly (same configure flags)
 * so the corpus asserts production behaviour, not a divergent test setup.
 */

import {
  getSchema,
  resolveExtensions,
  generateJSON,
  type Extensions,
} from '@tiptap/core';
import type { Fragment, Node as PMNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';

import { tableExtensions } from '@/components/notes/extensions/table-kit';
import { FenceCodeBlock } from '@/components/notes/extensions/fence-code-block';
import { LiteralText } from '@/components/notes/extensions/literal-text';
import { MarkdownCopy } from '@/components/notes/extensions/markdown-copy';
import { TagNode } from '@/components/notes/extensions/tag-node';
import { Callout } from '@/components/notes/extensions/callout-node';
import { WikiEmbedNode } from '@/components/notes/extensions/wiki-embed-node';

/**
 * Same `TightTaskList` patch NotesEditor uses (task lists always tight) — without
 * it, prosemirror-markdown re-inserts blank lines between checklist items on
 * every save, breaking the nested/task-list corpus case.
 */
const TightTaskList = TaskList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      tight: {
        default: true,
        parseHTML: () => true,
        renderHTML: (attributes: { tight?: boolean }) => ({
          'data-tight': attributes.tight ? 'true' : null,
        }),
      },
    };
  },
});

/**
 * Build the production extension set. Mirrors `NotesEditor.tsx`'s `extensions`
 * array (block-tools UI extensions like bubble-menu/drag-handle are render-only
 * and add no markdown serialize/parse spec, so they're irrelevant to round-trip
 * and intentionally omitted — the schema + every markdown spec is identical).
 */
export function buildNotesExtensions(): Extensions {
  return [
    StarterKit.configure({ link: false, codeBlock: false, text: false }),
    // Same node ('text'), only the markdown serialize differs: `<`/`>` typed as
    // prose are written verbatim, not as entities.
    LiteralText,
    // Same node ('codeBlock'), only the ``` input rule differs — mirrored so the
    // resolved extension list stays identical to production.
    FenceCodeBlock,
    TightTaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ inline: true, allowBase64: true }),
    Markdown.configure({
      html: true,
      transformPastedText: true,
      transformCopiedText: false,
    }),
    MarkdownCopy,
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: 'https',
    }),
    ...tableExtensions,
    TagNode,
    Callout,
    // ![[embed]] node — must be present so the corpus asserts that embeds
    // survive load→save byte-clean (atom node + literal-write serialize + the
    // before-image parse rule). The React NodeView is never invoked headless
    // (no EditorView), only the schema + markdown serialize/parse specs run.
    WikiEmbedNode,
  ];
}

export interface NotesMarkdownHarness {
  /** Parse markdown → a ProseMirror doc (the editor's "load" half). */
  mdToDoc(md: string): PMNode;
  /** Serialize a ProseMirror doc → markdown (the editor's "save" half). */
  docToMd(doc: PMNode): string;
  /** One full load→save cycle: md → doc → md. */
  roundTrip(md: string): string;
  /** The resolved ProseMirror schema (for node-level deep-equal assertions). */
  schema: ReturnType<typeof getSchema>;
  /** The production markdown serializer (takes a doc or any Fragment). */
  serializer: { serialize(content: PMNode | Fragment): string };
}

/**
 * Construct the headless harness. Throws loudly if the DOM shim was not loaded
 * first (generateJSON / the parser need `document`).
 */
export function createNotesMarkdownHarness(): NotesMarkdownHarness {
  if (typeof document === 'undefined' || typeof (globalThis as any).DOMParser === 'undefined') {
    throw new Error(
      'createNotesMarkdownHarness: DOM not initialised — load tests/web/notes-roundtrip/dom-setup.ts via the vitest `setupFiles` first.',
    );
  }

  const extensions = buildNotesExtensions();
  const schema = getSchema(extensions);
  const resolved = resolveExtensions(extensions);

  // The minimal editor surface MarkdownSerializer/MarkdownParser read. They only
  // touch `editor.schema`, `editor.extensionManager.extensions[].{name,type,options,storage}`,
  // and (for getMarkdown, which we bypass) `editor.state.doc`.
  const fakeEditor = {
    schema,
    extensionManager: { extensions: resolved },
    options: { content: '' },
    storage: {} as Record<string, unknown>,
  } as any;

  // `tiptap-markdown` does not export its MarkdownSerializer/MarkdownParser
  // classes, and their source files use extensionless relative imports that the
  // package "exports" map blocks. Instead we run the SAME wiring the live editor
  // runs: the `Markdown` extension's `onBeforeCreate` instantiates both classes
  // and stashes them on `editor.storage.markdown`. We invoke it with the `this`
  // context TipTap provides (`{ editor, options }`). This guarantees we use the
  // exact production serializer/parser objects — no reach into `src/`.
  const markdownExt = resolved.find((e: any) => e.name === 'markdown');
  if (!markdownExt) throw new Error('createNotesMarkdownHarness: Markdown extension missing');
  const onBeforeCreate = markdownExt.config.onBeforeCreate as (this: unknown) => void;
  onBeforeCreate.call({ editor: fakeEditor, options: markdownExt.options });
  const md = fakeEditor.storage.markdown as {
    parser: { parse(content: string, opts?: { inline?: boolean }): string };
    serializer: { serialize(content: PMNode | Fragment): string };
  };

  function mdToDoc(input: string): PMNode {
    const html: string = md.parser.parse(input);
    const json = generateJSON(html, extensions);
    return schema.nodeFromJSON(json);
  }

  function docToMd(doc: PMNode): string {
    return md.serializer.serialize(doc);
  }

  function roundTrip(md: string): string {
    return docToMd(mdToDoc(md));
  }

  return { mdToDoc, docToMd, roundTrip, schema, serializer: md.serializer };
}
