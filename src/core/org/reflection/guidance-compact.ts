/**
 * A full team guidance is made room in by the reflection itself (2026-11-26, Walnut VP: with the hint's
 * room spent, lessons waited and the VPs compacted the file by hand every day, one for the third time).
 * One model call proposes edits to the lines the reflection wrote (never a line the user wrote himself):
 * two lines close in subject said as ONE, or one long line said in fewer words, each keeping every point,
 * condition and example. Each edit is checked on its own: by rule (it frees room, keeps most of each old
 * line's words, same language, the injection screen) and by a second call that names the edits that lost
 * a point (a model rewriting many lines at once changed their meaning, guidance-align.ts). A refused edit
 * is named with its reason in the next call. The old lines are kept in the day record, the undo; the
 * waiting lessons then go in by the backfill. At most COMPACT_CALLS_PER_DAY_MAX edit calls a day, each with one
 * check call. A new line passes the step check as any line the reflection writes.
 */
import type { Task } from '../../types.js';
import { log } from '../../../logging/index.js';
import { normalizeForQuote } from './judge.js';
import { screenSkillWrite } from '../../memory-safety.js';
import { appendDayNote, mergeTwoGuidanceLines, readGuidance, replaceGuidanceLine, type GuidanceLine } from './records.js';
import { localDate, readReflectionState, updateReflectionState } from './state.js';
import { checkCached, checkStepOf, verdictOf } from './step-gate.js';
import { guidanceRoomLeft } from './team-guidance-hint.js';
import { MERGED_LINE_MAX, kept, reflectionsOwn, type MergeDeps } from './guidance-merge.js';

export const COMPACT_CALLS_PER_DAY_MAX = 4;
/** Room below this, with lessons waiting, is made (the tidy's own threshold, guidance-tidy.ts TIDY_ROOM_MIN). */
export const COMPACT_ROOM_MIN = 200;
/** Edits one call may propose (2026-11-26 replay on the real files: the fullest was 450 over, and a pair freed 7 to 35 characters). */
export const COMPACT_EDITS_MAX = 8;
/**
 * The edit call's answer room: up to COMPACT_EDITS_MAX lines of up to MERGED_LINE_MAX characters (2026-11-26 on
 * production: at the default 3000 tokens, eight Chinese edits were cut off and the answer read as no JSON).
 */
export const COMPACT_MAX_TOKENS = 8000;
/** An edit frees at least this many characters, or it is no room made. */
const FREES_MIN = 12;
/**
 * Each old line keeps this share of its content words in the new line. Lower than a lesson merge's
 * (guidance-merge.ts KEEP_OLD_MIN): saying a line in fewer words cuts words, and in Chinese every
 * rewording moves character pairs. The meaning is held by the check call (COMPACT_CHECK_SYSTEM).
 */
export const KEEP_COMPACT_MIN = 0.55;

export const COMPACT_SYSTEM = [
  'You keep a team\'s guidance: short rules, one a line, that every session of the team reads. The list is full and new lessons wait, so it must be said in fewer characters, losing nothing.',
  `Propose up to ${COMPACT_EDITS_MAX} edits, each line in at most one edit, never a line marked (the user's own):`,
  '- two numbered lines close in subject said as ONE line, or',
  '- one long line said in fewer words.',
  `Every point, condition, example, name and number of the old line(s) stays; cut only repeated words, filler and roundabout phrasing. One or two sentences, no line breaks, at most ${MERGED_LINE_MAX} characters, clearly shorter than the old line(s), in the language the lines are written in. Edits listed under REFUSED BEFORE failed for the reason given: fix that or pick other lines.`,
  'Answer only JSON: {"edits": [{"lines": [<number>] or [<number>, <number>], "text": "<the new line>"}]}',
].join('\n');

export const COMPACT_CHECK_SYSTEM = [
  'Each numbered edit below replaces one or two rules of a team\'s guidance with a shorter line. An edit LOSES when its new line drops or weakens any point, condition, exception, example, name or number of an old line, changes what a rule tells a reader to do, or puts two rules with no subject in common in one line (a reader looking for one would not find the other). Shorter wording of the same rule does not lose.',
  'Answer only JSON: {"lost": [<edit numbers>], "why": {"<edit number>": "<what was lost>"}}',
].join('\n');

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const mostlyCjk = (t: string): boolean => (t.match(CJK_RE)?.length ?? 0) * 2 >= (t.match(/\p{L}/gu)?.length ?? 0);

/** One edit: the line numbers it replaces (one or two) and the new line. */
export type CompactEdit = { lines: number[]; text: string };
export type CompactRefusal = { lines: number[]; why: string };
export type CompactResult = { kind: 'read'; edits: CompactEdit[]; refused: CompactRefusal[] } | { kind: 'failed'; why: string };

