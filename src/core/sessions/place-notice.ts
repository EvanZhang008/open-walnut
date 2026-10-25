/**
 * Place notice: a session learns where its task stands now (project, folder,
 * leader) when that is not what it was last told.
 *
 * The session prompt states the place at spawn (session-context.ts), but every
 * cold resume re-sends the spawn-time prompt byte for byte
 * (`appliedAppendSystemPrompt`, kept for the prompt cache), and a live CLI never
 * reads a prompt again. So a task the user moves keeps a session that believes
 * the old place: 2026-10-14, a leader moved into another project a week earlier
 * still read its old project in its prompt, named it in task_create, and filed
 * its subtask outside the team.
 *
 * The rule: the place a session was told is background state. When it differs
 * from the task's live place, the NEXT message delivered into the session (a
 * human, a peer, a trigger, a Walnut notice) carries a short note first, in the
 * same queue row, so it costs no turn of its own and never interrupts one.
 * What it was told:
 *   - the note it last got (`placeNoted`), while the session still runs on the
 *     prompt that note was written against (`promptHash`) and no compaction
 *     came after it (`compactUuid`: a summary is the model's own writing and
 *     may drop the note, the way Claude Code re-attaches its own state after a
 *     compaction instead of trusting the summary);
 *   - else the place in its stored prompt's task and leader lines;
 *   - else the project stamped on its record at start (no folder, no leader).
 * Personal AI asks are never told: their own `Ask …` project is not a place for
 * work. Only the leader tells (it holds the live tasks). Best effort: nothing
 * here ever fails a send.
 */

import { createHash } from 'node:crypto';
import { log } from '../../logging/index.js';
import type { SessionRecord, Task } from '../types.js';
import { createEnvelopeKit } from '../peers/envelope-kit.js';
import { isAskTask, sameProject } from './caller-placement.js';

const kit = createEnvelopeKit();

/** Where a task stands. A missing folder or leader = it has none. */
export interface SessionPlace {
  project: string;
  folderId?: string;
  folder?: string;
  leaderId?: string;
  leader?: string;
}

/** What the session was told. `undefined` = never said, so never compared. */
export interface ToldPlace {
  project: string;
  folderId?: string;
  /** null = told it has no folder. */
  folder?: string | null;
  /** null = told it has no leader. */
  leaderId?: string | null;
}

/** The record field: the last note, and the prompt it was written against. */
export interface PlaceNoted extends SessionPlace {
  promptHash: string;
  /** The compaction the note came after (`SessionRecord.lastCompactUuid` then). */
  compactUuid?: string;
  /** Set when the post-compaction hook stated it: the boundary it answered may be read later. */
  byHookAt?: string;
}

/** A hook statement this fresh belongs to the next boundary the server reads. */
const HOOK_BOUNDARY_MS = 5 * 60_000;

export function promptHash(prompt: string | undefined): string {
  return createHash('sha1').update(prompt ?? '').digest('hex').slice(0, 16);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The place a session prompt states (session-context.ts writes these lines).
 * Null when the prompt has no task line for this task.
 */
export function placeFromPrompt(prompt: string | undefined, taskId: string): ToldPlace | null {
  if (!prompt || !taskId) return null;
  const line = new RegExp(
    `\\(id ${escapeRe(taskId)}, (?:project "(.*?)"|the Inbox \\(no project\\))(?:, folder "(.*?)")?\\)\\.(?:\\n|$)`,
  ).exec(prompt);
  if (!line) return null;
  const leader = /Your task is a subtask of ".*?" \(id ([^\s)]+)\)/.exec(prompt);
  return { project: line[1] ?? '', folder: line[2] ?? null, leaderId: leader ? leader[1] : null };
}

/** What changed, oldest-first wording; empty = the session already knows. */
export function placeChanges(told: ToldPlace, live: SessionPlace): string[] {
  const changes: string[] = [];
  const name = (p: string) => (p.trim() ? `project "${p.trim()}"` : 'the Inbox');
  if (!sameProject(told.project, live.project)) changes.push(`${name(told.project)} became ${name(live.project)}`);
  if (told.folder !== undefined) {
    const same = told.folderId !== undefined
      ? (told.folderId || undefined) === live.folderId
      : (told.folder ?? undefined) === live.folder;
    if (!same) {
      changes.push(live.folder
        ? `folder ${told.folder ? `"${told.folder}"` : 'none'} became "${live.folder}"`
        : `it left folder "${told.folder}"`);
    }
  }
  if (told.leaderId !== undefined && (told.leaderId || undefined) !== live.leaderId) {
    changes.push(live.leaderId ? 'it has a new leader' : 'it no longer has a leader');
  }
  return changes;
}

