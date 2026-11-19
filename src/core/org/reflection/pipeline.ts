/**
 * One node's reflection pass (runner.ts runs it every few minutes for each node with the switch
 * on): find the candidates in its team's new messages (signals.ts), judge each one (judge.ts) within
 * the day's budget, and for each real bad decision correct the session, add the team guidance
 * line, write the skill when the lesson needs steps, and record the day (records.ts).
 *
 * Only new messages: anything older than the node's `since` (the first pass after the switch went
 * on) is never looked at, and each candidate is judged once (state.ts `seen`). Every effect is a
 * dependency, so a replay of a real conversation runs the same code with no send.
 */
import fsp from 'node:fs/promises';
import type { Task } from '../../types.js';
import { log } from '../../../logging/index.js';
import { judge, callModelDefault, type CallModel, type Finding, type JudgeInput, type Verdict } from './judge.js';
import { lastAssistantBefore, readTranscriptDefault, renderTurns, turnsAround, type ReadTranscript, type TurnText } from './context.js';
import { manyRoundWindows, messageSignals, recommends, type ReflectionSignal, type SpokenMessage } from './signals.js';
import { addGuidance, appendDayEntry, deletedSince, readGuidance, readGuidanceStrict, writeFindingSkill, type DayEntry } from './records.js';
import { claimCandidate, localDate, markSeen, readReflectionState, takeSkillWrite, updateReflectionState } from './state.js';
import { screenSkillWrite } from '../../memory-safety.js';
import { managedTasks } from './team.js';
import { normalizeForQuote } from './judge.js';

/** The session's text turns read before the moment: anger is often about a run of turns, not the last one. */
const TURNS_BEFORE: Record<ReflectionSignal, number> = { frustration: 10, overruled: 4, many_rounds: 3, decision_ask: 4 };

/** A moment older than this is not judged: its correction would come too late. */
export const MOMENT_MAX_AGE_MS = 24 * 3600_000;

/** A message is judged once the session had this long to answer it. */
export const ANSWER_GRACE_MS = 3 * 60_000;

export interface Candidate {
  key: string;
  signal: ReflectionSignal;
  task: Task;
  sessionId: string;
  /** His messages it is about (oldest first); none for a decision ask. */
  messages: SpokenMessage[];
  from: string;
  to: string;
}

export type SendCorrection = (task: Task, text: string, title: string) => Promise<boolean>;

/** Checked again right before a send: the switch still on, the task still the node's, open, and on the session judged. */
export type ConfirmSend = (node: Task, task: Task, sessionId: string) => Promise<boolean>;

export interface ReflectDeps {
  readTranscript: ReadTranscript;
  callModel: CallModel;
  send: SendCorrection;
  confirmSend: ConfirmSend;
  /** His messages per task (user-asks.ts). */
  readMessages: (taskId: string) => Promise<Array<SpokenMessage & { sid?: string }>>;
  rulesText: (node: Task) => Promise<string>;
  replyLanguage: () => Promise<string | null>;
  nowMs: () => number;
}

export interface ReflectResult { candidates: number; judged: number; findings: Array<{ candidate: Candidate; verdict: Verdict; entry?: DayEntry }> }

/**
 * The candidates in one task: new messages with a signal, closed many-round windows, an open
 * decision ask. `quiet` are keys the second look dropped, to be marked seen so they are not read again.
 */
export async function taskCandidates(
  task: Task, since: string, seen: ReadonlySet<string>, deps: Pick<ReflectDeps, 'readMessages' | 'readTranscript' | 'nowMs'>,
): Promise<{ candidates: Candidate[]; quiet: string[] }> {
  const now = deps.nowMs();
  // A day old, a moment is past correcting: the session moved on.
  const floor = new Date(Math.max(Date.parse(since), now - MOMENT_MAX_AGE_MS)).toISOString();
  const all = (await deps.readMessages(task.id)).filter((m) => m.at > floor);
  const out: Candidate[] = [];
  const quiet: string[] = [];
  const sid = (m?: { sid?: string }) => m?.sid ?? task.session_id ?? task.exec_session_id ?? '';
  let turns: TurnText[] | null = null;
  const turnsOf = async (sessionId: string, from: string, to: string) => {
    if (!sessionId) return [];
    turns ??= await turnsAround(sessionId, from, to, deps.readTranscript, { turnsBefore: 4 }).catch(() => []);
    return turns;
  };
  for (const m of all) {
    const key = `msg:${task.id}:${m.id}`;
    if (seen.has(key) || now - Date.parse(m.at) < ANSWER_GRACE_MS) continue;
    const first = messageSignals(m.text);
    if (!first.length) continue;
    turns = null;
    const before = lastAssistantBefore(await turnsOf(sid(m), m.at, m.at), m.at);
    // Unknown turn before (no transcript): no overrule can be told, only frustration.
    const signals = messageSignals(m.text, before ?? '');
    if (!signals.length) { quiet.push(key); continue; }
    out.push({ key, signal: signals[0], task, sessionId: sid(m), messages: [m], from: m.at, to: m.at });
  }
  for (const w of manyRoundWindows(all, now)) {
    const key = `rounds:${task.id}:${w.ids[0]}`;
    if (seen.has(key)) continue;
    const msgs = all.filter((m) => w.ids.includes(m.id));
    out.push({ key, signal: 'many_rounds', task, sessionId: sid(msgs[msgs.length - 1]), messages: msgs, from: w.from, to: w.to });
  }
  const report = task.user_status;
  if (report?.state === 'needs' && report.at && report.at > floor && !all.some((m) => m.at > report.at!)) {
    const key = `ask:${task.id}:${report.at}`;
    const sessionId = sid();
    if (!seen.has(key) && sessionId) {
      turns = null;
      const t = await turnsOf(sessionId, report.at, report.at);
      const last = [...t].reverse().find((x) => x.role === 'assistant');
      if (last && recommends(last.text)) out.push({ key, signal: 'decision_ask', task, sessionId, messages: [], from: last.at, to: report.at });
      else quiet.push(key);
    }
  }
  return { candidates: out, quiet };
}

