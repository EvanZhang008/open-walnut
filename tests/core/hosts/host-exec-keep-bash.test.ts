/**
 * host_exec keep against a real bash (src/core/hosts/host-exec-keep.ts): the cases in
 * tests/helpers/host-exec-keep-cases.ts, played call after call in one task directory, on every bash
 * this machine has (5.x in the test container, /bin/bash 3.2 on a Mac; add others with
 * WALNUT_KEEP_BASHES=/path/a:/path/b). Then two comparisons with the same lines run without keep:
 * keep changes no exit code, signal or output of a first call, and strict names the same step with
 * keep as without it.
 *
 * MACHINE SAFETY: short shell children under a 10 s timeout, each in its own temp dir; a signal goes
 * only to the process group of a child the runner started.
 */
import fs from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { failedStepOf, strictLine, withoutInnerMarks } from '../../../src/core/hosts/host-exec-strict.js'
import { shapedLine } from '../../../src/core/hosts/host-exec-keep.js'
import { KEEP_CASES, bashesHere, expected, nonBashSh, playCase, runLine, sandbox, type Sandbox } from '../../helpers/host-exec-keep-cases.js'

const bashes = bashesHere()
const sh = nonBashSh()
const boxes: Sandbox[] = []
afterAll(() => { for (const b of boxes) fs.rmSync(b.root, { recursive: true, force: true }) })

let n = 0
const job = () => `hx-keep-bash-${process.pid}-${n += 1}`

/** Lines whose exit, signal and output must not change with keep (a first call: nothing to restore). */
const SAME_LINES = [
  'true', 'false', 'echo a\nexit 3', "sh -c 'exit 7'", "exec sh -c 'exit 4'", 'grep -q zz-nomatch /dev/null',
  'echo a &&', 'echo a |', 'cat <<EOF\nhello', 'kill -TERM $$', 'echo out; echo err >&2; exit 5',
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

describe.each(bashes)('keep on bash %s', (_version, bash) => {
  for (const c of KEEP_CASES) {
    it.skipIf(c.steps.some((s) => s.sh) && !sh)(c.name, async () => {
      const { results, box } = await playCase(c, bash, sh)
      boxes.push(box)
      for (const [i, step] of c.steps.entries()) {
        const r = results[i]!
        const e = expected(step, box)
        const what = `step ${i + 1}: ${step.command.slice(0, 80)}\n--- output ---\n${r.out}`
        if (e.rc !== undefined) expect(r.rc, what).toBe(e.rc)
        if (e.signal !== undefined) expect(r.signal, what).toBe(e.signal)
        if (e.out !== undefined) expect(r.out, what).toBe(e.out)
        for (const h of e.has ?? []) expect(r.out, what).toContain(h)
        for (const h of e.not ?? []) expect(r.out, what).not.toContain(h)
        if (e.match !== undefined) expect(r.out, what).toMatch(new RegExp(e.match))
      }
    }, 30_000)
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
    const b = job()
    const next = await runLine(bash, shapedLine({ command: 'echo "$SK $PWD"', strict: true, keep: true }, b)!, box, { jobId: b })
    expect(next).toMatchObject({ rc: 0, out: `1 ${box.home}/sk\n` })
    // A background strict run keeps strict's own EXIT trap, and saves nothing.
    const c = job()
    const bg = await runLine(bash, shapedLine({ command: 'export SKB=1\nfalse\necho never', strict: true, keep: true, background: true }, c)!, box, { jobId: c })
    expect(bg.rc).toBe(1)
    expect(failedStepOf(bg.out, c, bg.rc)).toMatchObject({ command: 'false' })
    expect((await runLine(bash, shapedLine({ command: 'echo "${SKB-unset} ${SK-unset}"', keep: true }, job())!, box)).out).toBe('unset 1\n')
  }, 30_000)
})
