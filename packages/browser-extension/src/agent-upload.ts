/**
 * A trusted upload (agent-trusted.ts): the browser reads each file from its own machine by its path
 * (DOM.setFileInputFiles), any size, and none of it crosses to the agent's machine. A file on the
 * person's machine is theirs, so only two kinds go:
 *   - one this task's own downloads wrote (agent-downloads.ts);
 *   - one the person said yes to for this task (src/core/browser-control/upload-grants.ts), which
 *     Walnut sends with the command as `granted_paths`. The agent cannot set it: the server sends
 *     only the keys it knows (act-args.ts) and adds this one itself.
 * cdp.ts cdpSetFiles puts them in the field.
 */
import { downloadedFiles } from './agent-downloads'
import { AgentError } from './agent-shared'
import { FILE_ACCESS_WORDS } from './cdp'


/** Whether "Allow access to file URLs" is on for this extension (true where the browser cannot tell: Chrome answers then). */
export async function fileAccessOn(): Promise<boolean> {
  try {
    const e = (globalThis as { chrome?: { extension?: { isAllowedFileSchemeAccess?: () => unknown } } }).chrome?.extension
    if (typeof e?.isAllowedFileSchemeAccess !== 'function') return true
    return (await Promise.resolve(e.isAllowedFileSchemeAccess())) !== false
  } catch { return true }
}

/** The paths of a trusted upload, or a refusal that says how the person lets one go. */
export async function allowedPaths(a: Record<string, unknown>, owner: string): Promise<string[]> {
  const paths = Array.isArray(a.paths) ? (a.paths as unknown[]).filter((p): p is string => typeof p === 'string' && p.length > 0) : []
  if (!paths.length) throw new AgentError('A trusted upload takes paths of files on the browser\'s own machine (paths); to send the bytes, upload without trusted.', 'bad_request')
  const granted = Array.isArray(a.granted_paths) ? (a.granted_paths as unknown[]).filter((p): p is string => typeof p === 'string') : []
  const mine = await downloadedFiles(owner)
  const other = paths.filter((p) => !mine.includes(p) && !granted.includes(p))
  if (other.length) {
    throw new AgentError(`A trusted upload sends only a file this task downloaded (downloads lists them) or one the person said yes to; not ${other.slice(0, 3).join(', ')}. `
      + 'Update Walnut and the extension so it can ask the person, or send a file of 10 MB or less as bytes, without trusted.', 'path_not_allowed')
  }
  if (!await fileAccessOn()) throw new AgentError(FILE_ACCESS_WORDS, 'file_access_off')
  return paths
}
