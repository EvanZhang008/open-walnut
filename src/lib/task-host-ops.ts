/**
 * The ops that run only for a task (core/hosts/host-exec-target.ts callerOf): host_exec and its
 * reads, stops, lists and pinned runs, host_mcp_*, host_http, host_daemon_update and host_copy,
 * named by the API path they bind to. A trigger check's call to one of them acts for its trigger's
 * task (core/hosts/trigger-caller.ts), so:
 *   - the installed CLI sends these through the check's daemon, which vouches for the run
 *     (commands/tools.ts), and every other call of a check as it always went;
 *   - the server holds a check's trigger only for these (core/peers/capability-router.ts).
 * tests/core/hosts/trigger-caller-ratchet.test.ts fails when a new route of this kind is not here.
 *
 * Zero imports: the CLI loads this before anything else.
 */

const TASK_HOST_PATH = /^\/(hosts\/:host\/(exec|mcp|mcp-calls|http|daemon-update)(\/|$)|host-exec\/grants\/:grant_id\/exec$|host-copy(\/|$))/

/** True for an op bound to one of the task-only host routes. */
export function isTaskHostOpPath(bindPath: string | undefined): boolean {
  return typeof bindPath === 'string' && TASK_HOST_PATH.test(bindPath)
}
