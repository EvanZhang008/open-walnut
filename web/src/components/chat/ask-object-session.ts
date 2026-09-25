/**
 * The Walnut session behind an "ask about this object" drawer.
 *
 * An ask about one object (a mail, a Slack message) is an ordinary Ask Walnut session: a task filed
 * under the agent's `Ask …` project with a real session, rendered by the same `SessionPanel` every other
 * session uses. It used to be a lane conversation drawn by `PluginChatView`, which looked and behaved
 * like nothing else in the console (reported 2026-09-25: "please use the same UI like regular session").
 *
 * This module owns the part that is not React:
 *   . which session belongs to which object, remembered in localStorage per (agent, object), so
 *     reopening the same mail lands in the same session;
 *   . which canned questions were already asked in that session, so `Summarize` twice sends once while
 *     `Draft a reply` afterwards still goes out (into the same session);
 *   . the first message: the object's context as a leading `[Name]…[/Name]` block, which the session
 *     panel folds into one disclosure row above the question (`splitLeadingBanners`), so the bubble
 *     reads as what the person asked;
 *   . one launch in flight per (agent, object), because a double click or a StrictMode effect re-run
 *     would otherwise start two sessions and remember whichever landed last.
 *
 * Its own storage prefix, deliberately outside `walnut:ask-object`: that namespace's prune deletes any
 * key it does not recognise, which would erase these on the next page load.
 */
import type { quickStartSession } from '@/api/sessions';
import { presetLatchName } from './ask-object-conversation';

const STORE_PREFIX = 'walnut:ask-session:';
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Canned questions remembered per session. A person asks a handful at most; the cap is a backstop. */
const ASKED_MAX = 16;

export type AskSessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type EnumerableAskSessionStorage = AskSessionStorage & Pick<Storage, 'length' | 'key'>;

/** Which object, under which agent: the same object asked under two agents is two sessions. */
export interface AskSessionScope {
  agentId: string;
  key: string;
}

export interface AskSessionRecord {
  taskId: string;
  /** Absent while an engine that mints its own id has not reported it yet. */
  sessionId?: string;
  /** `presetLatchName` of every canned question already sent into this session. */
  asked: string[];
  /** Last use, for the 30-day prune. */
  at: number;
}

function browserStorage(): AskSessionStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function storeKey(scope: AskSessionScope): string {
  return `${STORE_PREFIX}${scope.agentId}:${scope.key}`;
}

function parseRecord(raw: string | null): AskSessionRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AskSessionRecord> | null;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.taskId !== 'string' || !parsed.taskId) return null;
    return {
      taskId: parsed.taskId,
      ...(typeof parsed.sessionId === 'string' && parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      asked: Array.isArray(parsed.asked) ? parsed.asked.filter((one): one is string => typeof one === 'string') : [],
      at: typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : 0,
    };
  } catch {
    return null;
  }
}

export function readAskSession(
  scope: AskSessionScope,
  storage: AskSessionStorage | undefined = browserStorage(),
): AskSessionRecord | null {
  try {
    return parseRecord(storage?.getItem(storeKey(scope)) ?? null);
  } catch {
    return null;
  }
}

export function writeAskSession(
  scope: AskSessionScope,
  record: AskSessionRecord,
  storage: AskSessionStorage | undefined = browserStorage(),
): void {
  const asked = record.asked.slice(-ASKED_MAX);
  try {
    storage?.setItem(storeKey(scope), JSON.stringify({ ...record, asked }));
  } catch {
    // Quota or private mode: the drawer still works, it just forgets which session was this object's.
  }
}

/** Drop the remembered session (it was deleted), so the next ask starts a new one. */
export function forgetAskSession(
  scope: AskSessionScope,
  storage: AskSessionStorage | undefined = browserStorage(),
): void {
  try { storage?.removeItem(storeKey(scope)); } catch { /* see writeAskSession */ }
}

