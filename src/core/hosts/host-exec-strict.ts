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

import { randomBytes } from 'node:crypto'
import { strictMark } from '../../providers/host-exec-line.js'

/**
 * Each strict run's seal: 12 hex digits in its marker lines that only this server knows (not the
 * job's environment, unlike its id), so a line the job prints in Walnut's form is never taken as
 * Walnut's (2026-11-05 review claude13: `echo 'walnut strict <its id>: exit 7 …'; exit 7` named a
 * step that never ran). Kept for the newest runs; after a restart any seal of the right form counts.
 * keep's could-not-save mark carries the same seal (host-exec-keep.ts).
 */
const seals = new Map<string, string>()
const SEALS_KEPT = 5_000
export function sealFor(jobId: string, make = false): string | undefined {
  let seal = seals.get(jobId)
  if (!seal && make) {
    seal = randomBytes(6).toString('hex')
    seals.set(jobId, seal)
    if (seals.size > SEALS_KEPT) seals.delete(seals.keys().next().value!)
  }
  return seal
}
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
/** A marker's head as the output has it: the run's seal when known, else any seal. */
const headSrc = (jobId: string) => `walnut strict ${esc(jobId)} ${sealFor(jobId) ?? '[0-9a-f]{12}'}: exit`

/**
 * A subshell (`( … )`, a pipe's `{ … }` member) fires the ERR trap inside, and what the shell around
 * it does next differs by bash (measured 2026-11-05): bash 5 fires it again naming `( … )` as
 * written; bash 4 fires it again naming the last simple command it ran itself (review: `echo a;
 * (false)` named `echo a`); bash 3.2 (macOS) does not fire it again and just ends. bash's $LINENO
 * also differs: only bash 5 counts a `-c` line's lines from 1 (code review 13: bash 4 gives the line
 * a function is written on, less one). So every line says bash's major version, the inner line also
 * that it is inner: failedStepOf names its command, and the output keeps only the outer line,
 * without the tag. The inner line also gives its subshell's pid ($BASHPID; bash 3.2 has none, so it
 * asks a sh it execs for its parent, a fork only when a subshell fails) and the outer line the last
 * background job's ($!): a subshell started with `&` lends the shell's step nothing, whatever printed
 * when (code review 13: `( …; grep -q x f ) &` named a later failing pipe; 2026-11-11, it still did
 * on the Mac's bash 3.2, whose inner line said pid 0).
 */
const BASH_TAG = '\t(bash '
const SUBSHELL_TAG = '\t(in a subshell, bash '
// A pid may be empty: bash 3.2 asks /bin/sh for it, which a broken machine may lack.
const TAG_RE = /\t\((in a subshell, )?bash (\d+)(?:, (?:pid|bg) (\d*))?\)$/

/**
 * A job id is `hx-` and [A-Za-z0-9_-] only (exec.run refuses others), so it sits in the trap's quotes as it is.
 * Only a failure that ends its shell is marked (`e` in `$-`): bash turns -e off inside `$( … )`, where
 * a failure goes on, and its line named the wrong step later (2026-11-05 code review 12:
 * `x=$(false; echo y)` then a failing `[ -f … ]` named `false`).
 *
 * The EXIT trap does nothing but be there: bash 3.2 and 4 exec the line's last command in place of the
 * shell under `-c` unless the shell has an EXIT trap to run, and an exec'd command never runs the ERR
 * trap (measured 2026-11-05 on 3.2, 4.2 and 5.2: `true` then a failing `grep -q` named no step without
 * it). It keeps the exit code, and a caller's own EXIT trap replaces it and keeps that too. Set before
 * the ERR trap, so the last command of Walnut's own that bash 4 may name is that trap (failedStepOf
 * never names it). With keep (host-exec-keep.ts) keep's own EXIT trap, set before this prefix, does
 * the same job (`exitTrap` false).
 */
