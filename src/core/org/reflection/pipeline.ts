/**
 * One node's reflection pass (runner.ts runs it every few minutes for each node with the switch
 * on): find the candidates in its team's new messages, threads and asks (candidates.ts), judge each
 * one (judge.ts) within the day's budget (the language check needs no judge, language.ts), and for
 * each real bad decision correct the session, add the team guidance line, write the skill when the
 * lesson needs steps, and record the day with the rule it became and the task it went to (records.ts).
 *
 * Only new messages: anything older than the node's `since` (the first pass after the switch went
 * on) is never looked at, and each candidate is judged once (state.ts `seen`). Every effect is a
 * dependency, so a replay of a real conversation runs the same code with no send.
 */
import fsp from 'node:fs/promises';
import type { Task } from '../../types.js';
import { log } from '../../../logging/index.js';
import { judge, callModelDefault, normalizeForQuote, PRODUCT_DEFECT_KINDS, type CallModel, type Finding, type JudgeInput, type Verdict } from './judge.js';
import { readTranscriptDefault, renderTurns, splitCardAnswers, turnsAround, turnsSince, type TurnText } from './context.js';
import { parseCardAnswer, type ReflectionSignal, type SpokenMessage } from './signals.js';
import { addGuidance, appendDayEntry, appendDayNote, dayNoteSaid, deletedSince, nearlySame, recordDayPass, readGuidance, readGuidanceStrict, writeFindingSkill, type DayEntry, type DayRule } from './records.js';
import { CARD_CORRECTION_GAP_MS, CARD_CORRECTIONS_MAX, claimCandidate, dailyCallsMax, DAILY_CALLS_RESERVED, localDate, markSeen, readReflectionState, recordBudgetLeft, takeChatSend, takeSkillWrite, updateReflectionState } from './state.js';
import { screenSkillWrite } from '../../memory-safety.js';
import { managedTasks } from './team.js';
import { collectCandidates, sessionNowOf, type Candidate, type CandidateDeps } from './candidates.js';
import { LANGUAGE_GUIDANCE, measureLanguage } from './language.js';
import { messagesFromAsks, rulesTextOf, threadsFromRecords } from './inputs.js';
import { PAIN_TITLES_FOR_JUDGE } from './pains.js';
import { readPains } from './pains-store.js';
import { backfillDropped, mergeGuidance, type MergeDeps } from './guidance-merge.js';
import { alignGuidance } from './guidance-align.js';
import { recordPain } from './pain-record.js';

export { ANSWER_GRACE_MS, MOMENT_MAX_AGE_MS, type Candidate } from './candidates.js';
export { nearlySame } from './records.js';
import { MOMENT_MAX_AGE_MS } from './candidates.js';
import { askTidy, tellHeldLines } from './guidance-tidy.js';
import { gatedPoint, heldPoint, holdCorrection, sendHeld } from './held-corrections.js';
import { compactGuidance } from './guidance-compact.js';
import { cardStillLacks, datedQuoteLine, handledSince, oldMomentLine, STALE_MOMENT_MS, quoteTimeOf, type AskNow, type LetterText, type TaskOutcome } from './moment-age.js';
import { checkCached, checkStepOf, findingInstruction, gatedNote, gateText, resetForGateVersion, STEP_CHECK_FAILED, STEP_CHECK_HELD, stepWords, verdictOf as stepVerdict, type GateResult, type StepCheck } from './step-gate.js';

/** The session's text turns read before the moment: anger is often about a run of turns, not the last one. */
const TURNS_BEFORE: Record<ReflectionSignal, number> = {
  frustration: 10, overruled: 4, many_rounds: 3, needs_ask: 4, not_for_user: 4, unclear_ask: 2, unreviewed_design: 4, regression: 6, built_different: 6, duplicate_display: 4, wrong_language: 0,
};

export type SendCorrection = (task: Task, text: string, title: string) => Promise<boolean>;

/** Checked again right before a send: the switch still on, the task still the node's (or the node itself), open, and on the session judged. */
/**
 * Whether a correction may go now: true, or why not (SendCheck). A task still open whose session
 * changed since the turn judged (a new chat, an engine switch, a restart) gets it on its session now,
 * told it is about an earlier session of the task (2026-11-23 audit: 16 of 23 corrections of a day
 * were "not sent", most for a session that had changed, and the record never said why).
 */
export type SendCheck = 'ok' | 'session_changed' | 'no_session' | 'task_done' | 'not_managed' | 'duty_off' | 'org_off' | 'gone';
export type ConfirmSend = (node: Task, task: Task, sessionId: string) => Promise<boolean | SendCheck>;
/** A check's answer as one SendCheck: true is ok, false a refusal of unknown cause. */
export const sendCheckOf = (v: boolean | SendCheck): SendCheck | 'off' => (v === true ? 'ok' : v === false ? 'off' : v);

export interface ReflectDeps extends CandidateDeps {
  callModel: CallModel;
  send: SendCorrection;
  confirmSend: ConfirmSend;
  rulesText: (node: Task) => Promise<string>;
  /** The user's standing rules alone (USER.md): the guidance is kept in line with them (guidance-align.ts). */
  userRules?: () => Promise<string>;
  /** The step check's model layer (step-gate.ts); without it only its fixed words hold a text. defaultDeps always sets it. */
  checkStep?: StepCheck;
  /** A thread's task as it stands now, for the check that an old moment was handled since (moment-age.ts). */
  taskOutcome?: TaskOutcome;
  /** A task's ask now and a letter's text, for the check that a card has what a correction says it lacks. */
  askNow?: AskNow;
  letterText?: LetterText;
}

