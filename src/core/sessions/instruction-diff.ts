/**
 * What a running session lacks of its current default instructions (pure; the
 * delivery bookkeeping is instruction-notice.ts).
 *
 * Two kinds of lines. A plain rule line is told when the session's prompt lacks
 * it. A versioned block (the user's profile from USER.md, a Main's or lead's core
 * instructions: user-profile-context.ts userProfileLine, session-context.ts
 * orgInstructionsLine) is a head line ending "Each line of this version starts
 * with [vXXXXXXXX]:" and the lines tagged with that version. Every save makes
 * every tagged line new, so comparing them as plain lines re-sent the whole block
 * for a one-line change (2026-10-30: a one-line USER.md save sent its 4.9 KB to
 * about 25 live sessions). A block is compared by its untagged words against the
 * version the session holds: only the new or reworded lines are told, with the
 * lines that were removed; a session that never had the block gets it whole.
 * A change is never sent as the whole block (2026-11-03: a save that reworded 10
 * of 27 lines went whole, 5 to 6 KB, to every live session). A reworded line is
 * told once, as its new wording, never also as removed (2026-11-11: three saves
 * that each reworded 8 to 10 lines to stay under the USER.md budget sent every one
 * twice, its new wording and again under "Removed"), and a renamed sub-heading
 * leaves the lines under it unchanged (the same night, "## Standing rules (agents
 * keep asking these)" became "## Standing rules" and all its lines went out again).
 */

import { POINTER_OPENING } from './prompt-blocks.js'
import { createHash } from 'node:crypto';

export const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

const HEAD_RE = /Each line of this version starts with \[(v[0-9a-f]{8})\]:$/;
/** A removed line is named, not repeated in full. */
const REMOVED_MAX_CHARS = 80;

/**
 * A block is named by what it is, so a new version of it, or a heading added
 * above it, is still the same block. Every versioned block Walnut writes has a
 * name here (tests/core/instruction-diff.test.ts); an unknown one falls back to
 * where it sits.
 */
const BLOCK_KINDS: Array<[string, RegExp]> = [
  ['user-profile', /^Your user's profile and standing rules, from memory\/USER\.md /],
  // "<who> cleared the instructions for your role at <time>": who may be an agent's name.
  ['core-instructions', /^(Your core instructions[,:] |.+ cleared the instructions for your role at \d{4}-)/],
  ['reply-language', /^Reply language, the user's setting \(v[0-9a-f]{8}\): /],
];

/** The head without what changes at every save (its version, its time), so a change of form reads as one. */
const formOf = (head: string) => hash(head.replace(/v[0-9a-f]{8}/g, 'v').replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}( UTC)?/g, 't'));

/** The "Added by X:" line of a Main's or lead's instructions: whose words the lines after it are. */
const opensAuthor = (word: string) => /^Added by .+:$/.test(word);
/** The line a block ends with when not all of it fit ("(USER.md runs past 4000 characters here; ...)"): not a rule. */
const TRUNCATED_RE = /^\(.+ runs past \d+ characters here;.+\)$/;
/** A sub-heading inside a block (inside an author's part, when it has one). */
const opensSection = (word: string) => word.startsWith('#');

/** A plain rule line and the heading it sits under (the charter's "## How we work"), shown with it. */
export interface Changed { line: string; heading?: string }

/** A versioned block: its head, its version, its lines without the tag (`words`) and as written (`tagged`). */
export interface Block { id: string; heading?: string; head: string; form: string; version: string; words: string[]; tagged: string[] }

/** The version of a block a session holds: told to it, or in its prompt (`form`: formOf its head; none from before it was kept). */
export interface BlockView { version: string; words: string[]; form?: string }

export interface Parsed {
  /** Every trimmed line of the text, block lines included. */
  all: Set<string>;
  /** Plain rule lines in order (headings, blank lines and block lines left out). */
  plain: Changed[];
  blocks: Map<string, Block>;
}

const parseCache = new Map<string, Parsed>();
const PARSE_CACHE_MAX = 200;

