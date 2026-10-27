/**
 * Default instructions that changed after a session started.
 *
 * A cold resume replays the spawn-time prompt byte for byte and a live CLI never
 * rereads one, so a long-running session (Main, a lead, any worker or ask) keeps
 * the instructions it was spawned with: 2026-10-25, Main kept its old rules until
 * it happened to be respawned, and a session older than the team charter brought
 * the old ways back after every compaction. Such a session gets the lines of its
 * current default instructions (session-context.ts defaultInstructions) that its
 * stored prompt lacks, as a leading notice on the first stdin line frozen after
 * this (session-message-queue.ts markProcessing / markNextProcessing): the frozen
 * bytes are what reaches the CLI, and a retry keeps them. Only those lines: the
 * rules that changed, never the whole prompt; nothing when none did.
 *
 * Told lines are recorded (`taskRoutingNoted`, a name kept from when this was
 * only the task routing rules) against that prompt and the last compaction
 * boundary, the way place notices are: a later change sends only its new lines,
 * and a compaction may drop them all from the context, so a new boundary makes
 * every changed line due again (the compaction hook restates them at once).
 * Best effort: nothing here ever fails a send.
 */

import { createHash } from 'node:crypto';
import { createEnvelopeKit } from '../peers/envelope-kit.js';
import { isAcpEngine, resolveEngine } from '../agents/engine-registry.js';
import { defaultInstructions, type InstructionTask } from './session-context.js';
import { log } from '../../logging/index.js';
import type { SessionRecord } from '../types.js';

const kit = createEnvelopeKit();
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
/**
 * The wire name from when this carried only the routing rules. Kept: the web and
 * iOS timelines split a notice with this outcome off the human's words in front
 * of it (history-walnut-riders.ts, TimelineInboundMessage.swift), an installed
 * iOS app included.
 */
const OUTCOME = 'task-routing-policy';
const NOTICE_ATTRS = { from: 'Walnut', outcome: OUTCOME, note: 'current default instructions, not a work request' };
const NOTICE_OPENING = `<walnut-message kind="notification" from="Walnut" outcome="${OUTCOME}"`;
/** Every Walnut session prompt opens with this (session-context.ts); a prompt without it is the caller's own. */
const WALNUT_PROMPT_MARK = 'You are a coding session opened by Walnut';

type NoticeRecord = Pick<SessionRecord, 'appliedAppendSystemPrompt' | 'engine' | 'lastCompactUuid' | 'taskRoutingNoted'>;
type Noted = NonNullable<SessionRecord['taskRoutingNoted']>;

/** A changed line and the heading it sits under (the charter's "## How we work"), shown with it. */
interface Changed { line: string; heading?: string }

/**
 * Lines of the current default instructions this prompt lacks, in prompt order.
 * Remembered per (role, prompt): the host slice asks for every session it lists,
 * at every push, and most sessions share a handful of prompts.
 */
const changedCache = new Map<string, Changed[]>();
const CHANGED_CACHE_MAX = 500;
function changedLines(prompt: string, task: InstructionTask): Changed[] {
  const current = defaultInstructions(task);
  const key = hash(current) + hash(prompt);
  const cached = changedCache.get(key);
  if (cached) return cached;
  const had = new Set(prompt.split('\n').map((l) => l.trim()));
  const out: Changed[] = [];
  let heading: string | undefined;
  for (const raw of current.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) { heading = line; continue; }
    if (!had.has(line)) out.push({ line, heading });
  }
  if (changedCache.size >= CHANGED_CACHE_MAX) changedCache.delete(changedCache.keys().next().value as string);
  changedCache.set(key, out);
  return out;
}

/** Same prompt and same compaction boundary as when the lines were told. */
function sameBase(noted: Noted | undefined, record: NoticeRecord): noted is Noted {
  return !!noted && noted.promptHash === hash(record.appliedAppendSystemPrompt ?? '')
    && (noted.compactUuid ?? '') === (record.lastCompactUuid ?? '');
}