export interface ReflectResult {
  candidates: number;
  judged: number;
  /** Candidates the spent judge budget left unjudged this pass (state.ts recordBudgetLeft: today's kept for a later pass, an earlier day's dropped). */
  skipped: number;
  findings: Array<{ candidate: Candidate; verdict: Verdict; entry?: DayEntry }>;
}

/** Free text the judge wrote that goes on to a session or a file: refused whole when the injection screen stops it. */
function unsafeText(f: Finding): string | null {
  return screenSkillWrite([f.correction, f.guidance, f.skill?.description ?? '', f.skill?.text ?? ''].join('\n\n'), 'reflection finding');
}

function correctionText(node: Task, nodeName: string, c: Candidate, f: Finding, said: { at: string; momentAt: string }, nowMs: number, where: 'recent' | 'earlier' | 'task' = 'recent'): string {
  // A thread's title is free text someone wrote: it rides a correction only when the injection screen passes it.
  const title = c.thread && !screenSkillWrite(c.thread.title, 'reflection thread title') ? c.thread.title : '';
  return [
    `${nodeName}'s reflection looked at ${where === 'earlier' ? 'a turn of an earlier session of this task' : where === 'task' ? 'a turn of this task' : 'your recent turn'}${c.messages.length ? ' and the user\'s answer to it' : ''}${title ? ` in the thread "${title}"` : c.thread ? ' in a thread' : ''} and found a decision to fix.`,
    '',
    f.correction,
    '',
    `What went wrong: ${f.what_went_wrong}`,
    `The right way: ${f.correct_action}`,
    `You said: "${f.session_quote}"`,
    ...(f.user_quote ? [datedQuoteLine(f.user_quote, said.at, nowMs)] : []),
    ...(f.rule_quote ? [`The rule: "${f.rule_quote}"`] : []),
    // A defect of the product: the task he said it in owns its fix, or hands it to the task that owns that code.
    ...(PRODUCT_DEFECT_KINDS.has(f.kind) ? ['', 'This is a defect of the product: fix it in this task, or hand it to the task that owns that code and say which.'] : []),
    '',
    // Words hours or days old say so: never read as a new ask (2026-11-26, Walnut VP).
    ...(c.messages.length && c.signal !== 'wrong_language' && nowMs - Date.parse(said.momentAt) >= STALE_MOMENT_MS ? ['', oldMomentLine(said.momentAt, nowMs)] : []),
    '',
    `Act on it in this task. No reply to ${nodeName} is needed (task ${node.id}).`,
  ].join('\n');
}

/** What the judge reads for one candidate: its turns (a thread's own, or the session's), the ask and his recent messages. */
export async function judgeInputOf(node: Task, c: Candidate, deps: Pick<ReflectDeps, 'readTranscript' | 'rulesText' | 'replyLanguage'>, guidance: readonly string[]): Promise<JudgeInput> {
  const turns: TurnText[] = c.context ?? splitCardAnswers(
    c.sessionId ? await turnsAround(c.sessionId, c.from, c.to, deps.readTranscript, { turnsBefore: TURNS_BEFORE[c.signal] }).catch(() => []) : []);
  const cardAsks = c.messages.map((m) => parseCardAnswer(m.text)?.ask).filter((a): a is string => !!a);
  // What the session did since the window ends (2026-11-24 audit: judged 6 to 18 hours late, a third of
  // the "not done" findings were done by then): its newest turns, for already_fixed only.
  // A thread message reads the thread's own answers after it, never its node's session, which works on many
  // threads at once (2026-11-24 replay: the session's newest turns were about other threads).
  const seenTo = turns[turns.length - 1]?.at ?? c.to;
  // Mail other agents and Walnut sent the session since, for a thread too: a change withdrawn after the moment
  // arrives that way (11-27 audit: a correction rested on a change withdrawn six minutes before it went out,
  // told the node's session by the task that withdrew it; the judge read only the thread).
  const since = seenTo > c.to ? seenTo : c.to;
  const later = c.context
    ? [...(c.later ?? []).filter((t) => t.at > seenTo), ...(c.sessionId ? await turnsSince(c.sessionId, since, deps.readTranscript, 4, ['agent']).catch(() => []) : [])].sort((a, b) => a.at.localeCompare(b.at))
    : c.sessionId ? await turnsSince(c.sessionId, since, deps.readTranscript, undefined, ['assistant', 'agent']).catch(() => []) : [];
  return {
    signal: c.signal, ...(c.also?.length ? { also: c.also } : {}), taskTitle: c.task.title, ...(c.thread ? { threadTitle: c.thread.title } : {}),
    turnsText: renderTurns(turns), ...(later.length ? { laterText: renderTurns(later) } : {}), momentAt: c.to,
    // The agent's words: its turns, the ask it put to him, the card asks he answered.
    // Quotes are checked against the turns judged: LATER is read for already_fixed, never quoted as the decision.
    sessionText: [...(c.ask?.text ? [c.ask.text] : []), ...cardAsks, ...turns.filter((t) => t.role === 'assistant').map((t) => t.text)].join('\n\n'),
    // What he said up to the moment, and only that: a later message of his is a candidate of its own.
    // His messages are his record even where the transcript clipped them, so they count too.
    // A card answer's ask is the agent's words, never his: only his words are quotable as his.
    userText: [
      ...turns.filter((t) => t.role === 'user' && t.at <= c.to).map((t) => t.text),
      ...c.messages.map((m) => parseCardAnswer(m.text)?.words ?? m.text), ...(c.evidence ?? []).map((m) => m.text),
    ].join('\n\n'),
    saidSources: [...turns.filter((t) => t.role === 'user' && t.at <= c.to), ...c.messages, ...(c.evidence ?? [])].map((m) => ({ at: m.at, text: m.text })),
    ...(c.ask?.text ? { askText: c.ask.text } : {}),
    ...(c.evidence ? { evidenceText: c.evidence.map((m: SpokenMessage) => `[${m.at}] ${m.text}`).join('\n\n') } : {}),
    rulesText: await deps.rulesText(node), guidance, replyLanguage: await deps.replyLanguage(),
    // His complaints already filed, newest first: the judge names the one this is, or a new one.
    pains: (await readPains(node.id)).sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, PAIN_TITLES_FOR_JUDGE).map((e) => ({ id: e.id, title: e.title })),
  };
}

