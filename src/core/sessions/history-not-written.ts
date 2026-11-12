/**
 * Whether a session's missing transcript is its normal state, so its history reads as no
 * conversation yet instead of "History unavailable: Session history file not found".
 *
 * Claude Code writes a session's transcript when the first message reaches it. Until then the
 * file does not exist, and that is no fault:
 *   - the first seconds after a launch (isHistoryStartupWindow: the CLI is still booting);
 *   - a session Walnut started with no message (`startedIdle`: an org router, an idle engine
 *     switch), however long it waits for its first one, also after its idle CLI was reaped;
 *   - a router's session: it only ever gets a turn when mail of its area reaches it, and that turn
 *     writes the transcript, so no transcript means no mail reached it yet. This also covers the
 *     routers started before `startedIdle` was recorded (2026-11-11: the Personal router's page
 *     read "History unavailable" for hours while it waited for its first mail).
 * A session that failed (`error`) still shows its fault at once, and a session on another host
 * keeps its own answer (that host may be unreachable; routers run on this machine only).
 */
import type { SessionRecord } from '../types.js';
import { isHistoryStartupWindow } from './session-lifecycle.js';
import { isRemoteHost } from '../hosts/remote-read-bound.js';

export async function historyNotWrittenYet(record: SessionRecord, nowMs = Date.now()): Promise<boolean> {
  if (isHistoryStartupWindow(record, nowMs)) return true;
  if (record.process_status === 'error' || isRemoteHost(record.host)) return false;
  if (record.startedIdle) return true;
  return await isRouterSession(record);
}

async function isRouterSession(record: SessionRecord): Promise<boolean> {
  if (!record.taskId) return false;
  try {
    const { getTask } = await import('../task-manager.js');
    return (await getTask(record.taskId)).org_role === 'router';
  } catch {
    return false;
  }
}

/** How long the own-path check may take before the read goes the usual way. */
const OWN_PATH_CHECK_MS = 3_000;

/**
 * Whether a history read can answer "no conversation yet" at once, with no read at
 * all: a session whose missing transcript is its normal state (historyNotWrittenYet),
 * that never had a model turn, and whose transcript is not at its own path for its
 * cwd (a few stats on the host). Without it the reader, finding no file at that
 * path, searched every transcripts folder on the host for it, and a router waiting
 * for its first mail answered after 30 to 60 s or failed with "Local daemon read
 * timeout" while the Mac was busy (2026-11-11, the user: "why this router take so
 * long to load, not even successful at end"). Anything that cannot be told (a long
 * cwd's hashed folder, a stat that fails or is slow, a fork, an ACP journal) keeps
 * the usual read.
 */
export async function transcriptNotWrittenYet(record: SessionRecord, _nowMs = Date.now()): Promise<boolean> {
  // Only this machine's sessions: a remote host's first paint makes no host call (it may hang).
  if (!record.cwd || record.forkedFromSessionId || record.firstTurnAt || isRemoteHost(record.host)) return false;
  const [{ engineCaps }, { turnEvidenceAt }] = await Promise.all([
    import('../agents/engine-registry.js'), import('../session-tracker.js'),
  ]);
  if (engineCaps(record.engine).historySource === 'acp-journal' || turnEvidenceAt(record)) return false;
  // Only a session that waits for its first message by design (started idle, a router). One in its
  // launch seconds keeps the usual read: its transcript may be written under another folder any moment.
  if (record.process_status === 'error' || !(record.startedIdle || await isRouterSession(record))) return false;
  try {
    const { DaemonFileReader } = await import('../daemon-file-reader.js');
    const reader = new DaemonFileReader('__local__');
    if (typeof reader.ownSessionPath !== 'function') return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const own = await Promise.race([
      reader.ownSessionPath(record.claudeSessionId, record.cwd, OWN_PATH_CHECK_MS).catch(() => undefined),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), OWN_PATH_CHECK_MS); }),
    ]).finally(() => clearTimeout(timer));
    return own === null;
  } catch {
    return false;
  }
}
