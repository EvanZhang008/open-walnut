/**
 * The quick bar's server calls (src/web/routes/quick-input-v1.ts): who it can talk to, tasks and
 * notes matching typed words, the send whose NDJSON answer follows the reply, and a quick
 * question's answer.
 */
import { apiGet } from './client';
import { searchNotesHybrid, type SearchResult } from './notes-v2';
import type { QuickPerson } from '@/components/quickbar/quickbar-people';

export function fetchQuickPeople(limit = 12, signal?: AbortSignal): Promise<{ people: QuickPerson[] }> {
  return apiGet('/api/v1/quick/people', { limit: String(limit) }, { signal, timeoutMs: 8_000 });
}

export interface QuickTaskRow { id: string; title: string; project: string; state: string; stateLabel: string }

export function searchQuickTasks(q: string, signal?: AbortSignal): Promise<{ tasks: QuickTaskRow[] }> {
  // No words: the open tasks, the ones needing the user first.
  const params: Record<string, string> = q.trim() ? { q, limit: '8' } : { recent: '1', limit: '8' };
  return apiGet('/api/v1/quick/tasks', params, { signal, timeoutMs: 8_000 });
}

/** Notes matching the words, by title and text (the Notes page's own search, its fast lane). */
export async function searchQuickNotes(q: string, signal?: AbortSignal): Promise<SearchResult[]> {
  if (!q.trim()) return [];
  const { results } = await searchNotesHybrid(q, { mode: 'string', limit: 8, signal });
  return results;
}

export type QuickFollowLine =
  | { type: 'sent' | 'held'; taskId: string; sessionId: string | null; started: boolean; messageId?: string }
  | { type: 'delivered' }
  | { type: 'text'; delta: string }
  | { type: 'reset' }
  | { type: 'activity'; detail: string }
  | { type: 'result'; text: string; unfinished?: true }
  | { type: 'error'; code: string; message: string };

export interface QuickImage { data: string; mediaType: string }

/**
 * Send `text` to `to` (a task id; the CEO when null) and call `onLine` with each line of the
 * answer: first `sent` or `held`, then the reply as it is written. Resolves when the answer ends.
 * A failure before any line (the network, a refusal) comes back as one `error` line, so the
 * caller has one path for everything that can happen.
 */
export async function quickSendFollow(
  to: string | null, text: string, images: QuickImage[], onLine: (line: QuickFollowLine) => void, signal?: AbortSignal,
): Promise<void> {
  const body = { ...(to ? { to } : {}), text, ...(images.length ? { images } : {}), follow: true };
  return postNdjson<QuickFollowLine>('/api/v1/quick/send', body, onLine, {
    signal,
    unreachable: 'Walnut could not be reached. Nothing was sent.',
    refused: (status) => `Not sent (${status}).`,
    lost: 'Lost the reply on the way. It is in the chat.',
  });
}

export type QuickAskLine =
  | { type: 'text'; delta: string }
  | { type: 'result'; text: string; conversation?: string }
  | { type: 'error'; code: string; message: string };

/** A quick question: one fast answer, no task, no session; the same `conversation` goes on with it. */
export function quickAsk(text: string, conversation: string | null, onLine: (line: QuickAskLine) => void, signal?: AbortSignal): Promise<void> {
  return postNdjson<QuickAskLine>('/api/v1/quick/ask', { text, ...(conversation ? { conversation } : {}) }, onLine, {
    signal,
    unreachable: 'Walnut could not be reached.',
    refused: (status) => `No answer (${status}).`,
    lost: 'The answer broke off on the way.',
  });
}

/**
 * A quick question made a task: a normal Ask Walnut chat started with the words (the phone's New
 * chat), whose task id is answered as soon as it is sent; the reply goes on in that chat.
 */
export async function startAskTask(text: string): Promise<string> {
  const ctl = new AbortController();
  let taskId: string | null = null;
  let failure: string | null = null;
  await postNdjson<QuickFollowLine>('/api/v1/quick/session', { text }, (line) => {
    if (line.type === 'sent' || line.type === 'held') { taskId = line.taskId; ctl.abort(); }
    else if (line.type === 'error') failure = line.message;
  }, { signal: ctl.signal, unreachable: 'Walnut could not be reached.', refused: (status) => `Not started (${status}).`, lost: 'Lost on the way.' });
  if (!taskId) throw new Error(failure ?? 'Not started.');
  return taskId;
}

/**
 * One POST whose answer is NDJSON, each line to `onLine`. A failure before any line (the network,
 * a refusal) and a stream that breaks come back as one `error` line, so the caller has one path for
 * everything that can happen; an abort ends it quietly.
 */
async function postNdjson<L>(
  url: string, body: unknown, onLine: (line: L) => void,
  opts: { signal?: AbortSignal; unreachable: string; refused: (status: number) => string; lost: string },
): Promise<void> {
  const { signal } = opts;
  const fail = (code: string, message: string) => onLine({ type: 'error', code, message } as L);
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch {
    if (!signal?.aborted) fail('network', opts.unreachable);
    return;
  }
  if (!res.ok || !res.body) {
    const answer = await res.json().catch(() => null) as { error?: string } | null;
    fail(`http_${res.status}`, answer?.error || opts.refused(res.status));
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!raw) continue;
        try { onLine(JSON.parse(raw) as L); } catch { /* a torn line: skip it */ }
      }
    }
  } catch {
    // The stream broke after it began (for a send: the reply is still in its chat).
    if (!signal?.aborted) fail('follow_lost', opts.lost);
  }
}
