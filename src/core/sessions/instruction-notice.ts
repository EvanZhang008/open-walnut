/**
 * Default instructions that changed after a session started.
 *
 * A cold resume replays the spawn-time prompt byte for byte and a live CLI never
 * rereads one, so a long-running session (Main, a lead, any worker or ask) keeps
 * the instructions it was spawned with: 2026-10-25, Main kept its old rules until
 * it happened to be respawned, and a session older than the team charter brought
 * the old ways back after every compaction. Such a session gets what it lacks of
 * its current default instructions (session-context.ts defaultInstructions; the
 * comparison is instruction-diff.ts: the plain lines its prompt lacks, and for a
 * versioned block such as the user's profile only the lines that changed) as a
 * leading notice on the first stdin line frozen after this (session-message-queue.ts
 * markProcessing / markNextProcessing): the frozen bytes are what reaches the CLI,
 * and a retry keeps them. Nothing when nothing changed.
 *
 * What was told is recorded (`taskRoutingNoted`, a name kept from when this was
 * only the task routing rules) against that prompt and the last compaction
 * boundary, the way place notices are: a later change sends only its own lines,
 * and a compaction may drop them all from the context, so a new boundary makes
 * everything due again (the compaction hook restates it at once).
 *
 * One notice on its way at a time (instruction-notice-flight.ts): a line is not
 * given one while another live row in the session's queue carries one, or while
 * a delivered one is being recorded. What a delivery records is what that notice
 * said, kept when it was attached, never a second reading of the instructions.
 * Best effort: nothing here ever fails a send.
 */

import { createEnvelopeKit } from '../peers/envelope-kit.js';
import { isAcpEngine, resolveEngine } from '../agents/engine-registry.js';
import { WALNUT_PROMPT_MARK, defaultInstructions, type InstructionTask } from './session-context.js';
import { currentUserProfile, refreshUserProfile } from './user-profile-context.js';
import { dueChanges, hash, parseInstructions, renderDue, sameRule, viewsAfter, type BlockView, type Due, type Parsed } from './instruction-diff.js';
import {
  NOTICE_OPENING, bumpNoticeTold, clearNoticeDelivering, leadsWithNotice, noticeDelivering, noticeInFlight,
  noticeToldGeneration,
} from './instruction-notice-flight.js';
import { log } from '../../logging/index.js';
import { restatementKey, splitAtLines } from './instruction-hook-parts.js';
import { isFollower } from '../server-role.js';
import { heldStatement, hookStatementVoid, statementBoundary } from './hook-statement.js';
import { parseHinted } from '../hints/hint-format.js';
import { isEnvelopeOnly, parseSessionEnvelopes } from '../../lib/history-session-envelope.js';
import type { SessionInstructionsNoted, SessionRecord } from '../types.js';

const kit = createEnvelopeKit();
/**
 * The wire name from when this carried only the routing rules. Kept: the web and
 * iOS timelines split a notice with this outcome off the human's words in front
 * of it (history-walnut-riders.ts, TimelineInboundMessage.swift), an installed
 * iOS app included.
 */
const OUTCOME = 'task-routing-policy';
const NOTICE_ATTRS = { from: 'Walnut', outcome: OUTCOME, note: 'current default instructions, not a work request' };

type NoticeRecord = Pick<SessionRecord, 'appliedAppendSystemPrompt' | 'engine' | 'lastCompactUuid' | 'lastCompactAt' | 'taskRoutingNoted'>;
type Noted = Omit<SessionInstructionsNoted, 'prior'>;

/**
 * Changes close together go out as one notice: once a session was told on its
 * current prompt and boundary, the next notice waits this long after that one,
 * whatever changed (2026-11-03: Main and two leads got 4 to 5 notices in 12 hours,
 * each riding its own message; 2026-11-20: with the user's profile, the Threads
 * rules and a role's instructions let through at once, sessions got a second one
 * 0.4 to 2.7 hours after the first, 65 in a night). A compaction starts a new
 * boundary, so what it dropped is told at once.
 */
export const NOTICE_GAP_MS = 3 * 60 * 60_000;

/** Same prompt and same compaction boundary as when the lines were told; never a fork's hook statement (hook-statement.ts). */
function sameBase(noted: Noted | undefined, record: NoticeRecord): noted is Noted {
  return !!noted && noted.promptHash === hash(record.appliedAppendSystemPrompt ?? '')
    && (noted.compactUuid ?? '') === (record.lastCompactUuid ?? '')
    && !hookStatementVoid(noted.byHookAt, record);
}

