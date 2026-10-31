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
 */

import { createHash } from 'node:crypto';

export const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

const HEAD_RE = /Each line of this version starts with \[(v[0-9a-f]{8})\]:$/;
/** A removed line is named, not repeated in full. */
const REMOVED_MAX_CHARS = 160;

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

/** A line of a block, with the "Added by X:" (`author`) and the sub-heading (`section`) it sits under. */
export interface Line { word: string; author?: string; section?: string }

/** One block's change for a session: whole (it never had it, or it changed form), or the new and removed lines. */
export interface BlockChange { block: Block; whole: boolean; from?: string; added: Line[]; removed: Line[] }

/** A block the session holds that the current instructions no longer have at all. */
export interface BlockGone { id: string; heading?: string; from: string; removed: Line[] }

export interface Due { plain: Changed[]; blocks: BlockChange[]; gone: BlockGone[] }

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
  const plain = current.plain.filter((c) => !prompt.all.has(c.line) && !toldPlain.has(hash(c.line)));
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
    const delta: BlockChange = { block, whole: false, from: view.version, added, removed };
    const whole: BlockChange = { block, whole: true, added: block.words.map((word) => ({ word })), removed: [] };
    // A save that rewrote most lines lists each new line and each old one: then the block whole
    // is shorter, and says the same (2026-10-31: a 6.1 KB change for a 4.5 KB block).
    blocks.push(blockText(delta).length < blockText(whole).length ? delta : whole);
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
function keyed(words: string[]): Array<Line & { key: string }> {
  let author: string | undefined;
  let section: string | undefined;
  return words.map((word) => {
    if (opensAuthor(word)) { author = word; section = undefined; return { word, key: `${word}\u0000\u0000${word}` }; }
    if (opensSection(word)) section = word;
    const line: Line = { word, ...(author ? { author } : {}), ...(section && section !== word ? { section } : {}) };
    return { ...line, key: `${author ?? ''}\u0000${section ?? ''}\u0000${word}` };
  });
}

/** Lines added and removed between two versions, counted per part (a repeated line counts each time). */
function wordChanges(had: string[], now: string[]): { added: Line[]; removed: Line[] } {
  const take = (from: ReturnType<typeof keyed>, against: ReturnType<typeof keyed>): Line[] => {
    const left = new Map<string, number>();
    for (const w of against) left.set(w.key, (left.get(w.key) ?? 0) + 1);
    const out: Line[] = [];
    for (const { key, ...line } of from) {
      const n = left.get(key) ?? 0;
      if (n > 0) left.set(key, n - 1);
      else out.push(line);
    }
    return out;
  };
  const a = keyed(had);
  const b = keyed(now);
  return { added: take(b, a), removed: take(a, b) };
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
 * was in. Shortened, unless its shortened form starts a line that is still there: a long rule
 * reworded at its end would read as the new one.
 */
const item = (kept: string[]) => ({ word, author, section }: Line) => {
  const cut = short(word);
  const shown = cut !== word && kept.some((k) => k.startsWith(cut.slice(0, -3))) ? word : cut;
  const text = shown.startsWith('- ') ? shown : `- ${shown}`;
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
  return `${head} Only what changed since the version you were given last (${c.from}) is below, each line `
    + `starting with [${c.block.version}]. Every line you hold for this part, whatever version it is tagged with, `
    + `stays in force${c.removed.length ? ' unless it is listed as removed' : ''}.`
    + (cut ? ` Not every line of it fits here: ${cut.slice(1, -1)}.` : '');
}

/** One block as told: whole (its head and every line), or its head as changes, the new lines and the removed ones. */
function blockText(c: BlockChange): string {
  if (c.whole) return `${c.block.head}\n${c.block.tagged.join('\n')}\n`;
  const tag = `[${c.block.version}] `;
  const out = [deltaHead(c)];
  if (c.added.length) {
    // Each new line under the parts it belongs to, so its scope and, for a lead, whose words it is stay.
    const lines: string[] = [];
    let author: string | undefined;
    let section: string | undefined;
    for (const l of c.added) {
      if (l.author && l.author !== author) { lines.push(tag + l.author); section = undefined; }
      if (l.section && l.section !== section) lines.push(tag + l.section);
      author = opensAuthor(l.word) ? l.word : l.author;
      section = opensAuthor(l.word) ? undefined : opensSection(l.word) ? l.word : l.section;
      lines.push(tag + l.word);
    }
    out.push(`New or reworded:\n${lines.join('\n')}`);
  }
  if (c.removed.length) out.push(`Removed, no longer in force:\n${c.removed.map(item(c.block.words)).join('\n')}`);
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
