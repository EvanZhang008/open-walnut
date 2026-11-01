/**
 * How the composer DRAWS its references (2026-11-01, the user: a picked task "should
 * render in the input bar, not just be text ... notes and everything else the same").
 *
 * The text stays exactly what composer-refs.ts keeps (`@[label]` tokens, `@/path` file
 * references), so typing, the caret, IME, undo and what is sent are the textarea's own.
 * A layer behind the textarea draws the same characters, and each reference among them
 * as a pill: the opening `@[` (or `@`) is where its icon sits and the closing `]` is its
 * right edge, so every character keeps its width and the caret lines up.
 *
 *   composerSegments(body, table, active) → text and pill segments, in order
 *   pillAt(segments, caret, side)          → the pill the caret sits at the edge of, or in
 *
 * PURE MODULE: no React, no DOM.
 */
import { extractEntityRefs, sourceDisplayName, sourceOfRefId, type EntityRefKind } from '@/utils/entity-ref-tags';
import { listInlineRefs, type RefTable } from './composer-refs';

/** Every kind of reference the composer can hold. */
export type ComposerPillKind = EntityRefKind | 'file';

/**
 * Every kind, once. A kind missing here does not type-check, and
 * tests/web/composer-ref-pills.test.ts fails on a reference kind of entity-ref-tags.ts
 * that is not drawn as a pill or has no CSS rule.
 */
export const PILL_KINDS: Record<ComposerPillKind, true> = { task: true, session: true, project: true, source: true, file: true };

export interface ComposerPill {
  kind: ComposerPillKind;
  /** The characters the icon covers: `@[`, `@`, or `@"`. */
  open: string;
  /** Drawn quieter: a source's name (`Chat · `) or a file's folder (`/repo/src/`). */
  lead: string;
  /** Drawn as the pill's words. */
  label: string;
  /** The closing characters (`]`, `"`, or none). */
  close: string;
  /** For a source: its id (`notes`, `team-chat`). */
  sourceId?: string;
}

export interface ComposerSegment {
  start: number;
  end: number;
  text: string;
  pill?: ComposerPill;
}

/** A file reference the picker writes (formatMentionPath): `@/abs/path`, `@~/path`, `@"/a b"`. */
const FILE_REF_RE = /(^|\s)(@"(?:~?\/)[^"\n]*"|@~?\/(?:[^\s"]*[^\s".,;:!?)])?)/g;

interface Span { start: number; end: number; pill: ComposerPill }

function entitySpans(body: string, table: RefTable): Span[] {
  const out: Span[] = [];
  for (const ref of listInlineRefs(body, table)) {
    const m = extractEntityRefs(ref.tag)[0];
    if (!m) continue;
    let lead = '';
    let label = ref.label;
    let sourceId: string | undefined;
    if (m.kind === 'source') {
      sourceId = sourceOfRefId(m.id);
      const name = `${sourceDisplayName(sourceId)} · `;
      if (label.startsWith(name)) { lead = name; label = label.slice(name.length); }
    }
    out.push({ start: ref.start, end: ref.end, pill: { kind: m.kind, open: '@[', lead, label, close: ']', sourceId } });
  }
  return out;
}

/** Every file reference in `text`, as written (`@/a/b.ts`, `@"/a b/c.md"`). */
export function fileRefsIn(text: string): string[] {
  return [...text.matchAll(FILE_REF_RE)].map((m) => m[2]);
}

function fileSpans(body: string, files?: ReadonlySet<string>): Span[] {
  const out: Span[] = [];
  for (const m of body.matchAll(FILE_REF_RE)) {
    const start = (m.index ?? 0) + m[1].length;
    const raw = m[2];
    if (files && !files.has(raw)) continue;
    const quoted = raw.startsWith('@"');
    const path = quoted ? raw.slice(2, -1) : raw.slice(1);
    const cut = path.replace(/\/+$/, '').lastIndexOf('/') + 1;
    out.push({
      start,
      end: start + raw.length,
      pill: { kind: 'file', open: quoted ? '@"' : '@', lead: path.slice(0, cut), label: path.slice(cut), close: quoted ? '"' : '' },
    });
  }
  return out;
}

/**
 * The body cut into plain text and pills. `active` is the `@query` the user is typing
 * right now (the palette's span): it stays plain text until it is picked. `files`, when
 * given, are the file references the picker wrote: a path the user typed or pasted
 * stays text they can edit.
 */
export function composerSegments(
  body: string,
  table: RefTable,
  opts: { active?: { start: number; end: number } | null; files?: ReadonlySet<string> } = {},
): ComposerSegment[] {
  const { active } = opts;
  const spans = [...entitySpans(body, table), ...fileSpans(body, opts.files)]
    .filter((s) => !active || s.end <= active.start || s.start >= active.end)
    .sort((a, b) => a.start - b.start);
  const out: ComposerSegment[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.start < at) continue; // overlapping matches: the first one wins
    if (s.start > at) out.push({ start: at, end: s.start, text: body.slice(at, s.start) });
    out.push({ start: s.start, end: s.end, text: body.slice(s.start, s.end), pill: s.pill });
    at = s.end;
  }
  if (at < body.length) out.push({ start: at, end: body.length, text: body.slice(at) });
  return out;
}

/** Does the body draw any pill? (The layer is only on while it does.) */
export function hasPills(segments: readonly ComposerSegment[]): boolean {
  return segments.some((s) => s.pill);
}

/**
 * The pill whose edge the caret sits on, so the keys treat it as one unit: `before`
 * finds the pill that ENDS at the caret (Backspace, ←), `after` the one that STARTS at
 * it (Delete, →), `inside` the one the caret is strictly within (a click into its words).
 */
export function pillAt(segments: readonly ComposerSegment[], caret: number, side: 'before' | 'after' | 'inside'): ComposerSegment | null {
  for (const s of segments) {
    if (!s.pill) continue;
    if (side === 'before' && s.end === caret) return s;
    if (side === 'after' && s.start === caret) return s;
    if (side === 'inside' && caret > s.start && caret < s.end) return s;
  }
  return null;
}