/** Lines and versioned blocks of a prompt. Remembered per text: the host slice asks for every session at every push. */
export function parseInstructions(text: string): Parsed {
  const key = hash(text);
  const cached = parseCache.get(key);
  if (cached) {
    // Least recently used goes first: the host slice reads every live prompt at every push.
    parseCache.delete(key);
    parseCache.set(key, cached);
    return cached;
  }
  const all = new Set<string>();
  const plain: Changed[] = [];
  const blocks = new Map<string, Block>();
  const perHeading = new Map<string, number>();
  let heading: string | undefined;
  let block: Block | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    all.add(line);
    if (block) {
      const tag = `[${block.version}] `;
      if (line.startsWith(tag)) { block.tagged.push(line); block.words.push(line.slice(tag.length)); continue; }
      block = null;
    }
    if (!line) continue;
    const head = HEAD_RE.exec(line);
    if (head) {
      const kind = BLOCK_KINDS.find(([, re]) => re.test(line))?.[0];
      const n = perHeading.get(kind ?? heading ?? '') ?? 0;
      perHeading.set(kind ?? heading ?? '', n + 1);
      const id = kind ? (n ? `${kind}#${n}` : kind) : `${heading ?? ''}#${n}`;
      block = { id, heading, head: line, form: formOf(line), version: head[1], words: [], tagged: [] };
      blocks.set(block.id, block);
      continue;
    }
    if (line.startsWith('#')) { heading = line; continue; }
    plain.push({ line, heading });
  }
  const parsed = { all, plain, blocks };
  if (parseCache.size >= PARSE_CACHE_MAX) parseCache.delete(parseCache.keys().next().value as string);
  parseCache.set(key, parsed);
  return parsed;
}

/**
 * A line of a block, with the "Added by X:" (`author`) and the sub-heading (`section`) it sits
 * under. `reworded`: a new line that takes the place of a line of the same meaning in older words.
 */
export interface Line { word: string; author?: string; section?: string; reworded?: true }

/** One block's change for a session: whole (it never had it, or it changed form), or the new and removed lines. */
export interface BlockChange { block: Block; whole: boolean; from?: string; added: Line[]; removed: Line[] }

/** A block the session holds that the current instructions no longer have at all. */
export interface BlockGone { id: string; heading?: string; from: string; removed: Line[] }

export interface Due { plain: Changed[]; blocks: BlockChange[]; gone: BlockGone[] }

/**
 * A block a cap cut (prompt-blocks.ts) reads as its head line, then a pointer line to the rest.
 * A session spawned before the cut holds that line whole, so the head is no change to it; the
 * pointer is told (a few hundred bytes), so the session knows where the rest lives from then on.
 * Only a line right before a pointer counts as a head, and only one long enough to be a rule of
 * its own, so a rule shortened by hand (a clause taken off its end) is still told.
 */
const isPointer = (line: string | undefined): boolean => !!line && line.startsWith(POINTER_OPENING)

function headOfHeld(line: string, prompt: Parsed): boolean {
  if (line.length < 80) return false
  for (const held of prompt.all) if (held.length > line.length && held.startsWith(line)) return true
  return false
}

/**
 * What to tell: the current plain lines the prompt lacks and the session was not
 * told (`toldPlain`, line hashes), and every block whose version differs from the
 * one the session holds (`views`, by block id; a block missing there is read from
 * the prompt). Null when nothing is due.
 */
export function dueChanges(
  current: Parsed, prompt: Parsed, toldPlain: Set<string>, views: Record<string, BlockView>,
  // By block id: lines its source still holds that did not fit in the block (user-profile-context.ts `cut`).
  beyond: Record<string, Set<string>> = {},
): Due | null {
  const plain = current.plain.filter((c, i) => !prompt.all.has(c.line) && !toldPlain.has(hash(c.line))
    // The head a cap cut, when the session holds that line whole: no change to it (its pointer is told).
    && !(isPointer(current.plain[i + 1]?.line) && headOfHeld(c.line, prompt)));
  const held = (id: string): BlockView | undefined => {
    if (views[id]) return views[id];
    const b = prompt.blocks.get(id);
    return b ? { version: b.version, words: b.words, form: b.form } : undefined;
  };
  const blocks: BlockChange[] = [];
  for (const block of current.blocks.values()) {
    const view = held(block.id);
    if (view?.version === block.version) continue;
    // Whole: never had it, was told it is gone, or it changed form (Walnut's default
    // became the user's own words): a list of changes would read against the wrong head.
    if (!view || !view.words.length || (view.form && view.form !== block.form)) {
      blocks.push({ block, whole: true, added: block.words.map((word) => ({ word })), removed: [] });
      continue;
    }
    const changes = wordChanges(view.words, block.words);
    // The truncation note is not a rule, and a line the budget cut is still in force.
    const added = changes.added.filter((l) => !TRUNCATED_RE.test(l.word));
    const removed = changes.removed.filter((l) => !TRUNCATED_RE.test(l.word) && !beyond[block.id]?.has(l.word));
    // A save that kept every word (a new time stamp alone) changes nothing the session reads.
    if (!added.length && !removed.length) continue;
    blocks.push({ block, whole: false, from: view.version, added, removed });
  }
  const gone: BlockGone[] = [];
  const ids = new Set([...prompt.blocks.keys(), ...Object.keys(views)]);
  for (const id of ids) {
    if (current.blocks.has(id)) continue;
    const view = held(id);
    if (view?.words.length) gone.push({ id, heading: prompt.blocks.get(id)?.heading, from: view.version, removed: view.words.map((word) => ({ word })) });
  }
  return plain.length || blocks.length || gone.length ? { plain, blocks, gone } : null;
}

