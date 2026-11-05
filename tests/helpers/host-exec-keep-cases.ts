/**
 * host_exec keep against a real shell (src/core/hosts/host-exec-keep.ts): the cases as data and the
 * runner that plays one, so the same cases replay on any bash a machine has (bash 3.2 on a Mac's
 * /bin/bash, 4.2, 5.x; more with WALNUT_KEEP_BASHES=/path/a:/path/b). Each step runs the line Walnut
 * builds as `<shell> -c` in its own process group, both streams in one file, as the daemon runs it
 * (host-exec-core.ts), with WALNUT_TASK_DIR set to the case's own task directory.
 *
 * Two ways a keep call finds its directory, and every case plays both unless it names one: `server`,
 * as host-exec.ts does with a current host (the kept directory read from keep.cwd and given as the
 * run's cwd; one that is gone: the fresh cwd, and the step's `gone`), and `shell`, a host that cannot
 * hand it over (the shell enters it itself).
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
import { KEEP_CWD_FILE, TRAP_FIRST_LINE, keptDirOf, shapedLine } from '../../src/core/hosts/host-exec-keep.js'

export type KeepMode = 'server' | 'shell'

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
  kill?: { signal: NodeJS.Signals; afterMs: number }
  expect: {
    rc?: number | null
    signal?: string | null
    out?: string
    has?: string[]
    not?: string[]
    /** A regular expression the whole output matches. */
    match?: string
    /** server mode: the kept directory found gone (the run started in the fresh cwd). */
    gone?: string | null
    /** What differs in shell mode. */
    shell?: { out?: string; has?: string[]; match?: string }
  }
}

/** `nonRoot`: needs file modes to hold (root writes anywhere). */
export interface KeepCase { name: string; steps: KeepStep[]; mode?: KeepMode; nonRoot?: true }

/** The line a save that could not complete prints (host-exec-keep.ts). */
export const notSavedLine = (why: string) => `walnut: keep could not save this run's state (${why}); the next keep call starts from the last saved one\n`

