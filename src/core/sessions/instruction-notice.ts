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
import { refreshUserProfile } from './user-profile-context.js';
import { dueChanges, hash, parseInstructions, renderDue, viewsAfter, type BlockView, type Due, type Parsed } from './instruction-diff.js';
import {
  NOTICE_OPENING, bumpNoticeTold, clearNoticeDelivering, leadsWithNotice, noticeDelivering, noticeInFlight,
  noticeToldGeneration,
} from './instruction-notice-flight.js';
import { log } from '../../logging/index.js';
import { hookStatementVoid } from './hook-statement.js';
import type { SessionRecord } from '../types.js';

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
type Noted = NonNullable<SessionRecord['taskRoutingNoted']>;

/** Same prompt and same compaction boundary as when the lines were told; never a fork's hook statement (hook-statement.ts). */
function sameBase(noted: Noted | undefined, record: NoticeRecord): noted is Noted {
  return !!noted && noted.promptHash === hash(record.appliedAppendSystemPrompt ?? '')
    && (noted.compactUuid ?? '') === (record.lastCompactUuid ?? '')
    && !hookStatementVoid(noted.byHookAt, record);
}

/** What the session holds beyond its prompt: told plain lines and block versions (none when `ignoreTold`). */
function heldBeyondPrompt(record: NoticeRecord, current: Parsed, prompt: Parsed, ignoreTold?: boolean) {
  const noted = record.taskRoutingNoted;
  if (ignoreTold || !sameBase(noted, record)) return { told: new Set<string>(), views: {} as Record<string, BlockView> };
  const told = new Set(noted.lines ?? []);
  const views: Record<string, BlockView> = { ...(noted.blocks ?? {}) };
  if (noted.blocks) return { told, views };
  // A record from before blocks were kept: it was told every tagged line of a version as plain
  // lines. The current version, when all of it was told; else, when it was told lines of some
  // version in between (neither current nor in the prompt), what it holds is unknown and the
  // block is told whole once, so no rule of that version is left standing unsaid.
  const known = new Set([...current.all, ...prompt.all].map(hash));
  const between = [...told].some((h) => !known.has(h));
  for (const block of current.blocks.values()) {
    if (block.tagged.length && block.tagged.every((l) => told.has(hash(l)))) {
      views[block.id] = { version: block.version, words: block.words, form: block.form };
    } else if (between && prompt.blocks.get(block.id)?.version !== block.version) {
      views[block.id] = { version: 'unknown', words: [] };
    }
  }
  return { told, views };
}

/** What this session should be told now, or null. */
function dueFor(record: NoticeRecord, task: InstructionTask, ignoreTold?: boolean): { due: Due; views: Record<string, BlockView> } | null {
  // ACP rebuilds its instructions from buildSessionContext at every establish.
  if (isAcpEngine(resolveEngine(record.engine))) return null;
  const prompt = record.appliedAppendSystemPrompt;
  // Unknown spawn prompt (never stored, or over the size cap): treat it as current.
  if (prompt === undefined || prompt === null) return null;
  // A slim profile runs on its caller's prompt alone, with no Walnut instructions to update.
  if (!prompt.includes(WALNUT_PROMPT_MARK)) return null;
  const current = parseInstructions(defaultInstructions(task));
  const parsedPrompt = parseInstructions(prompt);
  const { told, views } = heldBeyondPrompt(record, current, parsedPrompt, ignoreTold);
  const due = dueChanges(current, parsedPrompt, told, views);
  return due ? { due, views } : null;
}

function render(due: Due): string {
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: NOTICE_ATTRS,
    body: 'Walnut changed your default instructions after this session started. Below is the current wording of '
      + 'each rule that changed; where your system prompt or an earlier summary says otherwise, these win. Follow '
      + 'them from now on. This notice itself starts no work.\n\n'
      + renderDue(due),
  });
}

/** A notice's told record, and the blocks it told (to merge only those onto a newer record). */
type Told = { noted: Noted; changed: string[] };
const changedIds = (due: Due) => [...due.blocks.map((c) => c.block.id), ...due.gone.map((g) => g.id)];