/** Has this canned question already been sent into the remembered session? */
export function askSessionAsked(record: AskSessionRecord | null, preset: string): boolean {
  return Boolean(record && preset && record.asked.includes(presetLatchName(preset)));
}

/** The record with `preset` noted as asked and its clock re-stamped. */
export function withAsked(record: AskSessionRecord, preset: string | undefined, now: number): AskSessionRecord {
  const name = preset ? presetLatchName(preset) : '';
  return {
    ...record,
    asked: name && !record.asked.includes(name) ? [...record.asked, name] : record.asked,
    at: now,
  };
}

/**
 * The first message about an object: its context as a named leading block, then the question.
 *
 * `bannerName` is what the session panel's disclosure row says (`Mail you are asking about`), so it
 * names the object in the person's words. A name the banner splitter would refuse (brackets, a slash
 * first, too long) is cleaned rather than trusted, because a refused name leaves the whole block in the
 * bubble. An empty context sends the question alone.
 */
export function askObjectFirstMessage(bannerName: string, contextBlock: string, question: string): string {
  const context = contextBlock.trim();
  const asked = question.trim();
  if (!context) return asked;
  const name = bannerName.replace(/[[\]]/g, '').replace(/^\/+/, '').replace(/\s+/g, ' ').trim().slice(0, 60)
    || 'Context';
  return `[${name}]\n${context}\n[/${name}]\n\n${asked}`;
}

export type AskSessionLaunch = Parameters<typeof quickStartSession>[0];

export interface AskSessionLaunchDeps {
  storage?: AskSessionStorage;
  start?: (payload: AskSessionLaunch) => Promise<{ taskId: string; sessionId?: string }>;
  now?: () => number;
}

/** What a launch call gets back. `joined`: another call's launch was already out, so THIS call's
 *  message was never sent (the caller sends it into the session if it still matters). */
export interface AskSessionLaunched {
  record: AskSessionRecord;
  joined: boolean;
}

const inFlight = new Map<string, Promise<AskSessionRecord>>();

/**
 * Start the session for this object and remember it. One launch in flight per scope: a second call
 * while the first is out joins it (`joined: true`), so a double click or an effect re-run makes one
 * session. Throws when the server refuses; nothing is remembered then.
 */
export async function launchAskSession(
  scope: AskSessionScope,
  payload: AskSessionLaunch,
  preset: string | undefined,
  deps: AskSessionLaunchDeps = {},
): Promise<AskSessionLaunched> {
  const flightKey = `${scope.agentId}\u0000${scope.key}`;
  const pending = inFlight.get(flightKey);
  if (pending) return { record: await pending, joined: true };
  // Loaded on first use rather than imported: the API module pulls the socket client in, and this file's
  // rules are graded without a DOM.
  const start = deps.start ?? ((body: AskSessionLaunch) => import('@/api/sessions').then((api) => api.quickStartSession(body)));
  const now = deps.now ?? Date.now;
  const launched = start(payload).then((result) => {
    const record = withAsked({
      taskId: result.taskId,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      asked: [],
      at: now(),
    }, preset, now());
    writeAskSession(scope, record, deps.storage ?? browserStorage());
    return record;
  }).finally(() => { inFlight.delete(flightKey); });
  inFlight.set(flightKey, launched);
  return { record: await launched, joined: false };
}

/** Remove records unused for 30 days, and anything under the prefix that is not a record. */
export function pruneAskSessions(storage: EnumerableAskSessionStorage, now: number = Date.now()): number {
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !key.startsWith(STORE_PREFIX)) continue;
    let record: AskSessionRecord | null = null;
    try { record = parseRecord(storage.getItem(key)); } catch { record = null; }
    if (!record || now - record.at > PRUNE_AFTER_MS) doomed.push(key);
  }
  for (const key of doomed) {
    try { storage.removeItem(key); } catch { /* see writeAskSession */ }
  }
  return doomed.length;
}

try {
  if (typeof localStorage !== 'undefined') pruneAskSessions(localStorage);
} catch {
  // No DOM (unit tests) or storage disabled: nothing to prune.
}
