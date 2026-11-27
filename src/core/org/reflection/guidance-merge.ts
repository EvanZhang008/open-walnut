/**
 * A lesson that finds the team guidance full (the day's new lines spent, or the file at its cap) is
 * merged into the existing line closest to it instead of being dropped (2026-11-21, the Walnut VP: on
 * 11-20 another VP's reflection dropped 14 lessons as "not added (day_full)", and the same mistakes
 * came back that day). One model call rewrites that line so it says both. The rewrite is checked
 * before it is written: it keeps most of the old line's words and most of the lesson's, it is not the
 * old line again, and it stays short enough for the hint the sessions read. Only a line the
 * reflection wrote is rewritten, never one the user wrote himself; the old text is kept in the day
 * record (`was`), the undo. A lesson an existing line already says is only pointed at, and a lesson
 * merged once is known after that without another call.
 *
 * When a merge cannot be made, the day record says why. The lessons a full day dropped (before this
 * existed, or when a merge failed) are taken up again from the day records (backfillDropped), a few
 * each pass, at most BACKFILL_TRIES_MAX tries each, from their own share of the day's merge calls.
 * A merge never grows the lines past what the sessions' hint shows (team-guidance-hint.ts
 * guidanceRoomLeft): when that room is spent, the record says so, for the user to tidy the file.
 */
import fsp from 'node:fs/promises';
import type { Task } from '../../types.js';
import { log } from '../../../logging/index.js';
import { normalizeForQuote, type CallModel } from './judge.js';
import { screenSkillWrite } from '../../memory-safety.js';
import { addGuidance, appendDayNote, dayNoteSaid, readDayEntries, readGuidance, reflectionDayFileOf, replaceGuidanceLine, type GuidanceLine } from './records.js';
import { localDate, readReflectionState, updateReflectionState, type ReflectionState } from './state.js';
import { guidanceRoomLeft } from './team-guidance-hint.js';
import { ASK_FIRST_CONFLICTS, askFirstLesson, checkCached, checkStepOf, verdictOf, type StepCheck } from './step-gate.js';

/** Merge calls a node may spend a day (apart from the judge's budget), and the backfill's share of them. */
export const MERGE_CALLS_PER_DAY_MAX = 12;
export const BACKFILL_CALLS_PER_DAY_MAX = 6;
/** A merged line is at most this long: the hint the sessions read has room for about 1,400 characters of lines. */
export const MERGED_LINE_MAX = 300;
/** Days of records the backfill reads, lessons it takes up a pass, and tries one lesson gets. */
export const BACKFILL_DAYS = 7;
/**
 * A lesson that holds the user's own words waits this long (2026-11-25 audit: at the day's rate the backlog
 * only grows, and from the 7th day lessons of his own words would have fallen out unplaced, unsaid). They
 * are taken up first.
 */
export const BACKFILL_OWN_WORDS_DAYS = 30;
export const BACKFILL_PER_PASS = 4;
export const BACKFILL_TRIES_MAX = 2;
/** Shares of the old line's and the lesson's words the rewrite keeps, at least (2026-11-21, a real model's 16 good merges of a VP's lessons kept 0.79 to 1 of the old line and 0.38 to 0.89 of the lesson; one that lost one of the old line's two conditions kept 0.64). */
export const KEEP_OLD_MIN = 0.75;
export const KEEP_LESSON_MIN = 0.35;

export const MERGES_SPENT = 'today\'s merges are spent';
export const ROOM_SPENT = 'the guidance fills what the sessions read: a line would fall out of their hint';

export type MergeResult =
  | { kind: 'merged'; line: number; text: string; was: string }
  | { kind: 'same'; line: number; text: string }
  | { kind: 'failed'; why: string };

export const MERGE_SYSTEM = [
  'You keep a team\'s guidance: short rules, one a line, that every session of the team reads. The list is full, and a new lesson must go in without losing any rule.',
  'Pick the ONE numbered line closest in subject to the new lesson and rewrite it so it says everything it said before AND the new lesson: keep the old line\'s own words and every point, condition and example of it, add what the lesson adds, and cut only words the two repeat. One or two sentences, no line breaks, at most ' + MERGED_LINE_MAX + ' characters, in the language the reply-language line names. Never rewrite a line marked (the user\'s own).',
  'When a line already says all of the new lesson, answer {"same": <its number>}. Otherwise answer {"line": <number>, "text": "<the rewritten line>"}. One JSON object, nothing else.',
].join('\n');

