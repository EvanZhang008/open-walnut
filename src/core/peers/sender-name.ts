/**
 * The name a session goes by when it sends: its TASK's title, never the session's own.
 *
 * A session title is a CLI-era label that is rarely revisited: a fork used to print
 * `Fork of <source>` for every hop, and an old session kept a ticket URL as its name
 * (2026-11-03: a task's messages arrived from "Fork of Fork of Fork of Fork of Fork of
 * Session: <service> — https://…"). The task title is the one the user curates and
 * every surface shows, so every envelope `from` (peer note, reply, a start's first
 * line) and every notice naming the sender reads it from here. The session title is
 * the fallback for a session with no task, or a task the store cannot read right now.
 *
 * The host daemons name their callers the same way (`callerIdentity` in
 * offline-host-core.ts), and `tests/core/peers/sender-name-ratchet.test.ts` fails on a
 * new envelope call site that names the sender from the session record.
 */

/** The fields of a session record a sender's name is read from. */
export interface NamedSession {
  title?: string | null;
  taskId?: string | null;
}

/** The sender's display name: the task's title, else the session's, else ''. */
export async function senderTitleOf(record: NamedSession | null | undefined): Promise<string> {
  if (!record) return '';
  const taskId = record.taskId?.trim();
  if (taskId) {
    try {
      const { getTask } = await import('../task-manager.js');
      const title = (await getTask(taskId)).title?.trim();
      if (title) return title;
    } catch {
      /* a task the store cannot read: the session's own title below */
    }
  }
  return record.title?.trim() ?? '';
}
