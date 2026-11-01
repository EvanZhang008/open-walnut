/**
 * The local Walnut server, as this extension uses it (src/web/routes/quick-input-v1.ts):
 * a quick answer streamed as NDJSON, a message into Main's chat followed by Main's reply to it,
 * and the tasks matching some words. A loopback caller needs no token.
 */
import { getPreferenceValues } from "@raycast/api";

export interface QuickTask {
  id: string;
  title: string;
  project: string;
  state: string;
  stateLabel: string;
}

export type Mode = "quick" | "main";

export function walnutBase(): string {
  const { port } = getPreferenceValues<{ port?: string }>();
  const n = Number(port);
  return `http://127.0.0.1:${Number.isInteger(n) && n > 0 && n < 65536 ? n : 3456}`;
}

export const NOT_RUNNING = "Walnut is not answering on this Mac. Open the Walnut app, then try again.";

export function openTaskLink(taskId: string): string {
  return `open-walnut://open?to=${encodeURIComponent(`/tasks/${taskId}`)}`;
}

export async function findTasks(q: string, signal?: AbortSignal): Promise<QuickTask[]> {
  const res = await fetch(`${walnutBase()}/api/v1/quick/tasks?limit=8&q=${encodeURIComponent(q)}`, { signal });
  if (!res.ok) return [];
  const body = (await res.json()) as { tasks?: QuickTask[] };
  return Array.isArray(body.tasks) ? body.tasks : [];
}

/** Lines of a streamed response body, as they arrive. */
async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) yield part;
  }
  if (buffer) yield buffer;
}

/** A quick answer; `onText` gets the whole text so far each time more arrives. */
export async function askQuick(
  text: string,
  opts: { conversation: string; context?: string; signal?: AbortSignal; onText: (text: string) => void },
): Promise<{ text: string; durationMs?: number }> {
  const res = await fetch(`${walnutBase()}/api/v1/quick/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, conversation: opts.conversation, ...(opts.context ? { context: opts.context } : {}) }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `The answer failed (HTTP ${res.status})`);
  }
  let sofar = "";
  for await (const line of lines(res.body)) {
    if (!line.trim()) continue;
    let value: { type?: string; delta?: string; text?: string; message?: string; durationMs?: number };
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value.type === "text") {
      sofar += value.delta ?? "";
      opts.onText(sofar);
    } else if (value.type === "result") {
      return { text: value.text ?? sofar, durationMs: value.durationMs };
    } else if (value.type === "error") {
      throw new Error(value.message || "The answer failed");
    }
  }
  return { text: sofar };
}

export interface MainProgress {
  text: string;
  activity?: string;
}

/**
 * Tell Main, and follow its reply: one request whose answer streams the send's outcome, then
 * Main's words for THIS message as it writes them (the server matches the turn that took it).
 * Resolves when that turn ends, or `held` when Main waits on the user's answer first.
 */
export async function tellMain(
  text: string,
  opts: { signal?: AbortSignal; onProgress: (p: MainProgress) => void; onSent?: (taskId: string) => void },
): Promise<{ text: string; taskId: string; held?: boolean; unfinished?: boolean }> {
  const res = await fetch(`${walnutBase()}/api/v1/quick/main`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, follow: true }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `Main did not get it (HTTP ${res.status})`);
  }
  let taskId = "";
  let reply = "";
  let activity: string | undefined;
  for await (const line of lines(res.body)) {
    if (!line.trim()) continue;
    let value: { type?: string; taskId?: string; delta?: string; detail?: string; text?: string; message?: string; unfinished?: boolean };
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value.type === "sent" || value.type === "held") {
      taskId = value.taskId ?? "";
      opts.onSent?.(taskId);
      if (value.type === "held") return { text: "", taskId, held: true };
    } else if (value.type === "text") {
      reply += value.delta ?? "";
      activity = undefined;
      opts.onProgress({ text: reply, activity });
    } else if (value.type === "reset") {
      // The words so far were the turn Main was in; the next turn is the reply.
      reply = "";
      opts.onProgress({ text: reply, activity });
    } else if (value.type === "activity") {
      activity = value.detail || "working";
      opts.onProgress({ text: reply, activity });
    } else if (value.type === "result") {
      return { text: value.text || reply, taskId, unfinished: value.unfinished };
    } else if (value.type === "error") {
      throw new Error(value.message || "Main's turn failed");
    }
  }
  return { text: reply, taskId, unfinished: true };
}

/**
 * Tell Main and go: one POST, answered once the message is in Main's queue (the reply is read in
 * Main's chat). `held`: Main waits on the user's answer to its own question, so nothing was sent.
 */
export async function sendToMain(text: string, signal?: AbortSignal): Promise<{ taskId: string; held?: boolean }> {
  const res = await fetch(`${walnutBase()}/api/v1/quick/main`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as { taskId?: string; held?: boolean; error?: string };
  if (!res.ok) throw new Error(body.error || `Main did not get it (HTTP ${res.status})`);
  return { taskId: body.taskId ?? "", held: body.held };
}