/** What was told that counts for this conversation: a fork's hook statement gives way to what it replaced. */
function heldNoted(record: NoticeRecord): Noted | undefined {
  const noted = heldStatement(record.taskRoutingNoted, record);
  return sameBase(noted, record) ? noted : undefined;
}

/** What the session holds beyond its prompt: told plain lines and block versions (none when `ignoreTold`). */
function heldBeyondPrompt(record: NoticeRecord, current: Parsed, prompt: Parsed, ignoreTold?: boolean) {
  const noted = heldNoted(record);
  if (ignoreTold || !noted) return { told: new Set<string>(), views: {} as Record<string, BlockView>, texts: [] as string[] };
  const told = new Set(noted.lines ?? []);
  const views: Record<string, BlockView> = { ...(noted.blocks ?? {}) };
  const texts = noted.texts ?? [];
  if (noted.blocks) return { told, views, texts };
  // A record from before blocks were kept: it was told every tagged line of a version as plain
  // lines. The current version, when all of it was told; else, when it was told lines of some
  // version in between (neither current nor in the prompt), what it holds is unknown and the
  // block is told whole once, so no rule of that version is left standing unsaid.
  // A told line was tagged then: the current blocks' lines count as known in that form too.
  const known = new Set([...current.all, ...prompt.all, ...[...current.blocks.values()].flatMap((b) => b.tagged)].map(hash));
  const between = [...told].some((h) => !known.has(h));
  for (const block of current.blocks.values()) {
    if (block.tagged.length && block.tagged.every((l) => told.has(hash(l)))) {
      views[block.id] = { version: block.version, words: block.words, form: block.form };
    } else if (between && prompt.blocks.get(block.id)?.version !== block.version) {
      views[block.id] = { version: 'unknown', words: [] };
    }
  }
  return { told, views, texts };
}

type Found = { due: Due; views: Record<string, BlockView>; texts: string[] };

type HeldAndDue = { views: Record<string, BlockView>; texts: string[]; found: Due | null };
/**
 * heldBeyondPrompt and dueChanges for one prompt, one set of current instructions and one record
 * of what the session was told, worked out once. Both are pure in those inputs, and the host slice
 * asks for every active session at every push (2026-11-24: the diff was a fifth of the server's
 * CPU in a memory burst after a restart). Keyed by the parsed texts (parseInstructions hands back
 * the same object per text) and the record fields heldNoted reads.
 */
const dueMemo = new WeakMap<Parsed, WeakMap<Parsed, Map<string, HeldAndDue>>>();
const DUE_MEMO_PER_PAIR = 8;
function heldAndDue(record: NoticeRecord, current: Parsed, prompt: Parsed, ignoreTold: boolean | undefined, cut: readonly string[] | undefined): HeldAndDue {
  const key = JSON.stringify([record.taskRoutingNoted ?? null, record.lastCompactUuid ?? null, record.lastCompactAt ?? null, !!ignoreTold, cut ?? null]);
  let byPrompt = dueMemo.get(current);
  if (!byPrompt) dueMemo.set(current, byPrompt = new WeakMap());
  let byKey = byPrompt.get(prompt);
  if (!byKey) byPrompt.set(prompt, byKey = new Map());
  const hit = byKey.get(key);
  if (hit) return hit;
  const { told, views, texts } = heldBeyondPrompt(record, current, prompt, ignoreTold);
  const found = dueChanges(current, prompt, told, views, cut?.length ? { 'user-profile': new Set(cut) } : {}, texts);
  const out = { views, texts, found };
  if (byKey.size >= DUE_MEMO_PER_PAIR) byKey.delete(byKey.keys().next().value!);
  byKey.set(key, out);
  return out;
}

/**
 * When the last notice reached this session, for the gap: one on its current prompt and boundary,
 * or one on an older prompt when the current one holds every line it told (a resume or a respawn
 * rebuilt it on the current instructions, so its gap goes on: 2026-11-21, sessions resumed on a
 * rebuilt prompt at 08:00 got their next notice 49 minutes and 2 hours later). Nothing after a
 * compaction on the prompt it was told on: that dropped what it said, and what it dropped is told at
 * once; nothing either when the prompt lacks a line or block version it told that is still current
 * (a record backfilled with an older prompt).
 */
