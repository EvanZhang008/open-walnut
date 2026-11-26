/**
 * A guidance that fills what the sessions read is the node's to tidy (2026-11-23 audit: with the
 * hint's room spent, every new lesson of a day was dropped as "not added" and nobody heard). Once a
 * day, while lessons wait for room, the node is told which ones and where its file is; it merges or
 * deletes lines with the work's context, and the waiting lessons go in on the next passes
 * (guidance-merge.ts backfillDropped). The reflection never rewrites the file wholesale itself: a
 * model rewriting many lines at once changed their meaning (guidance-align.ts).
 */
import type { Task } from '../../types.js';
import { log } from '../../../logging/index.js';
import { normalizeForQuote } from './judge.js';
import { droppedLessons } from './guidance-merge.js';
import { checkCached, checkStepOf, stepWords, verdictOf, type StepCheck } from './step-gate.js';
import { sessionNowOf } from './candidates.js';
import { guidanceFileOf, nearlySame, readGuidance } from './records.js';
import { localDate, readReflectionState, updateReflectionState } from './state.js';
import { guidanceRoomLeft, orgSkills } from './team-guidance-hint.js';
import type { CallModel } from './judge.js';

/** Below this much free room a waiting lesson cannot go in (a line is about 150 characters). */
export const TIDY_ROOM_MIN = 200;
/** Waiting lessons named in one note. */
const TIDY_LISTED_MAX = 8;

export interface TidyDeps {
  send: (task: Task, text: string, title: string) => Promise<boolean>;
  confirmSend?: (node: Task, task: Task, sessionId: string) => Promise<boolean | string>;
  currentSession?: (task: Task) => Promise<string>;
  /** For settleCovered: the model, his standing rules and the org's skills (the defaults read the real ones). */
  callModel?: CallModel;
  userRules?: () => Promise<string>;
  orgSkills?: (nodeId: string) => Promise<Array<{ name: string; description: string }>>;
  /** The step check's model layer (step-gate.ts); without it only its fixed words judge. */
  checkStep?: StepCheck;
}

/** Waiting lessons one call reads; at most two calls a day. */
export const COVERED_BATCH = 40;

export const COVERED_SYSTEM = [
  'A team\'s guidance is full and lessons wait for room. Find the waiting lessons that need no room:',
  '- covered: a GUIDANCE line, one of the USER RULES, or an ORG SKILL already says all of it (the same rule in other words counts; a lesson that adds a condition, a case or a step the others lack is not covered);',
  '- same: a waiting lesson that says the same as an EARLIER waiting lesson (name the later one; the earlier one stays).',
  'Answer only JSON: {"covered": [lesson numbers], "same": [lesson numbers]}',
].join('\n');

/**
 * Once a day, the waiting lessons a line, his standing rules or an org skill already says, or that repeat
 * an earlier waiting one, leave the queue (2026-11-25: of 79 waiting, several said what USER.md or an org
 * skill said, and two VPs spent a session each tidying for them). Answers the lessons settled. A call
 * that fails or cannot be read settles none.
 */
export async function settleCovered(node: Task, waiting: readonly string[], lines: readonly string[], deps: TidyDeps, nowMs: number): Promise<string[]> {
  const date = localDate(nowMs);
  if (!waiting.length || !deps.callModel || (await readReflectionState(node.id, nowMs)).coveredChecked === date) return [];
  await updateReflectionState(node.id, (s) => { s.coveredChecked = date; }, nowMs);
  const rules = (await deps.userRules?.().catch(() => '')) ?? '';
  const skills = await (deps.orgSkills ?? orgSkills)(node.id).catch(() => []);
  const settled: string[] = [];
  for (let at = 0; at < Math.min(waiting.length, COVERED_BATCH * 2); at += COVERED_BATCH) {
    const batch = waiting.slice(at, at + COVERED_BATCH);
    const user = [
      'GUIDANCE:', ...lines.map((l, i) => `${i + 1}. ${l}`), '',
      'USER RULES:', rules.trim() || '(none)', '',
      'ORG SKILLS:', ...(skills.length ? skills.map((k) => `- ${k.name}: ${k.description}`) : ['(none)']), '',
      'WAITING LESSONS:', ...batch.map((l, i) => `${i + 1}. ${l}`),
    ].join('\n');
    const raw = await deps.callModel(COVERED_SYSTEM, user, node.id).catch(() => '');
    let a: { covered?: unknown; same?: unknown } = {};
    try { a = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { continue; }
    const nums = [...(Array.isArray(a.covered) ? a.covered : []), ...(Array.isArray(a.same) ? a.same : [])]
      .filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= batch.length);
    settled.push(...new Set(nums.map((n) => batch[n - 1]!)));
  }
  if (settled.length) {
    const keys = settled.map(normalizeForQuote);
    await updateReflectionState(node.id, (s) => { s.covered = [...new Set([...(s.covered ?? []), ...keys])].slice(-1000); }, nowMs);
    log.task.info('reflection: waiting lessons already said elsewhere left the queue', { nodeId: node.id, count: settled.length });
  }
  return settled;
}