/** One edit checked against the lines by rule: why it is refused, or '' when it holds. Pure. */
function editRefusal(nums: readonly number[], text: string, lines: readonly GuidanceLine[], targets: ReadonlySet<number>): string {
  if ((nums.length !== 1 && nums.length !== 2) || new Set(nums).size !== nums.length || nums.some((n) => !lines[n - 1])) return 'not one or two lines of the list';
  if (nums.some((n) => !targets.has(n))) return 'a line the user wrote himself';
  const old = nums.map((n) => lines[n - 1]!.text);
  if (!text || text.length > MERGED_LINE_MAX) return `no line, or one over ${MERGED_LINE_MAX} characters`;
  if (text.length > old.reduce((s, l) => s + l.length, 0) - FREES_MIN) return 'the line frees no room';
  // Each line's words are kept (a line in another script than the rewrite cannot be matched word for word: none is taken).
  for (const [i, l] of old.entries()) {
    if (mostlyCjk(l) !== mostlyCjk(text)) return 'the lines are in another language than the rewrite';
    if (kept(l, text) < KEEP_COMPACT_MIN) return `the rewrite drops what line ${nums[i]} said (keep more of its own words)`;
  }
  if (screenSkillWrite(text, 'reflection guidance compact')) return 'the rewrite was refused by the injection screen';
  return '';
}