/** The changed lines still to tell (all of them when `ignoreTold`), or null when this session gets none. */
function dueLines(record: NoticeRecord, task: InstructionTask, ignoreTold?: boolean): Changed[] | null {
  // ACP rebuilds its instructions from buildSessionContext at every establish.
  if (isAcpEngine(resolveEngine(record.engine))) return null;
  const prompt = record.appliedAppendSystemPrompt;
  // Unknown spawn prompt (never stored, or over the size cap): treat it as current.
  if (prompt === undefined || prompt === null) return null;
  // A slim profile runs on its caller's prompt alone, with no Walnut instructions to update.
  if (!prompt.includes(WALNUT_PROMPT_MARK)) return null;
  const changed = changedLines(prompt, task);
  const noted = record.taskRoutingNoted;
  const told = !ignoreTold && sameBase(noted, record) ? new Set(noted.lines ?? []) : new Set<string>();
  const due = changed.filter((c) => !told.has(hash(c.line)));
  return due.length ? due : null;
}

function render(lines: Changed[]): string {
  const body: string[] = [];
  let heading: string | undefined;
  for (const c of lines) {
    if (c.heading && c.heading !== heading) body.push(`${c.heading}\n`);
    heading = c.heading;
    body.push(c.line.startsWith('- ') ? c.line : `${c.line}\n`);
  }
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: NOTICE_ATTRS,
    body: 'Walnut changed your default instructions after this session started. Below is the current wording of '
      + 'each rule that changed; where your system prompt or an earlier summary says otherwise, these win. Follow '
      + 'them from now on. This notice itself starts no work.\n\n'
      + body.join('\n').trim(),
  });
}

/** The notice a session should get, or null. `ignoreTold`: the caller restates it whatever was said before. */
export function instructionNoticeFor(record: NoticeRecord, task: InstructionTask, opts?: { ignoreTold?: boolean }): string | null {
  const due = dueLines(record, task, opts?.ignoreTold);
  return due ? render(due) : null;
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

/** The text without an instruction notice leading it (a line handed to a session spawned on the current prompt). */
export function stripInstructionNotice(text: string): string {
  const rest = text.trimStart();
  if (!rest.startsWith(NOTICE_OPENING)) return text;
  const end = rest.indexOf('</walnut-message>');
  return end < 0 ? text : rest.slice(end + '</walnut-message>'.length).trimStart();
}

export interface PendingInstructionNotice {
  text: string;
  /**
   * Inside the queue lock: the text with the notice leading it, or the text
   * unchanged (a slash command, one that already leads with it, or a line
   * frozen in the last minute already carries it). Claims the notice.
   */
  apply(text: string): string;
}

/**
 * Notices frozen into a line not yet delivered: two freezes racing into one
 * session carry it once. A claim lapses, so a line that never reached the CLI
 * (a stop parked it, the user discarded it) leaves the notice to a later one.
 */
const claims = new Map<string, { key: string; at: number }>();
const CLAIM_MS = 60_000;

/** What counts as told once `lines` reached the session: added to what this prompt and boundary were told. */
function notedOf(record: NoticeRecord, lines: Changed[], extra?: Partial<Noted>): Noted {
  const before = sameBase(record.taskRoutingNoted, record) ? record.taskRoutingNoted.lines ?? [] : [];
  const told = [...new Set([...before, ...lines.map((c) => hash(c.line))])];
  return { version: hash(told.join('|')), promptHash: hash(record.appliedAppendSystemPrompt ?? ''),
    ...(record.lastCompactUuid ? { compactUuid: record.lastCompactUuid } : {}), lines: told, ...extra };
}

async function recordTold(sessionId: string, noted: Noted): Promise<void> {
  const { updateSessionRecordConditionally } = await import('../session-tracker.js');
  await updateSessionRecordConditionally(sessionId, { taskRoutingNoted: noted }, () => true, { preserveLastActiveAt: true })
    .catch((error) => log.session.warn('Instruction notice: could not record it as told', { sessionId, error: String(error) }));
}

async function lookup(sessionId: string): Promise<{ record: SessionRecord; lines: Changed[]; text: string } | null> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record?.taskId) return null;
  const { listTasksByIds } = await import('../task-manager.js');
  const [task] = await listTasksByIds([record.taskId]);
  if (!task) return null;
  const lines = dueLines(record, task);
  return lines ? { record, lines, text: render(lines) } : null;
}