/** Each word of a block with the parts it sits in, so the same words in two parts are two lines. */
function keyed(words: string[]): Keyed[] {
  let author: string | undefined;
  let section: string | undefined;
  return words.map((word) => {
    if (opensAuthor(word)) { author = word; section = undefined; return { word, key: `${word}\u0000\u0000${word}` }; }
    if (opensSection(word)) section = word;
    const line: Line = { word, ...(author ? { author } : {}), ...(section && section !== word ? { section } : {}) };
    return { ...line, key: keyOf(line) };
  });
}

/** Words that say nothing of what a rule is about: two different rules share them freely. */
const FILLER_WORDS = new Set(('a an the and or but of to in on at for from by with as is are be it its this that these those '
  + 'he she his her him they their them you your we our i me my so if then than when while do does every each any all').split(' '));
/**
 * A rule that forbids and one that asks are never the same rule, however close their words
 * ("Never X", "Always X"): a pair must agree on whether it says "never", "always" and any negation.
 * One that does not is listed as removed, the safe way.
 */
const NEGATIONS = new Set(['never', 'not', 'no', 'nothing', 'none', 'nobody', 'don', 'doesn', 'isn', 'won', 'cannot']);
const polarity = (word: string) => {
  const words: string[] = word.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  return `${words.includes('never')}${words.includes('always')}${words.some((t) => NEGATIONS.has(t))}`;
};
/**
 * The content words of a line as a set, for telling a rewording from another rule: filler left
 * out, and Chinese, written without spaces, one character a word.
 */
const tokens = (word: string) => new Set((word.toLowerCase().match(/\p{Script=Han}|[\p{L}\p{N}]+/gu) ?? [])
  .flatMap((t) => (/\p{Script=Han}/u.test(t) ? [...t] : [t])).filter((t) => !FILLER_WORDS.has(t)));
/** How much two lines share: twice the common words over all words (1 the same words, 0 none). */
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return (2 * common) / (a.size + b.size);
}
/**
 * A line shares at least this much of its content words with the line it rewords. Measured on the
 * 2026-11-11 saves: rewordings 0.69 to 1.00, different rules at most 0.09.
 */
export const REWORD_MIN_OVERLAP = 0.65;
/** Shorter lines are cheap to name as removed, and a word or two is no evidence of the same rule. */
const REWORD_MIN_WORDS = 3;
/**
 * How close two sub-headings are, or null when one is not the other renamed: the same level, and
 * one's words hold the other's ("## Standing rules (agents keep asking these)", "## Standing rules")
 * or they share as much as a reworded line does.
 */
