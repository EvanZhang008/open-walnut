import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnBehindRegistry } from '../../src/providers/daemon-spawn-barrier.js'

let root: string
let input: fs.FileHandle
let output: fs.FileHandle
let stderr: fs.FileHandle
const active: Array<{ abort(): void; exited: Promise<unknown> }> = []

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-spawn-barrier-'))
  input = await fs.open('/dev/null', 'r')
  output = await fs.open(path.join(root, 'stdout'), 'w', 0o600)
  stderr = await fs.open(path.join(root, 'stderr'), 'w', 0o600)
})

afterEach(async () => {
  for (const child of active) child.abort()
  await Promise.all(active.splice(0).map((child) => child.exited))
  await Promise.all([input.close(), output.close(), stderr.close()])
  await fs.rm(root, { recursive: true, force: true })
})

function start(args = ['-c', 'printf "%s" "$$"']) {
  const gate = spawnBehindRegistry('/bin/sh', args, {
    cwd: root, env: { HOME: root, PATH: '/usr/bin:/bin' },
    stdio: [input.fd, output.fd, stderr.fd],
  })
  const exited = once(gate.process, 'exit', { signal: AbortSignal.timeout(5000) })
  active.push({ abort: gate.abort, exited })
  return { ...gate, exited }
}

describe('real process execution waits for registry commit', () => {
  it('does not execute until released, then preserves the recorded PID', async () => {
    const gate = start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await fs.readFile(path.join(root, 'stdout'), 'utf8')).toBe('')
    gate.release()
    expect(await gate.exited).toEqual([0, null])
    expect(await fs.readFile(path.join(root, 'stdout'), 'utf8')).toBe(String(gate.process.pid))
  })

  it('never executes when the registry write fails and the pipe is closed', async () => {
    const gate = start()
    gate.abort()
    expect(await gate.exited).toEqual([125, null])
    expect(await fs.readFile(path.join(root, 'stdout'), 'utf8')).toBe('')
  })

  it('rejects missing and non-executable programs before creating a wrapper', async () => {
    const options = { cwd: root, env: { PATH: root }, stdio: [input.fd, output.fd, stderr.fd] as [number, number, number] }
    expect(() => spawnBehindRegistry('absent-cli', [], options)).toThrow('Executable not found')
    const program = path.join(root, 'no-exec')
    await fs.writeFile(program, 'not executable', { mode: 0o600 })
    expect(() => spawnBehindRegistry(program, [], options)).toThrow()
    expect(await fs.readFile(path.join(root, 'stdout'), 'utf8')).toBe('')
  })

  it('passes arguments literally without shell expansion', async () => {
    const text = '\u4e2d\u6587 spaces; $(touch unwanted)' // CJK "Chinese"
    const gate = start(['-c', 'printf "%s" "$1"', 'fixture', text])
    gate.release()
    expect(await gate.exited).toEqual([0, null])
    expect(await fs.readFile(path.join(root, 'stdout'), 'utf8')).toBe(text)
    await expect(fs.stat(path.join(root, 'unwanted'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