/** The wrong_language finding: fixed words, no model call (language.ts). */
export function languageFinding(c: Candidate, replyLanguage: string | null, guidance: readonly string[]): Finding {
  const answer = c.answer ?? { text: '', at: c.to };
  const m = measureLanguage(answer.text);
  const listed = guidance.findIndex((g) => normalizeForQuote(g) === normalizeForQuote(LANGUAGE_GUIDANCE));
  return {
    kind: 'wrong_language', session_quote: answer.text.slice(0, 160).trim(), user_quote: '', rule_quote: replyLanguage ?? '',
    what_went_wrong: `It answered the user in another language than his reply-language setting names (${m.cjk} Chinese characters in ${m.letters} letters of prose).`,
    correct_action: 'Answer the user in the language his setting names; only code, commands, paths and identifiers stay as they are.',
    already_fixed: false,
    correction: `Your answer to the user at ${answer.at} was not in the language his reply-language setting names ("${replyLanguage ?? ''}"). Write every answer to him in that language from now on; only code, commands, paths and identifiers stay as they are.`,
    guidance: listed >= 0 ? '' : LANGUAGE_GUIDANCE, same_as: listed + 1, skill: null,
  };
}

/** The rule a finding becomes: its guidance line (added, or already listed), its skill, or none and why. */
async function keepRule(node: Task, nodeName: string, c: Candidate, f: Finding, guidance: readonly string[], now: number, deps: MergeDeps): Promise<DayRule> {
  const date = localDate(now);
  const lineOf = async (text: string) => (await readGuidance(node.id)).findIndex((l) => normalizeForQuote(l.text) === normalizeForQuote(text)) + 1;
  let rule: DayRule = f.same_as ? { kind: 'existing', text: guidance[f.same_as - 1] ?? '', line: f.same_as } : { kind: 'none', text: 'no new rule' };
  if (f.guidance && !f.same_as) {
    const state = await readReflectionState(node.id, now);
    const addedToday = (await readGuidance(node.id)).filter((l) => l.date === date).length;
    const added = await addGuidance(node.id, nodeName, { text: f.guidance, from: c.task.title.slice(0, 60), date }, { removed: state.removed, addedToday });
    if (added === 'added') await updateReflectionState(node.id, (s) => { s.written.push(normalizeForQuote(f.guidance)); }, now);
    // A full day or file merges the lesson into the closest line instead (guidance-merge.ts); the record says why when it cannot.
    const merged = added === 'day_full' || added === 'file_full'
      ? await mergeGuidance(node, nodeName, { text: f.guidance, from: c.task.title.slice(0, 60), date }, deps, now).catch((err) => ({ kind: 'failed' as const, why: String(err) }))
      : null;
    rule = added === 'added' ? { kind: 'guidance', text: f.guidance, line: await lineOf(f.guidance) }
      : added === 'known' ? { kind: 'existing', text: f.guidance, line: await lineOf(f.guidance) }
      : merged?.kind === 'merged' ? { kind: 'guidance', text: merged.text, line: merged.line, was: merged.was }
      : merged?.kind === 'same' ? { kind: 'existing', text: merged.text, line: merged.line }
      : { kind: 'none', text: `not added (${added}${merged?.kind === 'failed' ? `; not merged: ${merged.why}` : ''}): ${f.guidance}` };
  }
  if (!f.skill) return rule;
  const wrote = await takeSkillWrite(node.id, now) ? await writeFindingSkill(node.id, nodeName, f.skill) : 'day_full';
  if (wrote === 'written' || wrote === 'exists') {
    return { kind: 'skill', name: f.skill.name, text: `${f.skill.description || f.skill.name}${wrote === 'exists' ? ' (already in the registry)' : ''}`, ...(rule.kind === 'guidance' ? { line: rule.line } : {}) };
  }
  return { ...rule, text: `${rule.text}; skill ${f.skill.name} not written (${wrote === 'day_full' ? 'today\'s skill is written already' : wrote})` };
}

