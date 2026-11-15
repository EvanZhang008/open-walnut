/**
 * Which path in a temp directory is work a session must not lose (a draft, plan, note or evidence
 * file), and the note that tells the session to move it into its task directory. The TypeScript
 * twin of the Write/Bash hook's awk (src/providers/tmp-write-note-hook.ts): that hook runs as POSIX
 * sh on a host that may have no node, this one runs in a session's own `walnut` CLI or MCP server
 * process, on the session's host. tests/lib/tmp-draft-path.test.ts runs both on one table, so they
 * never judge a path differently.
 *
 * Why (2026-11-04): a task asked the user a question naming the temp folder its draft lived in
 * (a folder named for a risk report), waited 10 hours, and nothing flagged it: only a Write of a
 * draft got a note. Now a Walnut op's arguments (executor.ts) and the text a turn ends with (the
 * Stop hook through open_items) are checked too.
 *
 * What counts (from the path alone, never the content):
 * - prose formats always: .md .markdown .mdx .rst .org .adoc;
 * - any other file whose name or one of whose directories below the temp root carries a word
 *   like draft, plan, notes, evidence, report, summary, handoff, todo, commit-msg;
 * - never images, video, audio, .log, .html or archives, never test output folders, never Claude
 *   Code's own scratch tree (/tmp/claude-<uid>/), never a path in the task directory.
 */
import fs from 'node:fs'

export interface TmpDraftEnv {
  /** The session's TMPDIR. */
  tmpdir?: string
  /** The session's WALNUT_TASK_DIR. */
  taskDir?: string
}

const IGNORED_EXT = /^(png|jpe?g|gif|webp|heic|bmp|tiff?|svg|ico|mp4|mov|webm|mkv|avi|mp3|wav|m4a|ogg|flac|log|html?|gz|tgz|zip|tar|bz2|xz|7z)$/
const IGNORED_DIR = /^(playwright-report|test-results|coverage|node_modules)$/
const PROSE_EXT = /^(md|markdown|mdx|rst|org|adoc)$/
const WORK_WORD = /(^|[-_. ])(drafts?|plans?|notes?|evidence|reports?|summary|summaries|handoff|todo|commit-?msg|msg|messages?|pr-?body|pr-?desc|desc|description|comments?|letter|reply|memo)([-_. 0-9]|$)/

function strip(p: string): string {
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

/** `..` and `.` resolved, doubled slashes folded; never touches the disk. */
export function normPath(p: string): string {
  const stack: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') { stack.pop(); continue }
    stack.push(part)
  }
  return '/' + stack.join('/')
}

/** macOS /var and /tmp are /private/var and /private/tmp: compared without the prefix. */
function canon(p: string): string {
  return /^\/private\/(var|tmp)(\/|$)/.test(p) ? p.slice(8) : p
}

function under(p: string, root: string): boolean {
  const r = canon(strip(root))
  const c = canon(p)
  return r !== '' && (c === r || c.startsWith(r + '/'))
}

function volatile(p: string, env: TmpDraftEnv): boolean {
  if (p === '' || (env.taskDir && under(p, strip(env.taskDir)))) return false
  return under(p, '/tmp') || under(p, '/var/folders') || (!!env.tmpdir && under(p, normPath(env.tmpdir)))
}

/** The part of p below the temp root it sits in: the words the session chose, never the root's own. */
function below(p: string, env: TmpDraftEnv): string {
  const r = env.tmpdir ? normPath(env.tmpdir) : ''
  if (r && under(p, r)) return canon(p).slice(canon(strip(r)).length + 1)
  if (under(p, '/tmp')) return canon(p).slice(5)
  if (under(p, '/var/folders')) return canon(p).slice(13)
  return ''
}

/** camelCase words apart: slackDraft is slack-draft (PLAN.MD stays one word). */
function words(s: string): string {
  return s.replace(/([a-z0-9])(?=[A-Z])/g, '$1-').toLowerCase()
}

function worthy(rel: string): boolean {
  // Claude Code's own scratch tree (/tmp/claude-<uid>/<project>/<session>/tasks/<id>.output): its
  // project folder's name is the repo's, never a draft's.
  if (/^claude-[0-9]+(\/|$)/.test(rel)) return false
  const seg = words(rel).split('/')
  const base = seg[seg.length - 1]
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1) : ''
  const stem = dot > 0 ? base.slice(0, dot) : base
  if (IGNORED_EXT.test(ext)) return false
  if (seg.slice(0, -1).some((s) => IGNORED_DIR.test(s))) return false
  if (PROSE_EXT.test(ext)) return true
  seg[seg.length - 1] = stem
  return seg.some((s) => WORK_WORD.test(s))
}

/** An absolute path in a temp directory that is a draft, plan, note or evidence file (or folder). */
export function isTempDraftPath(p: string, env: TmpDraftEnv): boolean {
  if (!p.startsWith('/')) return false
  const n = normPath(p)
  return volatile(n, env) && worthy(below(n, env))
}