function gapClock(record: NoticeRecord, current: Parsed, prompt: Parsed): string | undefined {
  const held = heldNoted(record);
  if (held) return held.toldAt;
  const noted = heldStatement(record.taskRoutingNoted, record);
  if (!noted?.toldAt || noted.promptHash === hash(record.appliedAppendSystemPrompt ?? '')) return undefined;
  // What it was told that the instructions still say (a wording reworded or a rule dropped since is
  // in no rebuilt prompt), and the block versions it was told that are still current.
  const live = new Set([...current.all].map(hash));
  const holds = new Set([...prompt.all].map(hash));
  const lines = (noted.lines ?? []).filter((h) => live.has(h)).every((h) => holds.has(h));
  const blocks = Object.entries(noted.blocks ?? {}).every(([id, view]) => current.blocks.get(id)?.version !== view.version
    || prompt.blocks.get(id)?.version === view.version);
  return lines && blocks ? noted.toldAt : undefined;
}

/** What this session should be told now, or null. */
function dueFor(record: NoticeRecord, task: InstructionTask, ignoreTold?: boolean, now = Date.now()): Found | null {
  // ACP rebuilds its instructions from buildSessionContext at every establish.
  if (isAcpEngine(resolveEngine(record.engine))) return null;
  const prompt = record.appliedAppendSystemPrompt;
  // Unknown spawn prompt (never stored, or over the size cap): treat it as current.
  if (prompt === undefined || prompt === null) return null;
  // A slim profile runs on its caller's prompt alone, with no Walnut instructions to update.
  if (!prompt.includes(WALNUT_PROMPT_MARK)) return null;
  const current = parseInstructions(defaultInstructions(task));
  const parsedPrompt = parseInstructions(prompt);
  // Lines of USER.md past its budget are still the user's rules: never told as removed.
  const cut = currentUserProfile().cut;
  const { views, texts, found } = heldAndDue(record, current, parsedPrompt, ignoreTold, cut);
  // A replica's copy of the config has no Reply language (config-allowlist.ts): there it is
  // unknown, not gone, so a session it leads is never told the language rule stopped applying.
  const due = found && isFollower() ? { ...found, gone: found.gone.filter((g) => g.id !== 'reply-language') } : found;
  if (!due || (!due.plain.length && !due.blocks.length && !due.gone.length)) return null;
  // Every change waits out the gap after the last notice (gapClock).
  const lastAt = gapClock(record, current, parsedPrompt);
  if (!ignoreTold && lastAt && now - Date.parse(lastAt) < NOTICE_GAP_MS) return null;
  return { due, views, texts };
}

/** How much of the plain lines it told a record keeps in full words (they are the base of the next rewording). */
const TEXTS_MAX_CHARS = 30_000;
/**
 * The plain lines held in full words once `due` reached the session, newest first: one wording per
 * rule, so every older wording of a line it was told now goes (`dropped`). Every told line is kept,
 * so a short one that grows long later still has the wording it was told; one pushed out by the
 * cap is a told line the record cannot name, and the next rewording of a long line goes whole.
 */
function textsAfter(texts: readonly string[], due: Due): { texts: string[]; dropped: string[] } {
  const fresh = due.plain.map((c) => c.line);
  const was = new Set(due.plain.map((c) => c.was).filter((w): w is string => !!w));
  const dropped = texts.filter((t) => !fresh.includes(t) && (was.has(t) || fresh.some((l) => sameRule(t, l))));
  const gone = new Set(dropped);
  const out: string[] = [];
  let size = 0;
  for (const t of new Set([...fresh, ...texts.filter((x) => !gone.has(x))])) {
    if (size + t.length > TEXTS_MAX_CHARS) break;
    out.push(t);
    size += t.length;
  }
  return { texts: out, dropped };
}

/** The notice's opening; after a compaction, as part `part` of the restatement (instructionRestatementParts). */
function noticeIntro(part?: { i: number; n: number }): string {
  const lead = part
    ? `Walnut restates your default instructions that changed after this session started, part ${part.i} of ${part.n}: your `
      + 'context was just compacted, so earlier notices of them may be gone. Below is the current wording of each rule that changed'
    : 'Walnut changed your default instructions after this session started. Below is the current wording of each rule that changed';
  return `${lead}; where your system prompt or an earlier summary says otherwise, these win. Follow them from now on. `
    + 'This notice itself starts no work.\n\n';
}