/** The verdict on one candidate: the judge's, or the fixed language finding (no model call). Sends nothing. */
export async function verdictOf(
  node: Task, c: Candidate, deps: Pick<ReflectDeps, 'readTranscript' | 'callModel' | 'rulesText' | 'replyLanguage'>, guidance: readonly string[],
  onInput?: (input: JudgeInput) => void,
): Promise<Verdict> {
  if (c.signal === 'wrong_language') return { verdict: 'bad_decision', finding: languageFinding(c, await deps.replyLanguage(), guidance) };
  const input = await judgeInputOf(node, c, deps, guidance);
  onInput?.(input);
  if (!input.sessionText) return { verdict: 'unverified', why: 'no session turn to read' };
  return judge(input, deps.callModel, node.id);
}


/** Judge one candidate (or check it, for wrong_language) and act on a real finding. */
export async function reflectOnCandidate(
  // What this pass did already: a task id it sent a correction to, `lesson:<task>:<kind>:<text>` a lesson it kept.
  node: Task, nodeName: string, c: Candidate, deps: ReflectDeps, guidance: readonly string[], thisPass: Set<string> = new Set(),
): Promise<{ verdict: Verdict; entry?: DayEntry; again?: boolean }> {
  // The session's newest answer after the moment, before the judge reads: one written while it judged was
  // not read (2026-11-24 audit: a correction went 9 seconds after the session had answered).
  const newestTurn = async () => (c.sessionId && !c.context ? (await turnsSince(c.sessionId, c.to, deps.readTranscript, 1).catch(() => []))[0]?.at ?? '' : '');
  const before = await newestTurn();
  let sources: JudgeInput['saidSources'] = [];
  const verdict = await verdictOf(node, c, deps, guidance, (input) => { sources = input.saidSources ?? []; });
  if (verdict.verdict !== 'bad_decision') return { verdict };
  // It had not answered his message when the judge read, and has now: judged again on the next pass, with
  // that answer (nothing sent or written now; the second judgment sees the answer, so it never loops).
  if (!before && !c.context && (await newestTurn())) return { verdict: { verdict: 'unverified', why: 'the session answered while it was judged: judged again on the next pass' }, again: true };
  const f = verdict.finding;
  const unsafe = unsafeText(f);
  if (unsafe) return { verdict: { verdict: 'unverified', why: `the finding's text was refused: ${unsafe.slice(0, 160)}` } };
  const now = deps.nowMs();
  // When he wrote what it quotes: the message of his that holds it, wherever the judge read it ('' when none does).
  const saidAt = quoteTimeOf(c, f.user_quote, sources);
  // Old is judged by when the moment ended, never by the words it quotes: a fresh complaint quoting words of
  // days ago is a new ask (review of 57063edbcd); the quote's time is only shown.
  const said = { at: saidAt, momentAt: c.to };
  // The step check, in code (step-gate.ts): an instruction to use his browser, accounts or name, or to write
  // in production or a cloud account, never goes as written; the session gets a note to ask the person its
  // rules name instead, and the lesson that says so is not written (2026-11-25 audit).
  const willSend = !f.already_fixed && !!f.correction;
  // Each text passes the check once (its verdict kept, step-gate.ts checkCached), and only when it would
  // go out: sent now, held for a later send, written as a lesson or skill, or filed as his pain.
  const checkStep = checkStepOf(deps);
  const stepCheck = (text: string) => checkCached(node.id, text, checkStep, now);
  let gated: GateResult | null = null;
  let corrected: DayEntry['corrected'] = 'already_fixed';
  let held: DayEntry['held'];
  let notSent: DayEntry['notSent'];
  const proof: { quote?: string } = {};
  let settledBy: GateResult['settled'];
  let earlierSession = false;
  let checkFailed = false;
  if (willSend) {
    const chat = c.task.org_role === 'main' || c.task.org_role === 'lead';
    // One card or ask: its thread and its decision (or its words); a new decision on the same thread is another.
    // Keyed by its place only (the task and its thread): a card rewritten got a new decision id or words, and
    // so a new key, and one decision was corrected 4 times in 2 hours (2026-11-26 audit).
    const cardKey = c.signal === 'needs_ask' ? `${c.task.id}:${c.thread?.id ?? ''}` : '';
    const cardState = cardKey ? await readReflectionState(node.id, now) : undefined;
    const lastCard = cardKey ? cardState?.cardCorrected?.[cardKey] : undefined;
    const lastCorrection = cardKey ? cardState?.cardCorrection?.[cardKey] : undefined;
    const heSince = (c.evidence ?? []).some((m) => lastCard && m.at > lastCard);
    // No known asking session: the task's current one reads it, told it is about a turn of the task
    // (2026-11-25 audit: two such corrections were never sent nor held, both tasks had live sessions).
    const sessionId = c.sessionId || (c.hold ? await sessionNowOf(c.task, deps).catch(() => '') : '');
    const route = async (): Promise<{ to: 'send'; check: SendCheck } | { to: 'held'; why: NonNullable<DayEntry['held']> } | { to: 'off'; why: NonNullable<DayEntry['notSent']> }> => {
      // The same card corrected a short while ago, with nothing from him since: not again (2026-11-25 audit).
      // Unless the card was rewritten since and still lacks what that correction asked: then once more
      // (11-27 audit: a rewritten card still had no link four hours on, and its second correction was held).
      if (lastCard && now - Date.parse(lastCard) < CARD_CORRECTION_GAP_MS && !heSince) {
        const again = c.to > lastCard && !!lastCorrection && lastCorrection.n < CARD_CORRECTIONS_MAX
          && await cardStillLacks(c, lastCorrection.text, deps, node.id).catch(() => false);
        if (!again) return { to: 'off', why: 'card_corrected' };
      }
      if (!sessionId) return { to: 'held', why: c.hold ?? 'no_session' };
      // One a pass per task: a task's old session and its current one are the same reader now.
      if (thisPass.has(c.task.id)) return { to: 'held', why: 'one_per_pass' };
      const check = sendCheckOf(await deps.confirmSend(node, c.task, sessionId).catch(() => false));
      if (check !== 'ok' && check !== 'session_changed') return { to: 'off', why: check };
      return { to: 'send', check };
    };
    const r = await route();
    // About words hours or days old: what they asked may be done or answered since; then it is not sent.
    // Only for a send now: a held one is checked at its send (held-corrections.ts stillNeeded).
    const handled = r.to === 'send' ? await handledSince(c, f, said.momentAt, now, deps, node.id, proof).catch(() => 'unknown' as const) : 'open';
    if (r.to === 'off') { corrected = 'off'; notSent = r.why; }
    else if (handled === 'handled') { corrected = 'off'; notSent = 'handled_since'; }
    else {
      const g = await stepCheck(findingInstruction(f));
      // No verdict (the check failed): nothing of it goes now; it is held and checked again at its send.
      if (stepVerdict(g) === 'failed') { checkFailed = true; corrected = 'held'; held = 'check_failed'; }
      else {
        if (g.steps.length) gated = g;
        // A step his own rule settled is said in the record with the rule (review of 57063edbcd).
        if (g.settled?.length) settledBy = g.settled;
        if (r.to === 'held') { corrected = 'held'; held = r.why; }
        else if (chat && !(await takeChatSend(c.task.id, now))) { corrected = 'held'; held = 'own_cap'; }
        else {
          thisPass.add(c.task.id);
          const where = r.check === 'session_changed' ? 'earlier' : c.sessionId ? 'recent' : 'task';
          const text = gated ? gatedNote(nodeName, gated.steps, f.session_quote) : correctionText(node, nodeName, c, f, said, now, where);
          const title = gated ? `${nodeName}'s reflection: a step to ask about, not to take` : `${nodeName}'s reflection: ${f.correct_action.slice(0, 120)}`;
          corrected = await deps.send(c.task, text, title).then((ok) => (ok ? 'sent' : 'failed'), () => 'failed' as const);
          if (r.check === 'session_changed') earlierSession = true;
          if (corrected === 'sent' && cardKey) {
            const within = !!lastCard && now - Date.parse(lastCard) < CARD_CORRECTION_GAP_MS;
            await updateReflectionState(node.id, (s) => {
              (s.cardCorrected ??= {})[cardKey] = new Date(now).toISOString();
              (s.cardCorrection ??= {})[cardKey] = { text: f.correction.slice(0, 1500), n: within ? (s.cardCorrection?.[cardKey]?.n ?? 1) + 1 : 1 };
            }, now);
          }
        }
      }
    }
  }
  // A lesson this pass already kept for this task and kind, said again in other words, is not written
  // twice: his several messages about one thing are one lesson (2026-11-23 audit: one complaint judged
  // 4 times wrote 4 nearly equal lessons). A different lesson of the same kind is kept as usual.
  const lessonText = f.guidance || f.skill?.name || '';
  const lessonPrefix = `lesson:${c.task.id}:${f.kind}:`;
  const twin = lessonText ? [...thisPass].find((k) => k.startsWith(lessonPrefix) && nearlySame(k.slice(lessonPrefix.length), lessonText)) : undefined;
  // The lesson and the skill are checked before they are written, a skill even when its line is listed already.
  const lessonBody = [f.same_as ? '' : f.guidance, f.skill ? [f.skill.name, f.skill.description, f.skill.text].join('\n') : ''].filter(Boolean).join('\n\n');
  const lessonGate = gated ?? (lessonBody && !twin ? await stepCheck(lessonBody) : null);
  // The lesson's own pass by his rule is recorded too (11-27 audit: settledBy was never written).
  if (lessonGate?.settled?.length && lessonGate !== gated) settledBy = [...(settledBy ?? []), ...lessonGate.settled];
  const lessonVerdict = lessonGate ? stepVerdict(lessonGate) : 'pass';
  const rule: DayRule = lessonVerdict === 'held'
    // Kept as a dropped lesson: the backfill rewrites one with his own words to ask first (guidance-merge.ts).
    // (the backfill reads its words from the finding: the record never repeats the held text).
    ? { kind: 'none', text: f.guidance && !f.same_as ? `not added (${STEP_CHECK_HELD}: it would have sessions ${stepWords(lessonGate!.steps)})` : `not added (the step check held it: it would have sessions ${stepWords(lessonGate!.steps)})` }
    // No verdict now: kept as a dropped lesson, so the backfill takes it up (and checks it) later.
    : lessonVerdict === 'failed' && f.guidance && !f.same_as ? { kind: 'none', text: `not added (${STEP_CHECK_FAILED}): ${f.guidance}` }
    : twin
      ? { kind: 'none', text: `not added (same lesson as an earlier finding on this task this pass): ${lessonText}` }
      : lessonVerdict === 'failed' ? { kind: 'none', text: `no rule written now (${STEP_CHECK_FAILED})` }
      : await keepRule(node, nodeName, c, f, guidance, now, deps);
  if (lessonText && lessonVerdict === 'pass') thisPass.add(lessonPrefix + lessonText);
  const entry: DayEntry = {
    at: new Date(now).toISOString(), signal: c.signal, task: { id: c.task.id, title: c.task.title }, ...(c.thread ? { thread: c.thread } : {}),
    finding: f, ...(saidAt ? { saidAt } : {}), corrected, ...(held ? { held } : {}), ...(notSent ? { notSent } : {}), ...(notSent === 'handled_since' && proof.quote ? { handledQuote: proof.quote } : {}), ...(earlierSession ? { earlierSession } : {}),
    ...(gated ? { gated: { steps: [...gated.steps], why: gated.why, by: gated.by } } : {}),
    ...(settledBy ? { settledBy } : {}),
    rule, ...(corrected === 'sent' ? { handedTo: { taskId: c.task.id, title: c.task.title } } : {}),
  };
  // His complaint goes to the pain registry too (pains.ts): never for an ask he has not answered.
  if (f.user_quote && c.messages.length) {
    // Its cause is filed only when it passes the check: otherwise it says that a step was held back.
    const causeOk = !gated && stepVerdict(await stepCheck(f.what_went_wrong)) === 'pass';
    const painOf = causeOk ? f : { ...f, what_went_wrong: '(not filed here: the step check held back the fix it implied, or could not check it)' };
    const pain = await recordPain(node, nodeName, c, painOf, rule, now).catch((err) => {
      log.task.warn('reflection: pain not recorded', { nodeId: node.id, taskId: c.task.id, error: err instanceof Error ? err.message : String(err) });
      return undefined;
    });
    if (pain) entry.pain = pain;
  }
  await appendDayEntry(node.id, nodeName, localDate(now), entry);
  // Every hold waits for the task's next send, with the others held for it. A held one keeps only the
  // check's note when the check held its instruction; one not checked yet is checked at its send.
  if (held) {
    const text = gated ? gatedPoint(gated.steps) : heldPoint(f, saidAt);
    await holdCorrection(node, nodeName, c.task.title, { taskId: c.task.id, at: entry.at, date: localDate(now), entryAt: entry.at, text, saidAt, ...(checkFailed ? {} : { checked: true as const }) }, now)
      .catch((err) => log.task.warn('reflection: a held correction was not kept', { nodeId: node.id, taskId: c.task.id, error: err instanceof Error ? err.message : String(err) }));
  }
  return { verdict, entry };
}

