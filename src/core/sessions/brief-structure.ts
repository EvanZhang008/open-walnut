/**
 * The Brief's fixed shape (2026-10-30, the user, on a VP's Brief that was one flat list: "what is
 * being done, what does not need me, what needs me ... we must put this whole structure in"):
 * three sections, Needs you, Working, Waiting / snoozed (BRIEF_SECTIONS), always all three, in
 * that order, each task's line under the section of its own live status.
 *
 * The session writes the words; this file keeps the shape, so a Brief that forgot a heading or
 * put a task in the wrong section is fixed when it is stored rather than asked again, and the page
 * runs it again on every status move (OrgBrief.tsx), so a line follows its task between turns:
 *   - a heading the writer gave in other words ("**需要你：**", "## In progress", a bold label at
 *     the head of a line) is read as its section and written back as the canonical heading;
 *   - every line that starts with a task's <task-ref/> goes under that task's section (its
 *     user_status); a line about the owner itself, a finished task or no task stays where it was
 *     written;
 *   - a section left empty gets one "nothing" line in the Brief's language, and a task's line
 *     written bare becomes a list item.
 */
import { ABOUT_TAG_NAME } from '../org/message-about.js';
import { BRIEF_SECTIONS, NEEDS_CATEGORY_LABELS, briefTeam, fallbackUserState, needsLineOf, shownState, storedUserState, type BriefSectionTask, type BriefTask, type UserState } from '../user-status.js';
import { pickLead } from '../org/org-tree.js';
import { sameAreaTasks } from '../router/same-area.js';
import { askLineWriter, sourcesOfPieces, type BriefPiece, type BriefTextSource } from './brief-source.js';

// The web reads a Brief's writers through the alias it already has for this file.
export { briefPathWriters, briefSourcesOf, type BriefTextSource, type BriefWriter } from './brief-source.js';

export type BriefSectionKey = (typeof BRIEF_SECTIONS)[number]['state'];

const REF_RE = /<task-ref\b[^>]*\bid="([^"]+)"/;
/** A bold label at the head of a line, with what follows it. */
const INLINE_LABEL_RE = /^\s*(?:[-*+]\s+)?(?:\*\*|__)([^*_]{1,40}?)(?:[:：](?:\*\*|__)|(?:\*\*|__)[:：])\s*(.*)$/;

/** Other words a writer uses for a section's heading (English and Chinese). */
const HEADING_WORDS: Record<BriefSectionKey, RegExp> = {
  // A "To read" heading (written while it was a section of its own) is Needs you now.
  needs: /^(?:needs?\s+(?:you|your\s+action|action|the\s+user)|for\s+you|your\s+action|(?:需要|需|待|要)(?:你|您)(?:处理|决定|做|的)?|to\s+read|for\s+you\s+to\s+read|results?(?:\s+to\s+read)?|待读|待阅读?|可以看了)$/i,
  working: /^(?:working|in\s+progress|work\s+in\s+progress|进行中|正在做|正在进行|在做)$/i,
  waiting: /^(?:waiting(?:\s*\/\s*snoozed)?|snoozed|parked|on\s+hold|等待中?|在等|暂停|搁置|等待\s*\/\s*暂停)$/i,
};

/** The section a heading line names, or null when the line is no heading. A heading is a
 *  Markdown heading, or a short line that is only a bold or colon label. */
export function headingSection(line: string): BriefSectionKey | null {
  const t = line.trim();
  if (!t || t.includes('<task-ref')) return null;
  const isHeading = /^#{1,6}\s/.test(t);
  const bare = t.replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, '').replace(/[:：]\s*$/, '').trim();
  const isLabel = !isHeading && bare.length <= 40 && (/^(\*\*|__).+(\*\*|__)[:：]?$/.test(t) || /[:：]$/.test(t));
  if (!isHeading && !isLabel) return null;
  // A count or a note in brackets after the words: "Needs you (2)".
  const words = bare.replace(/\s*[(（][^)）]*[)）]\s*$/, '').trim();
  for (const s of BRIEF_SECTIONS) {
    if (words.toLowerCase() === s.heading.toLowerCase() || HEADING_WORDS[s.state].test(words)) return s.state;
  }
  return null;
}

/** The section a task's line belongs in now: its own live status (Task.user_status, its phase
 *  before one is derived), or null for finished work (it has none). Walnut's one reading of a
 *  task's state; this file adds no rule of its own. */