/** The envelope the session reads ahead of the message it came with. */
export function buildPlaceNoticeText(task: Pick<Task, 'id' | 'title'>, live: SessionPlace, changes: string[]): string {
  const where = [
    live.project.trim() ? `project "${live.project.trim()}"` : 'the Inbox (no project)',
    ...(live.folder ? [`folder "${live.folder}"`] : []),
  ].join(', ');
  const leader = live.leaderId
    ? ` Its leader is "${kit.sessionHandle(live.leader, undefined) || 'untitled'}" (${live.leaderId}).`
    : '';
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', about: kit.sessionHandle(task.title, undefined) || 'untitled', 'about-task': task.id, outcome: 'moved', note: 'automated Walnut status notice' },
    body: `Your task "${task.title}" (${task.id}) now stands in ${where}.${leader} `
      + `This changed since your session was told (${changes.join('; ')}); trust this over your prompt. `
      + 'Work you create lands here unless you name another project. A status notice, not a request: nothing waits on an answer.',
  });
}

/** The task's live place, with folder and leader names. */
export async function livePlaceOf(task: Task): Promise<SessionPlace> {
  const { getTask, listFolderLabels } = await import('../task-manager.js');
  const folderId = task.group_id || undefined;
  const folder = folderId ? (await listFolderLabels().catch(() => new Map<string, string>())).get(folderId) : undefined;
  const leaderId = task.parent_task_id || undefined;
  const leader = leaderId ? (await getTask(leaderId).catch(() => null))?.title : undefined;
  return {
    project: task.project ?? '',
    ...(folderId ? { folderId } : {}),
    ...(folder ? { folder } : {}),
    ...(leaderId ? { leaderId } : {}),
    ...(leader ? { leader } : {}),
  };
}

export function toldPlaceOf(
  record: Pick<SessionRecord, 'appliedAppendSystemPrompt' | 'project' | 'placeNoted' | 'lastCompactUuid'>, taskId: string,
): ToldPlace {
  const hash = promptHash(record.appliedAppendSystemPrompt);
  const noted = record.placeNoted;
  if (noted && noted.promptHash === hash && (noted.compactUuid ?? '') === (record.lastCompactUuid ?? '')) {
    return { project: noted.project, folderId: noted.folderId ?? '', folder: noted.folder ?? null, leaderId: noted.leaderId ?? null };
  }
  return placeFromPrompt(record.appliedAppendSystemPrompt, taskId) ?? { project: record.project ?? '' };
}

function notedFor(record: Pick<SessionRecord, 'appliedAppendSystemPrompt' | 'lastCompactUuid'>, live: SessionPlace): PlaceNoted {
  return {
    ...live, promptHash: promptHash(record.appliedAppendSystemPrompt),
    ...(record.lastCompactUuid ? { compactUuid: record.lastCompactUuid } : {}),
  };
}

async function recordTold(sessionId: string, noted: PlaceNoted): Promise<void> {
  const { updateSessionRecordConditionally } = await import('../session-tracker.js');
  await updateSessionRecordConditionally(sessionId, { placeNoted: noted }, () => true, { preserveLastActiveAt: true })
    .catch((err) => log.session.warn('place notice: could not record it as told', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    }));
}

/**
 * A compaction boundary in the session's stream: a note given before it no
 * longer counts as told, and neither does the rich-output instruction.
 * Idempotent per boundary (a replayed tail writes the
 * same uuid). Never throws.
 */
