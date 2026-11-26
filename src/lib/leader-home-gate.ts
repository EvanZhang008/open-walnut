/**
 * One rule for every git that writes: none writes into a data home that a leader switch is taking away or took
 * away. Fail-closed: only the read subcommands and read forms listed here count as reads; a read runs with
 * readOnlyGitEnv so it writes nothing either (no index refresh); a marker that cannot be read refuses. Its marker (local/leader-switch/handed-over.json, core/leader/switch/records.ts) says 'switching' from the
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

/**
 * Git subcommands that only read the repo they run in (with readOnlyGitEnv, which every gated spawner applies: in a
 * marked home a `status` or `diff` then never refreshes .git/index). The rule is fail-closed: every other subcommand counts as a
 * write, so one this list has not heard of is refused in a marked home, never let through.
 */
export const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'annotate', 'blame', 'cat-file', 'check-attr', 'check-ignore', 'check-mailmap', 'check-ref-format', 'cherry', 'count-objects',
  'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'for-each-ref', 'get-tar-commit-id', 'grep', 'help', 'log',
  'ls-files', 'ls-remote', 'ls-tree', 'merge-base', 'name-rev', 'patch-id', 'range-diff', 'rev-list', 'rev-parse', 'shortlog',
  'show', 'show-branch', 'show-ref', 'status', 'stripspace', 'var', 'verify-commit', 'verify-pack', 'verify-tag', 'version',
  'whatchanged',
])

/** Subcommands that read in some forms only (gitArgvWrites names each form); any other form writes. */
const READ_IN_SOME_FORMS = new Set(['apply', 'branch', 'bundle', 'config', 'hash-object', 'notes', 'reflog', 'remote', 'stash', 'symbolic-ref', 'tag', 'worktree'])

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

/** Whether the argv may write. Fail-closed: only the read subcommands and the read forms below do not. */
export function gitArgvWrites(argv: readonly string[]): boolean {
  const at = subcommandAt(argv)
  if (at < 0) return false
  const sub = argv[at]!
  if (GIT_READ_SUBCOMMANDS.has(sub)) return false
  if (!READ_IN_SOME_FORMS.has(sub)) return true
  const rest = argv.slice(at + 1)
  const has = (...flags: string[]) => flags.some((f) => rest.includes(f))
  const words = rest.filter((a) => !a.startsWith('-'))
  switch (sub) {
    // Without -w it only prints the id.
    case 'hash-object': return has('-w')
    case 'stash': return !(words[0] === 'list' || words[0] === 'show')
    case 'worktree': return words[0] !== 'list'
    case 'notes': return !(words[0] === 'list' || words[0] === 'show')
    // `git reflog` alone is `reflog show`; expire and delete write.
    case 'reflog': return !(words.length === 0 || words[0] === 'show' || words[0] === 'exists')
    // One name reads it; two set it; -d deletes.
    case 'symbolic-ref': return has('-d', '--delete') || words.length !== 1
    case 'tag': return !(words.length === 0 || has('-l', '--list'))
    case 'remote': return !(words.length === 0 || words[0] === 'get-url' || words[0] === 'show')
    case 'bundle': return !(words[0] === 'verify' || words[0] === 'list-heads')
    // --check and the summaries read; anything that applies writes.
    case 'apply': return !(has('--check', '--stat', '--numstat', '--summary') && !has('--index', '--cached', '--apply', '-3', '--3way'))
    case 'branch': {
      if (has('-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description', '-f', '--force', '-t', '--track')) return true
      // Listing (no name, or patterns after --list) and --show-current read; a name creates a branch.
      return !(words.length === 0 || has('-l', '--list', '--show-current', '--contains', '--merged', '--no-merged', '--points-at'))
    }
    case 'config': {
      if (has('--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit')) return true
      if (words[0] === 'get' || words[0] === 'list') return false
      if (has('--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '-l', '--list')) return false
      // `config <key>` reads it; `config <key> <value>` (or `config set`) writes.
      return words.length !== 1
    }
  }
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
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // Only a missing file (or a missing folder on the way) is no marker; a marker that cannot be read (EACCES, EIO,
      // a folder where the file should be) refuses: a wrong refusal costs one snapshot, a wrong pass the old home.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { home: at, state: 'handed-over' }
    }
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

/**
 * The env a git child gets so that its reads leave a data home under a leader switch byte for byte as it was:
 * GIT_OPTIONAL_LOCKS=0 (a status never writes .git/index back) and diff.autoRefreshIndex=false (a `git diff` of the
 * work tree rewrites the index after a touch even with optional locks off, git 2.47). Only a marked home (`cwd` in
 * it): anywhere else the env comes back unchanged, so a status refreshes the index as git always did and a touched
 * file is hashed once, not on every status (2026-11-26: with optional locks off everywhere, every git-sync status of
 * a 20 GB home whose files were touched took 98 to 131 s, against 0.04 s once the index was refreshed). Appends to
 * GIT_CONFIG_COUNT; returns a new env.
 */
export function readOnlyGitEnv<T extends Record<string, string | undefined>>(env: T, cwd: string): T {
  const out: Record<string, string | undefined> = { ...env }
  if (cwd && leaderHomeMarkAt(cwd)) {
    out.GIT_OPTIONAL_LOCKS = '0'
    const n = Number(out.GIT_CONFIG_COUNT) > 0 ? Number(out.GIT_CONFIG_COUNT) : 0
    out[`GIT_CONFIG_KEY_${n}`] = 'diff.autoRefreshIndex'
    out[`GIT_CONFIG_VALUE_${n}`] = 'false'
    out.GIT_CONFIG_COUNT = String(n + 1)
  }
  return out as T
}
