/**
 * The quick bar's server calls (src/web/routes/quick-input-v1.ts): who it can talk to, tasks
 * matching typed words, and the send whose NDJSON answer follows the reply.
 */
import { apiGet } from './client';
import type { QuickPerson } from '@/components/quickbar/quickbar-people';

export function fetchQuickPeople(limit = 12, signal?: AbortSignal): Promise<{ people: QuickPerson[] }> {
  return apiGet('/api/v1/quick/people', { limit: String(limit) }, { signal, timeoutMs: 8_000 });
}

export interface QuickTaskRow { id: string; title: string; project: string; state: string; stateLabel: string }

export function searchQuickTasks(q: string, signal?: AbortSignal): Promise<{ tasks: QuickTaskRow[] }> {
  return apiGet('/api/v1/quick/tasks', { q, limit: '8' }, { signal, timeoutMs: 8_000 });
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
  let res: Response;
  try {
    res = await fetch('/api/v1/quick/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(to ? { to } : {}), text, ...(images.length ? { images } : {}), follow: true }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) return;
    onLine({ type: 'error', code: 'network', message: 'Walnut could not be reached. Nothing was sent.' });
    return;
  }
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    onLine({ type: 'error', code: `http_${res.status}`, message: body?.error || `Not sent (${res.status}).` });
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
        try { onLine(JSON.parse(raw) as QuickFollowLine); } catch { /* a torn line: skip it */ }
      }
    }
  } catch {
    // The follow broke after the send went out: the reply is still in its chat.
    if (!signal?.aborted) onLine({ type: 'error', code: 'follow_lost', message: 'Lost the reply on the way. It is in the chat.' });
  }
}
