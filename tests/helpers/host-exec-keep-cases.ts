/**
 * host_exec keep against a real shell (src/core/hosts/host-exec-keep.ts): the cases as data and the
 * runner that plays one, so the same cases replay on any bash a machine has (bash 3.2 on a Mac's
 * /bin/bash, 4.2, 5.x; more with WALNUT_KEEP_BASHES=/path/a:/path/b). Each step runs the line Walnut
 * builds as `<shell> -c` in its own process group, both streams in one file, as the daemon runs it
 * (host-exec-core.ts), with WALNUT_TASK_DIR set to the case's own task directory.
 *
 * In a case's text, {home} is the directory a run starts in by default, {root} the case's temp dir,
 * {task} its task directory.
 *
 * MACHINE SAFETY: short shell children under a 10 s timeout, in their own temp dirs; a signal goes
 * only to the process group of a child this runner started (pid > 1).
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shapedLine } from '../../src/core/hosts/host-exec-keep.js'

export interface KeepStep {
  command: string
  /** A plain line run first, with no keep (to break the state file, remove a directory). */
  setup?: string
  cwd?: string
  keep?: boolean
  strict?: boolean
  background?: boolean
  /** Run under a POSIX sh that is not bash (the case is skipped where the machine has none). */
  sh?: boolean
  /** Lines run at the same time as `command`, with the same options. */
  parallel?: string[]
  /** Send this signal to the run's process group after `afterMs`. */
  kill?: { signal: 'SIGTERM' | 'SIGKILL'; afterMs: number }
  expect: {
    rc?: number | null
    signal?: string | null
    out?: string
    has?: string[]
    not?: string[]
    /** A regular expression the whole output matches. */
    match?: string
  }
}

export interface KeepCase { name: string; steps: KeepStep[] }