const wrapNotice = (body: string) => kit.buildWalnutMessage({ kind: 'notification', attrs: NOTICE_ATTRS, body });

function render(due: Due): string {
  return wrapNotice(noticeIntro() + renderDue(due));
}

/**
 * The restatement after a compaction as parts of at most `room` characters each, envelope included
 * (instruction-hook-parts.ts): each says which part it is, since the hooks reach the model in no fixed
 * order. `key` names this restatement (its rules' text). Null when nothing is due.
 */
export function instructionRestatementParts(record: NoticeRecord, task: InstructionTask, room: number): { parts: string[]; key: string } | null {
  const found = dueFor(record, task, true);
  if (!found) return null;
  const body = renderDue(found.due);
  // The wrapper escapes text inside (a `<walnut-message` grows by a few characters), so a part is
  // measured after wrapping and the split made tighter until every one fits.
  let space = room - wrapNotice(noticeIntro({ i: 99, n: 99 })).length;
  for (;;) {
    const chunks = splitAtLines(body, space);
    const parts = chunks.map((c, i) => wrapNotice(noticeIntro({ i: i + 1, n: chunks.length }) + c));
    if (parts.every((p) => p.length <= room) || space < 1_000) return { parts, key: restatementKey(body) };
    space -= 500;
  }
}

const capTexts = (texts: string[]) => {
  let size = 0;
  return texts.filter((t) => (size += t.length) <= TEXTS_MAX_CHARS);
};

/** A notice's told record, the blocks it told (to merge only those onto a newer record) and the older wordings it replaced. */
type Told = { noted: Noted; changed: string[]; replaced?: string[] };
const replacedOf = (found: Found) => textsAfter(found.texts, found.due).dropped;
const changedIds = (due: Due) => [...due.blocks.map((c) => c.block.id), ...due.gone.map((g) => g.id)];

/** What counts as told once `due` reached the session: added to what this prompt and boundary were told. */
function notedOf(record: NoticeRecord, found: Found, extra?: Partial<Noted>): Noted {
  const base = !extra?.byHookAt ? heldNoted(record)?.lines ?? [] : [];
  const { texts, dropped } = textsAfter(found.texts, found.due);
  // A wording a newer one replaced is no longer what the session holds: told no more, so it is told
  // again should it come back (a deploy rolled back), and it never reads as a line the record cannot name.
  const gone = new Set(dropped.map(hash));
  const told = [...new Set([...base, ...found.due.plain.map((c) => hash(c.line))])].filter((h) => !gone.has(h));
  const blocks = viewsAfter(found.views, found.due);
  return { version: hash(JSON.stringify([told, blocks])), promptHash: hash(record.appliedAppendSystemPrompt ?? ''),
    ...(record.lastCompactUuid ? { compactUuid: record.lastCompactUuid } : {}), lines: told, blocks,
    ...(texts.length ? { texts } : {}), toldAt: new Date().toISOString(), ...extra };
}

/** The notice a session should get, or null. `ignoreTold`: the caller restates it whatever was said before. */
export function instructionNoticeFor(record: NoticeRecord, task: InstructionTask, opts?: { ignoreTold?: boolean }): string | null {
  const found = dueFor(record, task, opts?.ignoreTold);
  return found ? render(found.due) : null;
}

/**
 * A message made only of Walnut's own notes (status pushes, a stopped or waiting
 * subtask, a place note, its hints): a notice joining it would be a line of its own
 * in the session. A subtask's completion or error is work, and carries it.
 */
export function isWalnutNotesOnly(text: string): boolean {
  const body = parseHinted(text).text.trim();
  // No text at all is a person's image, never Walnut's note.
  if (!body) return false;
  const segments = parseSessionEnvelopes(body);
  return isEnvelopeOnly(segments) && segments.every((s) => s.kind === 'envelope' && s.envelope.source === 'walnut'
    && (s.envelope.kind === 'app-state' || (s.envelope.kind === 'notification' && !WORK_NOTICE.test(s.envelope.raw))));
}
/** A subtask's completion or error: Walnut wakes the parent for it, so it starts real work. */
const WORK_NOTICE = /^<walnut-message [^\n]*\boutcome="(completed|error)"/;

/** A slash command must reach the CLI as typed: only raw input starting with "/" runs as one. */
export function isSlashCommandText(text: string): boolean {
  return text.trimStart().startsWith('/');
}

