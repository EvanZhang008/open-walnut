/**
 * Launch prompts: the first message of a session that just started, held until
 * the CLI's transcript can show it.
 *
 * A composer send gets an optimistic bubble the moment Enter is pressed. A LAUNCH
 * prompt never did: the server hands it to the CLI at spawn, and the only thing
 * that could show it was persisted history. The CLI writes that line only after
 * it boots (measured 2026-09-28: 6.4s from spawn to init on the Mac), and the
 * panel's opening fetches land long before, so a fresh session showed "Claude
 * Code is working…" over an empty timeline. The turn-start refetch
 * (web/src/components/sessions/turn-prompt-refetch.ts) shortened that to "until
 * the model's first output", which was still 13s on the reported session.
 *
 * So the server keeps what it launched with, and `session:get-queue` (which every
 * panel calls as it opens) returns it next to the queue. The panel shows it as the
 * turn's first bubble and drops it as soon as history holds a user row. That works
 * for every opener, not just the tab that pressed Start: a reload, a second window,
 * a session an agent started.
 *
 * In memory on purpose. The entry only matters for the seconds between spawn and
 * the first transcript line; losing it on a restart only brings back the old wait,
 * which the turn-start refetch still covers.
 */
import { bus, eventData } from '../event-bus.js';
import { launchNamingText } from './launch-naming.js';

export interface LaunchPrompt {
  /** Stable per session, so a re-read never mints a second bubble. */
  id: string;
  /** The human's words (see launch-naming.ts), not the wire message. */
  text: string;
  /** ISO time the launch was recorded. */
  at: string;
}

/** The first turn is long over by then; the cap only bounds a session whose
 *  result never arrived. */
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 200;
/** A prompt this large was spilled to a file anyway (quick-start-spill.ts), so
 *  the text is a short pointer. Past this we keep nothing rather than a copy of it. */
const MAX_TEXT_CHARS = 100_000;

const entries = new Map<string, LaunchPrompt & { expiresAt: number }>();

export function launchPromptId(sessionId: string): string {
  return `launch-${sessionId}`;
}

export function noteLaunchPrompt(sessionId: string, text: string, now = Date.now()): void {
  if (!sessionId || !text.trim() || text.length > MAX_TEXT_CHARS) return;
  entries.delete(sessionId);
  entries.set(sessionId, { id: launchPromptId(sessionId), text, at: new Date(now).toISOString(), expiresAt: now + TTL_MS });
  // Map order is insertion order: the first key is the oldest launch.
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export function launchPromptFor(sessionId: string, now = Date.now()): LaunchPrompt | undefined {
  const e = entries.get(sessionId);
  if (!e) return undefined;
  if (e.expiresAt <= now) {
    entries.delete(sessionId);
    return undefined;
  }
  return { id: e.id, text: e.text, at: e.at };
}

export function forgetLaunchPrompt(sessionId: string): void {
  entries.delete(sessionId);
}

/** Test hook. */
export function clearLaunchPrompts(): void {
  entries.clear();
}

/**
 * Which starts have a prompt worth holding. Only a start whose session id is
 * known up front (the native engine's pre-assigned id; ACP engines issue their
 * own), and never a fork or a side-thread lane: a fork's transcript already
 * holds the parent's user rows, and a lane's prompts are plumbing that history
 * hides on purpose.
 */
export function launchPromptOfStart(data: {
  message: string;
  namingMessage?: string;
  preassignedSessionId?: string;
  forkedFromSessionId?: string;
  lane?: string;
}): { sessionId: string; text: string } | null {
  if (!data.preassignedSessionId || data.forkedFromSessionId || data.lane) return null;
  const text = launchNamingText(data.message ?? '', data.namingMessage);
  return text.trim() ? { sessionId: data.preassignedSessionId, text } : null;
}

/**
 * Record launches and forget them when the first turn ends. Idempotent: the bus
 * keys subscribers by name, so a second server in the same process replaces it.
 * `session:start` handlers run synchronously inside emit(), so the entry exists
 * before the launch's HTTP answer reaches the browser that opens the panel.
 */
export function startLaunchPromptRegistry(): void {
  bus.subscribe('launch-prompts', (event) => {
    switch (event.name) {
      case 'session:start': {
        const hit = launchPromptOfStart(eventData<'session:start'>(event));
        if (hit) noteLaunchPrompt(hit.sessionId, hit.text);
        return;
      }
      // By the end of the first turn the transcript holds the prompt, and the
      // panel's turn-end refetch shows it from there.
      case 'session:result':
      case 'session:ended': {
        const sid = (event.data as { sessionId?: string } | undefined)?.sessionId;
        if (sid) forgetLaunchPrompt(sid);
        return;
      }
      case 'session:deleted': {
        for (const sid of eventData<'session:deleted'>(event).sessionIds ?? []) forgetLaunchPrompt(sid);
        return;
      }
      default:
    }
  }, { global: true, interest: ['session:start', 'session:result', 'session:ended', 'session:deleted'] });
}