/** The waiting lessons no line says yet, each once (the newest wording kept). Pure. */
export function distinctWaiting(waiting: readonly string[], lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of [...waiting].reverse()) {
    if (lines.some((l) => nearlySame(l, w)) || out.some((o) => nearlySame(o, w))) continue;
    out.unshift(w);
  }
  return out;
}

/** Pairs of guidance lines that say nearly the same, by line number (1-based). Pure. */
export function twinLines(lines: readonly string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) if (nearlySame(lines[i]!, lines[j]!)) out.push([i + 1, j + 1]);
  return out;
}

export function tidyNote(file: string, roomLeft: number, waiting: readonly string[], twins: ReadonlyArray<[number, number]> = []): string {
  return [
    `Your team guidance fills what your sessions read (${roomLeft < 0 ? `${-roomLeft} characters over` : `${roomLeft} characters left`}), so ${waiting.length} lesson${waiting.length === 1 ? '' : 's'} of the last days could not go in:`,
    ...waiting.slice(0, TIDY_LISTED_MAX).map((l) => `- ${l}`),
    ...(waiting.length > TIDY_LISTED_MAX ? [`- ... and ${waiting.length - TIDY_LISTED_MAX} more`] : []),
    ...(twins.length ? [`Lines that say nearly the same, to merge first: ${twins.slice(0, 6).map(([a, b]) => `${a} and ${b}`).join('; ')}.`] : []),
    'This is your team\'s routine upkeep: do it yourself, and do not report it to the user (no message, letter or thread about it).',
    `Make room in ${file}: merge lines that say the same, shorten long ones (keep every point and condition), delete what no longer holds. A lesson already said by a line needs no room. The file is on the machine Walnut's server runs on: from a session on another host, edit it there (host_exec on __local__). The waiting lessons go in by themselves once there is room. No reply is needed.`,
  ].join('\n');
}

