/**
 * App state: a plugin App shares what it shows with the AI working on a task.
 *
 * An App that embeds a session (an editor beside an AI partner, a dashboard
 * beside an assistant) knows things the session cannot see: the code typed but
 * not saved, the last test run, the attempt clock. The plugin publishes that as
 * one small JSON object per task (`walnut.appState.publish`). Walnut keeps the
 * latest copy in memory and tells the session in one of two ways:
 *
 *   - passive (the default): nothing is sent on publish. The NEXT message into
 *     the session (the person typing, a peer, a trigger) carries a
 *     `<walnut-message kind="app-state">` ahead of it, in the same queue row, so
 *     it costs no turn and never interrupts one (the place notice's rule,
 *     place-notice.ts). Typing for ten minutes and then asking a question sends
 *     one note, not a stream.
 *   - proactive: the same note also starts a turn of its own, debounced and at
 *     most one a minute per plugin and task, for a change the AI should react to
 *     without being asked (the attempt finished).
 *
 * The first note a session gets holds the whole object; after that only what
 * changed since the copy THAT session last read (app-state-render.ts): a value
 * per line, a line patch for an edited text. What a session was told is kept per
 * session, so a new session on the task, or a compaction (whose summary may
 * drop the note), starts again from the whole object. The session can always
 * read all of it with the `app_state` op (GET /api/v1/me/app-state).
 *
 * In memory on purpose: it is what an App shows right now, and an App publishes
 * it again when it opens. A restart loses it and the next note is a full one.
 * Only the leader keeps it (it owns the queue); a replica's publish is a no-op.
 * Nothing here ever fails a send.
 */

import { log } from '../../logging/index.js';
import { createEnvelopeKit } from '../peers/envelope-kit.js';
import { renderChanges, renderFull, type JsonObject } from './app-state-render.js';

const kit = createEnvelopeKit();

export type AppStateMode = 'passive' | 'proactive';

export interface AppStatePublishInput {
  taskId: string;
  state: Record<string, unknown>;
  mode?: AppStateMode;
  /** Shown on the card and to the AI; the plugin's name by default. */
  label?: string;
  /** One sentence told to the AI with the whole state: what it is, what is left out on purpose. */
  note?: string;
}

/** A serialized state above this is refused: it is a status, not a document store. */
export const MAX_STATE_BYTES = 64 * 1024;
/** A note longer than this says which values changed and points at `app_state`. */
export const MAX_NOTE_CHARS = 8_000;
/** (task, plugin) pairs kept; the least recently published goes first. */
const MAX_PUBLISHED = 500;
/** Sessions whose told copies are kept. */
const MAX_TOLD_SESSIONS = 500;
export const PROACTIVE_DEBOUNCE_MS = 2_000;
export const PROACTIVE_MIN_GAP_MS = 60_000;
/** A claim not recorded or released by then is let go (the send died in between). */
const CLAIM_MS = 30_000;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

interface Published {
  owner: string;
  /** The plugin generation that published it (server side); absent for the App in the browser. */
  generation?: string;
  taskId: string;
  label: string;
  note: string;
  state: JsonObject;
  version: number;
  updatedAt: number;
}

interface Told {
  taskId: string;
  state: JsonObject;
  version: number;
  /** The compaction boundary the session was past when told: a later one voids it. */
  compactUuid: string;
}

/** taskId → owner → what the plugin published last. */
const published = new Map<string, Map<string, Published>>();
/** sessionId → owner → what that session last read. */
const told = new Map<string, Map<string, Told>>();
/** sessionId → when a send took the note it is still delivering. */
const claims = new Map<string, number>();
/** `${taskId}\u0000${owner}` → the proactive timer and the last proactive turn. */
const proactive = new Map<string, { timer?: NodeJS.Timeout; lastAt: number }>();
let versionSeq = 0;

function proactiveKey(taskId: string, owner: string): string {
  return `${taskId}\u0000${owner}`;
}