/** When the switch was last turned on: a message before it is never judged, a switch off and on again included. */
export function reflectionSince(node: Task, stateSince: string): string {
  const at = node.org_duties?.reflection?.on ? node.org_duties.reflection.at : undefined;
  return at && at > stateSince ? at : stateSince;
}

/** One pass for one node. `all` is every task the org reads. */
export async function reflectForNode(node: Task, nodeName: string, all: readonly Task[], deps: ReflectDeps): Promise<ReflectResult> {
  const now = deps.nowMs();
  // A guidance line the user deleted is remembered first, so it is never written again.
  await rememberDeletedGuidance(node.id, now);
  // The step check's rules changed: what it held is judged again by the new ones.
  await resetForGateVersion(node.id, now);
  // Read and kept in one write: a node seen for the first time keeps the `since` of this pass, never
  // a new "now" at every pass (2026-11-19 on production: a node with no guidance file saved nothing).
  const state = await updateReflectionState(node.id, (s) => { s.callsFrom ??= new Date(now).toISOString(); return structuredClone(s); }, now);
  const callsMax = dailyCallsMax(state.callsFrom, now);
  const since = reflectionSince(node, state.since);
  const lines = await readGuidance(node.id);
  const result: ReflectResult = { candidates: 0, judged: 0, skipped: 0, findings: [] };
  const { candidates, quiet } = await collectCandidates(node, all, since, new Set(Object.keys(state.seen)), deps);
  await markSeen(node.id, quiet, 'no_signal', now);
  result.candidates = candidates.length;
  // The spent budget's leftovers: today's moments (left for a later pass) and an earlier day's (dropped).
  const left: string[] = [];
  const dropped: string[] = [];
  const today = localDate(now);
  const thisPass = new Set<string>();
  // Newest first: when the budget runs out, what is left is the oldest, the least worth correcting.
  for (const c of candidates.sort((a, b) => b.to.localeCompare(a.to))) {
    // The language check calls no model: it spends nothing of the day's budget. Anger and long
    // talks alone never take the day's last calls: those stay for the asks, defects and words that
    // say a question was not his (11-20: 120 angry messages would have spent the day by noon).
    const max = c.signal === 'frustration' || c.signal === 'many_rounds' ? callsMax - DAILY_CALLS_RESERVED : callsMax;
    const claim = await claimCandidate(node.id, c.key, now, max, { free: c.signal === 'wrong_language' });
    // Left for a later pass (today or the next days) while it can still be judged then; only a moment
    // that will be past MOMENT_MAX_AGE_MS by tomorrow's budget is dropped.
    if (claim === 'budget') { (Date.parse(c.to) < now - (MOMENT_MAX_AGE_MS - 24 * 3600_000) ? dropped : left).push(c.key); continue; }
    if (claim === 'seen') continue;
    result.judged++;
    let out: { verdict: Verdict; entry?: DayEntry; again?: boolean };
    try {
      out = await reflectOnCandidate(node, nodeName, c, deps, lines.map((l) => l.text), thisPass);
    } catch (err) {
      // Claimed already: a failure is never judged (or sent) again.
      out = { verdict: { verdict: 'unverified', why: `the step failed: ${err instanceof Error ? err.message : String(err)}` } };
    }
    await updateReflectionState(node.id, (s) => {
      if (out.again) delete s.seen[c.key];
      else s.seen[c.key] = { at: new Date(now).toISOString(), verdict: out.verdict.verdict };
    }, now);
    log.task.info('reflection: judged', { nodeId: node.id, taskId: c.task.id, signal: c.signal, verdict: out.verdict.verdict, ...(out.verdict.verdict !== 'bad_decision' ? { why: out.verdict.why.slice(0, 200) } : {}) });
    result.findings.push({ candidate: c, verdict: out.verdict, ...(out.entry ? { entry: out.entry } : {}) });
  }
  if (left.length || dropped.length) {
    // Never dropped unsaid: the ones that can wait stay unseen for a later pass; the rest are marked
    // seen and counted as dropped. Both are logged and said in the day's record.
    result.skipped = left.length + dropped.length;
    const { count: leftToday, first } = await recordBudgetLeft(node.id, left, dropped, now);
    log.task.info('reflection: the day\'s judge budget is spent', { nodeId: node.id, leftForLater: left.length, dropped: dropped.length, leftToday });
    // Said in the day's record, which the audit and the nightly note read: once a day, and for each drop.
    // Read from the record, not only the state's flag: a flag an older build spent left a day unsaid (2026-11-24 audit).
    if (first || dropped.length || !(await dayNoteSaid(node.id, today, 'Judge budget'))) {
      const used = (await readReflectionState(node.id, now)).day.calls;
      const kind = used < callsMax ? `the judge calls anger and long talks may use (${used} of ${callsMax}; the last ${DAILY_CALLS_RESERVED} are kept for asks and defects)` : `the day's ${callsMax} judge calls`;
      await appendDayNote(node.id, nodeName, today, `Judge budget: ${kind} were spent at ${new Date(now).toISOString().slice(11, 16)} UTC; ${left.length} moment${left.length === 1 ? '' : 's'} wait for a later pass${dropped.length ? `, ${dropped.length} too old to wait were dropped unjudged` : ''}.`, now)
        .catch(() => {});
    }
  }
  // What was held for a later send goes now where it may: one message per task.
  await sendHeld(node, nodeName, all, thisPass, deps, now).catch((err) => log.task.warn('reflection: held corrections not sent', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) }));
  // Every pass is counted in the day's JSON: a node with nothing to judge still shows it ran.
  await recordDayPass(node.id, nodeName, today, { candidates: result.candidates, judged: result.judged, skipped: result.skipped }, now)
    .catch((err) => log.task.warn('reflection: the pass was not counted in the day record', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) }));
  // Lessons a full day dropped are taken up again, a few a pass, after this pass's own findings had their places.
  await backfillDropped(node, nodeName, { ...deps, makeRoom: (n) => compactGuidance(node, nodeName, n, deps, now) }, now).catch((err) => log.task.warn('reflection: dropped lessons not taken up', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) }));
  // A full guidance is the node's to tidy: told once a day which lessons wait for room.
  await askTidy(node, nodeName, deps, now).catch((err) => log.task.warn('reflection: the node was not asked to tidy its guidance', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) }));
  // A line already in the guidance that the step check holds is named to the node, once each.
  await tellHeldLines(node, nodeName, deps, now).catch((err) => log.task.warn('reflection: held guidance lines not named', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) }));
  // Last: every line, new ones included, agrees with the user's standing rules as they are now.
  await alignGuidance(node, nodeName, deps, now).catch((err) => log.task.warn('reflection: guidance not aligned with the user\'s rules', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) }));
  return result;
}

