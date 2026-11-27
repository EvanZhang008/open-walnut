/**
 * The team guidance follows the user's standing rules (USER.md): when his rules gain a line or say
 * something new in a reworded one, the guidance lines the reflection wrote that the new rule overrules
 * are named to the node itself, which edits or deletes them (2026-11-21: the user wrote "ship Walnut
 * changes without asking me" into his rules, while a VP's guidance still told every session that a
 * change to a screen he uses waits for his own yes). A line the node deletes is never written again
 * (pipeline.ts rememberDeletedGuidance), and the judge is told a lesson never goes against his rules.
 *
 * The reflection never rewrites a line itself: a real model given his reworded rules as "new" rewrote a
 * safety line about real accounts into its opposite in 4 runs of 4, past every check (2026-11-21
 * review). The node reads the flag with the work's context and decides. Only what a rule newly says is
 * grounds: a reworded rule is shown as WAS and NOW, and the quoted rule must hold a word NOW adds.
 */
import type { Task } from '../../types.js';
import { log } from '../../../logging/index.js';
import { normalizeForQuote, quoteHolds, type CallModel } from './judge.js';
import { sessionNowOf } from './candidates.js';
import { guidanceFileOf, readGuidanceStrict } from './records.js';
import { localDate, readReflectionState, updateReflectionState } from './state.js';
import { contentTokens, kept, reflectionsOwn } from './guidance-merge.js';

/** Flag calls a node may spend a day. */
export const ALIGN_CALLS_PER_DAY_MAX = 6;
/** A new rule line this close to an old one (share of its words) is that rule reworded. */
export const REWORD_MIN = 0.5;

export const ALIGN_SYSTEM = [
  'You keep a team\'s guidance: short rules, one a line, that every session of the team reads. The user\'s own standing rules always win over a guidance line, and he just changed some of them (CHANGES: a NOW line is new; a WAS/NOW pair is a rule he reworded, and only what NOW says that WAS did not is new).',
  'Find each numbered line that tells sessions to do something the NEW part of a change now says otherwise (it asks him what the new rule says agents decide, or lets agents decide what the new rule keeps for him, or any other contradiction of what is new). A line that agrees with what is new, or that only something unchanged contradicts, is no conflict. Never flag a line for a wording you would prefer.',
  'For each conflict give: "line" (its number), "rule_quote" (the words of the NOW line it contradicts, copied exactly, holding what is new), and "why" (one sentence).',
  'Answer one JSON object and nothing else: {"conflicts":[{"line":<number>,"rule_quote":"...","why":"..."}]}, an empty list when there is none.',
].join('\n');

export interface RuleChange { now: string; was?: string }
export interface AlignFlag { line: number; text: string; rule: string; why: string }

const ruleKey = (line: string): string => normalizeForQuote(line.replace(/^\s*[-*]\s+/, ''));

/** His rules as lines worth comparing: no headings, no blank or tiny lines. Pure. */
export function rulesLines(text: string): string[] {
  return [...new Set(text.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter((l) => ruleKey(l).length >= 8))];
}

/** The lines his rules gained, each paired with the old line it rewords when there is one. Pure. */
export function ruleChanges(before: readonly string[], now: readonly string[]): RuleChange[] {
  const known = new Set(before.map(ruleKey));
  return now.filter((l) => !known.has(ruleKey(l))).map((l) => {
    let best: { was: string; k: number } | undefined;
    for (const b of before) { const k = kept(b, l); if (k >= REWORD_MIN && (!best || k > best.k)) best = { was: b, k }; }
    return best ? { now: l, was: best.was } : { now: l };
  });
}

export function alignPrompt(changes: readonly RuleChange[], lines: readonly string[], own: ReadonlySet<number>): string {
  return [
    'CHANGES:', ...changes.map((c) => (c.was ? `WAS: ${c.was}\nNOW: ${c.now}` : `NOW: ${c.now}`)),
    '', 'THE LINES:', ...lines.map((l, i) => `${i + 1}. ${l}${own.has(i + 1) ? ' (the user\'s own: never flag)' : ''}`),
  ].join('\n');
}

