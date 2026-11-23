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
import { readTranscriptDefault, renderTurns, splitCardAnswers, turnsAround, type TurnText } from './context.js';
import { parseCardAnswer, type ReflectionSignal, type SpokenMessage } from './signals.js';
import { addGuidance, appendDayEntry, appendDayNote, deletedSince, readGuidance, readGuidanceStrict, writeFindingSkill, type DayEntry, type DayRule } from './records.js';
import { claimCandidate, dailyCallsMax, DAILY_CALLS_RESERVED, localDate, markSeen, readReflectionState, recordBudgetLeft, takeChatSend, takeSkillWrite, updateReflectionState } from './state.js';
import { screenSkillWrite } from '../../memory-safety.js';
import { managedTasks } from './team.js';
import { collectCandidates, type Candidate, type CandidateDeps } from './candidates.js';
import { LANGUAGE_GUIDANCE, measureLanguage } from './language.js';
import { messagesFromAsks, rulesTextOf, threadsFromRecords } from './inputs.js';
import { PAIN_TITLES_FOR_JUDGE } from './pains.js';
import { readPains } from './pains-store.js';
import { backfillDropped, mergeGuidance, type MergeDeps } from './guidance-merge.js';
import { alignGuidance } from './guidance-align.js';
import { recordPain } from './pain-record.js';

export { ANSWER_GRACE_MS, MOMENT_MAX_AGE_MS, type Candidate } from './candidates.js';
import { MOMENT_MAX_AGE_MS } from './candidates.js';
import { askTidy } from './guidance-tidy.js';

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

function correctionText(node: Task, nodeName: string, c: Candidate, f: Finding, earlier = false): string {
  // A thread's title is free text someone wrote: it rides a correction only when the injection screen passes it.
  const title = c.thread && !screenSkillWrite(c.thread.title, 'reflection thread title') ? c.thread.title : '';
  return [
    `${nodeName}'s reflection looked at ${earlier ? 'a turn of an earlier session of this task' : 'your recent turn'}${c.messages.length ? ' and the user\'s answer to it' : ''}${title ? ` in the thread "${title}"` : c.thread ? ' in a thread' : ''} and found a decision to fix.`,
    '',
    f.correction,
    '',
    `What went wrong: ${f.what_went_wrong}`,
    `The right way: ${f.correct_action}`,
    `You said: "${f.session_quote}"`,
    ...(f.user_quote ? [`The user said: "${f.user_quote}"`] : []),
    ...(f.rule_quote ? [`The rule: "${f.rule_quote}"`] : []),
    // A defect of the product: the task he said it in owns its fix, or hands it to the task that owns that code.
    ...(PRODUCT_DEFECT_KINDS.has(f.kind) ? ['', 'This is a defect of the product: fix it in this task, or hand it to the task that owns that code and say which.'] : []),
    '',
    `Act on it in this task. No reply to ${nodeName} is needed (task ${node.id}).`,
  ].join('\n');
}