/** Ask the node once today when lessons wait for room. True when it was asked. */
export async function askTidy(node: Task, nodeName: string, deps: TidyDeps, nowMs: number): Promise<boolean> {
  const date = localDate(nowMs);
  const state = await readReflectionState(node.id, nowMs);
  // Asked today and the day's queue settled already: nothing to read (it would read 30 days of records every pass).
  if (state.tidyAsked === date && state.coveredChecked === date) return false;
  const lines = await readGuidance(node.id);
  const texts = lines.map((l) => l.text);
  const room = guidanceRoomLeft(nodeName, texts);
  // Placed (added, merged), deleted by someone, or said elsewhere already (settleCovered): no longer waiting.
  // A lesson the backfill gave up on still waits. State from before backfillGaveUp kept no such list: there
  // a backfilled lesson neither written nor merged was given up.
  const merged = new Set((state.mergedLessons ?? []).map((m) => m.lesson));
  const gaveUp = new Set(state.backfillGaveUp ?? (state.backfilled ?? []).filter((k) => !state.written.includes(k) && !merged.has(k)));
  const done = new Set([...(state.backfilled ?? []).filter((k) => !gaveUp.has(k)), ...state.removed, ...merged, ...(state.covered ?? [])]);
  // Counted once each: a lesson a line already says, or one said again in other words, is not waiting
  // (2026-11-24 audit: "80 wait" counted the same lesson from several tasks and days).
  const held = new Set(state.stepHeld ?? []);
  const lessons = distinctWaiting((await droppedLessons(node.id, nowMs)).filter((l) => !done.has(normalizeForQuote(l.text)) && !held.has(normalizeForQuote(l.text))).map((l) => l.text), texts);
  // Listed only when the step check passed it (each asked about once): the node may write a listed one.
  const queued: string[] = [];
  for (const l of lessons) {
    const g = await checkCached(node.id, l, checkStepOf(deps), nowMs).catch(() => null);
    if (g && verdictOf(g) === 'pass') queued.push(l);
    else if (g && verdictOf(g) === 'held') await updateReflectionState(node.id, (s) => { s.stepHeld = [...new Set([...(s.stepHeld ?? []), normalizeForQuote(l)])].slice(-1000); }, nowMs);
  }
  // Once a day, the ones a line, his rules or an org skill already says leave the queue first.
  const settled = new Set((await settleCovered(node, queued, texts, deps, nowMs).catch(() => [])).map(normalizeForQuote));
  const waiting = queued.filter((w) => !settled.has(normalizeForQuote(w)));
  if (state.tidyAsked === date) return false;
  if (!waiting.length) return false;
  // The reflection made room itself today (guidance-compact.ts): the node is not asked to.
  if (state.compacts?.date === date && state.compacts.freed > 0) return false;
  // Asked when little room is left, or when none of the waiting lessons fits in what is left
  // (2026-11-23: 276 characters left, every waiting lesson longer, and the node was never asked).
  if (room >= TIDY_ROOM_MIN && waiting.some((w) => guidanceRoomLeft(nodeName, [...texts, w]) >= 0)) return false;
  const sessionId = await sessionNowOf(node, deps);
  if (deps.confirmSend && !['ok', 'session_changed', true].includes(await deps.confirmSend(node, node, sessionId).catch(() => false))) return false;
  // Marked first: a send that fails is not repeated today.
  await updateReflectionState(node.id, (s) => { s.tidyAsked = date; }, nowMs);
  const ok = await deps.send(node, tidyNote(guidanceFileOf(node.id), room, waiting, twinLines(texts)), `Team guidance is full: ${waiting.length} lesson(s) wait for room`).catch(() => false);
  if (ok) log.task.info('reflection: the node was asked to make room in its guidance', { nodeId: node.id, waiting: waiting.length, room });
  return ok;
}

/**
 * The guidance lines already in the file that the step check holds are named to the node once each
 * (2026-11-25 review: a line written before the check told every session to sign in with the user's
 * saved browser login). Never deleted here: the node rewrites the line so the step is asked for, or
 * deletes it. Each line is asked about once (checkCached). True when the node was told.
 */
export async function tellHeldLines(node: Task, nodeName: string, deps: TidyDeps, nowMs: number): Promise<boolean> {
  // Once a day: a line the reflection writes passed the check already, and the file changes rarely.
  const date = localDate(nowMs);
  const state = await readReflectionState(node.id, nowMs);
  if (state.linesChecked === date) return false;
  await updateReflectionState(node.id, (s) => { s.linesChecked = date; }, nowMs);
  const lines = (await readGuidance(node.id)).map((l) => l.text);
  const told = new Set(state.linesHeldTold ?? []);
  const held: Array<{ line: number; text: string; steps: string }> = [];
  for (const [i, text] of lines.entries()) {
    if (told.has(normalizeForQuote(text))) continue;
    const g = await checkCached(node.id, text, checkStepOf(deps), nowMs).catch(() => null);
    if (g && verdictOf(g) === 'held') held.push({ line: i + 1, text, steps: stepWords(g.steps) });
  }
  if (!held.length) return false;
  const sessionId = await sessionNowOf(node, deps);
  if (deps.confirmSend && !['ok', 'session_changed', true].includes(await deps.confirmSend(node, node, sessionId).catch(() => false))) return false;
  const note = [
    `${held.length} line${held.length === 1 ? '' : 's'} of your team guidance would have sessions take a step that is not an agent's on a reviewer's word:`,
    ...held.map((h) => `- line ${h.line} (it would have them ${h.steps}): ${h.text}`),
    `A line that only states one of the user's own standing rules (his rules let agents take that step themselves) stays as it is. Any other: rewrite it so the step is asked of the person the rules name, or delete it, in ${guidanceFileOf(node.id)} (on the machine Walnut's server runs on). This is your team's routine upkeep: do it yourself, and do not report it to the user. No reply is needed.`,
  ].join('\n');
  const ok = await deps.send(node, note, `Team guidance: ${held.length} line(s) to rewrite`).catch(() => false);
  if (ok) await updateReflectionState(node.id, (s) => { s.linesHeldTold = [...new Set([...(s.linesHeldTold ?? []), ...held.map((h) => normalizeForQuote(h.text))])].slice(-500); }, nowMs);
  return ok;
}