export function briefSectionOf(task: BriefSectionTask): BriefSectionKey | null {
  const state: UserState = task.phase === 'COMPLETE' || task.status === 'done'
    ? 'done' : task.user_status ? storedUserState(task.user_status) : fallbackUserState(task.phase, task.status);
  return state === 'done' ? null : shownState(state);
}

/** The VP who leads a task's project, named after it on Main's lines; none for a lead or Main itself. */
export function briefVpOf(task: BriefTask, tasks: readonly BriefTask[]): BriefTask | undefined {
  if (!task.project || task.org_role === 'lead' || task.org_role === 'main') return undefined;
  const vp = pickLead(tasks as never[], task.project) as BriefTask | undefined;
  return vp && vp.id !== task.id && vp.phase !== 'COMPLETE' ? vp : undefined;
}

/** The tasks whose Needs you a Brief covers: a lead's team, Main's whole org, each kept to the
 *  owner's incoming-item area (router/same-area.ts), so Walnut never writes an area task's ask into
 *  the Brief of a node outside that area. A line the writer put there itself is left alone. */
export function briefAskScope<T extends BriefSectionTask>(owner: BriefSectionTask, tasks: readonly T[]): T[] {
  return sameAreaTasks(owner, owner.org_role === 'main'
    ? tasks.filter((t) => !t.plugin_only && t.id !== owner.id)
    : briefTeam(owner, tasks));
}

const attr = (v: string) => v.replace(/\s+/g, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const words = (v: string) => v.replace(/\s+/g, ' ').trim().replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** At most this many asks Walnut adds to a letter, newest first, each clipped: the rest are one
 *  line (ADDED_MORE_RE), so Main's org-wide Needs you never pushes a letter past what its writer
 *  can edit (brief-write.ts). */
export const ADDED_ASKS_MAX = 8;
const ADDED_ASK_CHARS = 200;
/** Walnut's line for the asks past ADDED_ASKS_MAX: no task of its own, never a rule issue. */
export const ADDED_MORE_RE = /^- And \d+ more asks? the user: the Task view lists (?:it|them)\.$/;

/** Walnut's line for a task that asks the user and that the letter does not name: its own ask. */
export function addedAskLine(task: BriefSectionTask, main: boolean, tasks: readonly BriefSectionTask[]): string {
  // What to do with it, then its ask or what there is to read (needsLineOf, 2026-11-03).
  const line = task.user_status ? needsLineOf(task.user_status) : null;
  const ask = (line ? [NEEDS_CATEGORY_LABELS[line.category], words(line.text)].filter(Boolean).join(': ') : words(task.user_status?.ask ?? '')).slice(0, ADDED_ASK_CHARS) || 'Needs you';
  return askLineOf(task, main, tasks, ask);
}

function askLineOf(task: BriefSectionTask, main: boolean, tasks: readonly BriefSectionTask[], ask: string): string {
  const vp = main ? briefVpOf(task, sameAreaTasks(task, tasks)) : undefined;
  return `- <task-ref id="${task.id}" label="${attr(task.title)}"/>${vp ? ` (VP <task-ref id="${vp.id}" label="${attr(vp.title)}"/>)` : ''}: ${ask}`;
}

const reEscape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** addedAskLine's shape with a category, its ask clipped as Walnut clips it. */
const LABELED_ASK_RE = new RegExp(
  `^- <task-ref id="[^"]+" label="[^"]*"/>(?: \\(VP <task-ref id="[^"]+" label="[^"]*"/>\\))?: `
  + `((?:${Object.values(NEEDS_CATEGORY_LABELS).map(reEscape).join('|')})(?:: .*)?)$`,
);

/**
 * The lines Walnut wrote into a stored letter, not its writer's (2026-11-06, Main: the asks
 * Walnut adds kept a stored letter over BRIEF_MAX_CHARS, and every edit after it failed). A letter
 * stored since this was known says so itself (TaskBrief.added, exactly the lines). One stored
 * before has no record, so its lines are told by their shape: addedAskLine's with a category (the
 * ask at most as long as Walnut clips it), the count past the cap, or a line equal to what Walnut
 * writes for that task now, in today's form or the one before 2026-11-03 (no category).
 */
export function briefWalnutLines(
  brief: { text: string; added?: readonly string[] } | undefined, owner: BriefSectionTask, tasks: readonly BriefSectionTask[],
): string[] {
  if (!brief) return [];
  if (brief.added) return [...brief.added];
  const main = owner.org_role === 'main';
  const known = new Set<string>();
  for (const t of briefAskScope(owner, tasks)) {
    known.add(addedAskLine(t, main, tasks));
    known.add(askLineOf(t, main, tasks, words(t.user_status?.ask ?? '').slice(0, ADDED_ASK_CHARS) || 'Needs you'));
  }
  return brief.text.split('\n').map((l) => l.trim()).filter((l) => {
    const labeled = l.match(LABELED_ASK_RE);
    return ADDED_MORE_RE.test(l) || known.has(l) || (!!labeled && labeled[1]!.length <= ADDED_ASK_CHARS);
  });
}

/**
 * The writer's own share of a letter, the part BRIEF_MAX_CHARS holds (brief-write.ts): every line
 * but Walnut's (`walnut`, from briefWalnutLines or a write's record, each excused once and only
 * word for word: a Walnut line its writer edited is the writer's), the count past the cap, the
 * section headings and a section's "nothing" line, each counted without its list marker or
 * indent, which Walnut may add when it shapes the letter. So shaping a letter never makes its
 * writer's share larger (tests/core/sessions/brief-own-chars.test.ts).
 */
export function briefOwnChars(text: string, walnut: readonly string[] = []): number {
  const left = new Map<string, number>();
  for (const l of walnut) left.set(l.trim(), (left.get(l.trim()) ?? 0) + 1);
  let n = 0;
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    const k = left.get(t);
    if (k) { left.set(t, k - 1); continue; }
    if (ADDED_MORE_RE.test(t) || headingSection(t) || saysNothing(t)) continue;
    n += t.replace(/^(?:[-*+]|\d+[.)])\s+/, '').length + 1;
  }
  return n;
}