export function withInstructionNotice(text: string, notice: string | null): string {
  if (!notice || isSlashCommandText(text)) return text;
  let rest = text.trimStart();
  while (rest.startsWith('<walnut-message ')) {
    const end = rest.indexOf('</walnut-message>');
    if (end < 0) break;
    if (rest.slice(0, end + '</walnut-message>'.length) === notice) return text;
    rest = rest.slice(end + '</walnut-message>'.length).trimStart();
  }
  return `${notice}\n\n${text}`;
}

/** The notice envelope leading a line, or null. */
export function leadingNotice(text: string): string | null {
  if (!leadsWithNotice(text)) return null;
  const rest = text.trimStart();
  const end = rest.indexOf('</walnut-message>');
  return end < 0 ? null : rest.slice(0, end + '</walnut-message>'.length);
}

/** The text without an instruction notice leading it (a line handed to a session spawned on the current prompt). */
export function stripInstructionNotice(text: string): string {
  const notice = leadingNotice(text);
  return notice ? text.trimStart().slice(notice.length).trimStart() : text;
}

export interface PendingInstructionNotice {
  text: string;
  /**
   * Inside the queue lock: the text with the notice leading it, or the text
   * unchanged (a slash command, one that already leads with it, another live row
   * of `queue` already carries a notice, one is being recorded as told, or the
   * line, `line` being every text it joins, holds only Walnut's own notes).
   */
  apply(text: string, queue: ReadonlyArray<{ status: string; message: string }>, line?: readonly string[]): string;
}

/**
 * What each attached notice told, by session and its hash (the host's due key
 * too), until a delivery records it: one USER.md save gives many sessions the
 * same text. A server restart loses it; a delivery then reads the instructions
 * again and records only a notice that still matches them.
 */
const attached = new Map<string, { told: Told; at: number }>();
const attachedKey = (sessionId: string, key: string) => `${sessionId}:${key}`;
const ATTACHED_MAX = 2_000;
const ATTACHED_MS = 24 * 60 * 60_000;

function remember(key: string, sessionId: string, told: Told): void {
  for (const [k, v] of attached) {
    if (attached.size < ATTACHED_MAX && Date.now() - v.at < ATTACHED_MS) break;
    attached.delete(k);
  }
  attached.set(attachedKey(sessionId, key), { told, at: Date.now() });
}

function takeAttached(sessionId: string, key: string): Told | undefined {
  const k = attachedKey(sessionId, key);
  const kept = attached.get(k);
  attached.delete(k);
  return kept?.told;
}

/**
 * What a delivered notice told, as the record should hold it now. The notice
 * was attached against the record of that moment; a compaction (whose hook
 * restated everything due) or another delivery may have come since. Onto a
 * record told for its current base: added to that. Onto one with no record for
 * its base: the notice's own when it was attached on that base, else nothing
 * (a compaction since may have dropped it, so the next line tells it again).
 * Another prompt (a fresh spawn): nothing.
 */
export function toldOnto(record: NoticeRecord, told: Told): Noted | null {
  const { noted, changed } = told;
  if (noted.promptHash !== hash(record.appliedAppendSystemPrompt ?? '')) return null;
  const cur = heldNoted(record);
  if (cur) {
    const replaced = new Set((told.replaced ?? []).map(hash));
    const lines = [...new Set([...(cur.lines ?? []), ...(noted.lines ?? [])])].filter((h) => !replaced.has(h));
    // Only the blocks this notice told: the rest of its snapshot may be older than the record.
    const blocks = { ...(cur.blocks ?? {}) };
    for (const id of changed) if (noted.blocks?.[id]) blocks[id] = noted.blocks[id];
    const gone = new Set(told.replaced ?? []);
    const texts = capTexts([...new Set([...(noted.texts ?? []), ...(cur.texts ?? [])])].filter((t) => !gone.has(t)));
    return { ...cur, version: hash(JSON.stringify([lines, blocks])), lines, blocks, ...(texts.length ? { texts } : {}),
      ...(noted.toldAt ? { toldAt: noted.toldAt } : {}) };
  }
  return sameBase(noted, record) ? noted : null;
}

/**
 * Record `noted` as told: as the compaction hook's fresh statement (`base`), on the boundary the
 * record holds now and keeping what was told before it (heldStatement), else onto the record as
 * it is now.
 */
