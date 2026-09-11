/**
 * Three-way merge (diff3) for the Files panel's Live Edit mode.
 *
 * Pure: no DOM, no network, no React — the whole point is that the rule which
 * decides "these two edits can both survive" is unit-testable, because the cost
 * of getting it wrong is silently throwing away either the user's typing or an
 * agent's write.
 *
 * The shape of the problem: we hold `base` (the bytes our optimistic lock refers
 * to), `ours` (the editor buffer) and `theirs` (what is on disk now). Both sides
 * are expressed as edits AGAINST BASE, in base line coordinates, so the two edit
 * lists can be walked together in one pass.
 *
 * CONFLICT RULE (exact): two hunks conflict when their base ranges OVERLAP and
 * they are not the identical edit. `[baseStart, baseEnd)` is half-open, so
 * touching ranges (ours replaces line 5, theirs replaces line 6) do NOT overlap
 * and both apply; two insertions at the same point are empty ranges, so they do
 * not overlap either and both apply (ours first). "Identical" means same base
 * range AND same replacement lines — that edit is applied once instead of twice.
 * 同行修改仅在词级范围互不重叠时合并，行数变化和真正重叠继续交给用户。
 */
import { diffLines, diffWordsWithSpace } from 'diff';

/** One side's edit, in BASE line coordinates. `[baseStart, baseEnd)` is
 *  half-open; an empty range is a pure insertion at that point. */
export interface MergeHunk {
  baseStart: number;
  baseEnd: number;
  /** Lines that replace the base range (empty = deletion). */
  lines: string[];
}

export type MergeResult =
  | { ok: true; merged: string }
  | { ok: false; conflicts: number };

/** CRLF collapsed to LF so the diff sees pure line content. The original ending
 *  is restored on output — see dominantEol. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** The line ending the text mostly uses, or null when it has no line break. */
function dominantEol(text: string): '\r\n' | '\n' | null {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  if (crlf === 0 && lf === 0) return null;
  return crlf > lf ? '\r\n' : '\n';
}

/** Lines of LF-normalised text, WITHOUT the phantom empty element a trailing
 *  newline produces — trailing-newline state is carried separately so it can be
 *  restored exactly rather than smuggled in as a bogus last line. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Lines of one jsdiff part. Every line we feed in is '\n'-terminated, so the
 *  last split element is the empty tail — dropping it blindly would eat a real
 *  line if that ever stopped being true, hence the endsWith check. */