const prefix = (jobId: string, seal: string, exitTrap = true) => `set -e; (set -o pipefail) 2>/dev/null && set -o pipefail; if [ -n "\${BASH_VERSION:-}" ]; then set -E; ${exitTrap ? 'trap : EXIT; ' : ''}trap 'walnut_rc=$? walnut_ps="\${PIPESTATUS[*]}"; walnut_in="${BASH_TAG}\${BASH_VERSINFO[0]:-0}, bg \${!:-0})"; [ "\${BASH_SUBSHELL:-0}" = 0 ] || walnut_in="${SUBSHELL_TAG}\${BASH_VERSINFO[0]:-0}, pid \${BASHPID:-$(exec /bin/sh -c "echo \\$PPID" 2>/dev/null)})"; case $- in *e*) printf "\\n${strictMark(jobId, seal)} %s [%s] line %s: %s%s\\n" "$walnut_rc" "$walnut_ps" "\${LINENO:-0}" "$BASH_COMMAND" "$walnut_in" >&2;; esac' ERR; fi`
/**
 * Walnut's own commands, which bash 4 may name as the step that failed after them: strict's traps, and
 * keep's EXIT trap, which bash names in single quotes by its first line (host-exec-keep.ts TRAP_FIRST_LINE).
 */
const OWN_COMMAND_RE = /^trap (?:'walnut_rc=|'\{ POSIXLY_CORRECT=y \|\| \\:; |: EXIT$)/

export function strictLine(line: string, jobId: string, opts: { exitTrap?: boolean } = {}): string {
  if (!/^hx-[A-Za-z0-9_-]+$/.test(jobId)) throw new Error(`strictLine: not a job id: ${jobId}`)
  // On the line's own first line, so bash counts the lines as the caller wrote them (its errors and
  // $LINENO; 2026-11-05 review 12: `cd /nope` on line 2 read "line 3"). Nothing after it: a line cut
  // off (`echo a &&`, `cat <<EOF` with no end) stays the syntax error bash makes of it (code review 13).
  return `${prefix(jobId, sealFor(jobId, true)!, opts.exitTrap !== false)}; ${line}`
}

export interface FailedStep {
  exitCode: number
  /**
   * The failing command: as bash saw it, except that for a pipe whose failing member is not its
   * last ($BASH_COMMAND names the last) it is that member, read from the line when the line splits
   * into as many members as the pipe had (2026-11-04 review: `false | cat` named `cat`).
   */
  command: string
  /** Each member's exit code, for a pipe of two or more. */
  pipeStatus?: number[]
  /** bash's own line number for the step ($LINENO), only from bash 5, where it is the caller's line. */
  bashLine?: number
  /** The command was named inside a subshell (internal: the answer never carries it), so no pipe of the line renames it. */
  inner?: true
  /** A function's own `return N` that ended it, when command names the call of that function instead. */
  returned?: string
  /** The line of the user's command it is on, when its text is found there once. */
  line?: number
  /** That line's text (at most 200 characters). */
  text?: string
}

/** This job's marker lines: its id in them (strictMark), and nothing else's. */
const stepRe = (jobId: string) => new RegExp(`^${headSrc(jobId)} (\\d+) \\[([\\d ]*)\\](?: line (\\d+))?: (.*)$`, 'gm')
const MARK_TAIL = /^ \d+ \[[\d ]*\](?: line \d+)?: /

/** `pid`: an inner line's subshell ($BASHPID), the outer line's last background job ($!); 0 when bash has none. */
interface Mark { rc: number; pipe: number[]; command: string; inner: boolean; bash: number; pid: number; line?: number; from: number; to: number }

function marksOf(output: string, jobId: string): Mark[] {
  return [...output.matchAll(stepRe(jobId))].map((m) => {
    const tag = TAG_RE.exec(m[4]!)
    const line = m[3] ? Number(m[3]) : 0
    const rc = Number(m[1])
    // $PIPESTATUS is the last pipe's: `(( 0 ))` and `[[ … ]]` leave it as it was (2026-11-05 review
    // claude13: `[0]` beside exit 1). Codes whose last failure is not the step's code are not its own.
    const codes = m[2]!.trim().split(/\s+/).filter(Boolean).map(Number)
    const lastBad = [...codes].reverse().find((c) => c !== 0) ?? 0
    return {
      rc, pipe: lastBad === rc ? codes : [rc], command: tag ? m[4]!.slice(0, tag.index) : m[4]!,
      inner: tag?.[1] !== undefined, bash: tag ? Number(tag[2]) : 0, pid: Number(tag?.[3] ?? 0), ...(line > 0 ? { line } : {}), from: m.index!, to: m.index! + m[0].length,
    }
  })
}

/**
 * The step a strict run stopped at, or null. The shell's own last line, naming the command of the
 * subshell line printed right before it (nothing between the two) when that line is what failed: the
 * shell's step is the subshell itself (bash 5 names `( … )`), a pipe member other than its last (each
 * runs in a subshell; bash names the last), a pipe ending in a loop or `{ … }` that failed with that
 * line's code (bash 5 names a command the shell ran before it: code review 13, `printf … | while …`
 * named `printf`), or any shell line under bash 4 (which names a command of its own that ran before).
 * Under bash 4 a run of such lines with one code, one subshell inside the next, gives the first (the
 * innermost; the others name bash's own commands). A subshell's line last of all, with nothing
 * printed after it, is the step under bash 3.2, which ends there without a line of its own, when the
 * run exited with its code; else it is a background `( … ) &` that stopped nothing, or one whose
 * shell went on (`set +e`).
 *
 * A subshell started with `&` lends nothing (its pid is the shell's `$!`).
 *
 * Known limits, from what bash prints. bash 3.2 prints no line of the shell's own after a subshell
 * failed, so a background subshell that failed last of all with nothing printed after it, in a run
 * that exited with its code, is taken as the step; nor does it say a pipe's codes when the pipe's
 * last member (a loop, a `{ … }`) failed inside. For a `( … )` that runs no ERR trap inside (it ends with its own `exit N`, or bash ran
 * its one failing command in place of the subshell, `( grep -q x f )`), bash 4 names a command that
 * ran before it, and so does the answer. Walnut's own commands are never named: no step then.
 */
export function failedStepOf(output: string, jobId: string, exitCode: unknown): FailedStep | null {
  if (!output.includes(`walnut strict ${jobId} `)) return null
  const marks = marksOf(output, jobId)
  const final = marks[marks.length - 1]
  // bash 3.2 ends right after the subshell: anything printed after its line came from a shell that went on.
  if (final?.inner && final.bash > 0 && final.bash < 4 && final.rc !== 0 && final.rc === exitCode && !output.slice(final.to).trim()) {
    return named({ exitCode: final.rc, command: final.command.slice(0, 500), ...(final.pipe.length > 1 ? { pipeStatus: final.pipe } : {}) })
  }
  let at = marks.length - 1
  while (at >= 0 && marks[at]!.inner) at -= 1
  if (at < 0) return null
  const last = marks[at]!
  // set -e ends the shell with the failing step's code: a run that ended otherwise did not stop there.
  if (last.rc === 0 || last.rc !== exitCode) return null
  const base = { exitCode: last.rc, ...(last.line && last.bash >= 5 ? { bashLine: last.line } : {}) }
  // A subshell's line right before `b`, with nothing printed between, from no background job.
  const adjacent = (a: Mark | undefined, b: Mark) => a?.inner === true && !(a.pid > 0 && a.pid === last.pid) && !output.slice(a.to, b.from).trim()
  let prev = adjacent(marks[at - 1], last) ? marks[at - 1]! : undefined
  const outer = last.command.trim()
  const sub = /^\((?!\()/.test(outer)
  const pipe = last.pipe.length > 1
  const bash4 = last.bash === 4 || prev?.bash === 4
  if (prev && ((prev.rc === last.rc && (sub || (pipe && (last.pipe[last.pipe.length - 1] === 0 || last.pipe[last.pipe.length - 1] === prev.rc)))) || bash4)) {
    if (bash4) {
      for (let k = at - 2; k >= 0 && marks[k]!.rc === prev.rc && adjacent(marks[k], prev); k -= 1) prev = marks[k]!
    }
    // A pipe inside the subshell: its failing member, read from the subshell's text as bash wrote it
    // (bash 5), or later from the line (lineOf, pipeMember).
    const inside = sub && prev.pipe.length > 1
      ? pipeMember({ exitCode: prev.rc, command: prev.command, pipeStatus: prev.pipe, text: outer.replace(/^\(\s*/, '').replace(/\s*\)$/, '') })
      : null
    const pipeStatus = pipe ? last.pipe : prev.pipe.length > 1 ? prev.pipe : undefined
    return named({ ...base, exitCode: prev.rc, command: (inside?.command ?? prev.command).slice(0, 500), ...(pipeStatus ? { pipeStatus } : {}), ...(pipe || inside ? { inner: true as const } : {}) })
  }
  return named({ ...base, command: last.command.slice(0, 500), ...(pipe ? { pipeStatus: last.pipe } : {}) })
}

/** The step, unless its command is one of Walnut's own (bash 4 names the last one it ran). */
const named = (step: FailedStep): FailedStep | null => (OWN_COMMAND_RE.test(step.command.trim()) ? null : step)

/** The output without the subshell lines (the shell's own line after each says it once), the bash tag of the shell's own, nor the empty line before it. */
export function withoutInnerMarks(output: string, jobId: string): string {
  if (!output.includes(`walnut strict ${jobId} `)) return output
  const head = new RegExp(`^${headSrc(jobId)}`)
  const lines = output.split('\n')
  const kept: string[] = []
  for (const l of lines) {
    const h = head.exec(l)
    const tag = h && MARK_TAIL.test(l.slice(h[0].length)) ? TAG_RE.exec(l) : null
    if (tag?.[1] !== undefined) {
      // The empty line its printf put first goes with it.
      if (kept.length && kept[kept.length - 1] === '') kept.pop()
      continue
    }
    kept.push(tag ? l.slice(0, tag.index) : l)
  }
  // The empty line before Walnut's own line is its printf's, there for output with no line end.
  return kept.join('\n').replace(new RegExp(`(^|\\n)\\n(?=${headSrc(jobId)} )`, 'g'), '$1')
}

/**
 * The output with Walnut's own line about the failed step (the last marker) naming `step.command`,
 * when bash named another (a pipe's last member, not the one that failed): Walnut wrote that line,
 * so it says what failedStep says (2026-11-05 review: failedStep said `false`, the line `cat`).
 */
export function withStepNamed(output: string, step: FailedStep, jobId: string): string {
  let last: RegExpExecArray | null = null
  for (const m of output.matchAll(stepRe(jobId))) last = m
  if (!last || last.index === undefined) return output
  // The line, code and pipe codes as failedStep has them (a subshell's pipe is its own, not the
  // shell's `[2]`: 2026-11-05 review sol13), or none: bash's own count is the caller's only under bash 5.
  const line = step.line ?? 0
  const codes = step.pipeStatus?.length ? step.pipeStatus.join(' ') : String(step.exitCode)
  return `${output.slice(0, last.index)}${strictMark(jobId)} ${step.exitCode} [${codes}]${line ? ` line ${line}` : ''}: ${step.command}${output.slice(last.index + last[0].length)}`
}

/**
 * A step bash names `return N`: a function returned it, and the step that failed is the call of that
 * function. Under bash 5 $LINENO is the call's line: when that line calls a function the command
 * defines, that call is the step (2026-11-05 review 12: `f() { return 3; }; f` named `return 3`).
 */
export function functionCall(step: FailedStep, command: string): FailedStep {
  if (!/^return\b/.test(step.command) || !step.bashLine) return step
  const text = command.split('\n')[step.bashLine - 1]
  if (text === undefined) return step
  const defined = new Set([...command.matchAll(/(?:^|[\s;{(&|])(?:function\s+([A-Za-z_][\w.:-]*)|([A-Za-z_][\w.:-]*)\s*\(\s*\))/g)].map((m) => m[1] ?? m[2]!))
  const called = [...defined].filter((name) => new RegExp(`(?:^|[\\s;&|({])${name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![\\w.:-])(?!\\s*\\()`).test(text))
  if (called.length !== 1) return step
  return { ...step, command: called[0]!, line: step.bashLine, text: text.trim().slice(0, 200), returned: step.command }
}

/** Text compared without its spaces: bash writes a command back its own way (`2>/dev/null` as `2> /dev/null`). */
const squeezed = (t: string) => t.replace(/\s+/g, '')

/** The 1-based line of `command` holding the step's text, when exactly one does. */
export function lineOf(step: FailedStep, command: string): number | undefined {
  const want = squeezed(step.command)
  if (!want) return undefined
  const hits = command.split('\n').flatMap((l, i) => (squeezed(l).includes(want) ? [i + 1] : []))
  return hits.length === 1 ? hits[0] : undefined
}

/**
 * The line cut at its top-level `;`, `&&`, `||`, `&` and line ends (not inside quotes, `$(...)`,
 * backquotes or a subshell), each part cut again at its lone `|`s: the pipes on the line.
 */
export function pipesOf(line: string): string[][] {
  const pipes: string[][] = []
  let members: string[] = []
  let cur = ''
  let quote: '"' | "'" | '`' | null = null
  let depth = 0
  const endMember = () => { members.push(cur.trim()); cur = '' }
  const endPipe = () => { endMember(); if (members.some(Boolean)) pipes.push(members); members = [] }
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!
    if (quote) {
      cur += c
      if (c === '\\' && quote !== "'" && i + 1 < line.length) { cur += line[i + 1]; i += 1 } else if (c === quote) quote = null
      continue
    }
    if (c === '\\' && i + 1 < line.length) { cur += c + line[i + 1]; i += 1; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue }
    if (c === '(') { depth += 1; cur += c; continue }
    if (c === ')') { depth = Math.max(0, depth - 1); cur += c; continue }
    if (depth > 0) { cur += c; continue }
    const two = line.slice(i, i + 2)
    if (two === '&&' || two === '||') { endPipe(); i += 1; continue }
    if (c === ';' || c === '\n' || (c === '&' && line[i + 1] !== '>' && line[i - 1] !== '>' && line[i - 1] !== '<')) { endPipe(); continue }
    if (c === '|' && line[i + 1] !== '&') { endMember(); continue }
    if (two === '|&') { endMember(); i += 1; continue }
    cur += c
  }
  endPipe()
  return pipes
}

/**
 * A pipe's failing member, read from the line's text, when bash named another; else the step as it
 * is. The pipe is the one on the line with as many members as the pipe had and whose last member is
 * the command bash named, when one alone is (2026-11-05 review: `echo one; true | false | cat`
 * named `cat`, and so did `echo building; ls /nope | cat; ...`), else the only one that size: bash
 * names an earlier command for a pipe ending in `( … )` that exits by itself (code review 13: `echo
 * x | ( read v; exit 3 )` named `echo x`).
 */
export function pipeMember(step: FailedStep): FailedStep {
  const codes = step.pipeStatus ?? []
  const bad = codes.reduce((at, c, i) => (c !== 0 ? i : at), -1)
  if (codes.length < 2 || bad < 0 || !step.text || step.inner) return step
  // The line's pipes, and those inside a subshell that is one member of it (`(ls /nope | cat)`).
  const top = pipesOf(step.text)
  const all = [...top, ...top.flat().flatMap((m) => (/^\(.*\)$/s.test(m) ? pipesOf(m.slice(1, -1)) : []))]
  const sized = all.filter((p) => p.length === codes.length)
  const named = sized.filter((p) => squeezed(p[p.length - 1]!) === squeezed(step.command))
  const pipe = named.length === 1 ? named[0] : named.length === 0 && sized.length === 1 ? sized[0] : undefined
  return pipe?.[bad] ? { ...step, command: pipe[bad]! } : step
}
