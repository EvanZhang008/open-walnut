/**
 * A spawn template's hook scripts ride argv strings of their own (hook-files-v1; the daemon
 * side is cli-argv-files-core.ts).
 *
 * Why (2026-11-11): every guard is a hook script in the session's `--settings` JSON, and it had
 * grown to 100 KB, 28 bytes under the room of one host spawn template string (host-start-core.ts
 * MAX_TEMPLATE_STRING, 120 KB), so the next hook change from any team would fail. A session start
 * sends the inline settings as before (the daemon writes each long hook to a file of its own when
 * it writes the settings file); the template pushes (spawn-template.ts) send each long hook
 * command as a token (`@walnut-hook-file:<sha256-32>`) with its text beside the settings as
 * `--walnut-hook-file <text>`, one template string per script, to a daemon that advertises
 * hook-files-v1 (an older one gets the inline template). The daemon puts the texts back before
 * a start records its args (inlineArgs), so its registry never holds this form.
 */
import { createHash } from 'node:crypto'

export const HOOK_FILES_CAPABILITY = 'hook-files-v1'
/** Mirrored inside createCliArgvFiles (it can reference nothing at module scope); a test pins both. */
export const HOOK_FILE_FLAG = '--walnut-hook-file'
export const HOOK_FILE_TOKEN = '@walnut-hook-file:'
/** A command this long or longer rides a file; a short one (a `walnut tools call ...`) stays inline. */
export const HOOK_FILE_MIN_CHARS = 512

type Group = { hooks?: Array<{ command?: unknown }> }

/**
 * argv (an entry that is not a string, a spawn template slot, is kept as it is) with the
 * long hook commands of its `--settings <json>` moved out: the settings name each by its
 * hash, and each text follows the settings value as `--walnut-hook-file <text>`, once per
 * distinct text. Anything else (no settings, a path, nothing long) comes back unchanged.
 */
export function compactHookArgs<T>(argv: ReadonlyArray<string | T>): Array<string | T> {
  const at = argv.findIndex((a, i) => a === '--settings' && typeof argv[i + 1] === 'string')
  if (at < 0) return argv.slice()
  const raw = argv[at + 1] as string
  let settings: { hooks?: Record<string, unknown> }
  try { settings = JSON.parse(raw) } catch { return argv.slice() }
  const hooks = settings && typeof settings === 'object' ? settings.hooks : undefined
  if (!hooks || typeof hooks !== 'object') return argv.slice()
  const texts = new Map<string, string>()
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups as Group[]) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        const command = hook?.command
        if (typeof command !== 'string' || command.length < HOOK_FILE_MIN_CHARS) continue
        const hash = createHash('sha256').update(command, 'utf8').digest('hex').slice(0, 32)
        texts.set(hash, command)
        hook.command = HOOK_FILE_TOKEN + hash
      }
    }
  }
  if (texts.size === 0) return argv.slice()
  const pairs = [...texts.values()].flatMap((text) => [HOOK_FILE_FLAG, text])
  return [...argv.slice(0, at), '--settings', JSON.stringify(settings), ...pairs, ...argv.slice(at + 2)]
}

/** compactHookArgs when the daemon reads hook files, else argv as it is. */
export function hookArgsFor<T>(daemon: { hasCapability(cap: string): boolean } | null | undefined, argv: ReadonlyArray<string | T>): Array<string | T> {
  return daemon?.hasCapability(HOOK_FILES_CAPABILITY) ? compactHookArgs(argv) : argv.slice()
}
