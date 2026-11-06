/**
 * App brief: background a plugin gives the AI working on a task, for the AI only.
 *
 * App state (app-state.ts) is a status the App shows, and the person sees every
 * note of it. Some things an App knows are for the AI and not for the person
 * yet: the rubric an interviewer grades by, the notes behind a quiz, a reference
 * the AI should guide toward without showing. The plugin sets that as one text
 * per task (`walnut.appState.setBrief`, server side only: the App in the browser
 * can neither set nor read it), and Walnut tells it:
 *
 *   - whole, once per session, ahead of the next message into it (the same row
 *     as an app-state note, so it costs no turn);
 *   - again after a compaction, whose summary may drop it (a new boundary voids
 *     what the session was told), and the compaction hook says it is coming;
 *   - ahead of the first message of a session Walnut starts for the task too
 *     (task-start.ts), an engine switch's included;
 *   - again when a queued row that carried it is discarded, or edited into a
 *     command, before it reached the model (session-message-queue.ts);
 *   - again when the plugin sets a different text: only the added part when the
 *     new text extends the old one, else the new text whole.
 *
 * Never cut: a brief longer than MAX_BRIEF_BYTES is refused at set, so the AI
 * never gets a pointer in place of the text it must hold. The envelope carries
 * `ai-only="true"` and leads the line, and every view a person reads shows its
 * fold, never its body (lib/ai-only-envelope.ts); `app_state` names it without
 * its text, since a tool result is a view too. In memory on the leader, like app state: a
 * restart forgets it, and the plugin sets it again when its App opens.
 */

import { createEnvelopeKit } from '../peers/envelope-kit.js';

const kit = createEnvelopeKit();

/** A brief above this is refused: it is told whole every time, so it must fit a message. */
export const MAX_BRIEF_BYTES = 48 * 1024;
/** (task, plugin) briefs kept; the least recently set goes first. */
const MAX_BRIEFS = 500;
/** Sessions whose told copies are kept. */
const MAX_TOLD_SESSIONS = 500;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export interface AppBriefInput {
  taskId: string;
  text: string;
  /** Shown on the fold and to the AI; the plugin's name by default. */
  label?: string;
}

interface Brief {
  owner: string;
  generation?: string;
  taskId: string;
  label: string;
  text: string;
  version: number;
  updatedAt: number;
}

interface BriefTold {
  taskId: string;
  text: string;
  version: number;
  compactUuid: string;
}

/** taskId → owner → the brief the plugin set last. */
const briefs = new Map<string, Map<string, Brief>>();
/** sessionId → owner → the brief that session was told last. */
const told = new Map<string, Map<string, BriefTold>>();
let versionSeq = 0;

function oneLine(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function dropBrief(owner: string, taskId: string): void {
  const byOwner = briefs.get(taskId);
  byOwner?.delete(owner);
  if (byOwner && byOwner.size === 0) briefs.delete(taskId);
}

function evict(): void {
  let count = 0;
  for (const byOwner of briefs.values()) count += byOwner.size;
  while (count > MAX_BRIEFS) {
    let oldest: Brief | undefined;
    for (const byOwner of briefs.values()) {
      for (const entry of byOwner.values()) if (!oldest || entry.updatedAt < oldest.updatedAt) oldest = entry;
    }
    if (!oldest) return;
    dropBrief(oldest.owner, oldest.taskId);
    count--;
  }
}

/** True when some plugin holds a brief: the send path is free otherwise. */
export function anyAppBrief(): boolean {
  return briefs.size > 0;
}

/**
 * Keep the plugin's brief for the task; an empty text clears it. The same text
 * again keeps its version, so a session already told is not told twice. Throws
 * on bad input so the plugin hears about it.
 */
export async function setAppBrief(
  owner: string,
  ownerName: string,
  input: AppBriefInput,
  options: { generation?: string; nowMs?: number } = {},
): Promise<{ version: number; kept: boolean }> {
  const nowMs = options.nowMs ?? Date.now();
  const taskId = typeof input?.taskId === 'string' ? input.taskId.trim() : '';
  if (!TASK_ID_RE.test(taskId)) throw new TypeError('An App brief needs the id of the task whose session reads it');
  if (typeof input.text !== 'string') throw new TypeError('An App brief is text');
  const text = input.text.trim();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BRIEF_BYTES) {
    throw new RangeError(`App brief is ${bytes} bytes; the limit is ${MAX_BRIEF_BYTES}. It is told whole each time: keep what the AI must hold, and let it read files for the rest.`);
  }
  const { role } = await import('../server-role.js');
  if (role() !== 'leader') return { version: 0, kept: false };
  const { getTask } = await import('../task-manager.js');
  const task = await getTask(taskId).catch(() => null);
  if (!task) throw new Error(`No task ${taskId}: an App brief is for the AI working on a task`);
  if (!text) {
    clearAppBrief(owner, task.id);
    return { version: 0, kept: true };
  }
  // No angle brackets: the label is an attribute every reader parses (lib/ai-only-envelope.ts).
  const label = (oneLine(input.label, 80) || ownerName || owner).replace(/[<>]/g, '');
  const current = briefs.get(task.id)?.get(owner);
  const same = current && current.text === text && current.label === label;
  const entry: Brief = {
    owner,
    ...(options.generation ? { generation: options.generation } : {}),
    taskId: task.id,
    label,
    text,
    version: same ? current.version : ++versionSeq,
    updatedAt: nowMs,
  };
  let byOwner = briefs.get(task.id);
  if (!byOwner) {
    byOwner = new Map();
    briefs.set(task.id, byOwner);
  }
  byOwner.set(owner, entry);
  evict();
  return { version: entry.version, kept: true };
}

