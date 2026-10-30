/**
 * Every read of the WHOLE process table into a Node buffer names its own
 * maxBuffer. With Node's default (1 MB) the read fails with ENOBUFS once the
 * table is bigger, and the caller sees no processes at all: on 2026-10-30
 * `ps -A -o pid=,command=` printed 1.15 MB on the Mac (live `claude` sessions
 * carry up to 119 KB of arguments each), and two quick-tier tests read "no such
 * process" for processes they had just started.
 *
 * Found from the source: a call of execFile / execFileSync / spawn / spawnSync /
 * execSync whose program is `ps` and whose flags list every process (-A, -e, -ax,
 * aux) with the command column. A shell pipeline (`ps ... | grep`) has no such
 * buffer and is exempt, as is a read inside a container (`docker exec`).
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')

/** Reads that pass through a wrapper whose own buffer is set, with why. */
const WRAPPED: Record<string, string> = {
  // deps.exec is boundedExecFile with maxBuffer 64 MB in both daemon twins.
  'src/providers/cli-owner-core.ts': 'deps.exec sets maxBuffer in daemon-standalone.ts and daemon-source.ts',
}

const CALL = /\b(execFileSync|execFile|spawnSync|spawn|execSync|run)\(\s*['"`](\/bin\/)?ps\b/
const WHOLE = /['"`\s](-A|-e|-ax|-axo|-axww|-Ao|-eo|aux|axo)\b/
const COMMAND_COLUMN = /command|args|aux/

export function unboundedPsReads(files: Array<{ file: string; text: string }>): string[] {
  const found: string[] = []
  for (const { file, text } of files) {
    if (WRAPPED[file]) continue
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (!CALL.test(line) || /^\s*(\*|\/\/)/.test(line)) return
      // The call as written: this line and the next few, up to its closing paren.
      const call = lines.slice(i, i + 4).join('\n')
      if (!WHOLE.test(call) || !COMMAND_COLUMN.test(call)) return
      if (/ps[^'"`\n]*\|/.test(call)) return // a shell pipeline: no Node buffer
      if (!/maxBuffer/.test(call)) found.push(`${file}:${i + 1}`)
    })
  }
  return found
}

function trackedSources(): Array<{ file: string; text: string }> {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'scripts', 'tests', 'packages'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
  return out.split('\n').filter((f) => /\.(ts|tsx|mts|mjs|cjs|js)$/.test(f) && f !== 'tests/scripts/ps-table-buffer-ratchet.test.ts')
    .flatMap((file) => { try { return [{ file, text: fs.readFileSync(path.join(ROOT, file), 'utf8') }] } catch { return [] } })
}

describe('whole process table reads', () => {
  it('each names a maxBuffer', () => {
    expect(unboundedPsReads(trackedSources()), 'add maxBuffer (64 << 20) to these ps reads').toEqual([])
  })

  it('the finder catches the shapes that broke and lets the safe ones by', () => {
    const src = (text: string) => [{ file: 'x.ts', text }]
    expect(unboundedPsReads(src(`execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' })`))).toEqual(['x.ts:1'])
    expect(unboundedPsReads(src(`spawnSync('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8' })`))).toEqual(['x.ts:1'])
    expect(unboundedPsReads(src(`execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='],\n  { encoding: 'utf-8' })`))).toEqual(['x.ts:1'])
    expect(unboundedPsReads(src(`execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 })`))).toEqual([])
    // One pid, or no command column: small output.
    expect(unboundedPsReads(src(`execFileSync('ps', ['-o', 'command=', '-p', String(pid)])`))).toEqual([])
    expect(unboundedPsReads(src(`execFileSync('ps', ['-A', '-o', 'pgid=,stat='])`))).toEqual([])
    expect(unboundedPsReads(src('execSync(`ps -eo pid,command | grep -F x`)'))).toEqual([])
  })
})
