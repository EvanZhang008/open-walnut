/**
 * Send one message to Main from anywhere in the app. Main's task is found or made by the
 * server (`ensureMainTask`); a Main with a session gets the message on it (the same
 * `session:send` a composer uses), and a Main with none is started with it, the same launch
 * Main's own composer in the chat slot runs (AskWalnutSlot `handleStartMain`).
 *
 * A Main that waits on the user's answer (a question or an approval) is not sent to: a new
 * message would refuse that prompt, and the user who clicked a quick action never saw it.
 * The caller shows Main's chat instead, where the prompt waits.
 */
import { ensureMainTask } from '@/api/org';
import { fetchWorkingDirs, hydrateSessionStatuses, quickStartSession } from '@/api/sessions';
import { wsClient } from '@/api/ws';
import { GENERAL_ASK_AGENT } from '@/components/chat/ask-walnut-slot-model';
import { seedLaunchPrompt } from '@/components/sessions/launch-prompt-seed';
import { sessionStatusStore } from '@/stores/session-status-store';
import { resolveTaskSessionId } from '@/utils/session-status';

export interface AskMainResult {
  taskId: string;
  sessionId: string | null;
  /** True when this message started Main's session. */
  started: boolean;
  /** Not sent: Main waits on the user's answer first. */
  held?: boolean;
}

/** A start whose session the task store may not show yet (the Org page's Main reads it). */
let lastStart: { taskId: string; sessionId: string | null; at: number } | null = null;
const START_GRACE_MS = 60_000;

export function recentMainStart(taskId: string | undefined, now = Date.now()): { sessionId: string | null } | null {
  if (!lastStart || now - lastStart.at > START_GRACE_MS) return null;
  if (taskId && lastStart.taskId !== taskId) return null;
  return { sessionId: lastStart.sessionId };
}

function waitsOnUser(sessionId: string): boolean {
  const s = sessionStatusStore.getStatus(sessionId);
  return !!s?.pendingPermissionTool && (s.process_status === 'running' || s.process_status === 'idle');
}

export async function askMain(message: string): Promise<AskMainResult> {
  const main = await ensureMainTask();
  // A replica cannot make Main: it lives with the primary (the buttons are hidden there).
  if (!main) throw new Error('The CEO runs on your Mac. Open Walnut there to use it.');
  const sessionId = resolveTaskSessionId(main);
  if (sessionId) {
    // The store only knows sessions someone asked about: ask for Main's now.
    await hydrateSessionStatuses([sessionId]).catch(() => { /* judged on what the store has */ });
    if (waitsOnUser(sessionId)) return { taskId: main.id, sessionId, started: false, held: true };
    await wsClient.sendRpc<{ messageId: string }>('session:send', { sessionId, message });
    return { taskId: main.id, sessionId, started: false };
  }
  const result = await quickStartSession({
    cwd: '',
    message,
    project: GENERAL_ASK_AGENT.project,
    walnutAgent: true,
    taskId: main.id,
    taskMeta: { pinTier: null },
  });
  // The launch emptied the working-dirs cache; refill it as the slot does (AskWalnutSlot runLaunch).
  void fetchWorkingDirs().catch(() => { /* drafts fetch again on their own */ });
  // The chat's first frame holds the message before the transcript has it (launch-prompt-seed.ts).
  if (result.sessionId) seedLaunchPrompt(result.sessionId, message);
  lastStart = { taskId: main.id, sessionId: result.sessionId ?? null, at: Date.now() };
  return { taskId: main.id, sessionId: result.sessionId ?? null, started: true };
}
