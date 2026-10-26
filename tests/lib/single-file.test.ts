/**
 * execFileReplaced: an npm update writes the new version in place of the file a
 * compiled server runs from, and every child the server starts from
 * process.execPath after that runs the new version. The server must know, or it
 * restarts its daemon on every check (each restart spawning the same new file).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { execFileReplaced, fileIdentity, type SingleFile } from '../../src/lib/single-file.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
const info = (execId: string | null | undefined): SingleFile => ({ root: '/rt', daemonVersion: 'walnut-daemon-a', modules: {}, execId })

describe('execFileReplaced', () => {
  it('is false for the file the process started from, and true once an update replaced it', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'single-file-'))
    dirs.push(d)
    const file = path.join(d, 'walnut')
    fs.writeFileSync(file, 'old build', { mode: 0o755 })
    const started = info(fileIdentity(file))
    expect(execFileReplaced(started, file)).toBe(false)
    // npm unpacks the new file beside the old one and renames it over: a new inode.
    fs.writeFileSync(path.join(d, '.walnut-new'), 'new build', { mode: 0o755 })
    fs.renameSync(path.join(d, '.walnut-new'), file)
    expect(execFileReplaced(started, file)).toBe(true)
  })

  it('a file that is gone counts as replaced; no recorded identity never does', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'single-file-'))
    dirs.push(d)
    const file = path.join(d, 'walnut')
    fs.writeFileSync(file, 'build')
    const started = info(fileIdentity(file))
    fs.rmSync(file)
    expect(fileIdentity(file)).toBeNull()
    expect(execFileReplaced(started, file)).toBe(true)
    expect(execFileReplaced(info(null), file)).toBe(false)
    expect(execFileReplaced(info(undefined), file)).toBe(false)
    expect(execFileReplaced(null, file)).toBe(false)
  })
})
