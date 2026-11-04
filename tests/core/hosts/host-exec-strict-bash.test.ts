/**
 * host_exec strict against a real bash (src/core/hosts/host-exec-strict.ts): the line Walnut builds
 * runs as `bash -c`, the way the daemon runs it, with both streams in one file as the daemon's log
 * has them. 2026-11-05 code review 13: the `$-` guard and the suffix after the caller's line were
 * checked as strings only, and a pipe ending in a loop named the pipe's first command on bash 5.
 * Each case runs on every bash this machine has (bash 5.2 in the test container; the hand-written
 * lines of bash 4.2 and macOS 3.2 are in host-exec-strict.test.ts).
 *
 * MACHINE SAFETY: short bash children under a 10 s timeout, writing only their own temp file.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { failedStepOf, strictLine, withoutInnerMarks } from '../../../src/core/hosts/host-exec-strict.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-strict-bash-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const bashes = [...new Map(['bash', '/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'].flatMap((b) => {
  const r = spawnSync(b, ['-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], { encoding: 'utf8', timeout: 5_000 })
  return r.status === 0 ? [[r.stdout.trim(), b] as const] : []
})).entries()]

let n = 0
function run(bash: string, line: string): { rc: number; out: string; jobId: string } {
  const jobId = `hx-strict-bash-${process.pid}-${n += 1}`
  const log = path.join(dir, `${n}.log`)
  const fd = fs.openSync(log, 'w')
  const r = spawnSync(bash, ['-c', strictLine(line, jobId)], { cwd: dir, stdio: ['ignore', fd, fd], timeout: 10_000 })
  fs.closeSync(fd)
  return { rc: r.status ?? -1, out: fs.readFileSync(log, 'utf8'), jobId }
}

describe.each(bashes)('strict on bash %s', (_version, bash) => {
  it('marks no failure inside `$( … )`, where bash goes on (the `$-` guard)', () => {
    const r = run(bash, 'x=$(false; echo y); echo "x=$x"')
    expect(r.rc).toBe(0)
    expect(r.out).toBe('x=y\n')
  })

  it('names the last command when it fails, and keeps a code the caller gave', () => {
    const last = run(bash, 'true\ngrep -q zz-nomatch /dev/null')
    expect(failedStepOf(last.out, last.jobId, last.rc)?.command).toBe('grep -q zz-nomatch /dev/null')
    expect(run(bash, 'echo a\nexit 3').rc).toBe(3)
    expect(run(bash, "exec sh -c 'exit 4'").rc).toBe(4)
  })

  it('leaves a cut-off line the syntax error bash makes of it', () => {
    for (const line of ['echo a &&', 'ls /nope ||', 'echo a |']) {
      const r = run(bash, line)
      expect(r.rc, line).not.toBe(0)
      expect(r.out, line).not.toMatch(/^a$/m)
    }
    const doc = run(bash, 'cat <<EOF\nhello')
    expect(doc.out).toContain('hello')
    expect(doc.out).not.toContain('exit')
  })

  it('names the command inside a pipe\'s last member that is a loop or a `{ … }`', () => {
    const loop = run(bash, "printf 'a\\nb\\n' | while read -r l; do grep -q \"zz$l\" /dev/null; done\necho never")
    expect(failedStepOf(loop.out, loop.jobId, loop.rc)).toMatchObject({ exitCode: 1, command: 'grep -q "zz$l" /dev/null', pipeStatus: [0, 1] })
    const group = run(bash, 'echo hi | { read x; false; }\necho never')
    expect(failedStepOf(group.out, group.jobId, group.rc)).toMatchObject({ exitCode: 1, command: 'false' })
  })

  it('a background subshell that failed earlier lends nothing to a later failing pipe', () => {
    const bg = '( sleep 0.1; grep -q zz-nomatch /dev/null ) &\nsleep 0.4\n'
    const pipe = run(bash, `${bg}test -f /no/such | cat`)
    expect(failedStepOf(pipe.out, pipe.jobId, pipe.rc)).toMatchObject({ command: 'cat', pipeStatus: [1, 0] })
    const silent = run(bash, `${bg}grep -q zz-nomatch /dev/null | cat`)
    expect(failedStepOf(silent.out, silent.jobId, silent.rc)).toMatchObject({ command: 'cat', pipeStatus: [1, 0] })
    // The answer shows the shell's own line only, without its bash tag.
    expect(withoutInnerMarks(pipe.out, pipe.jobId)).not.toMatch(/\t\(/)
  })

  it('names a subshell\'s own failing command', () => {
    const r = run(bash, 'echo start\n( cd / && false )\necho never')
    expect(failedStepOf(r.out, r.jobId, r.rc)).toMatchObject({ exitCode: 1, command: 'false' })
  })
})
