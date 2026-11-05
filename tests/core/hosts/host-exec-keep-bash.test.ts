/**
 * host_exec keep against a real bash (src/core/hosts/host-exec-keep.ts): the cases in
 * tests/helpers/host-exec-keep-cases.ts, played call after call in one task directory, on every bash
 * this machine has (5.x in the test container, /bin/bash 3.2 on a Mac; add others with
 * WALNUT_KEEP_BASHES=/path/a:/path/b), each both ways a call finds its kept directory (the server
 * reads it, or the shell enters it). Then comparisons with the same lines run without keep: keep
 * changes no exit code, signal or output of a first call (aliases, functions over every command the
 * save runs, readonly names and tracing included), and strict names the same step with keep as
 * without it; and runs at once always leave a pointer that names one run's directory and variables.
 *
 * MACHINE SAFETY: short shell children under a 10 s timeout, each in its own temp dir; a signal goes
 * only to the process group of a child the runner started.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { failedStepOf, strictLine, withoutInnerMarks } from '../../../src/core/hosts/host-exec-strict.js'
import { KEEP_SAVE_NAMES, KEEP_UNSET_FUNCTIONS, keepMarkWhy, shapedLine, withKeepMarkSaid } from '../../../src/core/hosts/host-exec-keep.js'
import { KEEP_CASES, SHADOWED, bashesHere, expected, keptStart, nonBashSh, notSavedLine, playCase, runLine, sandbox, type KeepMode, type Sandbox } from '../../helpers/host-exec-keep-cases.js'

const bashes = bashesHere()
const sh = nonBashSh()
const boxes: Sandbox[] = []
afterAll(() => { for (const b of boxes) fs.rmSync(b.root, { recursive: true, force: true }) })

let n = 0
const job = () => `hx-keep-bash-${process.pid}-${n += 1}`

/** One keep call as a current host's server makes it: the pointer read first, its generation in the line, its directory the cwd. */
async function keepCall(bash: string, box: Sandbox, command: string, o: { strict?: boolean; background?: boolean } = {}) {
  const k = keptStart(box)
  const jobId = job()
  const r = await runLine(bash, shapedLine({ command, keep: true, ...o }, jobId, { gen: k.gen })!, box, { cwd: k.cwd, jobId })
  return { ...r, jobId, shown: withKeepMarkSaid(r.out, jobId), why: keepMarkWhy(r.out, jobId) }
}

/** `word` as a function that would print a value, defined by the line (eval: `:` and `[` too). */
const shadow = (word: string) => `eval '${word}() { printf "fn:%s\\n" "$SECRET"; }'`
const SHADOW_SETS = ['', 'set -x; ', 'set -e; ', "PS4='$SECRET '; set -xe; "]

/** Lines whose exit, signal and output must not change with keep (a first call: nothing to restore). */
const SAME_LINES = [
  'true', 'false', 'echo a\nexit 3', "sh -c 'exit 7'", "exec sh -c 'exit 4'", 'grep -q zz-nomatch /dev/null',
  'echo a &&', 'echo a |', 'cat <<EOF\nhello', 'kill -TERM $$', 'echo out; echo err >&2; exit 5',
  // Review 2026-11-05 (keep round 1): tracing that would print a value, and what a line does to its shell.
  "export SECRET=private-canary; PS4='$SECRET '; set -x",
  "export SECRET=private-canary; exec 9>&2; BASH_XTRACEFD=9; PS4='$SECRET '; set -x",
  "export SECRET=private-canary; PS4='$SECRET '; set -x; echo traced",
  'export V=kept; readonly IFS; true', "export IFS='x y'; true", "IFS=$'\\n'; true",
  'unset PWD; export V=kept; set -u; true', 'export V=1; exec 2>&-; true', 'set -a; AX=1; set -o posix; true',
  'leak() { echo VALUE; }; export -f leak; leak', 'export V=1; set -eu; exit 3', 'printf -v BIG "%131072s" x; export BIG; true',
  'export V=1; unset walnut_nl walnut_kn walnut_kb; true',
  // Review 2026-11-05 (keep round 2): a trace on stdout or stdin, functions over the save's commands, posix mode.
  "export SECRET=private-canary; BASH_XTRACEFD=1; PS4='$SECRET '; set -x",
  "export SECRET=private-canary; BASH_XTRACEFD=0; PS4='$SECRET '; set -x",
  "export SECRET=private-canary; builtin() { printf 'fn:%s\\n' \"$SECRET\"; }; true",
  `export SECRET=private-canary; ${SHADOWED.map(shadow).join('; ')}; true`,
  `export SECRET=private-canary; PS4='$SECRET '; set -xeu; ${SHADOWED.map(shadow).join('; ')}; true`,
  "trap 'echo DBG' DEBUG; export V=1; true", "trap 'echo ERR' ERR; false", 'export POSIXLY_CORRECT=1; true', 'set -o posix; exit 3',
  'readonly POSIXLY_CORRECT; exit 3', 'POSIXLY_CORRECT=1; readonly POSIXLY_CORRECT; exit 3',
  'declare -i walnut_s walnut_d; export V=1; true',
]