/** What the judge reads for one candidate: its turns (a thread's own, or the session's), the ask and his recent messages. */
export async function judgeInputOf(node: Task, c: Candidate, deps: Pick<ReflectDeps, 'readTranscript' | 'rulesText' | 'replyLanguage'>, guidance: readonly string[]): Promise<JudgeInput> {
  const turns: TurnText[] = c.context ?? splitCardAnswers(
    c.sessionId ? await turnsAround(c.sessionId, c.from, c.to, deps.readTranscript, { turnsBefore: TURNS_BEFORE[c.signal] }).catch(() => []) : []);
  const cardAsks = c.messages.map((m) => parseCardAnswer(m.text)?.ask).filter((a): a is string => !!a);
  return {
    signal: c.signal, ...(c.also?.length ? { also: c.also } : {}), taskTitle: c.task.title, ...(c.thread ? { threadTitle: c.thread.title } : {}),
    turnsText: renderTurns(turns), momentAt: c.to,
    // The agent's words: its turns, the ask it put to him, the card asks he answered.
    sessionText: [...(c.ask?.text ? [c.ask.text] : []), ...cardAsks, ...turns.filter((t) => t.role === 'assistant').map((t) => t.text)].join('\n\n'),
    // What he said up to the moment, and only that: a later message of his is a candidate of its own.
    // His messages are his record even where the transcript clipped them, so they count too.
    // A card answer's ask is the agent's words, never his: only his words are quotable as his.
    userText: [
      ...turns.filter((t) => t.role === 'user' && t.at <= c.to).map((t) => t.text),
      ...c.messages.map((m) => parseCardAnswer(m.text)?.words ?? m.text), ...(c.evidence ?? []).map((m) => m.text),
    ].join('\n\n'),
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
export async function verdictOf(node: Task, c: Candidate, deps: Pick<ReflectDeps, 'readTranscript' | 'callModel' | 'rulesText' | 'replyLanguage'>, guidance: readonly string[]): Promise<Verdict> {
  if (c.signal === 'wrong_language') return { verdict: 'bad_decision', finding: languageFinding(c, await deps.replyLanguage(), guidance) };
  const input = await judgeInputOf(node, c, deps, guidance);
  if (!input.sessionText) return { verdict: 'unverified', why: 'no session turn to read' };
  return judge(input, deps.callModel, node.id);
}


/** Judge one candidate (or check it, for wrong_language) and act on a real finding. */
export async function reflectOnCandidate(
  node: Task, nodeName: string, c: Candidate, deps: ReflectDeps, guidance: readonly string[], sentThisPass: Set<string> = new Set(),
): Promise<{ verdict: Verdict; entry?: DayEntry }> {
  const verdict = await verdictOf(node, c, deps, guidance);
  if (verdict.verdict !== 'bad_decision') return { verdict };
  const f = verdict.finding;
  const unsafe = unsafeText(f);
  if (unsafe) return { verdict: { verdict: 'unverified', why: `the finding's text was refused: ${unsafe.slice(0, 160)}` } };
  const now = deps.nowMs();
  let corrected: DayEntry['corrected'] = 'already_fixed';
  let held: DayEntry['held'];
  let notSent: DayEntry['notSent'];
  let earlierSession = false;
  if (!f.already_fixed && f.correction) {
    // Held, recorded and in the nightly note only: no known session to send to (an ask whose asking
    // session, or a thread message whose session, is unknown: never the task's current one by
    // default); a session that already got one this pass; past a Main or lead chat's few a day
    // (the user's own chat).
    const chat = c.task.org_role === 'main' || c.task.org_role === 'lead';
    if (c.hold) { corrected = 'held'; held = c.hold; }
    // One a pass per task: a task's old session and its current one are the same reader now.
    else if (sentThisPass.has(c.task.id)) { corrected = 'held'; held = 'one_per_pass'; }
    else {
      const check = sendCheckOf(await deps.confirmSend(node, c.task, c.sessionId).catch(() => false));
      if (check !== 'ok' && check !== 'session_changed') { corrected = 'off'; notSent = check; }
      else if (chat && !(await takeChatSend(c.task.id, now))) { corrected = 'held'; held = 'own_cap'; }
      else {
        sentThisPass.add(c.task.id);
        corrected = await deps.send(c.task, correctionText(node, nodeName, c, f, check === 'session_changed'), `${nodeName}'s reflection: ${f.correct_action.slice(0, 120)}`)
          .then((ok) => (ok ? 'sent' : 'failed'), () => 'failed' as const);
        if (check === 'session_changed') notSent = undefined, earlierSession = true;
      }
    }
  }
  const rule = await keepRule(node, nodeName, c, f, guidance, now, deps);
  const entry: DayEntry = {
    at: new Date(now).toISOString(), signal: c.signal, task: { id: c.task.id, title: c.task.title }, ...(c.thread ? { thread: c.thread } : {}),
    finding: f, corrected, ...(held ? { held } : {}), ...(notSent ? { notSent } : {}), ...(earlierSession ? { earlierSession } : {}), rule, ...(corrected === 'sent' ? { handedTo: { taskId: c.task.id, title: c.task.title } } : {}),
  };
  // His complaint goes to the pain registry too (pains.ts): never for an ask he has not answered.
  if (f.user_quote && c.messages.length) {
    const pain = await recordPain(node, nodeName, c, f, rule, now).catch((err) => {
      log.task.warn('reflection: pain not recorded', { nodeId: node.id, taskId: c.task.id, error: err instanceof Error ? err.message : String(err) });
      return undefined;
    });
    if (pain) entry.pain = pain;
  }
  await appendDayEntry(node.id, nodeName, localDate(now), entry);
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
  const sentThisPass = new Set<string>();
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
    let out: { verdict: Verdict; entry?: DayEntry };
    try {
      out = await reflectOnCandidate(node, nodeName, c, deps, lines.map((l) => l.text), sentThisPass);
    } catch (err) {
      // Claimed already: a failure is never judged (or sent) again.
      out = { verdict: { verdict: 'unverified', why: `the step failed: ${err instanceof Error ? err.message : String(err)}` } };
    }
    await updateReflectionState(node.id, (s) => { s.seen[c.key] = { at: new Date(now).toISOString(), verdict: out.verdict.verdict }; }, now);
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
    if (first || dropped.length) {
      const used = (await readReflectionState(node.id, now)).day.calls;
      const kind = used < callsMax ? `the judge calls anger and long talks may use (${used} of ${callsMax}; the last ${DAILY_CALLS_RESERVED} are kept for asks and defects)` : `the day's ${callsMax} judge calls`;
      await appendDayNote(node.id, nodeName, today, `Judge budget: ${kind} were spent at ${new Date(now).toISOString().slice(11, 16)} UTC; ${left.length} moment${left.length === 1 ? '' : 's'} wait for a later pass${dropped.length ? `, ${dropped.length} too old to wait were dropped unjudged` : ''}.`)
        .catch(() => {});
    }
  }
  // Lessons a full day dropped are taken up again, a few a pass, after this pass's own findings had their places.
  await backfillDropped(node, nodeName, deps, now).catch((err) => log.task.warn('reflection: dropped lessons not taken up', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) }));
  // A full guidance is the node's to tidy: told once a day which lessons wait for room.
  await askTidy(node, nodeName, deps, now).catch((err) => log.task.warn('reflection: the node was not asked to tidy its guidance', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) }));
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
export interface ConfirmLookups { getTask: (id: string) => Promise<Task | null>; orgTasks: () => Promise<Task[]>; orgEnabled: () => Promise<boolean>; dutyOn: (t: Task, id: string) => boolean }

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
  const current = t.session_id ?? t.exec_session_id ?? '';
  if (!sessionId || !current) return 'no_session';
  return current === sessionId ? 'ok' : 'session_changed';
}

/** The real dependencies. */
export function defaultDeps(): ReflectDeps {
  return {
    readTranscript: readTranscriptDefault,
    callModel: callModelDefault(),
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
      return confirmSendCheck(node, task, sessionId, { getTask: async (id) => (await getTask(id)) ?? null, orgTasks, orgEnabled: isOrgEnabled, dutyOn });
    },
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
