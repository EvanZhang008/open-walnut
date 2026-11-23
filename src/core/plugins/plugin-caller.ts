/**
 * Who a plugin's own op call is: an App the user installed, named as such, never "an unidentified
 * process". A session reading a message from it (a role change, a move to another problem) must
 * know it is the App the person works in, not some program on the host (2026-11-07: a practice
 * App's "you are now the interviewer" note read as unidentified, and the session refused the role).
 *
 * Two kinds of call are an App's:
 *   - its server half (server-api.ts callPluginOp stamps `plugin:<id>` as its caller): pluginCallerName;
 *   - its background job on a host, once that host's daemon vouched for it (plugin-jobs/job-caller.ts
 *     vouchedPluginJob; the call itself stays the anonymous `external`): jobAppSender. A job only named
 *     by its headers is not one: anyone can write them (2026-11-23: a vouched job's task_send still read
 *     as an unidentified process, and a session followed its "post the report now" only "with caution").
 */

const PREFIX = 'plugin:'
const names = new Map<string, string>()

/** The plugin's display name, set as its API is built. */
export function notePluginName(pluginId: string, name: string): void {
  names.set(pluginId, name)
}

/** An App's display name by its plugin id (the id itself until its API is built). */
export function pluginAppName(pluginId: string): string {
  return names.get(pluginId) ?? pluginId
}

/** The App's name when `callerSid` is a plugin's own call, else undefined. */
export function pluginCallerName(callerSid: string | undefined): string | undefined {
  if (!callerSid?.startsWith(PREFIX)) return undefined
  const id = callerSid.slice(PREFIX.length)
  return id ? pluginAppName(id) : undefined
}

/** The envelope sender fields of a vouched job (peers/envelope-kit.ts EnvelopeSender `app` + `appJob`). */
export function jobAppSender(job: { plugin: string; job: string }): { app: string; appJob: string } {
  return { app: pluginAppName(job.plugin), appJob: job.job }
}