/**
 * Lines stopped by a signal to their process group, as the daemon stops a job. The save's wait reaps
 * a child the signal ended, and bash would report it ("Terminated") where the run without keep ends
 * silently.
 */
const STOPPED_LINES: Array<[string, NodeJS.Signals]> = [
  ['export K=1; cd /; sleep 5', 'SIGTERM'], ['export K=1; sleep 5', 'SIGHUP'],
  ['export K=1; sleep 10 & sleep 5', 'SIGTERM'], ['export K=1; (sleep 5)', 'SIGTERM'],
]

/** Every word in command position in keep's EXIT trap past its first line, and `[`/`test` (the reviewer's); each as an alias. */
const ALIASED = [
  'builtin', 'command', '[', 'test', '[[', '!', 'printf', 'declare', 'compgen', 'export', 'set', 'shopt', 'trap', 'umask', 'pwd', 'exec', 'unset',
  'mv', 'mkdir', 'rm', 'date', 'exit', 'if', 'then', 'elif', 'fi', 'while', 'do', 'done', 'case', 'esac', 'continue', ':', '}', 'POSIXLY_CORRECT=y',
]

/** Strict lines (tests/core/hosts/host-exec-strict-bash.test.ts, tests/e2e/host-exec-e2e.test.ts). */
const STRICT_LINES = [
  'x=$(false; echo y); echo "x=$x"',
  'true\ngrep -q zz-nomatch /dev/null',
  'echo a\nexit 3',
  "exec sh -c 'exit 4'",
  'echo a &&', 'ls /nope ||', 'echo a |', 'cat <<EOF\nhello',
  "printf 'a\\nb\\n' | while read -r l; do grep -q \"zz$l\" /dev/null; done\necho never",
  'echo hi | { read x; false; }\necho never',
  '( sleep 0.1; grep -q zz-nomatch /dev/null ) &\nsleep 0.4\ntest -f /no/such | cat',
  'echo start\n( cd / && false )\necho never',
  'echo a\n(false)\necho never',
  '(false)',
  'f() { return 3; }\nf\necho never',
  'yes | head -1 >/dev/null\necho never',
  'check() { grep -q zzz-not-there /dev/null; }\ncheck\necho never',
  'echo start\ntrue | false | cat\necho never',
]

/** A strict run's output with its run's own marks made comparable: no job id, no seal, no pid. */
const comparable = (out: string, jobId: string) => withoutInnerMarks(out, jobId)
  .replaceAll(jobId, 'JOB').replace(/(walnut strict JOB) [0-9a-f]{12}/g, '$1').replace(/\t\(bash \d+, bg \d+\)$/gm, '')

const root = process.getuid?.() === 0

