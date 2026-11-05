/**
 * host_exec keep against a real shell (src/core/hosts/host-exec-keep.ts): the cases as data and the
 * runner that plays one, so the same cases replay on any bash a machine has (bash 3.2 on a Mac's
 * /bin/bash, 4.2, 5.x; more with WALNUT_KEEP_BASHES=/path/a:/path/b). Each step runs the line Walnut
 * builds as `<shell> -c` in its own process group, both streams in one file, as the daemon runs it
 * (host-exec-core.ts), with WALNUT_TASK_DIR set to the case's own task directory.
 *
 * Two ways a keep call finds its snapshot, and every case plays both unless it names one: `server`,
 * as host-exec.ts does with a current host (keep.current read first: its generation goes into the
 * line, and its directory, as the daemon resolves the cwd it is given (resolveCwd), is the run's cwd;
 * one that is gone: the fresh cwd, and the step's `gone`), and `shell`, a host that cannot hand it
 * over (the shell reads the pointer and enters the directory itself). A step's output is compared as
 * the answer shows it: keep's mark said as a sentence (withKeepMarkSaid).
 *
 * In a case's text, {home} is the directory a run starts in by default, {root} the case's temp dir,
 * {task} its task directory, {first} the step's trap first line (it holds the run's seal).
 *
 * MACHINE SAFETY: short shell children under a 10 s timeout, in their own temp dirs; a signal goes
 * only to the process group of a child this runner started (pid > 1).
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KEEP_POINTER, daemonCwd, keepMarkWhy, pointerOf, shapedLine, trapFirstLine, withKeepMarkSaid } from '../../src/core/hosts/host-exec-keep.js'
import { sealFor } from '../../src/core/hosts/host-exec-strict.js'
import { resolveCwd } from '../../src/providers/host-exec-line.js'

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
    /** Why the save did not complete, read from keep's sealed mark (null: it did, or there is no mark). */
    why?: string | null
    /** What differs in shell mode. */
    shell?: { out?: string; has?: string[]; match?: string }
  }
}

/** `nonRoot`: needs file modes to hold (root writes anywhere). */
export interface KeepCase { name: string; steps: KeepStep[]; mode?: KeepMode; nonRoot?: true }

/** keep's mark for a save that could not complete, as the answer says it (host-exec-keep.ts withKeepMarkSaid). */
export const notSavedLine = (why: string) => `walnut: keep could not save this run's state (${why}); the next keep call starts from the last saved one\n`

/** How many 100000-byte exports go over this machine's ARG_MAX (the whole environment a program may start with). */
const argMax = Number(spawnSync('getconf', ['ARG_MAX'], { encoding: 'utf8' }).stdout.trim()) || 2_097_152
const BIG_COUNT = Math.ceil(argMax / 100_000) + 1

