/**
 * One rule for every git that writes: none writes into a data home that a leader switch is taking away or took
 * away. Its marker (local/leader-switch/handed-over.json, core/leader/switch/records.ts) says 'switching' from the
 * switch's start and 'handed-over' once it committed; a handed-over home must stay as it was (the switch-back and
 * the old-home check compare it byte for byte), and during the switch the final batch needs a home that stops
 * changing.
 *
 * The 2026-11-26 red: the main agent's session works in the data home (its cwd is the home), so the daemon's turn
 * snapshot of that session wrote into the home's .git: refs/walnut/turns/<sid>/<n> and their objects while it led,
 * and after a switch, the empty tree object 4b825dc into the handed-over home (the session goes on as a session of
 * the new leader on this host).
 *
 * Who asks:
 *  - the daemon twins' git runners (turn-snapshot-core, git-commit-core, transfer-pack-core, workspace-core: a
 *    session's repo, which may be the home or under it) refuse a writing git under a marker in either state
 *    (`daemonGitWriteRefusal`, handed to them as deps.gitWriteRefused): the daemon outlives its server's stop and
 *    gets no signal of it;
 *  - the server's spawners (integrations/git-children.ts refuseGitInQuiet: git-sync, the bundle client) refuse one
 *    under a 'handed-over' marker (`serverGitWriteRefusal`); during the switch the leader still runs its git sync
 *    until its stop, whose quiet (quietGitWriters) refuses every git from then on.
 * tests/core/leader/switch/switch-stop-writers-ratchet.test.ts pins every git runner of src/ to one of these.
 *
 * Leaf module: node's fs and path only.
 */
import fs from 'node:fs'
import path from 'node:path'

/** The marker's place in a data home (records.ts markerFile builds it from this). */
export const LEADER_SWITCH_MARKER_REL = path.join('local', 'leader-switch', 'handed-over.json')

/** Git subcommands that may write objects, refs, the index or the work tree of the repo they run in. */
export const GIT_WRITING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'commit-tree', 'fetch', 'gc', 'hash-object',
  'index-pack', 'init', 'maintenance', 'merge', 'merge-tree', 'mktag', 'mktree', 'mv', 'notes', 'pack-objects', 'prune',
  'pull', 'read-tree', 'rebase', 'repack', 'replay', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'symbolic-ref',
  'tag', 'unpack-objects', 'update-index', 'update-ref', 'worktree', 'write-tree',
])

/** Options that take the next argument (`git -C dir`, `-c key=value`): skipped to find the subcommand. */
const OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix'])

/** Where the subcommand sits in a git argv (with or without a leading 'git'), or -1. */
function subcommandAt(argv: readonly string[]): number {
  const from = argv[0] === 'git' || /[\\/]git$/.test(argv[0] ?? '') ? 1 : 0
  for (let i = from; i < argv.length; i++) {
    const a = argv[i]!
    if (OPTIONS_WITH_VALUE.has(a)) { i++; continue }
    if (a.startsWith('-')) continue
    return i
  }
  return -1
}

/** The subcommand of a git argv (with or without a leading 'git'), or null. */
export function gitSubcommand(argv: readonly string[]): string | null {
  const at = subcommandAt(argv)
  return at < 0 ? null : argv[at]!
}

/** Subcommands whose first word after them makes a read: `stash list`, `worktree list`, `notes show`. */
const READ_FORMS: Readonly<Record<string, ReadonlySet<string>>> = {
  stash: new Set(['list', 'show']), worktree: new Set(['list']), notes: new Set(['list', 'show']),
}

/**
 * Whether the argv may write: by its subcommand, except the read forms (`hash-object` without -w, `stash list`,
 * `worktree list`, `notes list|show`, `symbolic-ref` naming one ref, `tag` listing).
 */
export function gitArgvWrites(argv: readonly string[]): boolean {
  const at = subcommandAt(argv)
  if (at < 0) return false
  const sub = argv[at]!
  if (!GIT_WRITING_SUBCOMMANDS.has(sub)) return false
  const rest = argv.slice(at + 1)
  const words = rest.filter((a) => !a.startsWith('-'))
  if (sub === 'hash-object') return rest.includes('-w')
  if (READ_FORMS[sub]) return !(words[0] && READ_FORMS[sub]!.has(words[0]))
  if (sub === 'symbolic-ref') return rest.includes('-d') || rest.includes('--delete') || words.length >= 2
  if (sub === 'tag') return !(rest.includes('-l') || rest.includes('--list') || words.length === 0)
  return true
}

/** Where git runs: the argv's last `-C dir` (relative to cwd), else cwd. */
function gitDirOf(argv: readonly string[], cwd: string): string {
  let dir = cwd
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === '-C') dir = path.resolve(dir, argv[i + 1]!)
  return dir
}

export interface LeaderHomeMark { home: string; state: 'switching' | 'handed-over' }

/** The marker of the data home at `dir` or above it (a repo inside a home: plugins/<x>), or null. */
export function leaderHomeMarkAt(dir: string): LeaderHomeMark | null {
  let at = path.resolve(dir)
  for (;;) {
    const file = path.join(at, LEADER_SWITCH_MARKER_REL)
    let text: string | null = null
    try { text = fs.readFileSync(file, 'utf8') } catch { /* none here */ }
    if (text !== null) {
      // A marker that cannot be read marks the home as handed over (records.ts readMarker: never "not handed over").
      let state: LeaderHomeMark['state'] = 'handed-over'
      try { if ((JSON.parse(text) as { state?: unknown }).state === 'switching') state = 'switching' } catch { /* torn */ }
      return { home: at, state }
    }
    const up = path.dirname(at)
    if (up === at) return null
    at = up
  }
}

function refusal(argv: readonly string[], mark: LeaderHomeMark): string {
  const what = mark.state === 'switching' ? 'a leader switch is taking it away' : 'it was handed over to another machine'
  return `git ${gitSubcommand(argv)} refused: ${mark.home} is a Walnut data home ${what} (local/leader-switch/handed-over.json), and nothing writes into it`
}

/** For a daemon's git: why this argv may not run in `cwd` (a writing git under a marker of either state), or null. */
export function daemonGitWriteRefusal(argv: readonly string[], cwd: string): string | null {
  if (!gitArgvWrites(argv)) return null
  const mark = leaderHomeMarkAt(gitDirOf(argv, cwd))
  return mark ? refusal(argv, mark) : null
}

/** For a server's git: why this argv may not run in `cwd` (a writing git in a handed-over home), or null. */
export function serverGitWriteRefusal(argv: readonly string[], cwd: string): string | null {
  if (!gitArgvWrites(argv)) return null
  const mark = leaderHomeMarkAt(gitDirOf(argv, cwd))
  return mark?.state === 'handed-over' ? refusal(argv, mark) : null
}