describe.each(bashes)('keep on bash %s', (_version, bash) => {
  for (const mode of ['server', 'shell'] as KeepMode[]) {
    for (const c of KEEP_CASES.filter((k) => !k.mode || k.mode === mode)) {
      it.skipIf((c.steps.some((s) => s.sh) && !sh) || (c.nonRoot && root))(`${c.name} (${mode})`, async () => {
        const { results, box } = await playCase(c, bash, sh, mode)
        boxes.push(box)
        for (const [i, step] of c.steps.entries()) {
          const r = results[i]!
          const e = expected(step, box, mode, r.jobId)
          const what = `step ${i + 1}: ${step.command.slice(0, 80)}\n--- output ---\n${r.out.slice(0, 2000)}`
          if (e.rc !== undefined) expect(r.rc, what).toBe(e.rc)
          if (e.signal !== undefined) expect(r.signal, what).toBe(e.signal)
          if (e.out !== undefined) expect(r.out, what).toBe(e.out)
          for (const h of e.has ?? []) expect(r.out, what).toContain(h)
          for (const h of e.not ?? []) expect(r.out, what).not.toContain(h)
          if (e.match !== undefined) expect(r.out, what).toMatch(new RegExp(e.match))
          if (e.gone !== undefined) expect(r.gone, what).toBe(e.gone)
          if (e.why !== undefined) expect(r.why, what).toBe(e.why)
        }
      }, 30_000)
    }
  }

  it('changes no exit code, signal or output of a first call', async () => {
    for (const line of SAME_LINES) {
      const plainBox = sandbox()
      const keepBox = sandbox()
      boxes.push(plainBox, keepBox)
      const plain = await runLine(bash, line, plainBox)
      const kept = await runLine(bash, shapedLine({ command: line, keep: true }, job())!, keepBox)
      expect({ rc: kept.rc, signal: kept.signal, out: kept.out.replaceAll(keepBox.root, 'ROOT') }, line)
        .toEqual({ rc: plain.rc, signal: plain.signal, out: plain.out.replaceAll(plainBox.root, 'ROOT') })
    }
  }, 60_000)

  it('a stop by a signal ends with the same signal and output as without keep', async () => {
    for (const [line, signal] of STOPPED_LINES) {
      const plainBox = sandbox()
      const keepBox = sandbox()
      boxes.push(plainBox, keepBox)
      const kill = { signal, afterMs: 400 }
      const plain = await runLine(bash, line, plainBox, { kill })
      const kept = await runLine(bash, shapedLine({ command: line, keep: true }, job())!, keepBox, { kill })
      expect({ rc: kept.rc, signal: kept.signal, out: kept.out }, `${line} (${signal})`).toEqual({ rc: plain.rc, signal: plain.signal, out: plain.out })
    }
  }, 60_000)

  it('an alias of any command word the save uses changes neither the run nor the save', async () => {
    for (const word of ALIASED) {
      const line = `export VAL=keep; shopt -s expand_aliases; alias '${word}'='echo hijack'; true`
      const plainBox = sandbox()
      const keepBox = sandbox()
      boxes.push(plainBox, keepBox)
      const plain = await runLine(bash, line, plainBox)
      const kept = await runLine(bash, shapedLine({ command: line, keep: true }, job())!, keepBox)
      expect({ rc: kept.rc, signal: kept.signal, out: kept.out }, word).toEqual({ rc: plain.rc, signal: plain.signal, out: plain.out })
      expect((await keepCall(bash, keepBox, 'echo "${VAL-unset}"; pwd')).out, word).toBe(`keep\n${keepBox.home}\n`)
    }
  }, 120_000)

  it('a function over any command the save runs, alone or with set -x and -e, is never called, and the state saves', async () => {
    for (const word of SHADOWED) {
      for (const set of SHADOW_SETS) {
        const line = `export VAL=keep SECRET=private-canary; ${set}${shadow(word)}; true`
        const plainBox = sandbox()
        const keepBox = sandbox()
        boxes.push(plainBox, keepBox)
        const plain = await runLine(bash, line, plainBox)
        const kept = await keepCall(bash, keepBox, line)
        expect({ rc: kept.rc, signal: kept.signal, out: kept.out }, `${set}${word}`).toEqual({ rc: plain.rc, signal: plain.signal, out: plain.out })
        expect((await keepCall(bash, keepBox, 'echo "${VAL-unset}"')).out, `${set}${word}`).toBe('keep\n')
      }
    }
  }, 240_000)

  it('a readonly function over a command the save runs: one the first line removes stops the save with the mark, any other changes nothing', async () => {
    for (const word of SHADOWED) {
      for (const set of ['', "PS4='$SECRET '; set -xe; "]) {
        const box = sandbox()
        boxes.push(box)
        await keepCall(bash, box, 'export VAL=old')
        const line = `export VAL=new SECRET=private-canary; ${set}${shadow(word)}; readonly -f ${word}; exit 3`
        const plainBox = sandbox()
        boxes.push(plainBox)
        const plain = await runLine(bash, line, plainBox)
        const kept = await keepCall(bash, box, line)
        const removed = KEEP_UNSET_FUNCTIONS.includes(word)
        const what = `${set}${word}`
        expect({ rc: kept.rc, signal: kept.signal }, what).toEqual({ rc: plain.rc, signal: plain.signal })
        expect(kept.shown, what).toBe(removed ? withKeepMarkSaid(plain.out, kept.jobId) + notSavedLine('the line made a function the save needs readonly') : plain.out)
        expect(kept.why, what).toBe(removed ? 'the line made a function the save needs readonly' : null)
        expect((await keepCall(bash, box, 'echo "$VAL"')).out, what).toBe(removed ? 'old\n' : 'new\n')
      }
    }
  }, 240_000)

  it('runs at once: after every round the pointer names one run\'s directory and variables, and a call that starts during the saves gets one whole snapshot', async () => {
    const box = sandbox()
    boxes.push(box)
    const dirs = ['d0', 'd1', 'd2', 'd3']
    for (const d of dirs) fs.mkdirSync(path.join(box.home, d))
    // A background keep call (it restores, never saves) over and over while the writers run.
    let writing = true
    const seen: string[] = []
    const reader = (async () => {
      while (writing) {
        const r = await keepCall(bash, box, 'printf "%s|%s" "${TAG-}" "$PWD"', { background: true })
        seen.push(r.out)
      }
    })()
    for (let round = 0; round < 25; round += 1) {
      await Promise.all(dirs.map((d) => keepCall(bash, box, `cd "$HOME/${d}"; export TAG=${d}; true`)))
      const k = keptStart(box)
      expect(k.gen, `round ${round}`).toBeTruthy()
      const r = await runLine(bash, `. "$WALNUT_TASK_DIR/host-exec/keep.d/${k.gen}.sh" && printf "%s|%s" "$TAG" "$walnut_kd"`, box)
      expect(r.out, `round ${round}`).toBe(`${path.basename(k.cwd!)}|${k.cwd}`)
    }
    writing = false
    await reader
    expect(seen.length).toBeGreaterThan(3)
    for (const s of seen) {
      const [tag, pwd] = s.split('|')
      expect(tag === '' ? pwd : `${box.home}/${tag}`, s).toBe(pwd)
    }
  }, 240_000)

  it('a name the save needs made readonly: the exit code stays, one line says it was not saved, and the last state stands', async () => {
    for (const name of KEEP_SAVE_NAMES) {
      for (const [tail, rc] of [['set -e; true', 0], ['set -eu; exit 3', 3]] as const) {
        const box = sandbox()
        boxes.push(box)
        await keepCall(bash, box, 'export V=old')
        const line = `export V=new; readonly ${name}; ${tail}`
        const plainBox = sandbox()
        boxes.push(plainBox)
        const plain = await runLine(bash, line, plainBox)
        const kept = await keepCall(bash, box, line)
        expect({ rc: kept.rc, signal: kept.signal }, line).toEqual({ rc: plain.rc, signal: plain.signal })
        expect(kept.rc, line).toBe(rc)
        expect(kept.shown, line).toBe(plain.out + notSavedLine('the line made a walnut_ variable readonly'))
        expect(kept.why, line).toBe('the line made a walnut_ variable readonly')
        expect((await keepCall(bash, box, 'echo "$V"')).out, line).toBe('old\n')
      }
    }
    // The names the save only reads: readonly, it saves all the same.
    for (const name of ['walnut_kh', 'walnut_kg', 'walnut_kf', 'walnut_kn', 'walnut_kb', 'walnut_kz']) {
      const box = sandbox()
      boxes.push(box)
      const kept = await keepCall(bash, box, `export V=new; readonly ${name}; set -e; true`)
      expect(kept, name).toMatchObject({ rc: 0, out: '' })
      expect((await keepCall(bash, box, 'echo "$V"')).out, name).toBe('new\n')
    }
  }, 120_000)

  it('strict names the same step with keep as without it, with the same exit code', async () => {
    for (const line of STRICT_LINES) {
      const plainBox = sandbox()
      const keepBox = sandbox()
      boxes.push(plainBox, keepBox)
      const a = job()
      const b = job()
      const strict = await runLine(bash, strictLine(line, a), plainBox, { jobId: a })
      const both = await runLine(bash, shapedLine({ command: line, strict: true, keep: true }, b)!, keepBox, { jobId: b })
      expect(both.rc, line).toBe(strict.rc)
      expect(failedStepOf(both.out, b, both.rc), line).toEqual(failedStepOf(strict.out, a, strict.rc))
      expect(comparable(both.out, b), line).toBe(comparable(strict.out, a))
    }
  }, 60_000)

  it('strict and keep: a failed step stops the run, its code stays, and what it set before carries', async () => {
    const box = sandbox()
    boxes.push(box)
    const a = job()
    const first = await runLine(bash, shapedLine({ command: 'export SK=1; mkdir -p sk && cd sk\ngrep -q zz-nomatch /dev/null\necho never', strict: true, keep: true }, a)!, box, { jobId: a })
    expect(first.rc).toBe(1)
    expect(failedStepOf(first.out, a, first.rc)).toMatchObject({ exitCode: 1, command: 'grep -q zz-nomatch /dev/null' })
    expect(first.out).not.toContain('never')
    const next = await keepCall(bash, box, 'echo "$SK $PWD"', { strict: true })
    expect(next).toMatchObject({ rc: 0, out: `1 ${box.home}/sk\n` })
    // A background strict run keeps strict's own EXIT trap, and saves nothing.
    const c = job()
    const bg = await runLine(bash, shapedLine({ command: 'export SKB=1\nfalse\necho never', strict: true, keep: true, background: true }, c)!, box, { jobId: c })
    expect(bg.rc).toBe(1)
    expect(failedStepOf(bg.out, c, bg.rc)).toMatchObject({ command: 'false' })
    expect((await keepCall(bash, box, 'echo "${SKB-unset} ${SK-unset}"')).out).toBe('unset 1\n')
  }, 30_000)
})