/** What counts as told once `due` reached the session: added to what this prompt and boundary were told. */
function notedOf(record: NoticeRecord, found: { due: Due; views: Record<string, BlockView> }, extra?: Partial<Noted>): Noted {
  const base = sameBase(record.taskRoutingNoted, record) && !extra?.byHookAt ? record.taskRoutingNoted.lines ?? [] : [];
  const told = [...new Set([...base, ...found.due.plain.map((c) => hash(c.line))])];
  const blocks = viewsAfter(found.views, found.due);
  return { version: hash(JSON.stringify([told, blocks])), promptHash: hash(record.appliedAppendSystemPrompt ?? ''),
    ...(record.lastCompactUuid ? { compactUuid: record.lastCompactUuid } : {}), lines: told, blocks, ...extra };
}

/** The notice a session should get, or null. `ignoreTold`: the caller restates it whatever was said before. */
export function instructionNoticeFor(record: NoticeRecord, task: InstructionTask, opts?: { ignoreTold?: boolean }): string | null {
  const found = dueFor(record, task, opts?.ignoreTold);
  return found ? render(found.due) : null;
}

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
function leadingNotice(text: string): string | null {
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
   * of `queue` already carries a notice, or one is being recorded as told).
   */
  apply(text: string, queue: ReadonlyArray<{ status: string; message: string }>): string;
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
  const cur = record.taskRoutingNoted;
  if (sameBase(cur, record)) {
    const lines = [...new Set([...(cur.lines ?? []), ...(noted.lines ?? [])])];
    // Only the blocks this notice told: the rest of its snapshot may be older than the record.
    const blocks = { ...(cur.blocks ?? {}) };
    for (const id of changed) if (noted.blocks?.[id]) blocks[id] = noted.blocks[id];
    return { ...cur, version: hash(JSON.stringify([lines, blocks])), lines, blocks };
  }
  return sameBase(noted, record) ? noted : null;
}

/** Record `noted` as told: as is (`base`, the compaction hook's fresh statement), else onto the record as it is now. */
async function recordTold(sessionId: string, told: Told, opts?: { base?: boolean }): Promise<void> {
  const { updateSessionRecordConditionally } = await import('../session-tracker.js');
  // Filled in under the record's lock, from the row as it is then.
  const patch: { taskRoutingNoted?: Noted } = {};
  await updateSessionRecordConditionally(sessionId, patch, (current) => {
    const next = opts?.base ? told.noted : toldOnto(current, told);
    if (!next) return false;
    patch.taskRoutingNoted = next;
    return true;
  }, { preserveLastActiveAt: true })
    .catch((error) => log.session.warn('Instruction notice: could not record it as told', { sessionId, error: String(error) }));
  bumpNoticeTold(sessionId);
}

async function lookup(sessionId: string): Promise<{ record: SessionRecord; text: string; told: Told } | null> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record?.taskId) return null;
  const { listTasksByIds } = await import('../task-manager.js');
  const [task] = await listTasksByIds([record.taskId]);
  if (!task) return null;
  // The user's profile rides the default instructions: compare against it as on disk now.
  await refreshUserProfile();
  const found = dueFor(record, task);
  return found ? { record, text: render(found.due), told: { noted: notedOf(record, found), changed: changedIds(found.due) } } : null;
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
      apply: (input, queue) => {
        // Told since this was looked up: what it says may be told already.
        if (noticeToldGeneration(sessionId) !== gen) return input;
        if (noticeDelivering(sessionId) || noticeInFlight(queue)) return input;
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
      await recordTold(sessionId, kept);
      log.session.info('Instruction notice delivered', { sessionId, lines: kept.noted.lines?.length ?? 0, blocks: kept.changed });
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
    const empty = { due: { plain: [], blocks: [], gone: [] }, views: {} };
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
export function instructionNoticeForHost(
  record: NoticeRecord & Pick<SessionRecord, 'claudeSessionId' | 'process_status' | 'lastActiveAt'>, task: InstructionTask, now = Date.now(),
): { policy: string; due: string } | null {
  // Only a session that may take a line soon: the slice rides every push to the
  // host, and an idle one is told by whichever path reaches it first later.
  const active = record.process_status === 'running'
    || now - Date.parse(record.lastActiveAt ?? '') < HOST_NOTICE_ACTIVE_MS;
  if (!active) return null;
  const found = dueFor(record, task);
  if (!found) return null;
  const policy = render(found.due);
  const due = hash(JSON.stringify([hash(record.appliedAppendSystemPrompt ?? ''), record.lastCompactUuid ?? '', policy]));
  remember(due, record.claudeSessionId, { noted: notedOf(record, found), changed: changedIds(found.due) });
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
