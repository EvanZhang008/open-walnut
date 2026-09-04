/**
 * Client-side builders and parser for the entity-ref pill markup — the mirror of
 * the server's src/utils/entity-refs.ts. Keep the two in sync: an emitter on
 * either side must produce byte-identical tags, because the same regex shape
 * reads them back on both.
 *
 * Escaping contract (from the server's taskRefTag): inside an attribute only `"`
 * is escaped, to `&quot;`. Nothing else is touched — the value is XML-ish markup
 * that the render pipeline HTML-escapes for real when it emits the anchor, so
 * escaping `&`/`<` here would double-escape it there.
 *
 * A project has no separate identifier: its NAME is its identity, so a project
 * ref carries the name in `id` and keeps the attribute shape identical to the
 * other two kinds. One shape means one regex, one extractor.
 *
 * PURE MODULE — no React, no DOM, no import from markdown.ts (which pulls in
 * marked/dompurify). It has to load in a bare node test.
 */

/** Escape a value for attribute context — `"` only, per the server's contract. */
function escAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}

/** Undo escAttr when a label leaves attribute context. */
function decodeAttr(s: string): string {
  return s.replace(/&quot;/g, '"');
}

/** Build a `<task-ref/>` tag. */
export function taskRefTag(id: string, label: string): string {
  return `<task-ref id="${escAttr(id)}" label="${escAttr(label)}"/>`;
}

/** Build a `<session-ref/>` tag — same contract as taskRefTag. */
export function sessionRefTag(id: string, label: string): string {
  return `<session-ref id="${escAttr(id)}" label="${escAttr(label)}"/>`;
}

/**
 * Build a `<project-ref/>` tag. `name` IS the identity, so it lands in `id`; the
 * label defaults to the name because a project pill has nothing else to show
 * (unlike a task, whose id is opaque and whose title is the label).
 */
export function projectRefTag(name: string, label?: string): string {
  return `<project-ref id="${escAttr(name)}" label="${escAttr(label ?? name)}"/>`;
}

export type EntityRefKind = 'task' | 'session' | 'project';

/** One tag occurrence: its kind, attributes, and `[start, end)` span in the text. */
export interface EntityRefMatch {
  kind: EntityRefKind;
  id: string;
  /** Decoded (`&quot;` → `"`). Absent when the tag carried no label attribute. */
  label?: string;
  start: number;
  end: number;
}

// Module-private: a shared `g`-flag regex is a lastIndex footgun for any consumer
// using .test()/.exec(). Only matchAll (which clones per spec) reads it.
const ENTITY_REF_RE = /<(task|session|project)-ref\s+id="([^"]*)"(?:\s+label="([^"]*)")?\s*\/?>/g;

/**
 * Every ref tag in `text`, in document order, with the span each one occupies.
 *
 * The span is what makes this usable for editing rather than only rendering: a
 * composer can replace a pill in place, and a highlighter can decorate it,
 * without re-deriving positions from a second scan that could disagree.
 */
export function extractEntityRefs(text: string): EntityRefMatch[] {
  const out: EntityRefMatch[] = [];
  // matchAll clones the regex per spec, so the shared g-flag instance is safe.
  for (const m of text.matchAll(ENTITY_REF_RE)) {
    const start = m.index ?? 0;
    const kind = m[1] as EntityRefKind;
    const ref: EntityRefMatch = {
      kind,
      // A task/session id is opaque and never carries a quote; a project's id
      // IS its display name, so it must come back decoded like a label does.
      id: kind === 'project' ? decodeAttr(m[2] ?? '') : (m[2] ?? ''),
      start,
      end: start + m[0].length,
    };
    if (m[3] !== undefined) ref.label = decodeAttr(m[3]);
    out.push(ref);
  }
  return out;
}