/** Lines the reflection wrote that the file no longer has were deleted by someone: they go to `removed`. */
export async function rememberDeletedGuidance(nodeId: string, nowMs: number): Promise<void> {
  // A file that cannot be read now (gone mid-sync, a lock) says nothing about what the user deleted.
  const lines = await readGuidanceStrict(nodeId);
  if (!lines) return;
  await updateReflectionState(nodeId, (s) => {
    for (const k of deletedSince(s.written, lines)) {
      if (!s.removed.includes(k)) s.removed.push(k);
      // The lessons merged into a deleted line went with it: they are not written again either.
      for (const m of s.mergedLessons ?? []) if (m.line === k && !s.removed.includes(m.lesson)) s.removed.push(m.lesson);
      s.mergedLessons = (s.mergedLessons ?? []).filter((m) => m.line !== k);
    }
    s.written = s.written.filter((k) => !s.removed.includes(k));
  }, nowMs);
}

/** What confirmSend reads, so its rules are tested without a server. */
export interface ConfirmLookups {
  getTask: (id: string) => Promise<Task | null>; orgTasks: () => Promise<Task[]>; orgEnabled: () => Promise<boolean>; dutyOn: (t: Task, id: string) => boolean;
  /** The session a send reaches now (session-send-core.ts currentSessionOfTask). */
  currentSession?: (t: Task) => Promise<string>;
}