/** "- Nothing", "- None", "- 无", "- 暂无": a whole line that only says the section is empty.
 *  Anchored: a real line that merely contains such a word ("对方还没有回复") is the writer's. */
function saysNothing(line: string): boolean {
  if (line.includes('<task-ref') || /^\s{2,}/.test(line)) return false;
  const bare = line.replace(/[*_`]/g, '').replace(/^\s*[-*+]\s+/, '').trim();
  return /^(?:nothing(?:\s+(?:here|now|right\s+now|needs\s+you(?:\s+right\s+now)?))?|none(?:\s+now)?|n\/a|无|暂无|没有|目前没有)[.。!！]?$/i.test(bare);
}

/** The line an empty section gets, in the Brief's language (given, else read from the letter). */
export function emptySectionLine(language?: string, text = ''): string {
  const words = text.replace(/<task-ref\b[^>]*>/g, '');
  return /chinese|中文|^zh/i.test(language ?? '') || (!language && /[\u4e00-\u9fff]/.test(words)) ? '- 无' : '- None';
}

function askedAt(t: BriefSectionTask): number {
  const at = Date.parse(t.user_status?.checkedAt ?? t.user_status?.at ?? t.phase_changed_at ?? '');
  return Number.isFinite(at) ? at : 0;
}

export interface StructuredBrief {
  text: string;
  /** The lines put under another section than the one they were written in. */
  moved: number;
  /** The sections that had no heading of their own. */
  added: BriefSectionKey[];
  /** With `live`: the tasks asking the user that Walnut added to Needs you, and how many lines of
   *  finished tasks left. */
  asksAdded?: string[];
  dropped?: number;
  /** With `live`: the lines Walnut wrote into the letter (its asks, the count past the cap). */
  walnutLines?: string[];
  /** With `sources`: who wrote each part of `text`, each slice of the input keeping its writer
   *  (brief-source.ts). */
  text_sources?: BriefTextSource[];
}

/** A line being shaped: its text and the pieces it is made of (a slice of the input, or Walnut's). */
interface Ln { text: string; pieces: BriefPiece[] }

const layout = (text: string): Ln => ({ text, pieces: text ? [{ text, layout: true }] : [] });
const prefixed = (prefix: string, ln: Ln): Ln => ({ text: prefix + ln.text, pieces: [{ text: prefix, layout: true }, ...ln.pieces] });

/** The part of a line from `from` to `to` (offsets into its text), its pieces cut to match. */
function sliceLn(ln: Ln, from: number, to: number): Ln {
  const pieces: BriefPiece[] = [];
  let at = 0;
  for (const p of ln.pieces) {
    const a = Math.max(from, at); const b = Math.min(to, at + p.text.length);
    if (b > a) {
      const text = p.text.slice(a - at, b - at);
      pieces.push('src' in p ? { text, src: p.src + (a - at) } : 'writer' in p ? { text, writer: p.writer } : { text, layout: true });
    }
    at += p.text.length;
  }
  return { text: ln.text.slice(from, to), pieces };
}

/**
 * The Brief in its three sections. `tasks` gives each named task's live status; `owner` is the
 * Brief's own task, whose lines stay where the writer put them.
 */
export function structureBrief(
  text: string, ownerId: string, tasks: readonly BriefSectionTask[],
  opts: {
    language?: string;
    /** The Brief's owner (Main or a lead): with it the letter is held to the live state too
     *  (2026-10-31, the user: a task asking him to pick a design was in no Needs you): a task that
     *  asks the user and that the letter does not name gets its own line in Needs you, and a line
     *  whose task finished leaves. */
    live?: BriefSectionTask;
    /** Who wrote each part of `text`: with it the result carries `text_sources` for its own text. */
    sources?: readonly BriefTextSource[];
  } = {},
): StructuredBrief {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const lead: Ln[] = [];
  const body: Record<BriefSectionKey, Ln[]> = { needs: [], working: [], waiting: [] };
  const seen = new Set<BriefSectionKey>();
  let current: BriefSectionKey | null = null;
  let moved = 0;
  // Where the last line went: an indented line under it (a wrapped item) follows it.
  let last: Ln[] | null = null;
  // A finished task's line is leaving, with the indented lines under it.
  let dropping = false;
  let dropped = 0;
  const named = new Set<string>();
  // A chat reply's tasks line (org/message-about.ts) is never the letter's.
  const aboutLine = new RegExp(`^\\s{0,3}<${ABOUT_TAG_NAME}\\b[^>]*/>\\s*$`);
  let offset = 0;
  const rawLines = text.split('\n').map((l) => { const at = offset; offset += l.length + 1; return { l, at }; });
  for (const { l: raw, at: rawAt } of rawLines.filter(({ l }) => !aboutLine.test(l))) {
    const kept = raw.trimEnd();
    let line: Ln = { text: kept, pieces: kept ? [{ text: kept, src: rawAt }] : [] };
    // Walnut's own count of the asks past the cap is made again below, from the live state.
    if (opts.live && ADDED_MORE_RE.test(line.text.trim())) { last = null; continue; }
    const indented = /^\s+\S/.test(line.text);
    if (dropping && indented && !REF_RE.test(line.text)) continue;
    dropping = false;
    // An indented line under an item is the item's, even when it reads like a label ("  Working:").
    const heading: BriefSectionKey | null = last && indented ? null : headingSection(line.text);
    if (heading) { current = heading; seen.add(heading); last = null; continue; }
    // "**Needs you:** pick a supplier.": the label opens its section, the rest is its first line.
    const inline = line.text.match(INLINE_LABEL_RE);
    const inlineSection = inline ? headingSection(`**${inline[1]!.trim()}:**`) : null;
    if (inline && inlineSection) {
      current = inlineSection; seen.add(inlineSection); last = null;
      const rest = inline[2]!;
      if (!rest.trim()) continue;
      const from = line.text.length - rest.length + (rest.length - rest.trimStart().length);
      line = prefixed('- ', sliceLn(line, from, from + rest.trim().length));
    }
    // An indented line under an item (a wrapped line or a sub-item with no task of its own) goes
    // with that item wherever it goes.
    if (last && indented && !REF_RE.test(line.text)) { last.push(line); continue; }
    // A task's line written bare is a list item, so lines never run together into one paragraph.
    if (/^<task-ref\b/.test(line.text)) line = prefixed('- ', line);
    const ref = line.text.match(REF_RE)?.[1];
    // A line is about its first task (Main's names the VP second).
    if (ref) named.add(ref);
    const task = ref && ref !== ownerId ? byId.get(ref) : undefined;
    const target = task ? briefSectionOf(task) : null;
    if (opts.live && task && !target) { dropping = true; dropped++; last = null; continue; }
    if (target && target !== current) moved++;
    const dest: Ln[] = target ? body[target] : current ? body[current] : ref && ref === ownerId ? body.working : lead;
    // A sub-item that leaves its item becomes an item of its own: kept indented, it would nest under
    // a stranger, or open its new section as a code block.
    if (indented && dest !== last) {
      const bare = sliceLn(line, line.text.length - line.text.trimStart().length, line.text.length);
      line = /^(?:[-*+]\s|\d+[.)]\s)/.test(bare.text) ? bare : prefixed('- ', bare);
    }
    last = dest;
    last.push(line);
    if (!line.text.trim()) last = null;
  }
  // Every task that asks the user now is in Needs you, in its own words when the letter has none.
  const added: string[] = [];
  // Every line Walnut writes into the letter goes through here, so the write records it as
  // Walnut's (TaskBrief.added) and the length limit leaves it out (briefOwnChars).
  const walnutLines: string[] = [];
  const walnut = (ln: Ln) => { body.needs.push(ln); walnutLines.push(ln.text); };
  if (opts.live) {
    const main = opts.live.org_role === 'main';
    const missing = briefAskScope(opts.live, tasks)
      .filter((t) => !named.has(t.id) && briefSectionOf(t) === 'needs' && !t.user_status?.transient)
      .sort((a, b) => askedAt(b) - askedAt(a));
    for (const t of missing.slice(0, ADDED_ASKS_MAX)) {
      const words = addedAskLine(t, main, tasks);
      // The ask's words are its task's writer's (a session's report, a turn's last words), never the Brief's owner.
      walnut({ text: words, pieces: [{ text: words, writer: askLineWriter(t) }] });
      added.push(t.id);
    }
    const more = missing.length - ADDED_ASKS_MAX;
    if (more > 0) walnut(layout(`- And ${more} more ${more === 1 ? 'ask' : 'asks'} the user: the Task view lists ${more === 1 ? 'it' : 'them'}.`));
  }
  const trim = (ls: Ln[]) => {
    let a = 0; let b = ls.length;
    while (a < b && !ls[a]!.text.trim()) a++;
    while (b > a && !ls[b - 1]!.text.trim()) b--;
    return ls.slice(a, b);
  };
  const out: Ln[] = [];
  const head = trim(lead);
  if (head.length) out.push(...head, layout(''));
  for (const s of BRIEF_SECTIONS) {
    let lines = trim(body[s.state]);
    const items = lines.filter((l) => l.text.trim() && !saysNothing(l.text) && !headingSection(l.text));
    // A "nothing" line next to real items is stale (a task moved in); an empty section says so.
    if (items.length) lines = lines.filter((l) => !saysNothing(l.text));
    else if (s.optional) continue;
    else if (!lines.some((l) => saysNothing(l.text))) lines = [layout(emptySectionLine(opts.language, text))];
    out.push(layout(`### ${s.heading}`), ...lines, layout(''));
  }
  const joined = out.map((l) => l.text).join('\n');
  const shaped = joined.trim();
  let sources: BriefTextSource[] | undefined;
  if (opts.sources) {
    const pieces: BriefPiece[] = [];
    out.forEach((l, i) => { if (i) pieces.push({ text: '\n', layout: true }); pieces.push(...l.pieces); });
    const cutStart = joined.length - joined.trimStart().length;
    sources = sourcesOfPieces(text, opts.sources, pieces, cutStart, cutStart + shaped.length);
  }
  return {
    text: shaped,
    moved,
    added: BRIEF_SECTIONS.filter((s) => !s.optional).map((s) => s.state).filter((k) => !seen.has(k)),
    ...(opts.live ? { asksAdded: added, dropped, walnutLines } : {}),
    ...(sources ? { text_sources: sources } : {}),
  };
}

/** The three sections' headings and Walnut's lists under each, for the ask. */
export function briefSectionsBlock(sections: Record<BriefSectionKey, readonly string[]> | undefined): string {
  return BRIEF_SECTIONS.filter((s) => !s.optional || (sections?.[s.state]?.length ?? 0) > 0).map((s) => {
    const rows = sections?.[s.state] ?? [];
    return `### ${s.heading}\n${rows.length ? rows.join('\n') : '(none now)'}`;
  }).join('\n');
}

/** The rule every Brief follows: the three headings, each task under its own live status. */
export const BRIEF_STRUCTURE_RULE = `It has exactly these sections, always all of them, in this order, under these exact Markdown headings: ${BRIEF_SECTIONS.filter((s) => !s.optional).map((s) => `"### ${s.heading}"`).join(', ')}. A task with only something to read (finished, or it answered the user, asking nothing) goes under Needs you, its line saying what to look at. A task goes in the section of its own live status in Walnut's lists below, never in another one; an empty section gets one line saying there is nothing. Finished work leaves the Brief. Nothing before the first heading. Walnut moves a line to its task's section and adds a missing heading.`;
