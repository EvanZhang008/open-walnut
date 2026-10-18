/**
 * Three-way merge (diff3), shared by the Files panel's Live Edit, the notes editor
 * and the Mac's drain of notes written while it was away
 * (docs/plan/walnut-replica-servers-impl.md section 6). Web code imports it through
 * the `@open-walnut/three-way-merge` alias.
 *
 * Pure: no DOM, no network, no clock. The result depends on the inputs only (a step
 * budget bounds the work, never a wall clock), so the same three texts merge the same
 * way on a busy machine, in a worker thread, or in the browser.
 *
 * Every side is expressed as edits AGAINST BASE, in base line coordinates, so the
 * edit lists of all sides can be walked together in one pass.
 *
 * CONFLICT RULE (exact): two hunks conflict when their base ranges OVERLAP and they
 * do not render the same lines. `[baseStart, baseEnd)` is half-open, so touching
 * ranges (one side replaces line 5, the other line 6) do NOT overlap and both apply;
 * insertions at the same point do not overlap either: each distinct block applies
 * once, in side order (`ours` first; in `mergeVersions`, the older side first).
 * Lines that both sides changed merge word by word when their word edits do not
 * touch (lines up to INLINE_MAX_LINE characters, within INLINE_BUDGET edit steps);
 * anything else is a conflict region.
 *
 * A whole-document line diff gives up past `maxEditLength` (default MAX_EDIT_LENGTH)
 * edit steps; the whole document is then ONE conflict region (`overBudget`).
 *
 * How the worker gets it: `createThreeWayMerge` references nothing at module scope,
 * so src/core/offline-merge/note-merge-worker.ts runs its very source
 * (`toString()`) with the diff library it loads.
 */
import { diffArrays, diffWordsWithSpace } from 'diff';

/** Edit steps the whole-document line diff may take; beyond it the document is one conflict. */
export const MAX_EDIT_LENGTH = 50_000;
/**
 * Longest line merged word by word; a longer line that both sides changed is a line
 * conflict. (The plan said 2,000; a long Markdown table row of about 5,000 characters
 * edited in two places merged before the step budget replaced the wall clock, and still
 * must: the step budget alone bounds the work.)
 */
export const INLINE_MAX_LINE = 8_000;
/** Word-level edit steps one merge may spend in total; past it, changed lines conflict whole. */
export const INLINE_BUDGET = 50_000;

/** One side's edit, in BASE line coordinates. `[baseStart, baseEnd)` is
 *  half-open; an empty range is a pure insertion at that point. */
export interface MergeHunk {
  baseStart: number;
  baseEnd: number;
  /** Lines that replace the base range (empty = deletion). */
  lines: string[];
}

/** A region where the sides disagree: base lines `[from, to)` and each side's lines there. */
export interface ConflictRegion {
  baseRange: [number, number];
  ours: string[];
  theirs: string[];
}

export type MergeResult =
  | { ok: true; merged: string }
  | {
    ok: false;
    conflicts: number;
    regions: ConflictRegion[];
    /** The line diff gave up: the whole document is the one region. */
    overBudget: boolean;
    /** The merge with every conflicting region taken from `ours`. */
    oursText: string;
    /** The merge with every conflicting region taken from `theirs`. */
    theirsText: string;
  };

export interface MergeOptions {
  /** Edit steps of the whole-document line diff (default MAX_EDIT_LENGTH). */
  maxEditLength?: number;
  /** The side whose frontmatter `id:` line every side takes before the merge. */
  idFrom?: 'ours' | 'theirs';
}

/** One version of a document for `mergeVersions`. */
export interface MergeVersion {
  /** Stable name of the side (a host and op id, or 'mac'). */
  key: string;
  text: string;
  /** When the side wrote it: in a conflicting region the newest side wins. */
  at: number;
}

export interface VersionsOptions {
  maxEditLength?: number;
  /** Key of the version whose frontmatter `id:` line every version takes (the Mac's). */
  idFrom?: string;
  /** Key of the version whose line ending the result takes (default: the first given). */
  eolFrom?: string;
  /** Skip the diff: the whole document is one conflict region (a merge that ran out of time). */
  wholeNote?: boolean;
}

export interface VersionsRegion {
  baseRange: [number, number];
  /** The version whose lines the merged text holds there (the newest that took part). */
  winner: string;
  /** Each version that took part, with its lines there. */
  versions: Record<string, string[]>;
}

