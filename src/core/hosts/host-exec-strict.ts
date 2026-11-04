/**
 * host_exec `strict`: the line stops at the first command that fails, a failure inside a pipe
 * counts (pipefail), and the answer names the step (`failedStep`). An agent reading a chained
 * `a; b | c; d` otherwise sees only the last command's exit code and guesses which one broke.
 *
 * The server shapes the line, so a host on an older daemon gets it too. It runs in bash, or sh
 * where a host has none: pipefail and the ERR trap are set only where the shell has them, and a
 * shell without them still stops at the first failure (`set -e`). bash's LINENO is not the
 * user's line under `-c` or in a function, so the line is found by the failing command's own
 * text (lineOf), and a pipe's member statuses come with it ($BASH_COMMAND names its last member).
 */

const MARK = 'walnut strict: exit'
const PREFIX = `set -e; (set -o pipefail) 2>/dev/null && set -o pipefail; if [ -n "\${BASH_VERSION:-}" ]; then set -E; trap 'walnut_rc=$? walnut_ps="\${PIPESTATUS[*]}"; printf "\\n${MARK} %s [%s]: %s\\n" "$walnut_rc" "$walnut_ps" "$BASH_COMMAND" >&2' ERR; fi`

export function strictLine(line: string): string {
  return `${PREFIX}\n${line}`
}

export interface FailedStep {
  exitCode: number
  /** The failing command as bash saw it (a pipe's last member when the pipe failed). */
  command: string
  /** Each member's exit code, for a pipe of two or more. */
  pipeStatus?: number[]
  /** The line of the user's command it is on, when its text is found there once. */
  line?: number
}

const STEP_RE = /^walnut strict: exit (\d+) \[([\d ]*)\]: (.*)$/gm

/** The step a strict run stopped at (the last marker in its output), or null. */
export function failedStepOf(output: string): FailedStep | null {
  if (!output.includes(MARK)) return null
  let last: RegExpExecArray | null = null
  for (const m of output.matchAll(STEP_RE)) last = m
  if (!last) return null
  const pipe = last[2].trim().split(/\s+/).filter(Boolean).map(Number)
  return { exitCode: Number(last[1]), command: last[3].slice(0, 500), ...(pipe.length > 1 ? { pipeStatus: pipe } : {}) }
}

/** The 1-based line of `command` holding the step's text, when exactly one does. */
export function lineOf(step: FailedStep, command: string): number | undefined {
  const want = step.command.trim()
  if (!want) return undefined
  const hits = command.split('\n').flatMap((l, i) => (l.includes(want) ? [i + 1] : []))
  return hits.length === 1 ? hits[0] : undefined
}
