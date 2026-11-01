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

/** A picture sent with a message: raw base64 and its type (clipboard-image.ts makes one). */
export interface QuickImage {
  data: string;
  mediaType: string;
}

export function walnutBase(): string {
  const { port } = getPreferenceValues<{ port?: string }>();
  const n = Number(port);
  return `http://127.0.0.1:${Number.isInteger(n) && n > 0 && n < 65536 ? n : 3456}`;
}

export const NOT_RUNNING = "Walnut is not answering on this Mac. Open the Walnut app, then try again.";

export function openTaskLink(taskId: string): string {
  return `open-walnut://open?to=${encodeURIComponent(`/tasks/${taskId}`)}`;
}

/** A note opens on the notes page, the way the web app links one (`/notes?path=`). */
export function openNoteLink(path: string): string {
  return `open-walnut://open?to=${encodeURIComponent(`/notes?path=${encodeURIComponent(path)}`)}`;
}

export interface QuickNote {
  path: string;
  title: string;
  snippet: string;
}

/** Notes matching the words (GET /api/v1/notes/search), with their snippet as plain text. */
export async function findNotes(q: string, signal?: AbortSignal): Promise<QuickNote[]> {
  const res = await fetch(`${walnutBase()}/api/v1/notes/search?limit=6&q=${encodeURIComponent(q)}`, { signal });
  if (!res.ok) return [];
  const body = (await res.json()) as { results?: Array<{ path?: string; title?: string; snippet?: string }> };
  return (body.results ?? [])
    .filter((n): n is { path: string; title?: string; snippet?: string } => typeof n.path === "string" && n.path.length > 0)
    .map((n) => ({
      path: n.path,
      title: n.title || n.path.split("/").pop() || n.path,
      snippet: (n.snippet ?? "").replace(/<\/?mark>/g, "").replace(/\s+/g, " ").trim(),
    }));
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

/**
 * A quick answer; `onText` gets the whole text so far each time more arrives. With `tools` it is a
 * light agent session that may search the web and read pages, and `onActivity` names each step.
 */
export async function askQuick(
  text: string,
  opts: {
    conversation: string; context?: string; tools?: boolean; signal?: AbortSignal
    onText: (text: string) => void; onActivity?: (detail: string) => void
  },
): Promise<{ text: string; durationMs?: number }> {
  const res = await fetch(`${walnutBase()}/api/v1/quick/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text, conversation: opts.conversation,
      ...(opts.context ? { context: opts.context } : {}),
      ...(opts.tools ? { tools: true } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `The answer failed (HTTP ${res.status})`);
  }
  let sofar = "";
  for await (const line of lines(res.body)) {
    if (!line.trim()) continue;
    let value: { type?: string; delta?: string; text?: string; message?: string; detail?: string; durationMs?: number };
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value.type === "text") {
      sofar += value.delta ?? "";
      opts.onText(sofar);
    } else if (value.type === "activity" && value.detail) {
      opts.onActivity?.(value.detail);
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
export async function sendToMain(text: string, images?: QuickImage[], signal?: AbortSignal): Promise<{ taskId: string; held?: boolean }> {
  const res = await fetch(`${walnutBase()}/api/v1/quick/main`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, ...(images?.length ? { images } : {}) }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as { taskId?: string; held?: boolean; error?: string };
  if (!res.ok) throw new Error(body.error || `Main did not get it (HTTP ${res.status})`);
  return { taskId: body.taskId ?? "", held: body.held };
}

/**
 * A message straight into one task's chat as the user's own (POST /quick/task-message), or the
 * start of its session when it has none. `held`: it waits on the user's answer to a prompt first.
 */
export async function sendToTask(taskId: string, text: string, images?: QuickImage[]): Promise<{ started?: boolean; held?: boolean }> {
  const res = await fetch(`${walnutBase()}/api/v1/quick/task-message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId, text, ...(images?.length ? { images } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as { started?: boolean; held?: boolean; error?: string };
  if (!res.ok) throw new Error(body.error || `The task did not get it (HTTP ${res.status})`);
  return { started: body.started, held: body.held };
}