function partLines(value: string): string[] {
  if (value === '') return [];
  return value.endsWith('\n') ? value.slice(0, -1).split('\n') : value.split('\n');
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * Express `other` as a list of hunks against `base`, in base line coordinates.
 *
 * jsdiff emits a replacement as adjacent removed+added parts; those are merged
 * into ONE hunk, because "delete 2 lines, insert 3" at the same spot is a single
 * edit as far as overlap is concerned — treating them separately would report a
 * self-conflict between a side and itself.
 */
export function diffToHunks(base: string[], other: string[]): MergeHunk[] {
  const toText = (lines: string[]) => lines.map((line) => `${line}\n`).join('');
  const parts = diffLines(toText(base), toText(other));
  const hunks: MergeHunk[] = [];
  let baseIdx = 0;
  let open: MergeHunk | null = null;

  for (const part of parts) {
    const lines = partLines(part.value);
    if (!part.added && !part.removed) {
      if (open) { hunks.push(open); open = null; }
      baseIdx += lines.length;
      continue;
    }
    if (!open) open = { baseStart: baseIdx, baseEnd: baseIdx, lines: [] };
    if (part.removed) {
      baseIdx += lines.length;
      open.baseEnd = baseIdx;
    } else {
      open.lines.push(...lines);
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

interface InlineEdit {
  start: number;
  end: number;
  text: string;
}

function inlineEdits(base: string, text: string, timeout: number): InlineEdit[] | null {
  const parts = diffWordsWithSpace(base, text, { timeout });
  if (!parts) return null;
  const edits: InlineEdit[] = [];
  let pos = 0;
  let edit: InlineEdit | null = null;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      if (edit) edits.push(edit);
      edit = null;
      pos += part.value.length;
      continue;
    }
    edit ??= { start: pos, end: pos, text: '' };
    if (part.removed) {
      pos += part.value.length;
      edit.end = pos;
    } else {
      edit.text += part.value;
    }
  }
  if (edit) edits.push(edit);
  return edits;
}

function mergeInline(base: string, ours: string, theirs: string, deadline: number): string | null {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;
  if (Date.now() >= deadline) return null;
  const a = inlineEdits(base, ours, Math.max(1, deadline - Date.now()));
  const b = inlineEdits(base, theirs, Math.max(1, deadline - Date.now()));
  if (!a || !b) return null;
  const edits = [...a];
  for (const other of b) {
    let duplicate = false;
    for (const own of a) {
      if (Date.now() >= deadline) return null;
      if (own.start === other.start && own.end === other.end && own.text === other.text) {
        duplicate = true;
        continue;
      }
      // 插入点落在另一侧替换的边界也不猜测，避免拼出双方都没写过的词。
      const overlaps = own.start === own.end
        ? own.start >= other.start && own.start <= other.end
        : other.start === other.end
          ? other.start >= own.start && other.start <= own.end
          : own.start < other.end && other.start < own.end;
      if (overlaps) return null;
    }
    if (!duplicate) edits.push(other);
  }
  edits.sort((x, y) => x.start - y.start);
  let pos = 0;
  let result = '';
  for (const edit of edits) {
    result += base.slice(pos, edit.start) + edit.text;
    pos = edit.end;
  }
  return result + base.slice(pos);
}

function applyRegion(base: string[], start: number, end: number, hunks: MergeHunk[]): string[] {
  const result: string[] = [];
  let pos = start;
  for (const hunk of hunks) {
    result.push(...base.slice(pos, hunk.baseStart), ...hunk.lines);
    pos = hunk.baseEnd;
  }
  result.push(...base.slice(pos, end));
  return result;
}

/**
 * Merge `ours` and `theirs` over their common `base`.
 *
 * Returns the merged text when every hunk pair could be applied without
 * guessing, otherwise the number of conflicting pairs (the caller only needs to
 * know that a human has to look, but the count makes a test assertion precise).
 */
export function threeWayMerge(base: string, ours: string, theirs: string): MergeResult {
  const b = normalizeEol(base);
  const o = normalizeEol(ours);
  const t = normalizeEol(theirs);

  // The buffer that is about to be written decides the ending; base and theirs
  // only answer when ours has no line break to learn from at all.
  const eol = dominantEol(ours) ?? dominantEol(theirs) ?? dominantEol(base) ?? '\n';
  const baseTrail = b.endsWith('\n');
  const oursTrail = o.endsWith('\n');
  const theirsTrail = t.endsWith('\n');
  // When the two sides disagree about the final newline, the side that CHANGED
  // it is the one expressing an intent; the other is just carrying base along.
  const trailing = oursTrail === theirsTrail
    ? oursTrail
    : (oursTrail !== baseTrail ? oursTrail : theirsTrail);

  // One side untouched ⇒ the other side IS the answer, VERBATIM. Returning the
  // original bytes (not a rejoin) is deliberate: rewriting the untouched side's
  // line endings would be a whole-file change nobody asked for.
  if (o === b) return { ok: true, merged: theirs };
  if (t === b) return { ok: true, merged: ours };

  const baseLines = splitLines(b);
  const ourLines = splitLines(o);
  const theirLines = splitLines(t);

  const ourHunks = diffToHunks(baseLines, ourLines);
  const theirHunks = diffToHunks(baseLines, theirLines);

  const out: string[] = [];
  const inlineDeadline = Date.now() + 40;
  let pos = 0;
  let i = 0;
  let j = 0;
  let conflicts = 0;

  const copyBaseTo = (upto: number) => {
    for (let k = pos; k < upto; k++) out.push(baseLines[k]!);
    if (upto > pos) pos = upto;
  };
  const apply = (h: MergeHunk) => {
    copyBaseTo(h.baseStart);
    out.push(...h.lines);
    if (h.baseEnd > pos) pos = h.baseEnd;
  };

  while (i < ourHunks.length || j < theirHunks.length) {
    const a = ourHunks[i];
    const c = theirHunks[j];
    // A hunk a previous conflict already swallowed: nothing left to decide.
    if (a && a.baseEnd < pos) { i++; continue; }
    if (c && c.baseEnd < pos) { j++; continue; }

    // Strictly-earlier hunk wins the turn. `<=` (not `<`) is what makes touching
    // ranges and same-point insertions clean rather than conflicts.
    if (a && (!c || a.baseEnd <= c.baseStart)) {
      if (a.baseStart < pos) { conflicts++; i++; if (a.baseEnd > pos) pos = a.baseEnd; continue; }
      apply(a);
      i++;
      continue;
    }
    if (c && (!a || c.baseEnd <= a.baseStart)) {
      if (c.baseStart < pos) { conflicts++; j++; if (c.baseEnd > pos) pos = c.baseEnd; continue; }
      apply(c);
      j++;
      continue;
    }

    // Overlapping. The same edit made on both sides is not a disagreement.
    if (a && c && a.baseStart === c.baseStart && a.baseEnd === c.baseEnd && sameLines(a.lines, c.lines)) {
      if (a.baseStart < pos) conflicts++;
      else apply(a);
      i++;
      j++;
      continue;
    }

    if (a && c) {
      const start = Math.min(a.baseStart, c.baseStart);
      let end = Math.max(a.baseEnd, c.baseEnd);
      const ourStart = i++;
      const theirStart = j++;
      let expanded: boolean;
      do {
        expanded = false;
        while (ourHunks[i] && ourHunks[i].baseStart < end) {
          end = Math.max(end, ourHunks[i++].baseEnd);
          expanded = true;
        }
        while (theirHunks[j] && theirHunks[j].baseStart < end) {
          end = Math.max(end, theirHunks[j++].baseEnd);
          expanded = true;
        }
      } while (expanded);
      const ourRegion = applyRegion(baseLines, start, end, ourHunks.slice(ourStart, i));
      const theirRegion = applyRegion(baseLines, start, end, theirHunks.slice(theirStart, j));
      const lines: string[] = [];
      let clean = start >= pos && ourRegion.length === end - start && theirRegion.length === end - start;
      for (let k = 0; clean && k < end - start; k++) {
        const line = mergeInline(baseLines[start + k], ourRegion[k], theirRegion[k], inlineDeadline);
        if (line === null) clean = false;
        else lines.push(line);
      }
      if (clean) apply({ baseStart: start, baseEnd: end, lines });
      else {
        conflicts++;
        pos = end;
      }
    }
  }
  copyBaseTo(baseLines.length);

  if (conflicts > 0) return { ok: false, conflicts };
  return { ok: true, merged: joinLines(out, eol, trailing) };
}

function joinLines(lines: string[], eol: string, trailing: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(eol) + (trailing ? eol : '');
}