/** How many 100000-byte exports go over this machine's ARG_MAX (the whole environment a program may start with). */
const argMax = Number(spawnSync('getconf', ['ARG_MAX'], { encoding: 'utf8' }).stdout.trim()) || 2_097_152
const BIG_COUNT = Math.ceil(argMax / 100_000) + 1

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
    { command: 'mkdir -p gone && cd gone', expect: { rc: 0, gone: null } },
    { setup: 'rm -rf gone', command: 'echo ran; pwd', expect: { rc: 0, out: 'ran\n{home}\n', gone: '{home}/gone', shell: { out: 'walnut: the kept directory {home}/gone is gone; this run starts in {home}\nran\n{home}\n' } } },
    { command: 'pwd', expect: { out: '{home}\n', gone: null } },
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
      + `; tail -n 1 ${STATE}; (. ${STATE}) && echo sourced; ls "$WALNUT_TASK_DIR/host-exec"`, expect: { out: 'some-set\nwalnut_kz=1\nsourced\nkeep.cwd\nkeep.sh\n' } },
  ] },
  { name: 'the state files are 0600 in a 0700 directory, made when missing', steps: [
    { setup: 'rm -rf "$WALNUT_TASK_DIR/host-exec"', command: 'export M=1', expect: { rc: 0 } },
    { command: `ls -ld "$WALNUT_TASK_DIR/host-exec" ${STATE} "$WALNUT_TASK_DIR/host-exec/keep.cwd" | cut -c1-10`, keep: false, expect: { out: 'drwx------\n-rw-------\n-rw-------\n' } },
  ] },
  { name: 'set -x, set -u, set -C, nocasematch and functions named like builtins neither leak a value nor break the save', steps: [
    { command: 'export SECRETV=topsecret-123 KEEPTEST_BASE=BASE; set -xuC; shopt -s nocasematch; printf() { echo hijack; }; declare() { echo hijack; }; true', expect: { rc: 0, not: ['topsecret-123', 'hijack', 'unbound'] } },
    { command: 'echo "$SECRETV $KEEPTEST_BASE"', expect: { out: 'topsecret-123 BASE\n' } },
  ] },
  { name: 'a stop (SIGTERM) saves where it was, and the run still ends by that signal', steps: [
    { command: 'export KILLED=1; cd /; sleep 5', kill: { signal: 'SIGTERM', afterMs: 400 }, expect: { rc: null, signal: 'SIGTERM', out: '' } },
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
  // Review 2026-11-05 (keep round 1): what a line may do to its shell before Walnut's save runs.
  { name: 'tracing with a PS4 that names a value prints nothing of the save, and the state saves', steps: [
    { command: 'export SECRET=private-canary; PS4=\'$SECRET \'; set -x', expect: { rc: 0, out: '' } },
    { command: 'echo "$SECRET"', expect: { out: 'private-canary\n' } },
  ] },
  { name: 'a trace on its own descriptor (BASH_XTRACEFD 9) prints nothing of the save', steps: [
    { command: 'export SECRET=private-canary; exec 9>&2; BASH_XTRACEFD=9; PS4=\'$SECRET \'; set -x', expect: { rc: 0, out: '' } },
    { command: 'echo "$SECRET"', expect: { out: 'private-canary\n' } },
  ] },
  { name: 'verbose mode echoes the save\'s first line only, which holds no value', steps: [
    { command: 'export SECRET=private-canary; set -v; true', expect: { rc: 0, out: `${TRAP_FIRST_LINE}\n` } },
    { command: 'export SECRET=private-canary; set -xv; false', expect: { rc: 1, out: `+ false\n${TRAP_FIRST_LINE}\n` } },
    { command: 'echo "$SECRET"', expect: { out: 'private-canary\n' } },
  ] },
  { name: 'a line that closes its stderr still saves', steps: [
    { command: 'export CLOSED=1; exec 2>&-; true', expect: { rc: 0, out: '' } },
    { command: 'echo "$CLOSED"', expect: { out: '1\n' } },
  ] },
  { name: 'a custom IFS, readonly too, does not break the save', steps: [
    { command: 'export IFS=\'x y\'; export VAL=keep1; true', expect: { rc: 0, out: '' } },
    { command: 'echo "$VAL"', expect: { out: 'keep1\n' } },
    { command: 'IFS=$\'\\n\'; readonly IFS; export VAL=keep2; true', expect: { rc: 0, out: '' } },
    { command: 'echo "$VAL"', expect: { out: 'keep2\n' } },
  ] },
  { name: 'PWD unset under set -u: the directory is still kept', steps: [
    { command: 'mkdir -p up && cd up && unset PWD; export V=kept; set -u; true', expect: { rc: 0, out: '' } },
    { command: 'echo "$V"; pwd', expect: { out: 'kept\n{home}/up\n' } },
  ] },
  { name: 'CDPATH does not change where the kept directory is', steps: [
    { command: 'mkdir -p p/sub sub && export CDPATH="$PWD/p" && cd sub >/dev/null', expect: { rc: 0, out: '' } },
    { command: 'pwd', expect: { out: '{home}/p/sub\n' } },
  ] },
  { name: 'exported functions do not carry', steps: [
    { command: 'leak() { echo VALUE; }; export -f leak; export FV=1; leak', expect: { rc: 0, out: 'VALUE\n' } },
    { command: 'type leak >/dev/null 2>&1 && echo has-leak || echo no-leak; echo "$FV"', expect: { out: 'no-leak\n1\n' } },
  ] },
  { name: 'set -eu with exit 3 keeps the 3, and the state saves', steps: [
    { command: 'export EU=1; set -eu; exit 3', expect: { rc: 3, out: '' } },
    { command: 'echo "$EU"', expect: { out: '1\n' } },
  ] },
  { name: 'allexport and posix mode do not break the save', steps: [
    { command: 'set -a; AX=1; set -o posix; export PX=2; true', expect: { rc: 0, out: '' } },
    { command: 'echo "${AX-unset} ${PX-unset}"', expect: { out: '1 2\n' } },
  ] },
  { name: 'functions named like the commands the save runs do not change it', steps: [
    { command: 'export FN=1; [() { echo hijack; }; for f in command test mv mkdir rm pwd compgen export set shopt trap umask printf declare exit exec unset; do eval "$f() { echo hijack; }"; done; true', expect: { rc: 0, out: '' } },
    { command: 'echo "$FN"', expect: { out: '1\n' } },
  ] },
  { name: 'one exported value over 128 KiB carries, and leaves no temp file', steps: [
    { command: 'printf -v BIG "%131072s" x; export BIG; true', expect: { rc: 0, out: '' } },
    { command: 'echo "${#BIG}"; printf "%s\\n" "$WALNUT_TASK_DIR"/host-exec/*', expect: { out: '131072\n{task}/host-exec/keep.cwd\n{task}/host-exec/keep.sh\n' } },
  ] },
  { name: 'exports over the whole ARG_MAX carry, and leave no temp file', steps: [
    { command: `i=0; while [ $i -lt ${BIG_COUNT} ]; do i=$((i+1)); printf -v "BIG$i" "%100000s" x; export "BIG$i"; done; true`, expect: { rc: 0, out: '' } },
    { command: `echo "\${#BIG1} \${#BIG${BIG_COUNT}}"; printf "%s\\n" "$WALNUT_TASK_DIR"/host-exec/*`, expect: { out: '100000 100000\n{task}/host-exec/keep.cwd\n{task}/host-exec/keep.sh\n' } },
  ] },
  { name: '200 exported values of 1000 bytes carry', steps: [
    { command: 'i=0; while [ $i -lt 200 ]; do i=$((i+1)); printf -v "D$i" "%01000d" $i; export "D$i"; done; true', expect: { rc: 0, out: '' } },
    { command: 'echo "${#D1} ${#D200} ${D200:990}"', expect: { out: '1000 1000 0000000200\n' } },
  ] },
  { name: 'values ending in a backslash or holding = carry exactly', steps: [
    { command: 'export TB=\'ends=\\\' TE==a=b=', expect: { rc: 0, out: '' } },
    { command: 'printf "[%s][%s]" "$TB" "$TE"', expect: { out: '[ends=\\][=a=b=]' } },
  ] },
  { name: 'a save whose folder cannot be made says so in one line with no value, and the exit code stays', steps: [
    { setup: 'rm -rf "$WALNUT_TASK_DIR/host-exec"; touch "$WALNUT_TASK_DIR/host-exec"', command: 'export W=new; exit 4', expect: { rc: 4, out: notSavedLine('its folder in the task directory cannot be made') } },
    { setup: 'rm -f "$WALNUT_TASK_DIR/host-exec"', command: 'echo "${W-unset}"', expect: { out: 'unset\n' } },
  ] },
  { name: 'a save that cannot write says so, and the next call starts from the last saved one', nonRoot: true, steps: [
    { command: 'mkdir -p old && cd old && export W=old', expect: { rc: 0, out: '' } },
    { setup: 'chmod 500 "$WALNUT_TASK_DIR/host-exec"', command: 'export W=new; cd /', expect: { rc: 0, out: notSavedLine('it cannot be written in the task directory') } },
    { setup: 'chmod 700 "$WALNUT_TASK_DIR/host-exec"', command: 'echo "$W"; pwd; ls -A "$WALNUT_TASK_DIR/host-exec"', expect: { out: 'old\n{home}/old\nkeep.cwd\nkeep.sh\n' } },
  ] },
  // The save's own stop (its subshell's `exit`) never becomes the run's end: a stop still ends it by SIGTERM.
  { name: 'the not-saved line goes to the run\'s stderr, never to an fd 4 the line opened, and nowhere with stderr closed', steps: [
    { command: 'exec 4>"$HOME/fd4.txt"; readonly walnut_kt; true', expect: { rc: 0, out: notSavedLine('the line made a walnut_ variable readonly') } },
    { command: 'cat "$HOME/fd4.txt"; exec 4>"$HOME/fd4.txt"; exec 2>&-; readonly walnut_kt; true', expect: { rc: 0, out: '' } },
    { command: 'cat "$HOME/fd4.txt"; echo end', expect: { out: 'end\n' } },
  ] },
  { name: 'a readonly walnut_ name under a stop: the run still ends by SIGTERM, and says it was not saved', steps: [
    { command: 'export V=old', expect: { rc: 0, out: '' } },
    { command: 'export V=new; readonly walnut_kt; sleep 5', kill: { signal: 'SIGTERM', afterMs: 400 }, expect: { rc: null, signal: 'SIGTERM', out: notSavedLine('the line made a walnut_ variable readonly') } },
    { command: 'echo "$V"', expect: { out: 'old\n' } },
  ] },
  { name: 'a line that unsets a walnut_ name the save reads: one line says it was not saved', steps: [
    { command: 'export V=1; unset walnut_kf; true', expect: { rc: 0, out: notSavedLine('the line changed a walnut_ variable') } },
    { command: 'echo "${V-unset}"', expect: { out: 'unset\n' } },
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
export function stepLine(step: KeepStep, command: string, b: Sandbox, jobId: string, mode: KeepMode = 'server'): string {
  const cwd = step.cwd !== undefined ? fill(step.cwd, b) : undefined
  return shapedLine({ command, keep: step.keep !== false, strict: step.strict, background: step.background, cwd }, jobId, { shellCd: mode === 'shell' }) ?? command
}

/**
 * Where a keep call with no cwd starts in server mode, as host-exec.ts finds it: keep.cwd's directory
 * as the host resolves it (host-exec-line.ts resolveCwd), or, when it is gone, the fresh cwd and `gone`.
 */
export function keptStart(b: Sandbox): { cwd?: string; gone?: string } {
  let bytes: Buffer
  try { bytes = fs.readFileSync(path.join(b.task, KEEP_CWD_FILE)) } catch { return {} }
  const dir = keptDirOf(bytes)
  if (!dir) return {}
  try {
    const real = fs.realpathSync(dir)
    return fs.statSync(real).isDirectory() ? { cwd: real } : { gone: dir }
  } catch {
    return { gone: dir }
  }
}

export interface StepResult { step: number; rc: number | null; signal: string | null; out: string; gone: string | null }

/** Play a case on `bash` (`sh` for a step that asks for it), in a fresh sandbox; each step's result. */
export async function playCase(c: KeepCase, bash: string, sh: string | null, mode: KeepMode = 'server'): Promise<{ results: StepResult[]; box: Sandbox }> {
  const box = sandbox()
  const results: StepResult[] = []
  for (const [i, step] of c.steps.entries()) {
    if (step.setup) await runLine('/bin/sh', fill(step.setup, box), box)
    const shell = step.sh ? sh! : bash
    const named = step.cwd !== undefined ? fill(step.cwd, box) : undefined
    const kept = mode === 'server' && step.keep !== false && named === undefined ? keptStart(box) : {}
    const runs = [step.command, ...(step.parallel ?? [])].map((command) => {
      const jobId = `hx-keep-${process.pid}-${seq += 1}`
      return runLine(shell, stepLine(step, command, box, jobId, mode), box, { cwd: named ?? kept.cwd, jobId, kill: step.kill })
    })
    const [first] = await Promise.all(runs)
    results.push({ step: i, ...first!, gone: kept.gone ?? null })
  }
  return { results, box }
}

/** What a step's result should be in `mode`, with the case's paths filled in (for a vitest expect, or any other check). */
export function expected(step: KeepStep, b: Sandbox, mode: KeepMode = 'server'): KeepStep['expect'] {
  const e = { ...step.expect, ...(mode === 'shell' ? step.expect.shell : {}) }
  return {
    ...e,
    ...(e.out !== undefined ? { out: fill(e.out, b) } : {}),
    ...(e.has ? { has: e.has.map((h) => fill(h, b)) } : {}),
    gone: mode === 'server' && typeof e.gone === 'string' ? fill(e.gone, b) : mode === 'server' ? e.gone : undefined,
  }
}