/** A value with every kind of character a quote can trip on. */
export const ODD_VALUE = 'a  b "dq" \'sq\' $HOME ${x} `echo bt` \\ back\nline two\ttab \u00e9 \u2713 \u{1F389} end\n'
/** ODD_VALUE quoted for bash (single quotes; a newline inside them is kept as it is). */
const quoted = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`

const STATE = '"$WALNUT_TASK_DIR/host-exec/keep.sh"'

export const KEEP_CASES: KeepCase[] = [
  { name: 'cd carries to the next keep call', steps: [
    { command: 'mkdir -p proj/sub && cd proj/sub', expect: { rc: 0, out: '' } },
    { command: 'pwd', expect: { rc: 0, out: '{home}/proj/sub\n' } },
    { command: 'pwd', keep: false, expect: { out: '{home}\n' } },
    { command: 'cd ..; pwd', expect: { out: '{home}/proj\n' } },
    { command: 'pwd', expect: { out: '{home}/proj\n' } },
  ] },
  { name: 'an explicit cwd wins, and where that run ends is kept', steps: [
    { command: 'mkdir -p proj other && cd proj', expect: { rc: 0 } },
    { command: 'pwd', cwd: '{home}/other', expect: { out: '{home}/other\n' } },
    { command: 'pwd', expect: { out: '{home}/other\n' } },
  ] },
  { name: 'exported variables carry: new, changed and unset, across a call that changes nothing', steps: [
    { command: 'export NEWV=new KEEPTEST_BASE=changed; unset KEEPTEST_GONE; UNEXPORTED=1', expect: { rc: 0, out: '' } },
    { command: 'true', expect: { rc: 0, out: '' } },
    { command: 'echo "${NEWV-unset}|${KEEPTEST_BASE-unset}|${KEEPTEST_GONE-unset}|${UNEXPORTED-unset}"', expect: { out: 'new|changed|unset|unset\n' } },
    { command: 'echo "${NEWV-unset}|${KEEPTEST_BASE-unset}|${KEEPTEST_GONE-unset}"', keep: false, expect: { out: 'unset|base|here\n' } },
    { command: 'export KEEPTEST_GONE=back; unset NEWV', expect: { rc: 0 } },
    { command: 'echo "${NEWV-unset}|${KEEPTEST_BASE-unset}|${KEEPTEST_GONE-unset}"', expect: { out: 'unset|changed|back\n' } },
  ] },
  { name: 'a venv-like activate carries PATH and VIRTUAL_ENV, not its deactivate function', steps: [
    { command: 'mkdir -p venv/bin && printf \'%s\\n\' \'export VIRTUAL_ENV="$PWD/venv"\' \'export PATH="$VIRTUAL_ENV/bin:$PATH"\' \'deactivate() { :; }\' > venv/bin/activate'
      + ' && printf \'#!/bin/sh\\necho venv-tool\\n\' > venv/bin/vtool && chmod +x venv/bin/vtool && . venv/bin/activate && vtool', expect: { rc: 0, out: 'venv-tool\n' } },
    { command: 'echo "$VIRTUAL_ENV"; vtool; type deactivate >/dev/null 2>&1 && echo has-deactivate || echo no-deactivate', expect: { rc: 0, out: '{home}/venv\nvenv-tool\nno-deactivate\n' } },
  ] },
  { name: 'values with spaces, quotes, $, backquotes, newlines and unicode carry exactly', steps: [
    { command: `export KV=${quoted(ODD_VALUE)}`, expect: { rc: 0, out: '' } },
    { command: 'cd /', expect: { rc: 0 } },
    { command: 'printf "[%s]" "$KV"', expect: { out: `[${ODD_VALUE}]` } },
    { command: `export LANG=C.UTF-8 KU=${quoted('\u00e9\u2713\u{1F389}')}`, expect: { rc: 0 } },
    { command: 'printf "[%s][%s]" "$KU" "$KV"', expect: { out: `[\u00e9\u2713\u{1F389}][${ODD_VALUE}]` } },
  ] },
  { name: 'readonly and excluded names never carry', steps: [
    { command: 'export RO_V=1; readonly RO_V; export SHLVL=9 walnut_x=1 BASH_KEEPX=1 KEEP_OK=1', expect: { rc: 0 } },
    { command: 'echo "${RO_V-unset}|${walnut_x-unset}|${BASH_KEEPX-unset}|$SHLVL|$KEEP_OK"; RO_V=2 && echo writable', expect: { rc: 0, out: 'unset|unset|unset|1|1\nwritable\n' } },
    { command: `grep -c -e RO_V -e walnut_x -e BASH_KEEPX -e SHLVL ${STATE}`, keep: false, expect: { out: '0\n' } },
  ] },
  { name: 'exit 3 saves, and the run exits 3', steps: [
    { command: 'export AFTER_EXIT=yes; cd /; exit 3', expect: { rc: 3, out: '' } },
    { command: 'echo "${AFTER_EXIT-unset} $PWD"', expect: { out: 'yes /\n' } },
  ] },
  { name: 'a failing last command keeps its code, and the state saves', steps: [
    { command: 'export FAILV=1; false', expect: { rc: 1, out: '' } },
    { command: 'export FAILV=2; grep -q zz-nomatch /dev/null', expect: { rc: 1 } },
    { command: 'export FAILV=3; sh -c \'exit 7\'', expect: { rc: 7 } },
    { command: 'echo "$FAILV"', expect: { out: '3\n' } },
  ] },
  { name: 'a line that sets its own EXIT trap saves nothing, and its trap still runs', steps: [
    { command: 'export UT=1; trap \'echo user-trap-ran\' EXIT', expect: { rc: 0, out: 'user-trap-ran\n' } },
    { command: 'echo "${UT-unset}"', expect: { out: 'unset\n' } },
  ] },
  { name: 'a line that execs saves nothing', steps: [
    { command: 'export EX=1; exec sh -c \'exit 4\'', expect: { rc: 4 } },
    { command: 'echo "${EX-unset}"', expect: { out: 'unset\n' } },
  ] },
  { name: 'a background run starts from the kept state and saves nothing', steps: [
    { command: 'export BG0=1; mkdir -p d && cd d', expect: { rc: 0 } },
    { command: 'echo "bg sees $BG0 in $PWD"; export BG1=1; cd /', background: true, expect: { rc: 0, out: 'bg sees 1 in {home}/d\n' } },
    { command: 'echo "${BG1-unset} $PWD"', expect: { out: 'unset {home}/d\n' } },
  ] },
  { name: 'a kept directory that is gone says so, and the run goes on', steps: [
    { command: 'mkdir -p gone && cd gone', expect: { rc: 0 } },
    { setup: 'rm -rf gone', command: 'echo ran; pwd', expect: { rc: 0, out: 'walnut: the kept directory {home}/gone is gone; this run starts in {home}\nran\n{home}\n' } },
    { command: 'pwd', expect: { out: '{home}\n' } },
  ] },
  { name: 'a state file cut short or broken is ignored with a note, and the next save replaces it', steps: [
    { setup: `printf 'declare -x HALF="oo' > ${STATE}`, command: 'echo "${HALF-unset}"', expect: { rc: 0, out: 'walnut: the kept state in {task}/host-exec/keep.sh cannot be read; this run starts without it\nunset\n' } },
    { command: 'echo "${HALF-unset}"', expect: { rc: 0, out: 'unset\n' } },
    { setup: `printf 'declare -x NOTRAIL="x"\\n' > ${STATE}`, command: 'echo "${NOTRAIL-unset}"', expect: { has: ['cannot be read'], match: 'unset\\n$' } },
    { setup: `printf 'if then fi )(\\nwalnut_kz=1\\n' > ${STATE}`, command: 'echo "ran $?"', expect: { rc: 0, has: ['cannot be read', 'ran 0'] } },
    { command: 'export AFTER=ok', expect: { rc: 0, out: '' } },
    { command: 'echo "$AFTER"', expect: { out: 'ok\n' } },
  ] },
  // A run that starts after another saved starts from that one's state, so more than one may be set.
  { name: 'runs at once leave one whole file, and no temp file', steps: [
    { command: 'export P0=1; sleep 0.5', parallel: [1, 2, 3, 4, 5, 6, 7].map((i) => `export P${i}=1; sleep 0.5`), expect: { rc: 0 } },
    { command: 'n=0; for i in 0 1 2 3 4 5 6 7; do eval "[ -n \\"\\${P$i-}\\" ]" && n=$((n+1)); done; [ "$n" -ge 1 ] && echo some-set'
      + `; tail -n 1 ${STATE}; (. ${STATE}) && echo sourced; ls "$WALNUT_TASK_DIR/host-exec"`, expect: { out: 'some-set\nwalnut_kz=1\nsourced\nkeep.sh\n' } },
  ] },
  { name: 'the state file is 0600 in a 0700 directory, made when missing', steps: [
    { setup: 'rm -rf "$WALNUT_TASK_DIR/host-exec"', command: 'export M=1', expect: { rc: 0 } },
    { command: `ls -ld "$WALNUT_TASK_DIR/host-exec" ${STATE} | cut -c1-10`, keep: false, expect: { out: 'drwx------\n-rw-------\n' } },
  ] },
  { name: 'set -x, set -u, set -C, nocasematch and functions named like builtins neither leak a value nor break the save', steps: [
    { command: 'export SECRETV=topsecret-123 KEEPTEST_BASE=BASE; set -xuC; shopt -s nocasematch; printf() { echo hijack; }; declare() { echo hijack; }; true', expect: { rc: 0, not: ['topsecret-123', 'hijack', 'unbound'] } },
    { command: 'echo "$SECRETV $KEEPTEST_BASE"', expect: { out: 'topsecret-123 BASE\n' } },
  ] },
  { name: 'a stop (SIGTERM) saves where it was, and the run still ends by that signal', steps: [
    { command: 'export KILLED=1; cd /; sleep 5', kill: { signal: 'SIGTERM', afterMs: 400 }, expect: { rc: null, signal: 'SIGTERM' } },
    { command: 'echo "${KILLED-unset} $PWD"', expect: { out: '1 /\n' } },
  ] },
  { name: 'a run killed hard (SIGKILL) saves nothing', steps: [
    { command: 'export KK=1; cd /; sleep 5', kill: { signal: 'SIGKILL', afterMs: 400 }, expect: { rc: null, signal: 'SIGKILL' } },
    { command: 'echo "${KK-unset} $PWD"', expect: { out: 'unset {home}\n' } },
  ] },
  { name: 'a POSIX sh that is not bash ignores keep', steps: [
    { command: 'export SHV=1; cd /; echo sh-ran', sh: true, expect: { rc: 0, out: 'sh-ran\n' } },
    { command: 'echo "${SHV-unset} $PWD"; ls -A "$WALNUT_TASK_DIR/host-exec"', expect: { out: 'unset {home}\n' } },
  ] },
]

/** A POSIX sh on this machine that is not bash (dash, or a /bin/sh that is not bash), or null. */
export function nonBashSh(): string | null {
  for (const sh of ['/bin/sh', '/bin/dash', '/usr/bin/dash']) {
    const r = spawnSync(sh, ['-c', 'echo "${BASH_VERSION:-none}"'], { encoding: 'utf8', timeout: 5_000 })
    if (r.status === 0 && r.stdout.trim() === 'none') return sh
  }
  return null
}

/** Every bash here, by version: the usual places, and WALNUT_KEEP_BASHES. */
export function bashesHere(): Array<[string, string]> {
  const extra = (process.env.WALNUT_KEEP_BASHES ?? '').split(':').filter(Boolean)
  return [...new Map(['bash', '/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash', ...extra].flatMap((b) => {
    const r = spawnSync(b, ['-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], { encoding: 'utf8', timeout: 5_000 })
    return r.status === 0 ? [[r.stdout.trim(), b] as const] : []
  })).entries()]
}

export interface Sandbox { root: string; home: string; task: string }

export function sandbox(): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-keep-')))
  const home = path.join(root, 'home')
  const task = path.join(root, 'task')
  // The daemon makes the task's host-exec directory (its logs) before a run.
  fs.mkdirSync(path.join(task, 'host-exec'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true })
  return { root, home, task }
}

const fill = (s: string, b: Sandbox) => s.replace(/\{home\}/g, b.home).replace(/\{root\}/g, b.root).replace(/\{task\}/g, b.task)

let seq = 0

/** One run of `line` as the daemon runs it: its exit, its output (both streams in one file). */
export function runLine(shell: string, line: string, b: Sandbox, o: { cwd?: string; jobId?: string; kill?: KeepStep['kill'] } = {}): Promise<{ rc: number | null; signal: string | null; out: string }> {
  const jobId = o.jobId ?? `hx-keep-${process.pid}-${seq += 1}`
  const log = path.join(b.root, `${jobId}.log`)
  const fd = fs.openSync(log, 'w')
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: b.home, KEEPTEST_BASE: 'base', KEEPTEST_GONE: 'here', WALNUT_TASK_DIR: b.task, WALNUT_HOST_EXEC_JOB: jobId }
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-c', line], { cwd: o.cwd ?? b.home, env, detached: true, stdio: ['ignore', fd, fd] })
    fs.closeSync(fd)
    const stop = (sig: NodeJS.Signals) => { if (child.pid && child.pid > 1) try { process.kill(-child.pid, sig) } catch { /* gone */ } }
    const killer = o.kill ? setTimeout(() => stop(o.kill!.signal), o.kill.afterMs) : null
    const cap = setTimeout(() => stop('SIGKILL'), 10_000)
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (killer) clearTimeout(killer)
      clearTimeout(cap)
      resolve({ rc: code, signal, out: fs.readFileSync(log, 'utf8') })
    })
  })
}

/** The line a step runs: Walnut's, as host-exec.ts builds it. */
export function stepLine(step: KeepStep, command: string, b: Sandbox, jobId: string): string {
  const cwd = step.cwd !== undefined ? fill(step.cwd, b) : undefined
  return shapedLine({ command, keep: step.keep !== false, strict: step.strict, background: step.background, cwd }, jobId) ?? command
}

export interface StepResult { step: number; rc: number | null; signal: string | null; out: string }

/** Play a case on `bash` (`sh` for a step that asks for it), in a fresh sandbox; each step's result. */
export async function playCase(c: KeepCase, bash: string, sh: string | null): Promise<{ results: StepResult[]; box: Sandbox }> {
  const box = sandbox()
  const results: StepResult[] = []
  for (const [i, step] of c.steps.entries()) {
    if (step.setup) await runLine('/bin/sh', fill(step.setup, box), box)
    const shell = step.sh ? sh! : bash
    const cwd = step.cwd !== undefined ? fill(step.cwd, box) : undefined
    const runs = [step.command, ...(step.parallel ?? [])].map((command) => {
      const jobId = `hx-keep-${process.pid}-${seq += 1}`
      return runLine(shell, stepLine(step, command, box, jobId), box, { cwd, jobId, kill: step.kill })
    })
    const [first] = await Promise.all(runs)
    results.push({ step: i, ...first! })
  }
  return { results, box }
}

/** What a step's result should be, with the case's paths filled in (for a vitest expect, or any other check). */
export function expected(step: KeepStep, b: Sandbox): KeepStep['expect'] {
  const e = step.expect
  return {
    ...e,
    ...(e.out !== undefined ? { out: fill(e.out, b) } : {}),
    ...(e.has ? { has: e.has.map((h) => fill(h, b)) } : {}),
  }
}