/** Stop briefing: the brief and what every session was told of it go away. */
export function clearAppBrief(owner: string, taskId: string): void {
  dropBrief(owner, taskId);
  for (const [sessionId, byOwner] of told) {
    if (byOwner.get(owner)?.taskId === taskId) byOwner.delete(owner);
    if (byOwner.size === 0) told.delete(sessionId);
  }
}

/** A plugin generation went away: its briefs go; a newer generation's stay (app-state.ts disposeAppStateOwner). */
export function disposeAppBriefOwner(owner: string, generation?: string): void {
  for (const [taskId, byOwner] of [...briefs]) {
    const entry = byOwner.get(owner);
    if (entry && (generation === undefined || !entry.generation || entry.generation === generation)) dropBrief(owner, taskId);
  }
}

export interface BriefNote {
  owner: string;
  taskId: string;
  text: string;
  version: number;
  body: string;
}

const FOR_YOU = 'It is for you only: the person does not see it in this conversation, and the App shows them what it decides to, when it decides to. Do not quote it or paste it to them unless they ask for it and the App\'s rules allow it.';

function buildNote(entry: Brief, before: BriefTold | undefined): BriefNote {
  let title: string;
  let body: string;
  if (!before) {
    title = 'brief';
    body = `${entry.label}'s brief for the AI on this task. ${FOR_YOU} Walnut tells it once, and again after a compaction; hold it for the rest of the task.\n\n${entry.text}`;
  } else if (entry.text.startsWith(before.text)) {
    title = 'brief, added to';
    body = `Added to ${entry.label}'s brief (the rest is as you were told, and the same rules hold):\n\n${entry.text.slice(before.text.length).trim()}`;
  } else {
    title = 'brief, replaced';
    body = `${entry.label}'s brief changed. This replaces the one before it, whole. ${FOR_YOU}\n\n${entry.text}`;
  }
  const text = kit.buildWalnutMessage({
    kind: 'app-state',
    attrs: {
      from: entry.label, 'about-task': entry.taskId, title,
      note: 'automated App brief, for the AI only', 'ai-only': 'true',
    },
    body,
  });
  return { owner: entry.owner, taskId: entry.taskId, text: entry.text, version: entry.version, body: text };
}

/** The brief notes this session should get with its next message: one per plugin whose brief it lacks. */
export function dueBriefNotes(sessionId: string, taskId: string, compactUuid: string): BriefNote[] {
  const byOwner = briefs.get(taskId);
  if (!byOwner || byOwner.size === 0) return [];
  const known = told.get(sessionId);
  const notes: BriefNote[] = [];
  for (const entry of byOwner.values()) {
    const before = known?.get(entry.owner);
    const valid = before && before.taskId === entry.taskId && before.compactUuid === compactUuid ? before : undefined;
    if (valid && valid.version === entry.version) continue;
    notes.push(buildNote(entry, valid));
  }
  return notes;
}

/** The session now holds these briefs, on this compaction boundary. */
export function rememberBriefsTold(sessionId: string, notes: Array<Pick<BriefNote, 'owner' | 'taskId' | 'text' | 'version'>>, compactUuid: string): void {
  if (notes.length === 0) return;
  let byOwner = told.get(sessionId);
  if (!byOwner) {
    byOwner = new Map();
    told.set(sessionId, byOwner);
    while (told.size > MAX_TOLD_SESSIONS) told.delete(told.keys().next().value as string);
  }
  for (const n of notes) byOwner.set(n.owner, { taskId: n.taskId, text: n.text, version: n.version, compactUuid });
}

/** What the session was told goes: a row that carried it never reached the model. */
export function forgetBriefsTold(sessionId: string): void {
  told.delete(sessionId);
}

export interface AppBriefView {
  plugin: string;
  label: string;
  version: number;
  updatedAt: string;
  bytes: number;
}

/**
 * The briefs of the task, without their text, for the session's own read (`app_state`): a tool
 * result is a view the person reads (the web's expanded tool, the phone's preview), so the text
 * reaches the model only as a note ahead of a message.
 */
export function briefsOf(taskId: string): AppBriefView[] {
  return [...(briefs.get(taskId)?.values() ?? [])].map((entry) => ({
    plugin: entry.owner,
    label: entry.label,
    version: entry.version,
    updatedAt: new Date(entry.updatedAt).toISOString(),
    bytes: Buffer.byteLength(entry.text, 'utf8'),
  }));
}

/**
 * One line for the compaction hook (open-items.ts): the brief may be gone from
 * the summary, and it comes back whole with the next message. Never the text:
 * the hook's room is small and the person reads the hook's output.
 */
export function briefAfterCompactionLine(taskId: string): string {
  const labels = [...(briefs.get(taskId)?.values() ?? [])].map((b) => b.label);
  if (labels.length === 0) return '';
  return `The App brief from ${labels.join(' and ')} (for the AI only) may be missing from this summary: it comes again, whole, ahead of the next message.`;
}

/** Test seam: forget everything. */
export function resetAppBriefsForTesting(): void {
  briefs.clear();
  told.clear();
  versionSeq = 0;
}