/** The edit objects written out whole in an answer that does not parse (one cut off by its token limit). Pure. */
function completeEdits(raw: string): unknown[] {
  const out: unknown[] = [];
  for (const m of raw.matchAll(/\{\s*"lines"\s*:\s*\[[\d\s,]*\]\s*,\s*"text"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/g)) {
    try { out.push(JSON.parse(m[0])); } catch { /* not whole */ }
  }
  return out;
}

/** The model's answer read and each edit checked by rule; `targets` are the lines it may change. Pure. */
export function readCompact(raw: string, lines: readonly GuidanceLine[], targets: ReadonlySet<number>): CompactResult {
  let a: { edits?: unknown; merges?: unknown; lines?: unknown; text?: unknown };
  try { a = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch {
    // An answer cut off mid-way still holds the edits written out whole before the cut.
    const whole = completeEdits(raw);
    if (!whole.length) return { kind: 'failed', why: 'the answer is not JSON' };
    a = { edits: whole };
  }
  const list = Array.isArray(a.edits) ? a.edits : Array.isArray(a.merges) ? a.merges : a.lines ? [a] : [];
  const edits: CompactEdit[] = [];
  const refused: CompactRefusal[] = [];
  const used = new Set<number>();
  for (const m of list.slice(0, COMPACT_EDITS_MAX) as Array<{ lines?: unknown; text?: unknown }>) {
    const nums = Array.isArray(m?.lines) ? m.lines.filter((n): n is number => Number.isInteger(n)) : [];
    if (!nums.length) continue;
    const text = typeof m.text === 'string' ? m.text.replace(/\s+/g, ' ').trim() : '';
    const why = nums.some((n) => used.has(n)) ? 'a line already in another edit' : editRefusal(nums, text, lines, targets);
    if (why) { refused.push({ lines: nums, why }); continue; }
    nums.forEach((n) => used.add(n));
    edits.push({ lines: nums, text });
  }
  if (!edits.length && !refused.length) return { kind: 'failed', why: 'no edit in the answer' };
  return { kind: 'read', edits, refused };
}

/** The check call's answer read: the edits (1-based, in `edits`' order) it says lost a point, with why. Null when unreadable. Pure. */
export function readCompactCheck(raw: string, count: number): Map<number, string> | null {
  let a: { lost?: unknown; why?: unknown };
  try { a = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { return null; }
  if (!Array.isArray(a.lost)) return null;
  const why = a.why && typeof a.why === 'object' ? a.why as Record<string, unknown> : {};
  const out = new Map<number, string>();
  for (const n of a.lost) if (Number.isInteger(n) && n >= 1 && n <= count) out.set(n, typeof why[n] === 'string' ? `it loses ${why[n]}` : 'it loses a point of a line');
  return out;
}

function checkPrompt(edits: readonly CompactEdit[], lines: readonly GuidanceLine[]): string {
  return edits.map((e, i) => [`EDIT ${i + 1}:`, ...e.lines.map((n) => `OLD: ${lines[n - 1]!.text}`), `NEW: ${e.text}`].join('\n')).join('\n\n');
}

/**
 * Make room while lessons wait and little is left, up to today's calls. `waiting` says how many lessons
 * wait (guidance-merge.ts backfillDropped counts them). Answers the edits made.
 */
export async function compactGuidance(node: Task, nodeName: string, waiting: number, deps: Pick<MergeDeps, 'callModel' | 'checkStep'>, nowMs: number): Promise<number> {
  if (!waiting) return 0;
  const check = checkStepOf(deps);
  const date = localDate(nowMs);
  let made = 0;
  let refusedBefore: string[] = [];
  for (;;) {
    const lines = await readGuidance(node.id);
    const room = guidanceRoomLeft(nodeName, lines.map((l) => l.text));
    if (room >= COMPACT_ROOM_MIN) break;
    const state = await readReflectionState(node.id, nowMs);
    // A line with its source note, or one the reflection remembers writing, is the reflection's; the rest are the user's.
    const written = new Set(state.written);
    const targets = new Set(lines.flatMap((l, i) => (reflectionsOwn(l, written) ? [i + 1] : [])));
    if (!targets.size) break;
    const took = await updateReflectionState(node.id, (s) => {
      const c = s.compacts?.date === date ? s.compacts : { date, count: 0, freed: 0 };
      if (c.count >= COMPACT_CALLS_PER_DAY_MAX) return false;
      s.compacts = { ...c, count: c.count + 1 };
      return true;
    }, nowMs);
    if (!took) break;
    const prompt = [
      `NEEDED: at least ${COMPACT_ROOM_MIN - room} characters fewer in all.`, '',
      'THE LINES:', ...lines.map((l, i) => `${i + 1}. ${l.text}${targets.has(i + 1) ? '' : ' (the user\'s own)'}`),
      ...(refusedBefore.length ? ['', 'REFUSED BEFORE:', ...refusedBefore] : []),
    ].join('\n');
    const raw = await deps.callModel(COMPACT_SYSTEM, prompt, node.id, { maxTokens: COMPACT_MAX_TOKENS }).catch((err) => `${err}`);
    const r = readCompact(raw, lines, targets);
    if (r.kind === 'failed') {
      log.task.warn('reflection: no guidance edit to make room', { nodeId: node.id, why: r.why });
      continue;
    }
    const refused = [...r.refused];
    let edits = r.edits;
    if (edits.length) {
      // The meaning check: an unreadable answer takes no edit (a lost rule costs more than a day's wait).
      const lost = readCompactCheck(await deps.callModel(COMPACT_CHECK_SYSTEM, checkPrompt(edits, lines), node.id).catch(() => ''), edits.length);
      if (!lost) {
        log.task.warn('reflection: the guidance edits could not be checked', { nodeId: node.id });
        continue;
      }
      refused.push(...edits.flatMap((e, i) => (lost.has(i + 1) ? [{ lines: e.lines, why: lost.get(i + 1)! }] : [])));
      edits = edits.filter((_, i) => !lost.has(i + 1));
    }
    // Named by their words, so the next call (with new numbers) can be told what failed.
    refusedBefore = refused.slice(0, COMPACT_EDITS_MAX).map((x) => `- ${x.lines.map((n) => `"${lines[n - 1]?.text.slice(0, 60) ?? n}..."`).join(' with ')}: ${x.why}`);
    for (const e of edits) {
      const old = e.lines.map((n) => lines[n - 1]!);
      // The first line's source and date stay: an edit is no new line of today (records.ts day cap counts dates).
      const next = { text: e.text, from: old[0]!.from, date: old[0]!.date };
      // The new line is checked for a step as any line the reflection writes (review of 57063edbcd).
      if (verdictOf(await checkCached(node.id, e.text, check, nowMs)) !== 'pass') {
        refusedBefore.push(`- ${old.map((l) => `"${l.text.slice(0, 60)}..."`).join(' with ')}: the new line was held by the step check`);
        continue;
      }
      const keys = old.map((l) => normalizeForQuote(l.text));
      const into = normalizeForQuote(e.text);
      // The new line is the reflection's before it is in the file: cut off between the two, the old lines
      // are still in `written` and the file, never read as deleted by the user (review of 57063edbcd).
      await updateReflectionState(node.id, (s) => { if (!s.written.includes(into)) s.written.push(into); }, nowMs);
      const done = old.length === 2
        ? await mergeTwoGuidanceLines(node.id, nodeName, old[0]!.text, old[1]!.text, next)
        : await replaceGuidanceLine(node.id, nodeName, old[0]!.text, next);
      if (done === 'gone') continue;
      await updateReflectionState(node.id, (s) => {
        // The old lines leave `written`, and say they live on in the new one: a user who deletes it later
        // deletes them too, and they never come back as lessons (review of 57063edbcd).
        s.written = [...s.written.filter((k) => !keys.includes(k) && k !== into), into];
        const moved = (s.mergedLessons ?? []).map((x) => (keys.includes(x.line) ? { ...x, line: into } : x));
        s.mergedLessons = [...moved.filter((x) => !keys.includes(x.lesson)), ...keys.map((k) => ({ lesson: k, line: into }))].slice(-500);
        if (s.compacts?.date === date) s.compacts = { ...s.compacts, freed: s.compacts.freed + 1 };
      }, nowMs);
      const was = old.map((l) => `"${l.text}"`).join(' and ');
      await appendDayNote(node.id, nodeName, date, `Guidance made room for waiting lessons: ${old.length === 2 ? 'two lines merged' : 'a line said shorter'} into "${e.text}" (was ${was}).`, nowMs).catch(() => {});
      made++;
    }
    if (refused.length) log.task.warn('reflection: guidance edits refused', { nodeId: node.id, refused: refused.map((x) => x.why) });
  }
  if (made) log.task.info('reflection: guidance said shorter to make room', { nodeId: node.id, made, waiting });
  return made;
}