export function mergePrompt(lines: readonly GuidanceLine[], lesson: string, replyLanguage: string | null, ownLines: ReadonlySet<number> = new Set(), roomLeft?: number): string {
  return [
    `REPLY LANGUAGE: ${replyLanguage ?? 'the language the lines are written in'}`,
    ...(roomLeft !== undefined ? [`ROOM: the rewritten line may be at most ${roomLeft} characters longer than the line it replaces; when the lesson needs more, say the old line in fewer words (every point kept).`] : []),
    '', 'THE LINES:', ...lines.map((l, i) => `${i + 1}. ${l.text}${ownLines.has(i + 1) ? ' (the user\'s own)' : ''}`),
    '', 'THE NEW LESSON:', lesson,
  ].join('\n');
}

/** A text's content words: Latin words of 4+ letters and digits, and CJK character pairs. Pure. */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  const t = text.normalize('NFKC').toLowerCase();
  for (const w of t.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const cjk = w.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [];
    for (const run of cjk) {
      if (run.length === 1) out.add(run);
      for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
    }
    for (const latin of w.split(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/u)) if (latin.length >= 4) out.add(latin);
  }
  return out;
}

/** The share of `of`'s content words that `inText` has (1 when `of` has none). Pure. */
export function kept(of: string, inText: string): number {
  const a = contentTokens(of);
  if (!a.size) return 1;
  const b = contentTokens(inText);
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / a.size;
}

/** The model's answer read and checked against the lines; `targets` are the lines it may rewrite. Pure. */
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
/** Whether a text is written mostly in CJK characters (a lesson and its line can be in two languages). */
const mostlyCjk = (t: string): boolean => (t.match(CJK_RE)?.length ?? 0) * 2 >= (t.match(/\p{L}/gu)?.length ?? 0);

/**
 * The answer's JSON. A model that quotes a line holding straight double quotes often leaves them
 * unescaped (2026-11-21, a real VP's line with "..." in it): the line number and the text are then
 * read from the answer as written.
 */
function parseAnswer(raw: string): { line?: unknown; text?: unknown; same?: unknown } | null {
  const body = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  try { return JSON.parse(body); } catch { /* read it as written below */ }
  const same = /"same"\s*:\s*(\d+)/.exec(body);
  if (same) return { same: Number(same[1]) };
  const line = /"line"\s*:\s*(\d+)/.exec(body);
  const text = /"text"\s*:\s*"([\s\S]*)"\s*\}\s*$/.exec(body);
  return line && text ? { line: Number(line[1]), text: text[1].replace(/\\"/g, '"') } : null;
}

export function readMerge(raw: string, lines: readonly GuidanceLine[], lesson: string, targets?: ReadonlySet<number>): MergeResult {
  const a = parseAnswer(raw);
  if (!a) return { kind: 'failed', why: 'the answer is not JSON' };
  const n = Number.isInteger(a.same) ? a.same as number : Number.isInteger(a.line) ? a.line as number : 0;
  const old = lines[n - 1];
  if (!old) return { kind: 'failed', why: `no line ${n}` };
  if (Number.isInteger(a.same)) return { kind: 'same', line: n, text: old.text };
  if (targets && !targets.has(n)) return { kind: 'failed', why: `line ${n} is the user's own` };
  const text = typeof a.text === 'string' ? a.text.replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > MERGED_LINE_MAX) return { kind: 'failed', why: `no rewritten line, or one over ${MERGED_LINE_MAX} characters` };
  if (normalizeForQuote(text) === normalizeForQuote(old.text)) return { kind: 'failed', why: 'the rewrite adds nothing to the line' };
  if (kept(old.text, text) < KEEP_OLD_MIN) return { kind: 'failed', why: 'the rewrite drops what the line said' };
  // A lesson in another language than the line is translated into it: its words cannot be matched, so
  // the rewrite must at least have grown by a part of it (Chinese takes about a third of English's characters).
  const addsLesson = mostlyCjk(lesson) === mostlyCjk(text) ? kept(lesson, text) >= KEEP_LESSON_MIN : text.length - old.text.length >= lesson.length * 0.15;
  if (!addsLesson) return { kind: 'failed', why: 'the rewrite leaves out the lesson' };
  if (screenSkillWrite(text, 'reflection guidance merge')) return { kind: 'failed', why: 'the rewrite was refused by the injection screen' };
  return { kind: 'merged', line: n, text, was: old.text };
}

