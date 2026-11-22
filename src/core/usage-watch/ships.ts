/**
 * Ships: when a task put a change in front of users. A task ships when its session runs a
 * command that lands, deploys or publishes (and no result shows the command failed), or when
 * another release tool says so (`usage_watch {"action":"ship"}`). A land still running counts:
 * a task cannot finish before its own land does and skip the watch.
 */
import { usageDb } from './store.js'
import { base, simpleCommands, unwrap } from './shell-words.js'

const SHELLS = new Set(['bash', 'sh', 'zsh'])
const RUNNERS = new Set(['npm', 'bun', 'pnpm', 'yarn'])
const MAIN_REF_RE = /^(?:\S*:)?(?:refs\/heads\/)?(?:main|master)$/

/** What one simple command ships, or null. A dry run or a help page never counts. */
function shipOfWords(raw: string[], depth: number): string | null {
  const words = unwrap(raw)
  if (!words.length || words.some((w) => w === '--dry-run' || w === '--help' || w === '-h')) return null
  const head = base(words[0])
  const args = words.slice(1)
  if (head === 'walnut-dev' && args[0] === 'land') return 'walnut-dev land'
  if (head === 'walnut-cloud' && args[0] === 'land') return 'walnut-cloud land'
  if (head === 'deploy-committed.sh') return 'deploy-committed'
  if (SHELLS.has(head)) {
    const c = args.indexOf('-c')
    if (c >= 0) return depth < 2 && args[c + 1] !== undefined ? shipOfScript(args[c + 1]!, depth + 1) : null
    const file = args.find((a) => !a.startsWith('-'))
    return base(file) === 'deploy-committed.sh' ? 'deploy-committed' : null
  }
  if (head === 'ssh') {
    // `ssh <host> '<command>'`: the command runs there, and ships the same.
    let i = 0
    while (args[i] !== undefined && args[i]!.startsWith('-')) i += /^-[bcDEeFIiJLlmOopQRSWw]$/.test(args[i]!) ? 2 : 1
    const rest = args.slice(i + 1)
    return depth < 2 && rest.length ? shipOfScript(rest.join(' '), depth + 1) : null
  }
  if (RUNNERS.has(head) && args[0] === 'run' && args[1] === 'dev:prod') return 'dev:prod'
  if (RUNNERS.has(head) && args[0] === 'publish') return 'npm publish'
  if (head === 'gh' && args[0] === 'release' && args[1] === 'create') return 'gh release create'
  if (head === 'git') {
    // Global options before the subcommand (`git -C <dir> <sub>`, `git -c k=v <sub>`).
    let i = 0
    while (args[i] !== undefined && args[i]!.startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
    if (args[i] !== 'push') return null
    return args.slice(i + 1).some((a) => !a.startsWith('-') && MAIN_REF_RE.test(a)) ? 'a push to main' : null
  }
  return null
}

function shipOfScript(script: string, depth: number): string | null {
  for (const words of simpleCommands(script)) {
    const how = shipOfWords(words, depth)
    if (how) return how
  }
  return null
}

/** What a Bash command ships (a land, deploy, publish or update of main it runs), or null. */
export function shipOfCommand(command: string): string | null {
  return command ? shipOfScript(command, 0) : null
}

/**
 * Whether a ship command's result shows it failed: a foreground command's non-zero exit, a push
 * the remote refused, a land that refused. A background start or a success line is not a failure.
 */
export function shipFailed(result: string): boolean {
  const text = String(result ?? '')
  if (/Command running in background with ID/.test(text)) return false
  const head = text.slice(0, 400)
  if (/^\s*(?:<error>)?\s*Exit code [1-9]\d*/.test(head)) return true
  return /\[rejected\]|\berror: failed to push\b|\bland refused\b|\brefused: nothing landed\b/i.test(text.slice(-4_000))
}

export interface Ship { taskId: string; key: string; at: number; how: string; state: 'started' | 'done' | 'failed' }

export function recordShip(s: Ship): void {
  usageDb(undefined, (d) => {
    // A replayed tool call (a reconnect, a history fill) keeps the first time: a later one would
    // move the ship past a watch that covers it.
    d.prepare('INSERT OR IGNORE INTO ships (task_id, key, at, how, state) VALUES (?, ?, ?, ?, ?)').run(s.taskId, s.key, s.at, s.how, s.state)
  })
}

export function setShipState(taskId: string, key: string, state: Ship['state']): void {
  usageDb(undefined, (d) => { d.prepare('UPDATE ships SET state = ? WHERE task_id = ? AND key = ?').run(state, taskId, key) })
}

/** A task's ships that count (started or done), newest first. */
export function shipsOf(taskId: string): Ship[] {
  return usageDb([], (d) => (d.prepare("SELECT task_id, key, at, how, state FROM ships WHERE task_id = ? AND state != 'failed' ORDER BY at DESC LIMIT 50").all(taskId) as Array<Record<string, unknown>>)
    .map((r) => ({ taskId: String(r.task_id), key: String(r.key), at: Number(r.at), how: String(r.how), state: String(r.state) as Ship['state'] })))
}

export function lastShipOf(taskId: string): Ship | null {
  return shipsOf(taskId)[0] ?? null
}
