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