async function recordTold(sessionId: string, told: Told, opts?: { base?: boolean }): Promise<boolean> {
  const { updateSessionRecordConditionally } = await import('../session-tracker.js');
  // Filled in under the record's lock, from the row as it is then.
  const patch: { taskRoutingNoted?: SessionInstructionsNoted } = {};
  const written = await updateSessionRecordConditionally(sessionId, patch, (current) => {
    let next: SessionInstructionsNoted | null;
    if (opts?.base) {
      const { compactUuid: _read, ...stated } = told.noted;
      const prior = heldNoted(current);
      next = { ...stated, ...statementBoundary(current), ...(prior ? { prior } : {}) };
    } else next = toldOnto(current, told);
    if (!next) return false;
    patch.taskRoutingNoted = next;
    return true;
  }, { preserveLastActiveAt: true })
    .then(() => true, (error) => {
      log.session.warn('Instruction notice: could not record it as told', { sessionId, error: String(error) });
      return false;
    });
  bumpNoticeTold(sessionId);
  return written && !!patch.taskRoutingNoted;
}

/** The user's profile and Reply language ride the default instructions: compare against them as on disk now. */
const readInputs = () => Promise.all([refreshUserProfile(), import('./reply-language-context.js').then((m) => m.refreshReplyLanguage())]);

async function lookup(sessionId: string, now = Date.now()): Promise<{ record: SessionRecord; text: string; told: Told } | null> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record?.taskId) return null;
  const { listTasksByIds } = await import('../task-manager.js');
  const [task] = await listTasksByIds([record.taskId]);
  if (!task) return null;
  await readInputs();
  const found = dueFor(record, task, false, now);
  return found ? { record, text: render(found.due), told: { noted: notedOf(record, found), changed: changedIds(found.due), replaced: replacedOf(found) } } : null;
}

/** The notice the next frozen line into this session should carry, or null. Never throws. */
export async function instructionNoticeForSession(sessionId: string): Promise<PendingInstructionNotice | null> {
  try {
    const gen = noticeToldGeneration(sessionId);
    const found = await lookup(sessionId);
    if (!found) return null;
    const { text, told } = found;
    return {
      text,
      apply: (input, queue, line = [input]) => {
        // Told since this was looked up: what it says may be told already.
        if (noticeToldGeneration(sessionId) !== gen) return input;
        if (noticeDelivering(sessionId) || noticeInFlight(queue)) return input;
        // It waits for a message from a person, a task or a trigger; Walnut's own notes never carry it alone.
        if (line.every(isWalnutNotesOnly)) return input;
        const out = withInstructionNotice(input, text);
        if (out !== input) remember(hash(text), sessionId, told);
        return out;
      },
    };
  } catch (error) {
    log.session.warn('Instruction notice could not be checked', { sessionId, error: String(error) });
    return null;
  }
}

/**
 * Whether `notice`, leading a line about to reach a CLI that runs on `prompt`, is still what that CLI
 * must hear: it was looked up against that prompt (as attached), or, attached elsewhere (by the host,
 * or before a restart), it is what is due against that prompt now. An unknown prompt (the record could
 * not be read, or the prompt was too large to store) keeps it: the CLI still runs on its stored one.
 * Never throws (true when unsure).
 */
export async function noticeStillDue(sessionId: string, notice: string, prompt: string | undefined): Promise<boolean> {
  if (prompt === undefined) return true;
  try {
    const kept = attached.get(attachedKey(sessionId, hash(notice)))?.told;
    if (kept) return kept.noted.promptHash === hash(prompt);
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    if (!record?.taskId) return true;
    const { listTasksByIds } = await import('../task-manager.js');
    const [task] = await listTasksByIds([record.taskId]);
    if (!task) return true;
    await readInputs();
    const found = dueFor({ ...record, appliedAppendSystemPrompt: prompt }, task);
    return !!found && render(found.due) === notice;
  } catch {
    return true;
  }
}

/** A notice dropped from its line before it went out (stale-notice.ts): nothing of it is told. */
export function forgetAttachedNotice(sessionId: string, notice: string): void {
  attached.delete(attachedKey(sessionId, hash(notice)));
}

/**
 * Lines that reached the CLI (session-message-queue.ts removeProcessed, session-queue-lines.ts
 * removeTaken, which marked them delivering inside their lock): the notice leading one is
 * recorded as told, as it was attached. Never throws; always clears the mark.
 */