/** The notice the next frozen line into this session should carry, or null. Never throws. */
export async function instructionNoticeForSession(sessionId: string): Promise<PendingInstructionNotice | null> {
  try {
    const found = await lookup(sessionId);
    if (!found) return null;
    const { text } = found;
    const key = hash(text);
    return {
      text,
      apply: (input) => {
        const claim = claims.get(sessionId);
        if (claim && claim.key === key && Date.now() - claim.at < CLAIM_MS) return input;
        const out = withInstructionNotice(input, text);
        if (out !== input) claims.set(sessionId, { key, at: Date.now() });
        return out;
      },
    };
  } catch (error) {
    log.session.warn('Instruction notice could not be checked', { sessionId, error: String(error) });
    return null;
  }
}

/**
 * Lines that reached the CLI (session-message-queue.ts removeProcessed): one
 * led by the current notice records its lines as told. Never throws.
 */
export async function noteInstructionNoticeDelivered(sessionId: string, messages: string[]): Promise<void> {
  if (!messages.some((m) => m.trimStart().startsWith(NOTICE_OPENING))) return;
  try {
    const found = await lookup(sessionId);
    if (!found || !messages.some((m) => m.trimStart().startsWith(found.text))) return;
    claims.delete(sessionId);
    await recordTold(sessionId, notedOf(found.record, found.lines));
    log.session.info('Instruction notice delivered', { sessionId, lines: found.lines.length });
  } catch (error) {
    log.session.warn('Instruction notice: delivery not recorded', { sessionId, error: String(error) });
  }
}

/**
 * The compaction hook restated every changed line: told for the boundary it
 * answers, which the server may record before or after (place-notice.ts
 * notePlaceCompaction carries a fresh hook statement onto the new boundary).
 * The hook's statement is a new base, so only its lines count. Never throws.
 */
export async function noteInstructionNoticeStatedByHook(record: SessionRecord, task: InstructionTask): Promise<void> {
  try {
    const lines = dueLines(record, task, true) ?? [];
    const fresh = { ...record, taskRoutingNoted: undefined };
    await recordTold(record.claudeSessionId, notedOf(fresh, lines, { byHookAt: new Date().toISOString() }));
  } catch { /* told again on the next line */ }
}

const HOST_NOTICE_ACTIVE_MS = 24 * 60 * 60_000;

/** The key naming what is due: which lines, against which prompt and compaction. */
function dueKey(record: NoticeRecord, lines: Changed[]): string {
  return hash(JSON.stringify([record.appliedAppendSystemPrompt ? hash(record.appliedAppendSystemPrompt) : '',
    record.lastCompactUuid ?? '', lines.map((c) => hash(c.line))]));
}

/**
 * The host slice's view (host-slice.ts): the notice and a key naming this "due"
 * (lines, prompt, compaction), only while the session has lines to be told. The
 * host delivers same-host messages itself (offline-host-core.ts handleLocal), so
 * it adds the notice once per key and journals the key with that delivery.
 */
export function instructionNoticeForHost(
  record: NoticeRecord & Pick<SessionRecord, 'process_status' | 'lastActiveAt'>, task: InstructionTask, now = Date.now(),
): { policy: string; due: string } | null {
  // Only a session that may take a line soon: the slice rides every push to the
  // host, and an idle one is told by whichever path reaches it first later.
  const active = record.process_status === 'running'
    || now - Date.parse(record.lastActiveAt ?? '') < HOST_NOTICE_ACTIVE_MS;
  if (!active) return null;
  const lines = dueLines(record, task);
  return lines ? { policy: render(lines), due: dueKey(record, lines) } : null;
}

/** A host journaled a delivery led by the notice under `due`: told, if that is still what was due. Never throws. */
export async function noteInstructionNoticeToldByHost(sessionId: string, due: string): Promise<void> {
  try {
    const found = await lookup(sessionId);
    if (!found || dueKey(found.record, found.lines) !== due) return;
    claims.delete(sessionId);
    await recordTold(sessionId, notedOf(found.record, found.lines));
  } catch (error) {
    log.session.warn('Instruction notice: host delivery not recorded', { sessionId, error: String(error) });
  }
}
