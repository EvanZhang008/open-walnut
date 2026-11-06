/**
 * Keep the file's own bytes wherever the user did not edit.
 *
 * The WYSIWYG editor (tiptap-markdown) does not round-trip Markdown byte for byte:
 * serializing an untouched document rewrites `|---|` as `| --- |`, escapes `#` and
 * `~`, pads table rows, drops blank lines and the final newline. With saving always
 * live, every keystroke would write that whole rewrite to disk (2026-11-07 review:
 * one typed sentence changed 24 other lines of a 153-line note).
 *
 * The fix is a three-way merge with the editor's own normalization as the base:
 *   base   = serialize(parse(original))  what the editor makes of the file untouched
 *   ours   = serialize(current doc)      the same, plus the user's edits
 *   theirs = original                    the bytes on disk
 * Lines only normalization changed come from `theirs` (the original bytes); lines
 * the user changed come from `ours`. Where both touch the same lines (the user typed
 * into a table row the serializer also rewrote), the user's version wins.
 *
 * The caller still checks that the result means the same document as `current`
 * (see FileMarkdownEditor) and falls back to `current` when it does not.
 */
import { threeWayMerge } from '@open-walnut/three-way-merge';

export function keepUntouchedSource(original: string, normalized: string, current: string): string {
  if (current === normalized) return original;
  if (original === normalized) return current;
  const result = threeWayMerge(normalized, current, original);
  return result.ok ? result.merged : result.oursText;
}