export interface VersionsResult {
  /** The merged document: clean edits applied, each conflicting region from its newest side. */
  text: string;
  conflicts: number;
  overBudget: boolean;
  regions: VersionsRegion[];
  /** Versions that lost at least one region, oldest first. */
  losers: string[];
  /** For each loser: the merge with every region it took part in taken from it. */
  wins: Record<string, string>;
}

interface DiffLib {
  diffArrays: typeof diffArrays;
  diffWordsWithSpace: typeof diffWordsWithSpace;
}

interface Limits {
  maxEditLength: number;
  inlineMaxLine: number;
  inlineBudget: number;
}

/**
 * The merge, self-contained: its only free names are its two parameters (and
 * globals), so the worker runs this very function's source with the library it loads.
 */
export function createThreeWayMerge(lib: DiffLib, limits: Limits) {
  type Hunk = { baseStart: number; baseEnd: number; lines: string[] };
  type Tagged = Hunk & { si: number };
  type Eol = '\r\n' | '\n';
  type Input = { key: string; raw: string; norm: string; lines: string[]; trail: boolean };
  type Region = { start: number; end: number; winner: number; renders: Map<number, string[]> };
  type Segment = { lines: string[] } | { region: number };
  type Core =
    | { overBudget: false; segs: Segment[]; regions: Region[]; eol: Eol; trailing: boolean; baseLines: string[] }
    | { overBudget: true; baseLines: string[] };

  /** CRLF collapsed to LF so the diff sees pure line content; the ending is restored on output. */
  function normalizeEol(text: string): string {
    return text.replace(/\r\n/g, '\n');
  }

  /** The line ending the text mostly uses, or null when it has no line break. */
  function dominantEol(text: string): Eol | null {
    const crlf = (text.match(/\r\n/g) ?? []).length;
    const lf = (text.match(/\n/g) ?? []).length - crlf;
    if (crlf === 0 && lf === 0) return null;
    return crlf > lf ? '\r\n' : '\n';
  }

  /** Lines of LF-normalised text, WITHOUT the phantom empty element a trailing newline
   *  produces: the trailing-newline state is carried separately and restored exactly. */
  function splitLines(text: string): string[] {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  function sameLines(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((line, i) => line === b[i]);
  }

  function joinLines(lines: string[], eol: string, trailing: boolean): string {
    if (lines.length === 0) return '';
    return lines.join(eol) + (trailing ? eol : '');
  }

  const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

  /** The frontmatter `id:` line of a text, or null. */
  function idLineOf(text: string): string | null {
    const m = FRONTMATTER.exec(text);
    if (!m) return null;
    const line = m[1].split(/\r?\n/).find((l) => /^id:/.test(l));
    return line ?? null;
  }

  /** The text with its frontmatter `id:` line replaced by `idLine` (line endings kept). */
  function withIdLine(text: string, idLine: string | null): string {
    if (idLine === null) return text;
    const m = FRONTMATTER.exec(text);
    if (!m) return text;
    const head = m[0];
    const replaced = head.replace(/\nid:[^\r\n]*/, () => `\n${idLine}`);
    return replaced === head ? text : replaced + text.slice(head.length);
  }

  /**
   * `other` as hunks against `base`, in base line coordinates, or null when the diff
   * needs more than `maxEdit` steps. A replacement (removed + added parts next to each
   * other) is ONE hunk, so a side never conflicts with itself.
   */
  function toHunks(base: string[], other: string[], maxEdit: number): Hunk[] | null {
    const parts = lib.diffArrays(base, other, { maxEditLength: maxEdit });
    if (!parts) return null;
    const hunks: Hunk[] = [];
    let pos = 0;
    let open: Hunk | null = null;
    for (const part of parts) {
      const n = part.count ?? part.value.length;
      if (!part.added && !part.removed) {
        if (open) { hunks.push(open); open = null; }
        pos += n;
        continue;
      }
      if (!open) open = { baseStart: pos, baseEnd: pos, lines: [] };
      if (part.removed) { pos += n; open.baseEnd = pos; } else open.lines.push(...(part.value as string[]));
    }
    if (open) hunks.push(open);
    return hunks;
  }

  type Edit = { start: number; end: number; text: string };

  /** Word edits of `text` against `base`, charged to the merge's step budget; null over it. */
  function wordEdits(base: string, text: string, budget: { left: number }): Edit[] | null {
    if (budget.left <= 0) return null;
    const parts = lib.diffWordsWithSpace(base, text, { maxEditLength: budget.left });
    // The attempt spent up to the whole budget: nothing after it merges word by word.
    if (!parts) { budget.left = 0; return null; }
    const edits: Edit[] = [];
    let pos = 0;
    let edit: Edit | null = null;
    for (const part of parts) {
      if (!part.added && !part.removed) {
        if (edit) edits.push(edit);
        edit = null;
        pos += part.value.length;
        continue;
      }
      budget.left -= part.count ?? 1;
      edit ??= { start: pos, end: pos, text: '' };
      if (part.removed) { pos += part.value.length; edit.end = pos; } else edit.text += part.value;
    }
    if (edit) edits.push(edit);
    return edits;
  }

  /** Word edits that touch: an insertion on the edge of a replacement is never guessed. */
  function editsOverlap(own: Edit, other: Edit): boolean {
    if (own.start === own.end) return own.start >= other.start && own.start <= other.end;
    if (other.start === other.end) return other.start >= own.start && other.start <= own.end;
    return own.start < other.end && other.start < own.end;
  }

  /** One base line changed by several sides (distinct lines, side order): merged word by word, or null. */
  function mergeLine(base: string, changed: string[], budget: { left: number }): string | null {
    if (changed.length === 1) return changed[0];
    if (base.length > limits.inlineMaxLine || changed.some((l) => l.length > limits.inlineMaxLine)) return null;
    const all: Edit[] = [];
    for (const line of changed) {
      const edits = wordEdits(base, line, budget);
      if (!edits) return null;
      for (const e of edits) {
        let duplicate = false;
        for (const o of all) {
          if (o.start === e.start && o.end === e.end && o.text === e.text) { duplicate = true; break; }
          if (editsOverlap(e, o)) return null;
        }
        if (!duplicate) all.push(e);
      }
    }
    all.sort((x, y) => x.start - y.start || x.end - y.end);
    let pos = 0;
    let out = '';
    for (const e of all) { out += base.slice(pos, e.start) + e.text; pos = e.end; }
    return out + base.slice(pos);
  }

  /** Base lines `[start, end)` with one side's hunks there applied. */
  /** Whether `big` holds every line of `small` in the same order (a subsequence). */
  function holdsInOrder(big: string[], small: string[]): boolean {
    let i = 0;
    for (const line of big) if (i < small.length && line === small[i]) i++;
    return i === small.length;
  }

  function applyRegion(base: string[], start: number, end: number, hunks: Hunk[]): string[] {
    const out: string[] = [];
    let pos = start;
    for (const h of hunks) { out.push(...base.slice(pos, h.baseStart), ...h.lines); pos = h.baseEnd; }
    out.push(...base.slice(pos, end));
    return out;
  }

  /**
   * The N-side merge over `base` (inputs in side order: earlier = older = inserted
   * first; in a conflicting region the LAST side that took part wins). `eolOrder` is
   * the order in which the sides' line endings are asked.
   */
  function core(baseRaw: string, inputs: Input[], eolOrder: number[], maxEdit: number): Core {
    const baseNorm = normalizeEol(baseRaw);
    const baseLines = splitLines(baseNorm);
    const all: Tagged[] = [];
    for (let si = 0; si < inputs.length; si++) {
      const hunks = toHunks(baseLines, inputs[si].lines, maxEdit);
      if (!hunks) return { overBudget: true, baseLines };
      for (const h of hunks) all.push({ ...h, si });
    }
    all.sort((x, y) => x.baseStart - y.baseStart || x.baseEnd - y.baseEnd || x.si - y.si);
    const segs: Segment[] = [];
    const regions: Region[] = [];
    const budget = { left: limits.inlineBudget };
    let pos = 0;
    let k = 0;
    while (k < all.length) {
      const first = all[k++];
      const start = first.baseStart;
      let end = first.baseEnd;
      const group: Tagged[] = [first];
      if (start === end) {
        // Insertions at one point (a hunk that covered the point took them in already).
        while (k < all.length && all[k].baseStart === start && all[k].baseEnd === start) group.push(all[k++]);
      } else {
        while (k < all.length && all[k].baseStart < end) { end = Math.max(end, all[k].baseEnd); group.push(all[k++]); }
      }
      segs.push({ lines: baseLines.slice(pos, start) });
      pos = end;
      const bySide = new Map<number, Hunk[]>();
      for (const h of group) { const list = bySide.get(h.si); if (list) list.push(h); else bySide.set(h.si, [h]); }
      const sides = [...bySide.keys()].sort((a, b) => a - b);
      if (start === end) {
        // Each distinct block once, older side first: an insertion is never a conflict. A block
        // whose lines another block holds in the same order is that block's start or a part of
        // it (a save whose answer was lost, then a longer save over the same base): written once.
        const blocks: string[][] = [];
        for (const si of sides) for (const h of bySide.get(si)!) if (!blocks.some((b) => sameLines(b, h.lines))) blocks.push(h.lines);
        const kept = blocks.filter((b, i) => !blocks.some((o, j) => j !== i && o.length > b.length && holdsInOrder(o, b)));
        segs.push({ lines: kept.flat() });
        continue;
      }
      const renders = new Map<number, string[]>();
      for (const si of sides) renders.set(si, applyRegion(baseLines, start, end, bySide.get(si)!));
      const firstRender = renders.get(sides[0])!;
      if (sides.every((si) => sameLines(renders.get(si)!, firstRender))) { segs.push({ lines: firstRender }); continue; }
      // Same line count everywhere: the lines may merge word by word.
      let merged: string[] | null = null;
      if (sides.every((si) => renders.get(si)!.length === end - start)) {
        merged = [];
        for (let i = 0; i < end - start && merged; i++) {
          const baseLine = baseLines[start + i];
          const changed: string[] = [];
          for (const si of sides) {
            const line = renders.get(si)![i];
            if (line !== baseLine && changed.indexOf(line) === -1) changed.push(line);
          }
          const line = changed.length === 0 ? baseLine : mergeLine(baseLine, changed, budget);
          if (line === null) merged = null; else merged.push(line);
        }
      }
      if (merged) { segs.push({ lines: merged }); continue; }
      regions.push({ start, end, winner: sides[sides.length - 1], renders });
      segs.push({ region: regions.length - 1 });
    }
    segs.push({ lines: baseLines.slice(pos) });
    const baseTrail = baseNorm.endsWith('\n');
    // A side that changed the final newline expresses an intent; the others carry base along.
    const trailing = inputs.some((s) => s.trail !== baseTrail) ? !baseTrail : baseTrail;
    let eol: Eol | null = null;
    for (const si of eolOrder) { eol = dominantEol(inputs[si].raw); if (eol) break; }
    return { overBudget: false, segs, regions, eol: eol ?? dominantEol(baseRaw) ?? '\n', trailing, baseLines };
  }

  /** The merged lines with each conflicting region taken from `pick(region)`. */
  function assemble(c: Extract<Core, { overBudget: false }>, pick: (r: Region) => number): string {
    const out: string[] = [];
    for (const s of c.segs) {
      if ('lines' in s) { out.push(...s.lines); continue; }
      const r = c.regions[s.region];
      out.push(...(r.renders.get(pick(r)) ?? r.renders.get(r.winner)!));
    }
    return joinLines(out, c.eol, c.trailing);
  }

  function input(key: string, raw: string): Input {
    const norm = normalizeEol(raw);
    return { key, raw, norm, lines: splitLines(norm), trail: norm.endsWith('\n') };
  }

  /**
   * Merge `ours` and `theirs` over their common `base`: the merged text when every
   * hunk pair applies without guessing, else the conflict regions and both full
   * resolutions (every conflicting region from one side).
   */
  function threeWayMerge(base: string, ours: string, theirs: string, opts: MergeOptions = {}): MergeResult {
    const maxEdit = opts.maxEditLength ?? limits.maxEditLength;
    let b = base;
    let o = ours;
    let t = theirs;
    if (opts.idFrom) {
      const id = idLineOf(opts.idFrom === 'ours' ? ours : theirs);
      b = withIdLine(b, id); o = withIdLine(o, id); t = withIdLine(t, id);
    }
    const bn = normalizeEol(b);
    const on = normalizeEol(o);
    const tn = normalizeEol(t);
    // One side untouched: the other side IS the answer, VERBATIM (rewriting the untouched
    // side's line endings would be a whole-file change nobody asked for).
    if (on === bn || on === tn) return { ok: true, merged: on === bn ? t : o };
    if (tn === bn) return { ok: true, merged: o };
    const ins = [input('ours', o), input('theirs', t)];
    const c = core(b, ins, [0, 1], maxEdit);
    if (c.overBudget) {
      return {
        ok: false, conflicts: 1, overBudget: true, oursText: o, theirsText: t,
        regions: [{ baseRange: [0, c.baseLines.length], ours: ins[0].lines, theirs: ins[1].lines }],
      };
    }
    if (c.regions.length === 0) return { ok: true, merged: assemble(c, (r) => r.winner) };
    const regions = c.regions.map((r) => ({
      baseRange: [r.start, r.end] as [number, number],
      ours: r.renders.get(0) ?? c.baseLines.slice(r.start, r.end),
      theirs: r.renders.get(1) ?? c.baseLines.slice(r.start, r.end),
    }));
    return {
      ok: false, conflicts: c.regions.length, regions, overBudget: false,
      oursText: assemble(c, () => 0), theirsText: assemble(c, () => 1),
    };
  }

  /**
   * Merge several versions of one document over their common `base`. Clean edits of
   * every version apply; in a conflicting region the NEWEST version that took part
   * wins (time, then key), and every version that lost a region is listed with its
   * own full resolution. The result does not depend on the order the versions are
   * given in: they are ranked by (at, key) first.
   */
  function mergeVersions(base: string, versions: MergeVersion[], opts: VersionsOptions = {}): VersionsResult {
    const maxEdit = opts.maxEditLength ?? limits.maxEditLength;
    const idSource = opts.idFrom !== undefined ? versions.find((v) => v.key === opts.idFrom) : undefined;
    const id = idSource ? idLineOf(idSource.text) : null;
    const b = withIdLine(base, id);
    const sorted = versions.slice().sort((x, y) => x.at - y.at || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    const ins = sorted.map((v) => input(v.key, withIdLine(v.text, id)));
    const indexOf = (key: string): number => ins.findIndex((x) => x.key === key);
    // Line endings: `eolFrom`'s, else the newest version's that has any (never the order given).
    const order = [...(opts.eolFrom !== undefined ? [indexOf(opts.eolFrom)] : []), ...ins.map((_, i) => ins.length - 1 - i)].filter((i) => i >= 0);
    const bn = normalizeEol(b);
    const changed = ins.map((_, si) => si).filter((si) => ins[si].norm !== bn);
    const none = { conflicts: 0, overBudget: false, regions: [] as VersionsRegion[], losers: [] as string[], wins: {} as Record<string, string> };
    if (changed.length === 0) return { text: order.length ? ins[order[0]].raw : b, ...none };
    if (new Set(changed.map((si) => ins[si].norm)).size === 1) return { text: ins[changed[changed.length - 1]].raw, ...none };
    const c: Core = opts.wholeNote ? { overBudget: true, baseLines: splitLines(bn) } : core(b, ins, order, maxEdit);
    if (c.overBudget) {
      const winner = changed[changed.length - 1];
      const lost = changed.filter((si) => ins[si].norm !== ins[winner].norm);
      const versionsOf: Record<string, string[]> = {};
      for (const si of changed) versionsOf[ins[si].key] = ins[si].lines;
      const wins: Record<string, string> = {};
      for (const si of lost) wins[ins[si].key] = ins[si].raw;
      return {
        text: ins[winner].raw, conflicts: 1, overBudget: true, losers: lost.map((si) => ins[si].key), wins,
        regions: [{ baseRange: [0, c.baseLines.length], winner: ins[winner].key, versions: versionsOf }],
      };
    }
    if (c.regions.length === 0) return { text: assemble(c, (r) => r.winner), ...none };
    const lost = new Set<number>();
    for (const r of c.regions) {
      const won = r.renders.get(r.winner)!;
      for (const [si, lines] of r.renders) if (si !== r.winner && !sameLines(lines, won)) lost.add(si);
    }
    const losers = [...lost].sort((x, y) => x - y);
    const wins: Record<string, string> = {};
    for (const si of losers) wins[ins[si].key] = assemble(c, (r) => (r.renders.has(si) ? si : r.winner));
    const regions = c.regions.map((r) => {
      const versionsOf: Record<string, string[]> = {};
      for (const [si, lines] of r.renders) versionsOf[ins[si].key] = lines;
      return { baseRange: [r.start, r.end] as [number, number], winner: ins[r.winner].key, versions: versionsOf };
    });
    return { text: assemble(c, (r) => r.winner), conflicts: c.regions.length, overBudget: false, regions, losers: losers.map((si) => ins[si].key), wins };
  }

  /** `other` as hunks against `base`; past the step budget, one hunk over the whole of it. */
  function diffToHunks(base: string[], other: string[]): MergeHunk[] {
    return toHunks(base, other, limits.maxEditLength) ?? [{ baseStart: 0, baseEnd: base.length, lines: other.slice() }];
  }

  return { threeWayMerge, mergeVersions, diffToHunks, idLineOf, withIdLine };
}

const merger = createThreeWayMerge(
  { diffArrays, diffWordsWithSpace },
  { maxEditLength: MAX_EDIT_LENGTH, inlineMaxLine: INLINE_MAX_LINE, inlineBudget: INLINE_BUDGET },
);

export const threeWayMerge = merger.threeWayMerge;
export const mergeVersions = merger.mergeVersions;
export const diffToHunks = merger.diffToHunks;
export const idLineOf = merger.idLineOf;
export const withIdLine = merger.withIdLine;
