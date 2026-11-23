/**
 * A `walnut tools call` failure is never lost: on stderr as always, but on stdout when stderr is
 * thrown away (2>/dev/null), as with --json (src/providers/tool-call-output.ts). 2026-11-22: a
 * lead parsed an empty stdout after `2>/dev/null` and read a refused call as a broken answer.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { failureOnStdout, renderToolCallFailure, stderrDiscarded, toolCallFailure } from '../../src/providers/tool-call-output.js'

const ROOT = path.resolve(__dirname, '../..')
const probe = `import { stderrDiscarded } from ${JSON.stringify(path.join(ROOT, 'src/providers/tool-call-output.ts'))}; process.stdout.write(String(stderrDiscarded()))`

function run(stderr: 'pipe' | number): string {
  const r = spawnSync(process.execPath, ['-e', probe], { stdio: ['ignore', 'pipe', stderr], encoding: 'utf8', timeout: 30_000 })
  return String(r.stdout).trim()
}

describe('a tools call failure with stderr thrown away', () => {
  it('tells a stderr sent to /dev/null from a pipe or a file, in a real process', () => {
    const devNull = fs.openSync('/dev/null', 'w')
    try { expect(run(devNull)).toBe('true') } finally { fs.closeSync(devNull) }
    expect(run('pipe')).toBe('false')
    const file = path.join(fs.mkdtempSync(path.join(ROOT, 'node_modules', '.tmp-stderr-')), 'err.txt')
    const fd = fs.openSync(file, 'w')
    try { expect(run(fd)).toBe('false') } finally { fs.closeSync(fd); fs.rmSync(path.dirname(file), { recursive: true, force: true }) }
  })

  it('a closed stderr counts as thrown away; the same file as /dev/null only when it is /dev/null', () => {
    const nul = { dev: 1, ino: 2 }
    expect(stderrDiscarded(() => { throw new Error('EBADF') }, () => nul)).toBe(true)
    expect(stderrDiscarded(() => ({ dev: 1, ino: 2 }), () => nul)).toBe(true)
    expect(stderrDiscarded(() => ({ dev: 1, ino: 3 }), () => nul)).toBe(false)
    expect(stderrDiscarded(() => ({ dev: 1, ino: 2 }), () => null)).toBe(false)
  })

  it('puts the one failure object on stdout then, and leaves --json as it was', () => {
    const f = toolCallFailure('invalid_arguments', 'Invalid arguments for task_history: limit: Too big')
    const onStdout = renderToolCallFailure(f, { json: true })
    expect(JSON.parse(onStdout.stdout)).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } })
    expect(onStdout.stderr).toBe('')
    expect(failureOnStdout(true)).toBe(true)
  })
})