/**
 * Right before a send: the node's switch and the org on, the task open, still on the session judged,
 * and the node itself (a correction about its own thread answers) or a task of its team.
 */
export async function confirmSendCheck(node: Task, task: Task, sessionId: string, look: ConfirmLookups): Promise<SendCheck> {
  const [n, t] = await Promise.all([look.getTask(node.id).catch(() => null), look.getTask(task.id).catch(() => null)]);
  if (!n || !t) return 'gone';
  if (!look.dutyOn(n, 'reflection')) return 'duty_off';
  if (t.phase === 'COMPLETE') return 'task_done';
  if (!(await look.orgEnabled())) return 'org_off';
  if (t.id !== n.id && !managedTasks(n, await look.orgTasks()).some((x) => x.id === t.id)) return 'not_managed';
  const current = await sessionNowOf(t, look);
  if (!sessionId || !current) return 'no_session';
  return current === sessionId ? 'ok' : 'session_changed';
}

const currentSessionDefault = async (t: Task): Promise<string> =>
  (await import('../../sessions/session-send-core.js')).currentSessionOfTask(t);

/** The real dependencies. */
export function defaultDeps(): ReflectDeps {
  return {
    readTranscript: readTranscriptDefault,
    callModel: callModelDefault(),
    // His standing rules ride the check: a sign-in they tell agents to do themselves is not held (step-gate.ts).
    checkStep: async (text, nodeId) => {
      const { USER_FILE } = await import('../../../constants.js');
      return gateText(text, callModelDefault(), nodeId, await fsp.readFile(USER_FILE, 'utf-8').catch(() => ''));
    },
    send: async (task, text, title) => {
      const { performSessionSend } = await import('../../sessions/session-send-core.js');
      const { getTask } = await import('../../task-manager.js');
      // Read again: a task finished since the pass began is never reopened by a correction.
      if ((await getTask(task.id).catch(() => null))?.phase === 'COMPLETE') return false;
      await performSessionSend({ to: task.id, text, title, source: 'org-reflection', expectReply: false });
      return true;
    },
    confirmSend: async (node, task, sessionId) => {
      const [{ getTask }, { dutyOn }, { orgTasks }, { isOrgEnabled }] = await Promise.all([
        import('../../task-manager.js'), import('../duties/node-duties.js'), import('../org-store.js'), import('../org-enabled.js'),
      ]);
      return confirmSendCheck(node, task, sessionId, { getTask: async (id) => (await getTask(id)) ?? null, orgTasks, orgEnabled: isOrgEnabled, dutyOn, currentSession: currentSessionDefault });
    },
    currentSession: currentSessionDefault,
    askNow: async (id) => {
      const { getTask } = await import('../../task-manager.js');
      const t = await getTask(id);
      return t ? t.user_status ?? null : null;
    },
    letterText: async (id) => {
      const { getLetter } = await import('../../human-inbox/store.js');
      const l = await getLetter(id);
      if (!l) return null;
      const actions = (l.actions ?? []).map((a) => `[${a.label}${a.recommended ? ' (recommended)' : ''}]`).join(' ');
      return [`Subject: ${l.subject}`, l.body ?? l.textPreview, actions ? `Buttons: ${actions}` : ''].filter(Boolean).join('\n');
    },
    taskOutcome: async (id) => {
      const { getTask } = await import('../../task-manager.js');
      const t = await getTask(id).catch(() => null);
      return t ? { id: t.id, title: t.title, phase: t.phase, summary: t.summary } : null;
    },
    sessionAt: async (t, at) => (await import('../../sessions/session-send-core.js')).sessionOfTaskAt(t.id, at),
    readThreads: async (taskId) => {
      const { readThreads } = await import('../threads-store.js');
      return threadsFromRecords((await readThreads(taskId)).threads);
    },
    readMessages: async (taskId) => {
      const { readUserAsks } = await import('../../sessions/user-asks.js');
      return messagesFromAsks((await readUserAsks(taskId)).asks);
    },
    rulesText: async (node) => {
      const { USER_FILE } = await import('../../../constants.js');
      const { readNodeMemory } = await import('../../artifacts/node-memory.js');
      return rulesTextOf(await fsp.readFile(USER_FILE, 'utf-8').catch(() => ''), (await readNodeMemory(node.id).catch(() => undefined))?.text ?? '');
    },
    userRules: async () => {
      const { USER_FILE } = await import('../../../constants.js');
      return fsp.readFile(USER_FILE, 'utf-8').catch(() => '');
    },
    replyLanguage: async () => {
      const [{ getConfig }, { replyLanguageText }] = await Promise.all([import('../../config-manager.js'), import('../../sessions/output-mode.js')]);
      return replyLanguageText(await getConfig());
    },
    nowMs: () => Date.now(),
  };
}
