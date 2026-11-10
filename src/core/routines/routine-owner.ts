/**
 * The org's Main, the last task told about a routine's missed run (cron/run-log.ts
 * routineOwnerChain): the routine's owner, else the task it delivers into, else Main.
 *
 * 2026-11-10, Walnut VP: the org reflection's and Inbox Triage's missed runs went to the user's
 * notifications because neither had an owner. Main is read at every sweep, never stored on the
 * routine, so a routine made before owners existed, or one made with none, reaches Main without a
 * migration, and a Main that changes is the one told.
 */

/** The org's Main task now, never made here: a Walnut with no org has none. */
export async function currentMainTaskId(): Promise<string | undefined> {
  try {
    const [{ orgTasks }, { pickMain }] = await Promise.all([import('../org/org-store.js'), import('../org/org-tree.js')]);
    return pickMain(await orgTasks())?.id;
  } catch {
    return undefined;
  }
}