export interface MergeDeps {
  callModel: CallModel; replyLanguage: () => Promise<string | null>;
  /** The step check (step-gate.ts): a lesson kept before it existed passes it before the backfill writes it. */
  checkStep?: StepCheck;
  /** Make room in a full guidance while lessons wait (guidance-compact.ts compactGuidance); answers the lines freed. */
  makeRoom?: (waiting: number) => Promise<number>;
}

/** The line a lesson merged before now sits in (its number), or 0 when none holds it any more. */
function mergedLineOf(s: ReflectionState, key: string, lines: readonly GuidanceLine[]): number {
  const into = (s.mergedLessons ?? []).find((m) => m.lesson === key)?.line;
  return into ? lines.findIndex((l) => normalizeForQuote(l.text) === into) + 1 : 0;
}

/**
 * Merge one lesson into the closest line the reflection wrote: one model call, while today's merge
 * calls are under `budget` (the backfill passes its smaller share, so fresh lessons keep the rest).
 */
export async function mergeGuidance(
  node: Task, nodeName: string, lesson: GuidanceLine, deps: MergeDeps, nowMs: number, budget = MERGE_CALLS_PER_DAY_MAX,
): Promise<MergeResult> {
  const lines = await readGuidance(node.id);
  if (!lines.length) return { kind: 'failed', why: 'no line to merge into' };
  const key = normalizeForQuote(lesson.text);
  const state = await readReflectionState(node.id, nowMs);
  // The same lesson again (a second finding of the day, a backfill of one merged already): known, no call.
  const at = mergedLineOf(state, key, lines);
  if (at) return { kind: 'same', line: at, text: lines[at - 1].text };
  // A line with its source note, or one the reflection remembers writing, is the reflection's; the rest are the user's.
  const written = new Set(state.written);
  const targets = new Set(lines.flatMap((l, i) => (reflectionsOwn(l, written) ? [i + 1] : [])));
  if (!targets.size) return { kind: 'failed', why: 'no line the reflection wrote' };
  const own = new Set(lines.map((_, i) => i + 1).filter((i) => !targets.has(i)));
  // The sessions read the lines in a hint of fixed size: a merge never pushes a line out of it (team-guidance-hint.ts).
  const roomLeft = guidanceRoomLeft(nodeName, lines.map((l) => l.text));
  if (roomLeft <= 0) return { kind: 'failed', why: ROOM_SPENT };
  const date = localDate(nowMs);
  const took = await updateReflectionState(node.id, (s) => {
    const m = s.merges?.date === date ? s.merges : { date, count: 0 };
    if (m.count >= budget) return false;
    s.merges = { date, count: m.count + 1 };
    return true;
  }, nowMs);
  if (!took) return { kind: 'failed', why: MERGES_SPENT };
  const raw = await deps.callModel(MERGE_SYSTEM, mergePrompt(lines, lesson.text, await deps.replyLanguage(), own, roomLeft), node.id).catch((err) => `${err}`);
  const r = readMerge(raw, lines, lesson.text, targets);
  if (r.kind === 'failed') return r;
  if (r.kind === 'merged') {
    const old = lines[r.line - 1];
    if (r.text.length - old.text.length > roomLeft) return { kind: 'failed', why: 'the rewrite would push a line out of the sessions\' hint' };
    // The old line's source and date stay: a merge is no new line of today (records.ts day cap counts dates).
    const done = await replaceGuidanceLine(node.id, nodeName, old.text, { text: r.text, from: old.from, date: old.date });
    if (done === 'gone') return { kind: 'failed', why: 'the line changed meanwhile' };
  }
  const into = normalizeForQuote(r.text);
  await updateReflectionState(node.id, (s) => {
    if (r.kind === 'merged') {
      // The merged line is the reflection's own now: a user who deletes it later is remembered (state.ts written).
      const was = normalizeForQuote(r.was);
      s.written = [...s.written.filter((k) => k !== was), into];
      s.mergedLessons = (s.mergedLessons ?? []).map((m) => (m.line === was ? { ...m, line: into } : m));
    }
    s.mergedLessons = [...(s.mergedLessons ?? []).filter((m) => m.lesson !== key), { lesson: key, line: into }].slice(-500);
  }, nowMs);
  return r;
}