/** The answer read and checked: a line the reflection wrote, a quote from a NOW line holding a word that line adds. Pure. */
export function readAlign(raw: string, lines: readonly string[], check: ReadonlySet<number>, changes: readonly RuleChange[]): AlignFlag[] {
  let a: { conflicts?: unknown };
  try { a = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { return []; }
  const out: AlignFlag[] = [];
  for (const c of Array.isArray(a.conflicts) ? a.conflicts as Array<Record<string, unknown>> : []) {
    const n = Number(c.line);
    const rule = typeof c.rule_quote === 'string' ? c.rule_quote.trim() : '';
    if (!check.has(n) || out.some((x) => x.line === n) || !rule) continue;
    const from = changes.find((ch) => quoteHolds(rule, ch.now));
    if (!from) continue;
    // A reworded rule is ground only through what it adds: the quote holds a word WAS did not have.
    if (from.was) {
      const was = contentTokens(from.was);
      if (![...contentTokens(rule)].some((t) => !was.has(t))) continue;
    }
    out.push({ line: n, text: lines[n - 1], rule, why: typeof c.why === 'string' ? c.why.trim().slice(0, 300) : '' });
  }
  return out;
}

export function flagNote(file: string, flags: readonly AlignFlag[]): string {
  return [
    'The user\'s standing rules (USER.md) changed, and these lines of your team guidance now go against them:',
    ...flags.map((f) => `- line ${f.line}: "${f.text}"\n  his rule now: "${f.rule}"${f.why ? `\n  ${f.why}` : ''}`),
    `Edit or delete them in ${file} so they agree with his rule, keeping what still holds (a safety step stays unless his rule plainly lifts it). The file is on the machine Walnut's server runs on: from a session on another host, edit it there (host_exec on __local__), never a copy of your own. A line you delete is never written again. Nothing to do for a flag that is wrong: leave the line.`,
  ].join('\n');
}

export interface AlignDeps {
  callModel: CallModel;
  userRules?: () => Promise<string>;
  send: (task: Task, text: string, title: string) => Promise<boolean>;
  /** Checked right before the send (pipeline.ts): the node's switch still on, the org on. */
  confirmSend?: (node: Task, task: Task, sessionId: string) => Promise<boolean | string>;
  currentSession?: (task: Task) => Promise<string>;
}

/**
 * One look at the guidance against what his rules newly say since the last look; the flags it sent
 * to the node. The first look only learns his rules. A read much shorter than the last (a sync
 * mid-write) is skipped once, so his whole file never reads as new; read the same twice, it holds.
 */
export async function alignGuidance(node: Task, nodeName: string, deps: AlignDeps, nowMs: number): Promise<AlignFlag[]> {
  const text = (await deps.userRules?.().catch(() => ''))?.trim() ?? '';
  if (!text) return [];
  const now = rulesLines(text);
  const state = await readReflectionState(node.id, nowMs);
  const keep = () => updateReflectionState(node.id, (s) => { s.aligned = { rules: now }; }, nowMs);
  const before = state.aligned?.rules;
  if (!before) { await keep(); return []; }
  // A read under half the last (a sync mid-write) waits; the same short file twice in a row is his real file.
  if (now.length < before.length / 2 && state.aligned?.short !== now.length) {
    await updateReflectionState(node.id, (s) => { if (s.aligned) s.aligned.short = now.length; }, nowMs);
    log.task.warn('reflection: the user\'s rules read much shorter than before; taken as they are if the next pass reads the same', { nodeId: node.id, before: before.length, now: now.length });
    return [];
  }
  const changes = ruleChanges(before, now);
  const file = await readGuidanceStrict(node.id);
  if (!file) return [];
  const written = new Set(state.written);
  // Only the reflection's own lines (a source note, or remembered as written) are flagged.
  const check = new Set(file.flatMap((l, i) => (reflectionsOwn(l, written) ? [i + 1] : [])));
  if (!changes.length || !check.size) { await keep(); return []; }
  const date = localDate(nowMs);
  const took = await updateReflectionState(node.id, (s) => {
    const m = s.aligns?.date === date ? s.aligns : { date, count: 0 };
    if (m.count >= ALIGN_CALLS_PER_DAY_MAX) return false;
    s.aligns = { date, count: m.count + 1 };
    return true;
  }, nowMs);
  if (!took) return [];
  const lines = file.map((l) => l.text);
  const own = new Set(lines.map((_, i) => i + 1).filter((i) => !check.has(i)));
  let raw: string;
  try { raw = await deps.callModel(ALIGN_SYSTEM, alignPrompt(changes, lines, own), node.id); } catch (err) {
    // His changes stay new: the next pass asks again.
    log.task.warn('reflection: guidance not checked against the user\'s changed rules', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
  const flags = readAlign(raw, lines, check, changes);
  const sessionId = await sessionNowOf(node, deps);
  if (flags.length && deps.confirmSend && !['ok', 'session_changed', true].includes(await deps.confirmSend(node, node, sessionId).catch(() => false))) return [];
  if (flags.length && !(await deps.send(node, flagNote(guidanceFileOf(node.id), flags), `Team guidance: ${flags.length} line(s) against the user's changed rules`).catch(() => false))) return [];
  await updateReflectionState(node.id, (s) => {
    s.aligned = { rules: now };
    if (flags.length) s.alignLog = [...(s.alignLog ?? []), ...flags.map((f) => ({ at: new Date(nowMs).toISOString(), line: f.text, rule: f.rule }))].slice(-50);
  }, nowMs);
  if (flags.length) log.task.info('reflection: guidance lines flagged against the user\'s changed rules', { nodeId: node.id, nodeName, flags: flags.length });
  return flags;
}
