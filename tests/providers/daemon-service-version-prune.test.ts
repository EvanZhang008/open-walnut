/**
 * Pruning staged daemon versions: keep the named ones and any a live process
 * still runs (a plugin job started from an older build), remove the rest, and
 * never touch a dir that is not a private, sha-named version.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { pruneDaemonServiceVersions } from '../../src/providers/daemon-service-artifact.js'

const sha = (c: string) => c.repeat(64)
let root: string
let versions: string
const children: ChildProcess[] = []

function version(name: string, mode = 0o700): string {
  const dir = path.join(versions, name)
  fs.mkdirSync(dir, { recursive: true, mode })
  fs.chmodSync(dir, mode)
  const exe = path.join(dir, 'daemon')
  fs.copyFileSync('/bin/sleep', exe)
  fs.chmodSync(exe, 0o700)
  return exe
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-prune-'))
  versions = path.join(root, 'versions')
  fs.mkdirSync(versions, { mode: 0o700 })
})
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  fs.rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'linux')('pruning staged daemon versions', () => {
  it('keeps the current, the previous and one a live process runs; removes the rest', async () => {
    const current = version(sha('a'))
    const previous = version(sha('b'))
    const inUse = version(sha('c'))
    version(sha('d'))
    const child = spawn(inUse, ['30'], { stdio: 'ignore' })
    children.push(child)
    await new Promise((resolve) => child.once('spawn', resolve))

    const removed = await pruneDaemonServiceVersions(root, [current, previous])
    expect(removed).toEqual([path.join(versions, sha('d'))])
    expect(fs.readdirSync(versions).sort()).toEqual([sha('a'), sha('b'), sha('c')])
  })

  it('leaves dirs that are not private sha-named versions alone', async () => {
    const current = version(sha('a'))
    version('walnut-daemon-old')
    version(sha('e'), 0o755)
    fs.symlinkSync('/tmp', path.join(versions, sha('f')))
    expect(await pruneDaemonServiceVersions(root, [current])).toEqual([])
    expect(fs.readdirSync(versions).sort()).toEqual([sha('a'), sha('e'), sha('f'), 'walnut-daemon-old'].sort())
  })
})