export async function noteInstructionNoticeDelivered(sessionId: string, messages: string[]): Promise<void> {
  try {
    const notices = messages.map(leadingNotice).filter((n): n is string => !!n);
    if (!notices.length) return;
    const kept = notices.map((n) => takeAttached(sessionId, hash(n))).find((n) => !!n);
    if (kept) {
      const recorded = await recordTold(sessionId, kept);
      log.session.info('Instruction notice delivered', { sessionId, lines: kept.noted.lines?.length ?? 0, blocks: kept.changed, ...(recorded ? {} : { recorded }) });
      return;
    }
    // Attached before a restart: record it only if it is still what is due.
    const found = await lookup(sessionId);
    if (!found || !notices.includes(found.text)) return;
    await recordTold(sessionId, found.told);
    log.session.info('Instruction notice delivered', { sessionId, lines: found.told.noted.lines?.length ?? 0, blocks: found.told.changed });
  } catch (error) {
    log.session.warn('Instruction notice: delivery not recorded', { sessionId, error: String(error) });
  } finally {
    clearNoticeDelivering(sessionId);
  }
}

/**
 * The compaction hook restated everything that changed: told for the boundary it
 * answers, which the server may record before or after (place-notice.ts
 * notePlaceCompaction carries a fresh hook statement onto the new boundary).
 * The hook's statement is a new base, so only what it said counts. Never throws.
 */
export async function noteInstructionNoticeStatedByHook(record: SessionRecord, task: InstructionTask): Promise<void> {
  try {
    const fresh = { ...record, taskRoutingNoted: undefined };
    const found = dueFor(fresh, task, true);
    const empty: Found = { due: { plain: [], blocks: [], gone: [] }, views: {}, texts: [] };
    await recordTold(record.claudeSessionId, { noted: notedOf(fresh, found ?? empty, { byHookAt: new Date().toISOString() }), changed: [] }, { base: true });
  } catch { /* told again on the next line */ }
}

const HOST_NOTICE_ACTIVE_MS = 24 * 60 * 60_000;

/**
 * The host slice's view (host-slice.ts): the notice and a key naming this "due"
 * (the notice itself), only while the session has something to be told. The
 * host delivers same-host messages itself (offline-host-core.ts handleLocal), so
 * it adds the notice once per key and journals the key with that delivery.
 */
/**
 * Only a session that may take a line soon gets a notice in the host slice: the slice rides every
 * push to the host, and an idle one is told by whichever path reaches it first later. Read on the
 * slim record, so the slice fetches the spawn prompt only for these.
 */
export function hostNoticeActive(record: Pick<SessionRecord, 'process_status' | 'lastActiveAt'>, now = Date.now()): boolean {
  return record.process_status === 'running' || now - Date.parse(record.lastActiveAt ?? '') < HOST_NOTICE_ACTIVE_MS;
}

export function instructionNoticeForHost(
  record: NoticeRecord & Pick<SessionRecord, 'claudeSessionId' | 'process_status' | 'lastActiveAt'>, task: InstructionTask, now = Date.now(),
): { policy: string; due: string } | null {
  if (!hostNoticeActive(record, now)) return null;
  const found = dueFor(record, task, false, now);
  if (!found) return null;
  const policy = render(found.due);
  const due = hash(JSON.stringify([hash(record.appliedAppendSystemPrompt ?? ''), record.lastCompactUuid ?? '', policy]));
  remember(due, record.claudeSessionId, { noted: notedOf(record, found), changed: changedIds(found.due), replaced: replacedOf(found) });
  return { policy, due };
}

/** A host journaled a delivery led by the notice under `due`: told, as that notice said. Never throws. */
export async function noteInstructionNoticeToldByHost(sessionId: string, due: string): Promise<void> {
  try {
    const kept = takeAttached(sessionId, due);
    if (kept) {
      await recordTold(sessionId, kept);
      return;
    }
    const found = await lookup(sessionId);
    if (!found) return;
    const key = hash(JSON.stringify([hash(found.record.appliedAppendSystemPrompt ?? ''), found.record.lastCompactUuid ?? '', found.text]));
    if (key === due) await recordTold(sessionId, found.told);
  } catch (error) {
    log.session.warn('Instruction notice: host delivery not recorded', { sessionId, error: String(error) });
  }
}

export { NOTICE_OPENING };