function headingScore(a: string, b: string): number | null {
  const level = (w: string) => /^#+/.exec(w)?.[0].length;
  if (!opensSection(a) || !opensSection(b) || level(a) !== level(b)) return null;
  const ta = tokens(a.replace(/^#+/, ''));
  const tb = tokens(b.replace(/^#+/, ''));
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  const holds = small.size > 0 && [...small].every((t) => big.has(t));
  const score = overlap(ta, tb);
  return holds || score >= REWORD_MIN_OVERLAP ? score : null;
}

type Pair = { from: number; to: number; score: number };
/** One-to-one pairs, the closest first, of the candidates `score` accepts (null: no pair). */
function pairUp<T>(from: T[], to: T[], score: (a: T, b: T) => number | null): Pair[] {
  const all: Pair[] = [];
  from.forEach((a, i) => to.forEach((b, j) => {
    const s = score(a, b);
    if (s !== null) all.push({ from: i, to: j, score: s });
  }));
  all.sort((x, y) => y.score - x.score);
  const usedFrom = new Set<number>();
  const usedTo = new Set<number>();
  const out: Pair[] = [];
  for (const p of all) {
    if (usedFrom.has(p.from) || usedTo.has(p.to)) continue;
    usedFrom.add(p.from);
    usedTo.add(p.to);
    out.push(p);
  }
  return out;
}

type Keyed = Line & { key: string };
const keyOf = (l: Line) => `${l.author ?? ''}\u0000${l.section ?? ''}\u0000${l.word}`;

/**
 * The older lines read under the sub-headings they were renamed to, so an unchanged line under a
 * renamed heading counts as unchanged. The heading line itself stays a change (it is reworded).
 */
function underRenamedHeadings(had: Keyed[], now: Keyed[]): Keyed[] {
  const nowHeads = new Set(now.filter((l) => opensSection(l.word)).map((l) => `${l.author ?? ''}\u0000${l.word}`));
  const hadHeads = new Set(had.filter((l) => opensSection(l.word)).map((l) => `${l.author ?? ''}\u0000${l.word}`));
  const gone = had.filter((l) => opensSection(l.word) && !nowHeads.has(`${l.author ?? ''}\u0000${l.word}`));
  const fresh = now.filter((l) => opensSection(l.word) && !hadHeads.has(`${l.author ?? ''}\u0000${l.word}`));
  if (!gone.length || !fresh.length) return had;
  const pairs = pairUp(gone, fresh, (a, b) => (a.author === b.author ? headingScore(a.word, b.word) : null));
  if (!pairs.length) return had;
  const renamed = new Map(pairs.map((p) => [`${gone[p.from].author ?? ''}\u0000${gone[p.from].word}`, fresh[p.to].word]));
  return had.map((l) => {
    const to = l.section ? renamed.get(`${l.author ?? ''}\u0000${l.section}`) : undefined;
    if (!to) return l;
    const line: Line = { word: l.word, ...(l.author ? { author: l.author } : {}), section: to };
    return { ...line, key: keyOf(line) };
  });
}

/**
 * Lines added and removed between two versions, counted per part (a repeated line counts each
 * time). A removed line whose rewording was added is not removed: the new line says `reworded`.
 * Only when the pair is clear: no line kept in the same part reads as close to the new one, else
 * the old line is named as removed, so a kept one is never taken for the one replaced.
 */
function wordChanges(had: string[], now: string[]): { added: Line[]; removed: Line[] } {
  const take = (from: Keyed[], against: Keyed[]): { lines: Line[]; kept: Line[] } => {
    const left = new Map<string, number>();
    for (const w of against) left.set(w.key, (left.get(w.key) ?? 0) + 1);
    const lines: Line[] = [];
    const kept: Line[] = [];
    for (const { key, ...line } of from) {
      const n = left.get(key) ?? 0;
      if (n > 0) { left.set(key, n - 1); kept.push(line); } else lines.push(line);
    }
    return { lines, kept };
  };
  const b = keyed(now);
  const a = underRenamedHeadings(keyed(had), b);
  const { lines: added, kept } = take(b, a);
  const { lines: removed } = take(a, b);
  const words = new Map<string, Set<string>>();
  const tok = (w: string) => words.get(w) ?? words.set(w, tokens(w)).get(w)!;
  const samePart = (x: Line, y: Line) => x.author === y.author && x.section === y.section;
  const pairs = pairUp(removed, added, (r, x) => {
    if (!samePart(r, x) || opensAuthor(r.word) || opensAuthor(x.word)) return null;
    // A sub-heading renamed (underRenamedHeadings matched it the same way).
    if (opensSection(r.word) || opensSection(x.word)) return headingScore(r.word, x.word);
    if (polarity(r.word) !== polarity(x.word)) return null;
    const tr = tok(r.word);
    const tx = tok(x.word);
    if (tr.size < REWORD_MIN_WORDS || tx.size < REWORD_MIN_WORDS) return null;
    const score = overlap(tr, tx);
    if (score < REWORD_MIN_OVERLAP) return null;
    // A kept line of the same part about as close to the new one: which line it replaces is unclear.
    if (kept.some((k) => samePart(k, x) && overlap(tok(k.word), tx) >= REWORD_MIN_OVERLAP)) return null;
    return score;
  });
  const paired = new Set(pairs.map((p) => p.from));
  const rewords = new Set(pairs.map((p) => p.to));
  return {
    added: added.map((l, i) => (rewords.has(i) ? { ...l, reworded: true as const } : l)),
    removed: removed.filter((_, i) => !paired.has(i)),
  };
}

/**
 * The lines of `now` that reword a line of `had` (whole lines, sub-headings included, as a
 * versioned block holds them): every one reaches every live session again (memory_write's answer).
 */
export function rewordedLines(had: string[], now: string[]): string[] {
  return wordChanges(had, now).added.filter((l) => l.reworded && !opensSection(l.word)).map((l) => l.word);
}

/** The block versions a session holds once `due` reached it. */
export function viewsAfter(views: Record<string, BlockView>, due: Due): Record<string, BlockView> {
  const out = { ...views };
  for (const c of due.blocks) out[c.block.id] = { version: c.block.version, words: c.block.words, form: c.block.form };
  for (const g of due.gone) out[g.id] = { version: g.from, words: [] };
  return out;
}

const short = (line: string) => (line.length > REMOVED_MAX_CHARS ? `${line.slice(0, REMOVED_MAX_CHARS - 3)}...` : line);
/**
 * A removed line as a list item (one that is a list item already stays one), with the parts it
 * was in. Shortened, unless its shortened form starts a line that is still there unchanged: the
 * cut would name that one too. A new line it starts is its rewording, and says so.
 */
const item = (kept: string[], added: string[] = []) => ({ word, author, section }: Line) => {
  const cut = short(word);
  const prefix = cut.slice(0, -3);
  const reworded = cut !== word && added.some((k) => k.startsWith(prefix));
  // A kept line with the same start: only the whole line says which one is gone.
  const shown = cut !== word && kept.some((k) => k.startsWith(prefix)) ? word : cut;
  const text = `${shown.startsWith('- ') ? shown : `- ${shown}`}${reworded ? ' (its new wording is above)' : ''}`;
  const where = [author, section].filter(Boolean).map((p) => `"${short(p!)}"`).join(' / ');
  return where ? `${text} (under ${where})` : text;
};

/**
 * The head of a block told as changes: it describes the block as before, and
 * says the lines below are only what changed. "They replace every earlier
 * version" is about a whole version; told as changes, the version is the lines
 * the session holds plus these.
 */
function deltaHead(c: BlockChange): string {
  const head = c.block.head.replace(HEAD_RE, '').trim()
    .replace(/They replace every earlier version and/, 'They replace')
    .replace(/\s*They replace every earlier version\.?/, '');
  const cut = c.block.words.find((w) => TRUNCATED_RE.test(w));
  const reworded = c.added.some((l) => l.reworded);
  return `${head} Only what changed since the version you hold (${c.from}) is below, tagged [${c.block.version}]; every other line you hold `
    + `for this part stays in force${c.removed.length ? ' unless listed as removed' : ''}.`
    + (reworded ? ' A reworded line takes the place of your line in the same part that says the same thing in older words.' : '')
    + (cut ? ` Not every line of it fits here: ${cut.slice(1, -1).replace(/\.$/, '')}.` : '');
}

/** Lines of a block, each under the parts it belongs to, so its scope and, for a lead, whose words it is stay. */
function withParts(tag: string, added: Line[]): string {
  const lines: string[] = [];
  let author: string | undefined;
  let section: string | undefined;
  for (const l of added) {
    if (l.author && l.author !== author) { lines.push(tag + l.author); section = undefined; }
    if (l.section && l.section !== section) lines.push(tag + l.section);
    author = opensAuthor(l.word) ? l.word : l.author;
    section = opensAuthor(l.word) ? undefined : opensSection(l.word) ? l.word : l.section;
    lines.push(tag + l.word);
  }
  return lines.join('\n');
}

/** One block as told: whole (its head and every line), or its head as changes, the new and reworded lines and the removed ones. */
function blockText(c: BlockChange): string {
  if (c.whole) return `${c.block.head}\n${c.block.tagged.join('\n')}\n`;
  const tag = `[${c.block.version}] `;
  const out = [deltaHead(c)];
  const fresh = c.added.filter((l) => !l.reworded);
  const reworded = c.added.filter((l) => l.reworded);
  if (fresh.length) out.push(`New:\n${withParts(tag, fresh)}`);
  if (reworded.length) out.push(`Reworded:\n${withParts(tag, reworded)}`);
  if (c.removed.length) {
    const added = new Set(c.added.map((l) => l.word));
    out.push(`Removed, no longer in force:\n${c.removed.map(item(c.block.words.filter((w) => !added.has(w)), [...added])).join('\n')}`);
  }
  out.push('');
  return out.join('\n');
}

/** The notice body below its opening sentence: lines in prompt order, each under its heading. */
export function renderDue(due: Due): string {
  const out: string[] = [];
  let heading: string | undefined;
  const under = (h: string | undefined) => {
    if (h && h !== heading) out.push(`${h}\n`);
    heading = h;
  };
  for (const c of due.plain) {
    under(c.heading);
    out.push(c.line.startsWith('- ') ? c.line : `${c.line}\n`);
  }
  for (const c of due.blocks) {
    under(c.block.heading);
    out.push(blockText(c));
  }
  for (const g of due.gone) {
    under(g.heading);
    out.push(`A part of your instructions (${g.from}) is gone; none of its lines apply any more:\n`
      + `${g.removed.map(item([])).join('\n')}\n`);
  }
  return out.join('\n').trim();
}