/** A value with every kind of character a quote can trip on. */
export const ODD_VALUE = 'a  b "dq" \'sq\' $HOME ${x} `echo bt` \\ back\nline two\ttab \u00e9 \u2713 \u{1F389} end\n'
/** ODD_VALUE quoted for bash (single quotes; a newline inside them is kept as it is). */
const quoted = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`

/** The snapshot keep.current names, for a plain line to read. */
const STATE = '"$WALNUT_TASK_DIR/host-exec/keep.d/$(head -n 1 "$WALNUT_TASK_DIR/host-exec/keep.current").sh"'
/** A setup that makes the snapshot generation g1 hold `text` (printf's format), the pointer naming it with {home}. */
const stateIs = (text: string) => 'mkdir -p "$WALNUT_TASK_DIR/host-exec/keep.d" && printf \'g1\\n%s\' "$HOME" > "$WALNUT_TASK_DIR/host-exec/keep.current"'
  + ` && printf '${text}' > "$WALNUT_TASK_DIR/host-exec/keep.d/g1.sh"`
const G1 = '{task}/host-exec/keep.d/g1.sh'

/** Every command word keep's EXIT trap runs, the dispatchers included, and `[`/`test`: each as a function the line defines. */
export const SHADOWED = [
  'builtin', 'command', 'exec', 'continue', 'set', 'unset', 'trap', 'exit', 'shopt', 'printf', 'declare', 'compgen', 'export',
  'umask', 'pwd', 'cd', 'date', 'mv', 'mkdir', 'rm', 'test', ':',
]

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
  { name: 'a snapshot cut short or broken is ignored with a note, and the next save replaces it', steps: [
    { setup: stateIs('declare -x HALF="oo'), command: 'echo "${HALF-unset}"', expect: { rc: 0, out: `walnut: the kept state in ${G1} cannot be read; this run starts without it\nunset\n` } },
    { command: 'echo "${HALF-unset}"', expect: { rc: 0, out: 'unset\n' } },
    { setup: stateIs('declare -x NOTRAIL="x"\\n'), command: 'echo "${NOTRAIL-unset}"', expect: { has: ['cannot be read'], match: 'unset\\n$' } },
    { setup: stateIs('if then fi )(\\nwalnut_kz=1\\n'), command: 'echo "ran $?"', expect: { rc: 0, has: ['cannot be read', 'ran 0'] } },
    { command: 'export AFTER=ok', expect: { rc: 0, out: '' } },
    { command: 'echo "$AFTER"', expect: { out: 'ok\n' } },
  ] },
  { name: 'a snapshot gone when the run sources it: the run starts without state, with the note', steps: [
    { command: 'export GV=1', expect: { rc: 0, out: '' } },
    { setup: `rm -f ${STATE}`, command: 'echo "${GV-unset}"', expect: { rc: 0, match: '^walnut: the kept state in \\S+/host-exec/keep\\.d/[0-9]+-[0-9]+-[0-9]+\\.sh cannot be read; this run starts without it\\nunset\\n$' } },
  ] },
  { name: 'a save removes the old snapshots but its own, the newest four others and any younger than ten minutes', steps: [
    { setup: 'mkdir -p "$WALNUT_TASK_DIR/host-exec/keep.d" && for i in 1 2 3 4 5 6; do : > "$WALNUT_TASK_DIR/host-exec/keep.d/100000000$i-1-1.sh"; done', command: 'export C=1', expect: { rc: 0, out: '' } },
    { command: 'cd "$WALNUT_TASK_DIR/host-exec/keep.d" && ls | grep -c "^100000000"; ls | wc -l | tr -d " "', keep: false, expect: { out: '4\n5\n' } },
    { command: 'true', expect: { rc: 0 } },
    { command: 'true', expect: { rc: 0 } },
    { command: 'cd "$WALNUT_TASK_DIR/host-exec/keep.d" && ls | grep "^100000000"; ls | wc -l | tr -d " "', keep: false, expect: { out: '1000000005-1-1.sh\n1000000006-1-1.sh\n5\n' } },
  ] },
  // A run that starts after another saved starts from that one's state, so more than one may be set.
  { name: 'runs at once leave one whole file, and no temp file', steps: [
    { command: 'export P0=1; sleep 0.5', parallel: [1, 2, 3, 4, 5, 6, 7].map((i) => `export P${i}=1; sleep 0.5`), expect: { rc: 0 } },
    { command: 'n=0; for i in 0 1 2 3 4 5 6 7; do eval "[ -n \\"\\${P$i-}\\" ]" && n=$((n+1)); done; [ "$n" -ge 1 ] && echo some-set'
      + `; tail -n 1 ${STATE}; (. ${STATE}) && echo sourced; ls "$WALNUT_TASK_DIR/host-exec"; ls "$WALNUT_TASK_DIR/host-exec/keep.d" | grep -vc "^[0-9]*-[0-9]*-[0-9]*\\.sh$"`, expect: { out: 'some-set\nwalnut_kz=1\nsourced\nkeep.current\nkeep.d\n0\n' } },
  ] },
  { name: 'the state files are 0600 in 0700 directories, made when missing', steps: [
    { setup: 'rm -rf "$WALNUT_TASK_DIR/host-exec"', command: 'export M=1', expect: { rc: 0 } },
    { command: `for f in "$WALNUT_TASK_DIR/host-exec" "$WALNUT_TASK_DIR/host-exec/keep.d" "$WALNUT_TASK_DIR/host-exec/keep.current" ${STATE}; do ls -ld "$f" | cut -c1-10; done`, keep: false, expect: { out: 'drwx------\ndrwx------\n-rw-------\n-rw-------\n' } },
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
    { command: 'export SECRET=private-canary; set -v; true', expect: { rc: 0, out: '{first}\n' } },
    { command: 'export SECRET=private-canary; set -xv; false', expect: { rc: 1, out: '+ false\n{first}\n' } },
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
  { name: 'functions named like every command the save runs do not change it', steps: [
    { command: `export FN=1; [() { echo hijack; }; for f in ${SHADOWED.join(' ')}; do eval "$f() { echo hijack; }"; done; true`, expect: { rc: 0, out: '' } },
    { command: 'echo "$FN"', expect: { out: '1\n' } },
  ] },
  { name: 'one exported value over 128 KiB carries, and leaves no temp file', steps: [
    { command: 'printf -v BIG "%131072s" x; export BIG; true', expect: { rc: 0, out: '' } },
    { command: 'echo "${#BIG}"; printf "%s\\n" "$WALNUT_TASK_DIR"/host-exec/*', expect: { out: '131072\n{task}/host-exec/keep.current\n{task}/host-exec/keep.d\n' } },
  ] },
  { name: 'exports over the whole ARG_MAX carry, and leave no temp file', steps: [
    { command: `i=0; while [ $i -lt ${BIG_COUNT} ]; do i=$((i+1)); printf -v "BIG$i" "%100000s" x; export "BIG$i"; done; true`, expect: { rc: 0, out: '' } },
    { command: `echo "\${#BIG1} \${#BIG${BIG_COUNT}}"; printf "%s\\n" "$WALNUT_TASK_DIR"/host-exec/*`, expect: { out: '100000 100000\n{task}/host-exec/keep.current\n{task}/host-exec/keep.d\n' } },
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
    { setup: 'chmod 700 "$WALNUT_TASK_DIR/host-exec"', command: 'echo "$W"; pwd; ls -A "$WALNUT_TASK_DIR/host-exec"; ls -A "$WALNUT_TASK_DIR/host-exec/keep.d" | wc -l | tr -d " "', expect: { out: 'old\n{home}/old\nkeep.current\nkeep.d\n1\n' } },
  ] },
  // The save's own stop (its subshell's `exit`) never becomes the run's end: a stop still ends it by SIGTERM.
  { name: 'the not-saved line goes to the run\'s stderr, never to an fd 4 the line opened, and nowhere with stderr closed', steps: [
    { command: 'exec 4>"$HOME/fd4.txt"; readonly walnut_g; true', expect: { rc: 0, out: notSavedLine('the line made a walnut_ variable readonly') } },
    { command: 'cat "$HOME/fd4.txt"; exec 4>"$HOME/fd4.txt"; exec 2>&-; readonly walnut_g; true', expect: { rc: 0, out: '' } },
    { command: 'cat "$HOME/fd4.txt"; echo end', expect: { out: 'end\n' } },
  ] },
  { name: 'a readonly walnut_ name under a stop: the run still ends by SIGTERM, and says it was not saved', steps: [
    { command: 'export V=old', expect: { rc: 0, out: '' } },
    { command: 'export V=new; readonly walnut_g; sleep 5', kill: { signal: 'SIGTERM', afterMs: 400 }, expect: { rc: null, signal: 'SIGTERM', out: notSavedLine('the line made a walnut_ variable readonly') } },
    { command: 'echo "$V"', expect: { out: 'old\n' } },
  ] },
  { name: 'a line that unsets a walnut_ name the save reads: one line says it was not saved', steps: [
    { command: 'export V=1; unset walnut_kh; true', expect: { rc: 0, out: notSavedLine('the line changed a walnut_ variable'), why: 'the line changed a walnut_ variable' } },
    { command: 'echo "${V-unset}"', expect: { out: 'unset\n' } },
  ] },
  { name: 'a walnut_ name the line gave an attribute (integer, upper case, array) does not change what is saved', steps: [
    { command: 'declare -i walnut_s walnut_d; { declare -u walnut_n; declare -A walnut_a; } 2>/dev/null; walnut_x=(1 2); export AV=kept-value; true', expect: { rc: 0, out: '' } },
    { command: 'echo "$AV"', expect: { out: 'kept-value\n' } },
  ] },
  // Review 2026-11-05 (keep round 2).
  // BASH_XTRACEFD=0 is in the first-call comparison (host-exec-keep-bash.test.ts): bash's own word on it differs by stdin.
  { name: 'a trace on stdout (BASH_XTRACEFD 1) prints nothing of the save', steps: [
    { command: 'export SECRET=private-canary; BASH_XTRACEFD=1; PS4=\'$SECRET \'; set -x', expect: { rc: 0, out: '' } },
    { command: 'echo "$SECRET"', expect: { out: 'private-canary\n' } },
  ] },
  { name: 'a function named builtin that would print a value is never called, and the state saves', steps: [
    { command: 'export VAL=keep SECRET=private-canary; builtin() { printf \'fn:%s\\n\' "$SECRET"; }; true', expect: { rc: 0, out: '' } },
    { command: 'echo "$VAL"', expect: { out: 'keep\n' } },
  ] },
  { name: 'a readonly function over a builtin: not saved, said by the mark, the exit code kept', steps: [
    { command: 'export V=old', expect: { rc: 0, out: '' } },
    { command: 'export V=new SECRET=private-canary; builtin() { printf \'fn:%s\\n\' "$SECRET"; }; readonly -f builtin; exit 4', expect: { rc: 4, out: notSavedLine('the line made a function the save needs readonly'), why: 'the line made a function the save needs readonly' } },
    { command: 'export V=new; exec() { echo fn; }; readonly -f exec; set -e; true', expect: { rc: 0, out: notSavedLine('the line made a function the save needs readonly') } },
    { command: 'echo "$V"', expect: { out: 'old\n' } },
  ] },
  { name: 'a readonly function the save never calls (set, mv) changes nothing', steps: [
    { command: 'export RV=1; set() { echo fn; }; mv() { echo fn; }; readonly -f set mv; true', expect: { rc: 0, out: '' } },
    { command: 'echo "$RV"', expect: { out: '1\n' } },
  ] },
  { name: 'a readonly POSIXLY_CORRECT keeps the exit code and prints nothing', steps: [
    { command: 'export RP=1; readonly POSIXLY_CORRECT; exit 3', expect: { rc: 3, out: '' } },
    { command: 'export RP=1; POSIXLY_CORRECT=1; readonly POSIXLY_CORRECT; exit 3', expect: { rc: 3, out: '' } },
  ] },
  { name: 'POSIXLY_CORRECT never carries, and posix mode does not either', steps: [
    { command: 'export POSIXLY_CORRECT=1 PV=pc', expect: { rc: 0, out: '' } },
    { command: 'echo "${POSIXLY_CORRECT-unset} $PV"; case :$SHELLOPTS: in (*:posix:*) echo posix;; (*) echo not-posix;; esac', expect: { out: 'unset pc\nnot-posix\n' } },
  ] },
  { name: 'a DEBUG trap prints nothing for the save', steps: [
    { command: 'export DV=1; trap \'echo DBG\' DEBUG; true', expect: { rc: 0, out: 'DBG\n' } },
    { command: 'echo "$DV"', expect: { out: '1\n' } },
  ] },
  { name: 'a kept directory ending in white space is the one the next call starts in, never a sibling without it', steps: [
    { command: 'mkdir -p "odd " odd && echo decoy > odd/f.txt && cd "odd " && echo in-space > f.txt && export V=oddspace', expect: { rc: 0, out: '' } },
    { command: 'pwd; cat f.txt; echo "$V"', expect: { out: '{home}/odd \nin-space\noddspace\n', gone: null } },
    { command: 'mkdir -p "tab\t" && cd "tab\t" && echo in-tab > f.txt', expect: { rc: 0 } },
    { command: 'cat f.txt', expect: { out: 'in-tab\n', gone: null } },
  ] },
  { name: 'output with no line end before the mark: the mark is still read, on its own line', steps: [
    { command: 'export V=old', expect: { rc: 0, out: '' } },
    { command: 'export V=new; printf no-newline; readonly walnut_s; true', expect: { rc: 0, out: `no-newline\n${notSavedLine('the line made a walnut_ variable readonly')}`, why: 'the line made a walnut_ variable readonly' } },
    { command: 'echo "$V"', expect: { out: 'old\n' } },
  ] },
  { name: 'a line the run prints that looks like the mark is never taken for it', steps: [
    { command: `export V=look; printf '%s\\n' ${quoted(notSavedLine('x').trimEnd())}; printf '\\nwalnut keep 0123456789ab: could not save (fake)\\n'`, expect: { rc: 0, out: `${notSavedLine('x')}\nwalnut keep 0123456789ab: could not save (fake)\n`, why: null } },
    { command: 'echo "$V"', expect: { out: 'look\n' } },
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

/** The line a step runs: Walnut's, as host-exec.ts builds it (`gen`: the generation server mode read). */
export function stepLine(step: KeepStep, command: string, b: Sandbox, jobId: string, mode: KeepMode = 'server', gen: string | null = null): string {
  const cwd = step.cwd !== undefined ? fill(step.cwd, b) : undefined
  return shapedLine({ command, keep: step.keep !== false, strict: step.strict, background: step.background, cwd }, jobId, mode === 'shell' ? { shellCd: true } : { gen }) ?? command
}

/**
 * What a keep call starts from in server mode, as host-exec.ts finds it: keep.current's generation,
 * and its directory as the daemon resolves the cwd it is given (daemonCwd, then host-exec-line.ts
 * resolveCwd), or, when it is gone, the fresh cwd and `gone`.
 */
export function keptStart(b: Sandbox): { gen: string | null; cwd?: string; gone?: string } {
  let bytes: Buffer
  try { bytes = fs.readFileSync(path.join(b.task, KEEP_POINTER)) } catch { return { gen: null } }
  const p = pointerOf(bytes)
  if (!p) return { gen: null }
  const real = resolveCwd(daemonCwd(p.dir), b.home)
  return typeof real === 'string' ? { gen: p.gen, cwd: real } : { gen: p.gen, gone: p.dir }
}

export interface StepResult { step: number; jobId: string; rc: number | null; signal: string | null; out: string; raw: string; why: string | null; gone: string | null }

/** Play a case on `bash` (`sh` for a step that asks for it), in a fresh sandbox; each step's result. */
export async function playCase(c: KeepCase, bash: string, sh: string | null, mode: KeepMode = 'server'): Promise<{ results: StepResult[]; box: Sandbox }> {
  const box = sandbox()
  const results: StepResult[] = []
  for (const [i, step] of c.steps.entries()) {
    if (step.setup) await runLine('/bin/sh', fill(step.setup, box), box)
    const shell = step.sh ? sh! : bash
    const named = step.cwd !== undefined ? fill(step.cwd, box) : undefined
    const kept = mode === 'server' && step.keep !== false ? keptStart(box) : { gen: null }
    const start = named === undefined ? kept : { gen: kept.gen }
    const runs = [step.command, ...(step.parallel ?? [])].map((command) => {
      const jobId = `hx-keep-${process.pid}-${seq += 1}`
      return runLine(shell, stepLine(step, command, box, jobId, mode, kept.gen), box, { cwd: named ?? start.cwd, jobId, kill: step.kill }).then((r) => ({ ...r, jobId }))
    })
    const [first] = await Promise.all(runs)
    const { jobId, out } = first!
    results.push({ step: i, jobId, rc: first!.rc, signal: first!.signal, out: withKeepMarkSaid(out, jobId), raw: out, why: keepMarkWhy(out, jobId), gone: start.gone ?? null })
  }
  return { results, box }
}

/** What a step's result should be in `mode`, with the case's paths filled in (for a vitest expect, or any other check). */
export function expected(step: KeepStep, b: Sandbox, mode: KeepMode = 'server', jobId = ''): KeepStep['expect'] {
  const e = { ...step.expect, ...(mode === 'shell' ? step.expect.shell : {}) }
  const first = (t: string) => (jobId && sealFor(jobId) ? t.replace(/\{first\}/g, () => trapFirstLine(sealFor(jobId)!)) : t)
  return {
    ...e,
    ...(e.out !== undefined ? { out: first(fill(e.out, b)) } : {}),
    ...(e.has ? { has: e.has.map((h) => fill(h, b)) } : {}),
    gone: mode === 'server' && typeof e.gone === 'string' ? fill(e.gone, b) : mode === 'server' ? e.gone : undefined,
  }
}