/** Free text the judge wrote that goes on to a session or a file: refused whole when the injection screen stops it. */
function unsafeText(f: Finding): string | null {
  return screenSkillWrite([f.correction, f.guidance, f.skill?.description ?? '', f.skill?.text ?? ''].join('\n\n'), 'reflection finding');
}

function correctionText(node: Task, nodeName: string, c: Candidate, f: Finding): string {
  return [
    `${nodeName}'s reflection looked at your recent turn${c.messages.length ? ' and the user\'s answer to it' : ''} and found a decision to fix.`,
    '',
    f.correction,
    '',
    `What went wrong: ${f.what_went_wrong}`,
    `The right way: ${f.correct_action}`,
    `You said: "${f.session_quote}"`,
    ...(f.user_quote ? [`The user said: "${f.user_quote}"`] : []),
    ...(f.rule_quote ? [`The rule: "${f.rule_quote}"`] : []),
    '',
    `Act on it in this task. No reply to ${nodeName} is needed (task ${node.id}).`,
  ].join('\n');
}

/** Judge one candidate and act on a real finding. */
export async function reflectOnCandidate(node: Task, nodeName: string, c: Candidate, deps: ReflectDeps, guidance: readonly string[]): Promise<{ verdict: Verdict; entry?: DayEntry }> {
  const turns = await turnsAround(c.sessionId, c.from, c.to, deps.readTranscript, { turnsBefore: TURNS_BEFORE[c.signal] }).catch(() => []);
  // What he said up to the moment, and only that: a later message of his is a candidate of its own.
  // His messages are his record even where the transcript clipped them, so they count too.
  const userText = [...turns.filter((t) => t.role === 'user' && t.at <= c.to).map((t) => t.text), ...c.messages.map((m) => m.text)].join('\n\n');
  const input: JudgeInput = {
    signal: c.signal, taskTitle: c.task.title, turnsText: renderTurns(turns), momentAt: c.to,
    sessionText: turns.filter((t) => t.role === 'assistant').map((t) => t.text).join('\n\n'),
    userText, rulesText: await deps.rulesText(node), guidance, replyLanguage: await deps.replyLanguage(),
  };
  if (!input.sessionText) return { verdict: { verdict: 'unverified', why: 'no session turn to read' } };
  const verdict = await judge(input, deps.callModel, node.id);
  if (verdict.verdict !== 'bad_decision') return { verdict };
  const f = verdict.finding;
  const unsafe = unsafeText(f);
  if (unsafe) return { verdict: { verdict: 'unverified', why: `the finding's text was refused: ${unsafe.slice(0, 160)}` } };
  let corrected: DayEntry['corrected'] = 'already_fixed';
  if (!f.already_fixed && f.correction) {
    corrected = !(await deps.confirmSend(node, c.task, c.sessionId).catch(() => false)) ? 'off'
      : await deps.send(c.task, correctionText(node, nodeName, c, f), `${nodeName}'s reflection: ${f.correct_action.slice(0, 120)}`)
        .then((ok) => (ok ? 'sent' : 'failed'), () => 'failed' as const);
  }
  const now = deps.nowMs();
  const date = localDate(now);
  let guidanceNote = f.same_as ? `already listed (line ${f.same_as})` : 'none';
  if (f.guidance && !f.same_as) {
    const state = await readReflectionState(node.id, now);
    const addedToday = (await readGuidance(node.id)).filter((l) => l.date === date).length;
    const added = await addGuidance(node.id, nodeName, { text: f.guidance, from: c.task.title.slice(0, 60), date }, { removed: state.removed, addedToday });
    guidanceNote = added === 'added' ? `added: ${f.guidance}` : `not added (${added}): ${f.guidance}`;
    if (added === 'added') await updateReflectionState(node.id, (s) => { s.written.push(normalizeForQuote(f.guidance)); }, now);
  }
  const skill = !f.skill ? undefined
    : await takeSkillWrite(node.id, now) ? `${f.skill.name} (${await writeFindingSkill(node.id, nodeName, f.skill)})`
    : `${f.skill.name} (not written: today's skill is written already)`;
  const entry: DayEntry = { at: new Date(now).toISOString(), signal: c.signal, task: { id: c.task.id, title: c.task.title }, finding: f, corrected, guidance: guidanceNote, ...(skill ? { skill } : {}) };
  await appendDayEntry(node.id, nodeName, date, entry);
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
  const state = await updateReflectionState(node.id, (s) => structuredClone(s), now);
  const since = reflectionSince(node, state.since);
  const lines = await readGuidance(node.id);
  const result: ReflectResult = { candidates: 0, judged: 0, findings: [] };
  const seen = new Set(Object.keys(state.seen));
  const candidates: Candidate[] = [];
  const quiet: string[] = [];
  for (const t of managedTasks(node, all, now)) {
    const found = await taskCandidates(t, since, seen, deps).catch((err) => {
      log.task.warn('reflection: candidates not read', { nodeId: node.id, taskId: t.id, error: err instanceof Error ? err.message : String(err) });
      return { candidates: [], quiet: [] };
    });
    candidates.push(...found.candidates);
    quiet.push(...found.quiet);
  }
  await markSeen(node.id, quiet, 'no_signal', now);
  result.candidates = candidates.length;
  for (const c of candidates.sort((a, b) => a.to.localeCompare(b.to))) {
    const claim = await claimCandidate(node.id, c.key, now);
    if (claim === 'budget') break;
    if (claim === 'seen') continue;
    result.judged++;
    let out: { verdict: Verdict; entry?: DayEntry };
    try {
      out = await reflectOnCandidate(node, nodeName, c, deps, lines.map((l) => l.text));
    } catch (err) {
      // Claimed already: a failure is never judged (or sent) again.
      out = { verdict: { verdict: 'unverified', why: `the step failed: ${err instanceof Error ? err.message : String(err)}` } };
    }
    await updateReflectionState(node.id, (s) => { s.seen[c.key] = { at: new Date(now).toISOString(), verdict: out.verdict.verdict }; }, now);
    log.task.info('reflection: judged', { nodeId: node.id, taskId: c.task.id, signal: c.signal, verdict: out.verdict.verdict, ...(out.verdict.verdict !== 'bad_decision' ? { why: out.verdict.why.slice(0, 200) } : {}) });
    result.findings.push({ candidate: c, verdict: out.verdict, ...(out.entry ? { entry: out.entry } : {}) });
  }
  return result;
}