function oneLine(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** A plain JSON object: the round trip drops what JSON cannot carry, and a cycle or BigInt throws. */
function normalizeState(state: unknown): JsonObject {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('App state must be a plain object');
  let json: string;
  try {
    json = JSON.stringify(state);
  } catch (error) {
    throw new TypeError(`App state must be JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_STATE_BYTES) {
    throw new RangeError(`App state is ${Buffer.byteLength(json, 'utf8')} bytes; the limit is ${MAX_STATE_BYTES}. Share a status, and let the AI read files for the rest.`);
  }
  return JSON.parse(json) as JsonObject;
}

function evictPublished(): void {
  let count = 0;
  for (const byOwner of published.values()) count += byOwner.size;
  while (count > MAX_PUBLISHED) {
    let oldest: Published | undefined;
    for (const byOwner of published.values()) {
      for (const entry of byOwner.values()) if (!oldest || entry.updatedAt < oldest.updatedAt) oldest = entry;
    }
    if (!oldest) return;
    dropPublished(oldest.owner, oldest.taskId);
    count--;
  }
}

function dropPublished(owner: string, taskId: string): void {
  const byOwner = published.get(taskId);
  byOwner?.delete(owner);
  if (byOwner && byOwner.size === 0) published.delete(taskId);
  const key = proactiveKey(taskId, owner);
  const timer = proactive.get(key)?.timer;
  if (timer) clearTimeout(timer);
  proactive.delete(key);
}

function rememberTold(sessionId: string, owner: string, entry: Told): void {
  let byOwner = told.get(sessionId);
  if (!byOwner) {
    byOwner = new Map();
    told.set(sessionId, byOwner);
    // Map order is insertion order: the first key is the session told longest ago.
    while (told.size > MAX_TOLD_SESSIONS) told.delete(told.keys().next().value as string);
  }
  byOwner.set(owner, entry);
}

/**
 * Keep the plugin's latest state for the task. Throws on bad input (a missing
 * task, a state that is not a small JSON object) so the plugin hears about it.
 */
export async function publishAppState(
  owner: string,
  ownerName: string,
  input: AppStatePublishInput,
  options: { generation?: string; nowMs?: number } = {},
): Promise<{ version: number; kept: boolean }> {
  const nowMs = options.nowMs ?? Date.now();
  const taskId = typeof input?.taskId === 'string' ? input.taskId.trim() : '';
  if (!TASK_ID_RE.test(taskId)) throw new TypeError('App state needs the id of the task whose session reads it');
  const mode: AppStateMode = input.mode === 'proactive' ? 'proactive' : 'passive';
  if (input.mode !== undefined && input.mode !== 'passive' && input.mode !== 'proactive') {
    throw new TypeError('App state mode is passive or proactive');
  }
  const state = normalizeState(input.state);
  const { role } = await import('../server-role.js');
  if (role() !== 'leader') return { version: 0, kept: false };
  const { getTask } = await import('../task-manager.js');
  const task = await getTask(taskId).catch(() => null);
  if (!task) throw new Error(`No task ${taskId}: app state is shared with the AI working on a task`);

  const entry: Published = {
    owner,
    ...(options.generation ? { generation: options.generation } : {}),
    taskId: task.id,
    label: oneLine(input.label, 80) || ownerName || owner,
    note: oneLine(input.note, 400),
    state,
    version: ++versionSeq,
    updatedAt: nowMs,
  };
  let byOwner = published.get(task.id);
  if (!byOwner) {
    byOwner = new Map();
    published.set(task.id, byOwner);
  }
  byOwner.set(owner, entry);
  evictPublished();
  if (mode === 'proactive') scheduleProactive(task.id, owner, nowMs);
  return { version: entry.version, kept: true };
}

/** Stop sharing: the latest copy and what every session was told about it go away. */
export function clearAppState(owner: string, taskId: string): void {
  dropPublished(owner, taskId);
  for (const [sessionId, byOwner] of told) {
    if (byOwner.get(owner)?.taskId === taskId) byOwner.delete(owner);
    if (byOwner.size === 0) told.delete(sessionId);
  }
}

/**
 * A plugin generation went away (disable, reload, uninstall): what it published
 * goes, and so does what its App published from the browser, which reloads with
 * it and publishes again on open. A newer generation's own publishes stay (a
 * reload can activate the new one before the old one is gone). What sessions
 * were told stays: it is only what they read, so a later diff is still right.
 */
export function disposeAppStateOwner(owner: string, generation?: string): void {
  for (const [taskId, byOwner] of [...published]) {
    const entry = byOwner.get(owner);
    if (entry && (generation === undefined || !entry.generation || entry.generation === generation)) dropPublished(owner, taskId);
  }
}

interface Note {
  owner: string;
  entry: Published;
  text: string;
}

/** Said in a proactive note: it starts a turn, so it is not background. */
const PROACTIVE_LINE = 'The App sent this on its own: something changed that it asks you to look at.';

function buildNote(entry: Published, before: Told | undefined, proactive: boolean): Note | null {
  const intro = entry.note ? `${entry.note}\n` : '';
  let summary: string;
  let body: string;
  if (!before) {
    summary = 'current state';
    body = `${intro}Live state of ${entry.label} for this task, shared by the App. Later messages carry only what changed; `
      + `\`walnut tools call app_state\` reads all of it at any time. ${proactive ? PROACTIVE_LINE : 'Background, not a request.'}\n\n`
      + renderFull(entry.state);
    if (body.length > MAX_NOTE_CHARS) {
      body = `${intro}Live state of ${entry.label} for this task, too long to show here (keys: `
        + `${Object.keys(entry.state).join(', ')}). Read it with \`walnut tools call app_state\`.`;
    }
  } else {
    const changes = renderChanges(before.state, entry.state);
    if (changes.count === 0) return null;
    summary = `${changes.count} change${changes.count === 1 ? '' : 's'}`;
    body = `Changed in ${entry.label} since you last saw it:\n${changes.lines.join('\n')}`;
    if (body.length > MAX_NOTE_CHARS) {
      body = `Changed in ${entry.label} since you last saw it: ${changes.paths.join(', ')}. `
        + 'Too long to show here: read the values with `walnut tools call app_state`.';
    }
  }
  if (proactive && !body.includes(PROACTIVE_LINE)) body += `\n\n${PROACTIVE_LINE}`;
  const text = kit.buildWalnutMessage({
    kind: 'app-state',
    attrs: {
      from: entry.label, 'about-task': entry.taskId, title: summary,
      note: proactive ? 'automated app state, sent by the App' : 'automated app state, background only',
    },
    body,
  });
  return { owner: entry.owner, entry, text };
}

export interface PendingAppState {
  text: string;
  /** The row that holds the text was queued: the session now knows this state. */
  markTold(): void;
  /** The text did not go out: the next message carries it again. */
  release(): void;
}

/**
 * The note the next message into this session should carry, or null. `body`
 * is the message itself: a slash command goes to the CLI raw and carries none.
 * Claimed before it returns, so two racing sends carry the note once.
 */
export async function pendingAppState(
  sessionId: string, body: string, nowMs = Date.now(), options: { proactive?: boolean } = {},
): Promise<PendingAppState | null> {
  // Every send into every session passes here: free unless some plugin shares state.
  if (published.size === 0) return null;
  try {
    if (body.trimStart().startsWith('/')) return null;
    const claimedAt = claims.get(sessionId);
    if (claimedAt !== undefined && nowMs - claimedAt < CLAIM_MS) return null;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    const byOwner = record?.taskId ? published.get(record.taskId) : undefined;
    if (!record || !byOwner || byOwner.size === 0) return null;
    // Re-checked after the await: a racing send may have claimed meanwhile.
    const raced = claims.get(sessionId);
    if (raced !== undefined && nowMs - raced < CLAIM_MS) return null;
    const compactUuid = record.lastCompactUuid ?? '';
    const known = told.get(sessionId);
    const notes: Note[] = [];
    for (const entry of byOwner.values()) {
      const before = known?.get(entry.owner);
      const valid = before && before.taskId === entry.taskId && before.compactUuid === compactUuid ? before : undefined;
      if (valid && valid.version === entry.version) continue;
      const note = buildNote(entry, valid, options.proactive === true);
      if (note) notes.push(note);
    }
    if (notes.length === 0) return null;
    claims.set(sessionId, nowMs);
    let settled = false;
    return {
      text: notes.map((n) => n.text).join('\n\n'),
      markTold: () => {
        if (settled) return;
        settled = true;
        claims.delete(sessionId);
        for (const n of notes) {
          rememberTold(sessionId, n.owner, { taskId: n.entry.taskId, state: n.entry.state, version: n.entry.version, compactUuid });
        }
        log.session.info('app state queued', { sessionId, taskId: record.taskId, plugins: notes.map((n) => n.owner) });
      },
      release: () => {
        if (settled) return;
        settled = true;
        claims.delete(sessionId);
      },
    };
  } catch (err) {
    log.session.warn('app state skipped', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export interface AppStateView {
  plugin: string;
  label: string;
  note?: string;
  version: number;
  updatedAt: string;
  state: JsonObject;
}

/**
 * Everything shared for the caller's task, whole: the `app_state` op. The
 * session has now read all of it, so the next note starts from here.
 */
export async function readAppState(sessionId: string | undefined): Promise<{ taskId: string | null; states: AppStateView[] }> {
  if (!sessionId) return { taskId: null, states: [] };
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record?.taskId) return { taskId: null, states: [] };
  const byOwner = published.get(record.taskId);
  const states: AppStateView[] = [];
  for (const entry of byOwner?.values() ?? []) {
    states.push({
      plugin: entry.owner,
      label: entry.label,
      ...(entry.note ? { note: entry.note } : {}),
      version: entry.version,
      updatedAt: new Date(entry.updatedAt).toISOString(),
      state: entry.state,
    });
    rememberTold(sessionId, entry.owner, {
      taskId: entry.taskId, state: entry.state, version: entry.version, compactUuid: record.lastCompactUuid ?? '',
    });
  }
  return { taskId: record.taskId, states };
}

function scheduleProactive(taskId: string, owner: string, nowMs: number): void {
  const key = proactiveKey(taskId, owner);
  const slot = proactive.get(key) ?? { lastAt: 0 };
  if (slot.timer) clearTimeout(slot.timer);
  // Debounced, and never sooner than a minute after the last proactive turn.
  const at = Math.max(nowMs + PROACTIVE_DEBOUNCE_MS, slot.lastAt + PROACTIVE_MIN_GAP_MS);
  slot.timer = setTimeout(() => {
    slot.timer = undefined;
    void deliverProactive(taskId, owner);
  }, at - nowMs);
  slot.timer.unref?.();
  proactive.set(key, slot);
}

/** Start a turn with the note, in the task's own conversation. Never throws. */
export async function deliverProactive(taskId: string, owner: string, nowMs = Date.now()): Promise<'sent' | 'skipped'> {
  const slot = proactive.get(proactiveKey(taskId, owner));
  try {
    if (!published.get(taskId)?.has(owner)) return 'skipped';
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(taskId).catch(() => null);
    if (!task || task.phase === 'COMPLETE') return 'skipped';
    const { taskConversation } = await import('./task-session-claim.js');
    const target = await taskConversation(taskId);
    if (!target) return 'skipped';
    const pending = await pendingAppState(target.claudeSessionId, '', nowMs, { proactive: true });
    if (!pending) return 'skipped';
    try {
      const { deliverToSession } = await import('./session-send-core.js');
      await deliverToSession(target, { busText: pending.text, enqueueText: pending.text, source: 'app-state', taskId });
      pending.markTold();
    } catch (err) {
      pending.release();
      throw err;
    }
    if (slot) slot.lastAt = nowMs;
    return 'sent';
  } catch (err) {
    log.session.warn('app state: proactive turn not sent', { taskId, owner, error: err instanceof Error ? err.message : String(err) });
    return 'skipped';
  }
}

/** Test seam: forget everything. */
export function resetAppStateForTesting(): void {
  for (const slot of proactive.values()) if (slot.timer) clearTimeout(slot.timer);
  published.clear();
  told.clear();
  claims.clear();
  proactive.clear();
  versionSeq = 0;
}