export async function notePlaceCompaction(sessionId: string, boundaryUuid: string, now = Date.now()): Promise<void> {
  try {
    const { getSessionByClaudeId, updateSessionRecordConditionally } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    if (!record || record.lastCompactUuid === boundaryUuid) return;
    // The CLI runs the hook right after it compacts, and the server may read the
    // boundary only after that: a fresh hook statement made after the last
    // boundary Walnut read answered THIS one. One made before it answered that one.
    const noted = record.placeNoted;
    const hookAt = noted?.byHookAt ? Date.parse(noted.byHookAt) : NaN;
    const answered = (at: number) => Number.isFinite(at) && now - at < HOOK_BOUNDARY_MS
      && (!record.lastCompactAt || at > Date.parse(record.lastCompactAt));
    const hookAnswered = answered(hookAt);
    const modeHookAnswered = answered(record.outputModeHookAt ? Date.parse(record.outputModeHookAt) : NaN);
    // The task routing rules the hook restated (task-routing-notice.ts) answer this boundary too.
    const routing = record.taskRoutingNoted;
    const routingHookAnswered = !!routing?.byHookAt && answered(Date.parse(routing.byHookAt));
    await updateSessionRecordConditionally(sessionId, {
      lastCompactUuid: boundaryUuid,
      lastCompactAt: new Date(now).toISOString(),
      // The summary drops the rich-output instruction too: back to "never told",
      // so the next send carries it in full (output-mode.ts), unless the hook
      // already restated it for this compaction. Same guarded write, so a
      // replayed boundary never voids an instruction sent after it.
      ...(modeHookAnswered ? {} : { output_mode_injected: undefined }),
      ...(hookAnswered && noted ? { placeNoted: { ...noted, compactUuid: boundaryUuid } } : {}),
      ...(routingHookAnswered && routing ? { taskRoutingNoted: { ...routing, compactUuid: boundaryUuid } } : {}),
    }, (cur) => cur.lastCompactUuid !== boundaryUuid, { preserveLastActiveAt: true });
  } catch (err) {
    log.session.warn('place notice: compaction not recorded', { sessionId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * The place to state right after a compaction (the open_items hook puts it into
 * the context), recorded as told. A compaction keeps the system prompt and
 * summarizes the rest, so the session surely knows its prompt's place and maybe
 * not a note: the place is stated only when it is not the prompt's. Null when
 * there is nothing to state: no task, an ask, a replica, or the prompt is still
 * right. Never throws.
 */
export async function statePlaceAfterCompaction(record: SessionRecord, task: Task): Promise<SessionPlace | null> {
  try {
    const { role } = await import('../server-role.js');
    if (role() !== 'leader' || isAskTask(task)) return null;
    const live = await livePlaceOf(task);
    const prompt = placeFromPrompt(record.appliedAppendSystemPrompt, task.id) ?? { project: record.project ?? '' };
    if (placeChanges(prompt, live).length === 0) return null;
    await recordTold(record.claudeSessionId, { ...notedFor(record, live), byHookAt: new Date().toISOString() });
    return live;
  } catch {
    return null;
  }
}

/**
 * Notes handed out but maybe not yet recorded: two sends racing into one
 * session carry the note once. A claim lapses, so a send that failed after
 * taking it leaves the note to a later message.
 */
const claims = new Map<string, { key: string; at: number }>();
const CLAIM_MS = 60_000;

export interface PendingPlaceNotice {
  text: string;
  /** Record that the session was told; call once the row holding `text` is queued. */
  markTold(): Promise<void>;
}

/** The note the next message into this session should carry, or null. Never throws. */
export async function pendingPlaceNotice(sessionId: string): Promise<PendingPlaceNotice | null> {
  try {
    // The leader holds the live tasks and records; a replica's copies may lag.
    const { role } = await import('../server-role.js');
    if (role() !== 'leader') return null;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    if (!record?.taskId) return null;
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(record.taskId).catch(() => null);
    if (!task || isAskTask(task)) return null;
    const live = await livePlaceOf(task);
    const changes = placeChanges(toldPlaceOf(record, task.id), live);
    if (changes.length === 0) return null;
    const noted = notedFor(record, live);
    const key = JSON.stringify(noted);
    const claim = claims.get(sessionId);
    if (claim && claim.key === key && Date.now() - claim.at < CLAIM_MS) return null;
    claims.set(sessionId, { key, at: Date.now() });
    return {
      text: buildPlaceNoticeText(task, live, changes),
      markTold: async () => {
        await recordTold(sessionId, noted);
        // The record holds it now; the claim only bridged the write.
        if (claims.get(sessionId)?.key === key) claims.delete(sessionId);
        log.session.info('place notice queued', { sessionId, taskId: task.id, changes });
      },
    };
  } catch (err) {
    log.session.warn('place notice skipped', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