/** Lines the reflection wrote that the file no longer has were deleted by someone: they go to `removed`. */
export async function rememberDeletedGuidance(nodeId: string, nowMs: number): Promise<void> {
  // A file that cannot be read now (gone mid-sync, a lock) says nothing about what the user deleted.
  const lines = await readGuidanceStrict(nodeId);
  if (!lines) return;
  await updateReflectionState(nodeId, (s) => {
    for (const k of deletedSince(s.written, lines)) if (!s.removed.includes(k)) s.removed.push(k);
    s.written = s.written.filter((k) => !s.removed.includes(k));
  }, nowMs);
}

const RULES_PART_MAX = 8000;

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
      const [n, t] = await Promise.all([getTask(node.id).catch(() => null), getTask(task.id).catch(() => null)]);
      if (!n || !t || !dutyOn(n, 'reflection') || t.phase === 'COMPLETE' || !(await isOrgEnabled())) return false;
      // The correction quotes this session: a task now on another session (an engine switch, a new chat) never gets it.
      if ((t.session_id ?? t.exec_session_id ?? '') !== sessionId) return false;
      return managedTasks(n, await orgTasks()).some((x) => x.id === t.id);
    },
    readMessages: async (taskId) => {
      const { readUserAsks } = await import('../../sessions/user-asks.js');
      return (await readUserAsks(taskId)).asks.map((a) => ({ id: a.id, at: a.at, text: a.text, ...(a.sid ? { sid: a.sid } : {}) }));
    },
    rulesText: async (node) => {
      const { USER_FILE } = await import('../../../constants.js');
      // Bounded, so one call stays near its budget whatever the files grow to.
      const user = (await fsp.readFile(USER_FILE, 'utf-8').catch(() => '')).slice(0, RULES_PART_MAX);
      const memory = (node.agent_memory?.text ?? '').slice(0, RULES_PART_MAX);
      return [user && `## The user's standing rules (USER.md)\n${user}`, memory && `## The lead's memory (MEMORY.md)\n${memory}`].filter(Boolean).join('\n\n');
    },
    replyLanguage: async () => {
      const [{ getConfig }, { replyLanguageText }] = await Promise.all([import('../../config-manager.js'), import('../../sessions/output-mode.js')]);
      return replyLanguageText(await getConfig());
    },
    nowMs: () => Date.now(),
  };
}
