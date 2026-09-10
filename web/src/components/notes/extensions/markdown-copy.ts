/**
 * Markdown text for a copied selection (⌘C plain-text flavour).
 *
 * `tiptap-markdown`'s own `transformCopiedText` serializes `slice.content`
 * verbatim. A ProseMirror slice for a few words inside a table cell is
 * `table(row(cell(text)))`, open at both ends, so the library wrote the words
 * back as a one-cell table (`| words |` + a `| --- |` row). Same for words in a
 * heading (`# words`), a list item (`- words`), or a code block (fenced).
 *
 * Rule here: when the selection sits inside ONE textblock, the open ancestors
 * are context the user never selected, so only the inline run is serialized
 * (marks such as `**bold**` / `` `code` `` survive; a code block copies as
 * plain text). A selection that spans blocks keeps the library behaviour.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Fragment, type Node as PMNode, type Schema, type Slice } from '@tiptap/pm/model';

export interface MarkdownSliceSerializer {
  serialize(content: PMNode | Fragment): string;
}

export function markdownForCopiedSlice(
  slice: Slice,
  schema: Schema,
  serializer: MarkdownSliceSerializer,
): string {
  // The clipboard slice is `selection.content()`, i.e. `doc.slice(from, to, true)`:
  // open at both ends through every ancestor of the selected text. Walk that
  // single-child spine down to the textblock the user was actually in.
  let { content, openStart, openEnd } = slice;
  while (openStart > 0 && openEnd > 0 && content.childCount === 1) {
    const node = content.firstChild!;
    if (node.isTextblock) {
      if (node.type.spec.code) return node.textContent;
      content = node.content;
      break;
    }
    if (node.isLeaf) break;
    content = node.content;
    openStart--;
    openEnd--;
  }

  // An inline run (also what a parent-less slice of one textblock looks like):
  // render it as a paragraph so marks serialize, but no block wrapper.
  const first = content.firstChild;
  if (first && first.isInline) {
    const paragraph = schema.nodes.paragraph;
    return paragraph
      ? serializer.serialize(Fragment.from(paragraph.create(null, content)))
      : content.textBetween(0, content.size, '\n');
  }

  return serializer.serialize(slice.content);
}

export const MarkdownCopy = Extension.create({
  name: 'markdownCopy',

  addProseMirrorPlugins() {
    const { editor } = this;
    return [
      new Plugin({
        key: new PluginKey('markdownCopy'),
        props: {
          clipboardTextSerializer: (slice) => {
            // `''` is falsy to `someProp`, so ProseMirror's plain-text default runs
            // when the Markdown extension has not built its serializer.
            const serializer = (editor.storage.markdown as { serializer?: MarkdownSliceSerializer }).serializer;
            if (!serializer) return '';
            return markdownForCopiedSlice(slice, editor.schema, serializer);
          },
        },
      }),
    ];
  },
});