const DROPPED_TEXT_RE = /^not added \((?:day_full|file_full|step_check_failed|step_check_held)\b/;
const DROPPED_MD_RE = /^- Rule: none \(not added \((?:day_full|file_full)(?:; not merged: .*?)?\): (.+)\)\s*$/;

/**
 * The lessons a full day or file dropped: those of the last BACKFILL_DAYS days, and those holding his own
 * words (the finding quoted him) of the last BACKFILL_OWN_WORDS_DAYS; his own first, each oldest first.
 */
/**
 * The only way a lesson is held for a step: kept out of the queue AND said in the day's record the node
 * reads, so none is held silently (11-27 audit: the tidy's own hold wrote no reason). Guard:
 * tests/core/org/reflection-audit6.test.ts (no other file writes stepHeld).
 */
export async function holdLesson(node: Task, nodeName: string, key: string, why: string, nowMs: number): Promise<void> {
  await updateReflectionState(node.id, (s) => { s.stepHeld = [...new Set([...(s.stepHeld ?? []), key])].slice(-1000); }, nowMs);
  await appendDayNote(node.id, nodeName, localDate(nowMs), why, nowMs).catch(() => {});
}

/**
 * A line the reflection may rewrite: one with its source note or one it remembers writing, never a line
 * the user wrote nor one that holds his own standing words (those are his, word for word). Pure.
 */
export function reflectionsOwn(l: GuidanceLine, written: ReadonlySet<string>): boolean {
  if (l.text.startsWith(STANDING_LINE_HEAD)) return false;
  return !!l.from || written.has(normalizeForQuote(l.text));
}

/** How a line of the user's own words begins (guidance-merge.ts standingWordsLine). */
export const STANDING_LINE_HEAD = 'The user\'s own standing instruction';

export const STANDING_SYSTEM = [
  'USER WORDS are what the user wrote to an AI agent. Do they give a standing instruction: what agents should do every time for a kind of case from now on (who to tag or ask, where to post, what to always do)? A complaint, a question, a one-time order about one item, or a mood is not one.',
  'Answer only YES or NO.',
].join('\n');

/**
 * His own words as a guidance line, word for word and dated, when they are a standing instruction; null
 * otherwise. His words are his own yes, for the cases they name and no wider: the line says so. Not put
 * through the step check (the check holds what the reflection would have sessions do on ITS word).
 */
export async function standingWordsLine(quote: string, date: string, callModel: CallModel, nodeId: string): Promise<string | null> {
  const q = quote.replace(/\s+/g, ' ').trim();
  if (q.length < 12) return null;
  const raw = await callModel(STANDING_SYSTEM, `USER WORDS: ${q}`, nodeId).catch(() => '');
  if (!/^\W*YES\b/i.test(raw.trim())) return null;
  return `${STANDING_LINE_HEAD} of ${date}, in his words, for the cases they name and no wider: "${q}"`;
}

/** A lesson the day records hold as not added: its text, its day, and the user's words it quotes (when it does). */
export interface DroppedLesson { text: string; date: string; own: boolean; quote?: string }

export async function droppedLessons(nodeId: string, nowMs: number): Promise<DroppedLesson[]> {
  const out: DroppedLesson[] = [];
  const push = (text: string, date: string, own: boolean, quote?: string) => {
    const t = text.trim();
    const at = out.findIndex((x) => normalizeForQuote(x.text) === normalizeForQuote(t));
    if (!t) return;
    if (at < 0) out.push({ text: t, date, own, ...(quote ? { quote } : {}) });
    else if (own) { out[at].own = true; out[at].quote ??= quote; }
  };
  for (let i = BACKFILL_OWN_WORDS_DAYS - 1; i >= 0; i--) {
    const date = localDate(nowMs - i * 24 * 3600_000);
    const recent = i < BACKFILL_DAYS;
    // The day's JSON holds the lesson whole; the Markdown is read only for a day without one.
    const entries = await readDayEntries(nodeId, date);
    if (entries) {
      for (const e of entries) {
        if (e.rule.kind !== 'none' || !DROPPED_TEXT_RE.test(e.rule.text) || !e.finding?.guidance) continue;
        const own = !!e.finding.user_quote?.trim();
        if (own || recent) push(e.finding.guidance, date, own, own ? e.finding.user_quote!.trim().slice(0, 300) : undefined);
      }
      continue;
    }
    if (!recent) continue;
    const md = await fsp.readFile(reflectionDayFileOf(nodeId, date), 'utf-8').catch(() => '');
    for (const raw of md.split('\n')) {
      const m = DROPPED_MD_RE.exec(raw.trim());
      if (m) push(m[1], date, false);
    }
  }
  return [...out.filter((l) => l.own), ...out.filter((l) => !l.own)];
}

/** Once a day, the lessons that leave the backlog tomorrow unplaced, said in the day's record. */
async function noteLeaving(node: Task, nodeName: string, todo: ReadonlyArray<{ text: string; date: string; own: boolean }>, nowMs: number): Promise<void> {
  const date = localDate(nowMs);
  const edge = (days: number) => localDate(nowMs - (days - 1) * 24 * 3600_000);
  const leaving = todo.filter((l) => l.date === (l.own ? edge(BACKFILL_OWN_WORDS_DAYS) : edge(BACKFILL_DAYS)));
  if (!leaving.length || await dayNoteSaid(node.id, date, 'Lessons leaving the backlog')) return;
  const own = leaving.filter((l) => l.own).length;
  await appendDayNote(node.id, nodeName, date, `Lessons leaving the backlog tomorrow unplaced: ${leaving.length}${own ? ` (${own} with the user's own words)` : ''}; the guidance has no room for them (the day records hold their words).`, nowMs).catch(() => {});
}

/**
 * Take up again, a few a pass, the lessons a full day dropped: added where there is room, else merged.
 * One that fails is tried again on a later pass, BACKFILL_TRIES_MAX times in all, and never holds up
 * the ones behind it; the backfill stops only when its share of today's merge calls is spent.
 */
export async function backfillDropped(node: Task, nodeName: string, deps: MergeDeps, nowMs: number): Promise<number> {
  const state = await readReflectionState(node.id, nowMs);
  const done = new Set(state.backfilled ?? []);
  const covered = new Set([...(state.covered ?? []), ...(state.stepHeld ?? [])]);
  const todo = (await droppedLessons(node.id, nowMs)).filter((l) => !done.has(normalizeForQuote(l.text)) && !state.removed.includes(normalizeForQuote(l.text)) && !covered.has(normalizeForQuote(l.text)));
  const date = localDate(nowMs);
  await noteLeaving(node, nodeName, todo, nowMs);
  // A full guidance makes its own room first: the lessons below go in after it (2026-11-26: the VPs compacted by hand).
  if (todo.length) await deps.makeRoom?.(todo.length).catch(() => 0);
  const check = checkStepOf(deps);
  let taken = 0;
  for (const l of todo.slice(0, BACKFILL_PER_PASS)) {
    const key = normalizeForQuote(l.text);
    // A lesson that would have sessions use his browser, accounts or name, or write in production or a
    // cloud account, is never written as it is. One that quotes him is rewritten to ask first and checked
    // again (his words are never dropped for a step); the others are held, said in the day's record. One the
    // check cannot judge now waits for a later pass. Each lesson is asked about once (checkCached).
    const g = await checkCached(node.id, l.text, check, nowMs);
    if (verdictOf(g) === 'failed') continue;
    let text = l.text;
    if (g.steps.length) {
      // Rewritten once: kept on the state, so a lesson that waits for room is not rewritten every pass.
      let asked = !l.own ? null : state.askFirst?.[key]
        ?? await askFirstLesson(l.text, g.steps, deps.callModel, (t, id) => checkCached(id, t, check, nowMs), node.id);
      // Its point is to act on his yes without asking again: "ask first" would turn it around (review of
      // 57063edbcd). When his own words are a standing instruction, they go in as his words, word for word
      // and dated, for the cases they name (11-27 audit: "for all the cr, list them and tag ..." was held and
      // found nowhere); otherwise it is held.
      if (asked === ASK_FIRST_CONFLICTS) {
        const standing = l.quote ? await standingWordsLine(l.quote, l.date, deps.callModel, node.id) : null;
        if (!standing) {
          await holdLesson(node, nodeName, key, `A dropped lesson with the user's own words was not taken up: the step check held it (${g.steps.join(', ')}), and its point is to act on his yes without asking again, which a rewrite to ask first would reverse. Write it yourself if his words allow the step; its words: "${l.text.slice(0, 300)}".`, nowMs);
          continue;
        }
        asked = standing;
      }
      const rewritten = asked;
      if (rewritten && !state.askFirst?.[key]) {
        await updateReflectionState(node.id, (s) => { s.askFirst = { ...(s.askFirst ?? {}), [key]: rewritten }; }, nowMs);
        await appendDayNote(node.id, nodeName, date, `A dropped lesson with the user's own words was held by the step check (${g.steps.join(', ')}) and is taken up ${rewritten.startsWith(STANDING_LINE_HEAD) ? 'as his own words' : 'rewritten to ask first'}: "${rewritten}".`, nowMs).catch(() => {});
      }
      if (!rewritten) {
        // His words: tried again on later passes, held only after BACKFILL_TRIES_MAX rewrites that failed.
        const tries = (state.backfillTries?.[key] ?? 0) + 1;
        if (l.own && tries < BACKFILL_TRIES_MAX) {
          await updateReflectionState(node.id, (s) => { s.backfillTries = { ...(s.backfillTries ?? {}), [key]: tries }; }, nowMs);
          continue;
        }
        await holdLesson(node, nodeName, key, `A dropped lesson was not taken up: the step check held it (${g.steps.join(', ')})${l.own ? `, and it could not be rewritten to ask first; its words: "${l.text.slice(0, 300)}"` : ''}.`, nowMs);
        continue;
      }
      text = rewritten;
    }
    const addedToday = (await readGuidance(node.id)).filter((x) => x.date === date).length;
    const line = { text, from: `reflection of ${l.date}`, date };
    const added = await addGuidance(node.id, nodeName, line, { removed: state.removed, addedToday });
    if (added === 'added') await updateReflectionState(node.id, (s) => { s.written.push(normalizeForQuote(text)); }, nowMs);
    const merged = added === 'day_full' || added === 'file_full' ? await mergeGuidance(node, nodeName, line, deps, nowMs, BACKFILL_CALLS_PER_DAY_MAX) : null;
    // No call was made: the lesson waits for a later pass (a new day, or room the user freed), no try spent.
    if (merged?.kind === 'failed' && (merged.why === MERGES_SPENT || merged.why === ROOM_SPENT)) break;
    const tries = merged?.kind === 'failed' ? (state.backfillTries?.[key] ?? 0) + 1 : 0;
    const settled = merged?.kind !== 'failed' || tries >= BACKFILL_TRIES_MAX;
    if (merged?.kind === 'failed') log.task.warn('reflection: a dropped lesson was not merged', { nodeId: node.id, tries, gaveUp: settled, why: merged.why });
    await updateReflectionState(node.id, (s) => {
      const t = { ...(s.backfillTries ?? {}) };
      if (settled) {
        delete t[key];
        s.backfilled = [...(s.backfilled ?? []), key].slice(-500);
        // Given up, not placed: it still waits for room, and the node's tidy names it (guidance-tidy.ts).
        if (merged?.kind === 'failed') s.backfillGaveUp = [...(s.backfillGaveUp ?? []), key].slice(-500);
      } else t[key] = tries;
      s.backfillTries = t;
    }, nowMs);
    if (merged?.kind !== 'failed') taken++;
  }
  return taken;
}
