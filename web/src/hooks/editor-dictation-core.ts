/**
 * Position logic for dictation into a rich editor (useEditorDictation), kept free
 * of any ProseMirror runtime import so it can be tested against a plain document.
 *
 * A span is the run of dictated words the editor holds right now, in document
 * positions: [from, to) holding exactly `text`. `pre`/`post` are the single
 * spaces the first write added beside it so the words did not touch the text
 * around them; they sit just outside the span and are removed with it when the
 * final text is written as one undoable step.
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Mappable } from '@tiptap/pm/transform';

export interface EditorDictationSpan {
  from: number;
  to: number;
  text: string;
  pre: string;
  post: string;
}

/** What an inline atom (an image, a tag chip) reads as: text, never a space. */
const LEAF = '\uFFFC';

/** The text of [from, to) as the span check reads it, or null when out of range. */
export function spanText(doc: PMNode, from: number, to: number): string | null {
  if (from < 0 || to > doc.content.size || to < from) return null;
  return doc.textBetween(from, to, '\n', LEAF);
}

/**
 * Follow a span through a change someone else made (the user typing, a paste,
 * an external reload). Text typed right at either edge stays outside the span.
 * Returns null when the change reached inside the span or replaced it: the words
 * there are no longer only the dictation's, so it must not write over them.
 */
export function mapDictationSpan(span: EditorDictationSpan, mapping: Mappable, doc: PMNode): EditorDictationSpan | null {
  const empty = span.from === span.to;
  const a = mapping.mapResult(span.from, 1);
  const b = empty ? a : mapping.mapResult(span.to, -1);
  if (a.deletedAcross || b.deletedAcross || b.pos < a.pos) return null;
  if (spanText(doc, a.pos, b.pos) !== span.text) return null;
  return { ...span, from: a.pos, to: b.pos };
}

/** The spaces to add so `words` written between `before` and `after` touch neither (the composer's rule). */
export function dictationPadding(before: string, after: string): { pre: string; post: string } {
  return {
    pre: before.length > 0 && !/\s$/.test(before) ? ' ' : '',
    post: after.length > 0 && !/^\s/.test(after) ? ' ' : '',
  };
}

/**
 * A position where text can go, as close to `pos` as possible: `pos` itself when
 * it sits in a textblock, else the end of the last textblock before it, else the
 * start of the first one after it. Null for a document with no textblock at all.
 * (A selected table, image block or callout puts the caret between blocks.)
 */
export function textAnchor(doc: PMNode, pos: number): number | null {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  if (doc.resolve(clamped).parent.inlineContent) return clamped;
  const near: { before: number | null; after: number | null } = { before: null, after: null };
  doc.descendants((node, at) => {
    if (near.after !== null) return false;
    if (!node.isTextblock) return true;
    if (at < clamped) near.before = at + 1 + node.content.size;
    else near.after = at + 1;
    return false;
  });
  return near.before ?? near.after;
}

/**
 * Where the first write of a dictation goes, and the spaces it needs: at `pos`
 * (moved into text when it is not there), padded against the text on each side
 * within the same textblock.
 */
export function planFirstWrite(doc: PMNode, pos: number): { at: number; pre: string; post: string } | null {
  const at = textAnchor(doc, pos);
  if (at === null) return null;
  const $at = doc.resolve(at);
  const start = at - $at.parentOffset;
  const end = start + $at.parent.content.size;
  return { at, ...dictationPadding(doc.textBetween(start, at, '\n', LEAF), doc.textBetween(at, end, '\n', LEAF)) };
}

/**
 * The range the final text replaces: the span with its padding when that padding
 * is still exactly where it was put (so one undo takes the whole dictation away),
 * else the span alone.
 */
export function finalRange(doc: PMNode, span: EditorDictationSpan): { from: number; to: number; pre: string; post: string } {
  const padFrom = span.from - span.pre.length;
  const padTo = span.to + span.post.length;
  const padded = spanText(doc, padFrom, span.from) === span.pre && spanText(doc, span.to, padTo) === span.post;
  return padded
    ? { from: padFrom, to: padTo, pre: span.pre, post: span.post }
    : { from: span.from, to: span.to, pre: '', post: '' };
}

/**
 * The structural surface of a ProseMirror Transaction this file writes through
 * (kept structural so the runtime class never has to be imported here).
 */
export interface DictationTr {
  doc: PMNode;
  insertText(text: string, from: number, to?: number): unknown;
  delete(from: number, to: number): unknown;
}

/** Replace [from, to) with `words` and nothing more (insertText('') would widen
 *  the delete to whole nodes, e.g. take an emptied paragraph with it). */
function replaceText(tr: DictationTr, from: number, to: number, words: string): void {
  if (words) tr.insertText(words, from, to);
  else tr.delete(from, to);
}

/**
 * Write a live draft into `tr`: over the span a draft already owns, else at
 * `anchor` with the padding it needs. Returns the span the draft now owns, or
 * null when nothing was written (no words yet, or no place for text).
 */
export function writeDraft(tr: DictationTr, span: EditorDictationSpan | null, words: string, anchor: number): EditorDictationSpan | null {
  if (span) {
    replaceText(tr, span.from, span.to, words);
    return { ...span, to: span.from + words.length, text: words };
  }
  if (!words) return null;
  const plan = planFirstWrite(tr.doc, anchor);
  if (!plan) return null;
  tr.insertText(plan.pre + words + plan.post, plan.at);
  const from = plan.at + plan.pre.length;
  return { from, to: from + words.length, text: words, pre: plan.pre, post: plan.post };
}

/**
 * First half of the final write: take the draft (with its padding when intact)
 * back out of the document, in a transaction kept out of undo history. Returns
 * where the final text goes and the padding to put back around it.
 */
export function takeBackDraft(tr: DictationTr, span: EditorDictationSpan): { at: number; pre: string; post: string } {
  const range = finalRange(tr.doc, span);
  tr.delete(range.from, range.to);
  return { at: range.from, pre: range.pre, post: range.post };
}

/**
 * Second half (or the whole of it, when no draft came first): write the final
 * words as the one undoable step. Returns the span they occupy (the refine target).
 */
export function writeFinal(tr: DictationTr, at: number, pre: string, post: string, words: string): EditorDictationSpan {
  tr.insertText(pre + words + post, at);
  const from = at + pre.length;
  return { from, to: from + words.length, text: words, pre, post };
}

/** Swap refined words in for the provisional ones `last` holds. Returns the new span. */
export function writeRefine(tr: DictationTr, last: EditorDictationSpan, finalText: string): EditorDictationSpan {
  replaceText(tr, last.from, last.to, finalText);
  return { ...last, to: last.from + finalText.length, text: finalText };
}
