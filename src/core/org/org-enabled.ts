/**
 * The switch that turns the whole org off (Settings → Org, config.yaml `org.enabled`). 2026-11-03,
 * the user: "people can have setting to disable that that will disable all the communications or
 * the org, but default enable".
 *
 * Absent means on, so an install that never set it (and an older Walnut that wrote config.yaml)
 * keeps its org. Off means:
 *  - Walnut starts no session for Main or a VP (org-autostart.ts, and every start or message that
 *    is not a person's own: task-start.ts, quick-start.ts, session-message-queue.ts);
 *  - none of the org's own messages are made: status lines and notices up to a VP or Main
 *    (status-push.ts, org-follow.ts), team notes and Main's digest (org-store.ts pendingOrgDigest),
 *    Brief refreshes and the org's message hints, away-inbox threads, scheduled org reports, the
 *    lead-waits wake, the re-check and status questions put to an org node, and the routines and
 *    triggers aimed at one (their fire is skipped, the routine stays as it is);
 *  - an agent's org_send is refused.
 * A person still reaches Main or a VP by typing in its chat. Tasks, their sessions, the Board and
 * the inbox keep working without the org.
 *
 * The value is cached for the hot paths (every message into a session asks it): read at the first
 * ask, again on every config change that can move it (a hand edit of the file announces one too),
 * and set at once by the settings write. Turned back on either way, the sweep starts the nodes that
 * never started (org-autostart.ts).
 *
 * Every send into a session also checks it (session-message-queue.ts, refuseOrgDeliveryWhileOff):
 * a message into Main's or a VP's session that is not a person's, nor an answer to a question it
 * asked, is refused while the org is off, so a path that forgot its own gate still sends nothing.
 */

import { log } from '../../logging/index.js';
import type { Config } from '../types.js';

/** On unless the user turned it off. */
export function orgEnabledOf(config: Pick<Config, 'org'> | null | undefined): boolean {
  return config?.org?.enabled !== false;
}

/** org-autostart.ts ORG_START_SOURCE (named here so this file imports nothing of the org). */
const ORG_START_SOURCE_NAME = 'org-autostart';

let cached: boolean | undefined;
let reading: Promise<boolean> | null = null;
let watching = false;

async function readNow(): Promise<boolean> {
  try {
    const { getConfig } = await import('../config-manager.js');
    set(orgEnabledOf(await getConfig()));
  } catch (err) {
    // A config that cannot be read keeps the last value, else on: the org is the default.
    log.task.warn('org switch: config not read', { error: err instanceof Error ? err.message : String(err) });
    cached ??= true;
  }
  return cached !== false;
}

/** Whether the org is on now. Cheap after the first ask. */
export async function isOrgEnabled(): Promise<boolean> {
  watch();
  if (cached !== undefined) return cached;
  reading ??= readNow().finally(() => { reading = null; });
  return reading;
}

/** The last value read, for a sync caller; unknown reads as on. */
export function orgEnabledCached(): boolean {
  watch();
  if (cached === undefined) void isOrgEnabled();
  return cached !== false;
}

/** The settings write sets it at once, before its config change is announced. */
export function noteOrgEnabled(on: boolean): void {
  set(on);
}

/** Turned back on (the settings write or a hand edit of the file): the nodes that never started start now. */
function set(on: boolean): void {
  const was = cached;
  cached = on;
  if (was !== false || !on) return;
  log.task.info('org switch: on again, starting the nodes that have no session');
  void (async () => {
    const { role } = await import('../server-role.js');
    if (role() !== 'leader') return;
    const { sweepOrgStarts } = await import('./org-autostart.js');
    await sweepOrgStarts('enabled');
  })().catch((err) => log.task.warn('org switch: start sweep failed', { error: err instanceof Error ? err.message : String(err) }));
}

function watch(): void {
  if (watching) return;
  watching = true;
  void import('../event-bus.js').then(({ bus, EventNames }) => {
    bus.subscribe('org-enabled', (event) => {
      if (event.name !== EventNames.CONFIG_CHANGED) return;
      // The narrow UI-state emits name another key and carry no config: nothing there moves `org`.
      const data = event.data as { key?: string; config?: unknown } | undefined;
      if (data?.key && data.key !== 'org' && !data.config) return;
      void readNow();
    }, { global: true, interest: [EventNames.CONFIG_CHANGED] });
  }).catch(() => { watching = false; });
}

/** Refused because the org is off: a 409 that says so in words the caller can act on. */
export class OrgOffError extends Error {
  readonly code = 'org_off';
  readonly status = 409;
  constructor(message = ORG_OFF_MESSAGE) {
    super(message);
    this.name = 'OrgOffError';
  }
}

export const ORG_OFF_MESSAGE = 'The org is off (Settings → Org): CEO and the VPs get no messages and start no work. '
  + 'Send to the task that does the work with task_send, or ask the user to turn the org on.';

/**
 * The sources of Walnut's own background turns (a clock, a re-check, a routine, a Brief refresh,
 * a status question). With the org off none of them reaches Main or a VP: each has its own gate,
 * and every send checks this list too (session-message-queue.ts), so one that forgot still sends
 * nothing. A person's words, a reply to a question the node asked, a notice about its own request
 * and an engine switch or a move are none of these and still go in.
 */
export const ORG_OFF_BLOCKED_SOURCES: ReadonlySet<string> = new Set([
  'wait-until', 'trigger-check-failed', 'routine', 'routine-trigger', 'routine-watcher',
  'needs-recheck', 'brief-refresh', 'status-report', 'task-watch', 'pr-watch', ORG_START_SOURCE_NAME,
  'idle-compact', 'thread-recheck',
]);

/** An org node: Main or a VP (a project's lead). */
export function isOrgNode(task: { org_role?: string } | null | undefined): boolean {
  return task?.org_role === 'main' || task?.org_role === 'lead' || task?.org_role === 'router';
}

/** For tests: forget the cached value. */
export function _resetOrgEnabledForTesting(value?: boolean): void {
  cached = value;
  reading = null;
}