/** Where a temp path may start in free text: /tmp, /private/tmp, /var/folders, /private/var/folders. */
const TEMP_START = /\/(?:private\/)?(?:tmp|var\/folders)\//g
/** The characters a path in text runs through: it ends at a space, quote, bracket, backtick or comma. */
const PATH_RUN = /^[^\s"'`<>(){}[\]|,;*\\]*/

/**
 * The temp draft paths that exist on this host, named anywhere in `text` (deduped, at most `max`).
 * A path starts only where a path can (never the tail of a longer one such as a/tmp/x), drops
 * trailing punctuation, and one glued to a non-ASCII word (CJK text right after it) is tried
 * without that tail. At most 50 candidates are looked at, each under 1024 characters.
 */
export function findTempDraftPaths(text: string, env: TmpDraftEnv, exists: (p: string) => boolean = fs.existsSync, max = 5): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const starts: number[] = []
  TEMP_START.lastIndex = 0
  for (let m = TEMP_START.exec(text); m && starts.length < 50; m = TEMP_START.exec(text)) starts.push(m.index)
  const root = env.tmpdir ? strip(env.tmpdir) : ''
  if (root && root !== '/') for (let i = text.indexOf(root + '/'); i >= 0 && starts.length < 50; i = text.indexOf(root + '/', i + 1)) starts.push(i)
  for (const at of [...new Set(starts)].sort((a, b) => a - b)) {
    if (found.length >= max) break
    if (at > 0 && /[A-Za-z0-9_.~/-]/.test(text[at - 1])) continue
    let p = (PATH_RUN.exec(text.slice(at, at + 1100)) ?? [''])[0]
    if (p.length > 1024) continue
    p = p.replace(/[.:!?]+$/, '')
    const nonAscii = p.search(/[^\x20-\x7e]/)
    if (nonAscii > 0 && !exists(p)) p = p.slice(0, nonAscii).replace(/[.:!?]+$/, '')
    p = normPath(p)
    if (seen.has(p)) continue
    seen.add(p)
    if (isTempDraftPath(p, env) && exists(p)) found.push(p)
  }
  return found
}

/** p inside single quotes for a shell. */
function sq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

/** The task directory for the example command: a path in single quotes, or the variable the session expands. */
function dirArg(taskDir: string): string {
  return taskDir.startsWith('$') ? `"${taskDir}/"` : sq(strip(taskDir) + '/')
}

/** The task directory's name in a note when the process does not know it (the server answering a session). */
export const TASK_DIR_VAR = '$WALNUT_TASK_DIR'

function joined(paths: string[]): string {
  return paths.length <= 1 ? (paths[0] ?? '') : `${paths.slice(0, -1).join(', ')} and ${paths[paths.length - 1]}`
}

/**
 * The one line a session hears when text it hands on names temp draft paths: `what` names the
 * text ("Your reply", "This Walnut call (task_send)"), `sendTo` where the new path goes.
 */
export function handedPathNote(what: string, paths: string[], taskDir: string, sendTo: string): string {
  return `Walnut note: ${what} names ${joined(paths)}, in a temp directory. Temp directories are emptied at every reboot `
    + 'and swept by cleaners between boots, so whoever reads it may find it gone. '
    + `Move it into your task directory, which survives reboots (for example: mv ${sq(paths[0])} ${dirArg(taskDir)}), then ${sendTo}. `
    + 'Screenshots and scratch output can stay in /tmp.'
}

/**
 * Walnut ops whose arguments are not text handed to a reader: a temp path in them is the thing
 * they work on (a command to run, a file to copy or upload), or Walnut's own hook call. Every
 * other op, a new one included, is checked (tests/lib/tmp-draft-path.test.ts).
 */
export const TMP_NOTE_EXEMPT_OPS: Readonly<Record<string, string>> = {
  host_exec: 'runs a command on a host; its paths are that host\'s',
  host_exec_pinned: 'runs a pinned command on a host, like host_exec',
  host_copy: 'copies files between hosts; a temp path is a source or a target',
  host_http: 'calls a web service on a host',
  host_mcp_call: 'calls an MCP tool on a host',
  mcp_call: 'calls an MCP tool',
  browser: 'drives a browser; a temp path is a screenshot or a file to upload',
  open_items: 'Walnut\'s own hooks call it; the Stop hook\'s note on the turn\'s text is built in it',
}

/** Every string inside an op's arguments, joined (keys left out). */
function argText(v: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 400) return
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) argText(x, out, depth + 1)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) argText(x, out, depth + 1)
}

/**
 * The note for a Walnut op a session called whose arguments name a temp draft, or null for an
 * exempt op. `checkDisk`: the process sees the session's files (its own CLI or MCP server, or the
 * server answering a session on this machine), so only a path that exists counts; a session on
 * another host is judged by the path's words alone.
 */
export function opTmpPathNote(op: string, args: unknown, o: { taskDir: string; tmpdir?: string; checkDisk: boolean; exists?: (p: string) => boolean }): string | null {
  if (op in TMP_NOTE_EXEMPT_OPS) return null
  const parts: string[] = []
  argText(args, parts)
  const text = parts.join('\n')
  if (!/\/(tmp|var\/folders)\//.test(text) && !(o.tmpdir && text.includes(strip(o.tmpdir)))) return null
  const env = { tmpdir: o.tmpdir, taskDir: o.taskDir.startsWith('$') ? undefined : o.taskDir }
  const paths = findTempDraftPaths(text, env, o.checkDisk ? (o.exists ?? fs.existsSync) : () => true)
  return paths.length ? handedPathNote(`This Walnut call (${op})`, paths, o.taskDir, 'send the new path where this call sent it') : null
}

/**
 * The Stop hook's note: the temp paths its sh read from the turn's final text and found on the
 * session's host (`tmp_paths`, `|` separated), judged by their words here. Null when none is a
 * draft. `taskDir`: the session's, or TASK_DIR_VAR when this process does not know it.
 */
export function stopTmpPathNote(tmpPaths: unknown, o: { taskDir: string; tmpdir?: string }): string | null {
  if (typeof tmpPaths !== 'string' || !tmpPaths) return null
  const env = { tmpdir: o.tmpdir, taskDir: o.taskDir.startsWith('$') ? undefined : o.taskDir }
  const paths = findTempDraftPaths(tmpPaths.split('|').join(' '), env, () => true)
  return paths.length ? handedPathNote('Your reply', paths, o.taskDir, 'tell the reader the new path in one line') : null
}
