/**
 * uploadFile against real files: the real uploadFile, pipeSingleStream and
 * pipeChunked, with a stand-in `ssh` that runs each remote command here with
 * `sh -c`, so every precheck, chunk write, listing, join and sha check is the
 * shell text a host would run.
 *
 * The fake (tests/providers/fixtures/fake-ssh-upload.sh, copied into a temp dir
 * first on PATH, in front of the exec guard) can cut a transfer the way a proxy
 * does (exit 255, "Connection closed", after half of stdin reached the command),
 * cut one chunk once, refuse every connection after a given chunk, and hide
 * sha256sum or shasum from the "host". Each call appends `<kind> <outcome>` to
 * the state dir's log (kind: exec, stream, chunk_NNNN).
 *
 * MACHINE SAFETY: no real ssh, no network; everything lives in a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { guardedPath } from '../setup/exec-guard.js'

const FAKE_SSH = path.resolve(__dirname, 'fixtures/fake-ssh-upload.sh')

let root = ''
let state = ''
let remote = ''
let savedPath: string | undefined
let savedState: string | undefined

const flag = (name: string, value = '') => fs.writeFileSync(path.join(state, name), value ? `${value}\n` : '')
const unflag = (name: string) => fs.rmSync(path.join(state, name), { force: true })
const readLog = (): string[] => {
  try { return fs.readFileSync(path.join(state, 'log'), 'utf8').split('\n').filter(Boolean) } catch { return [] }
}
const clearLog = () => fs.rmSync(path.join(state, 'log'), { force: true })
/** The chunks the host took whole, in order. */
const chunksOk = () => readLog().filter((l) => /^chunk_\d+ ok$/.test(l)).map((l) => l.split(' ')[0])
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `chunk_${String(from + i).padStart(4, '0')}`)
/** Make `tool` answer nothing on the "host" (exit 127, as when it is not installed). */
const hide = (tool: string) => fs.writeFileSync(path.join(state, 'hide', tool), '#!/bin/sh\nexit 127\n', { mode: 0o755 })
const onMachine = (tool: string) => (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, tool)))

function connection(): DaemonConnection {
  const conn = new DaemonConnection('devbox', { hostname: 'devbox.example.test', user: 'me' })
  // No ControlMaster (sshExec stays one-shot), and no seconds-long backoff.
  ;(conn as unknown as Record<string, unknown>).chunkPacing = { backoffMs: [1, 1, 1, 1, 1], gapMs: 0 }
  return conn
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-upload-fake-ssh-'))
  state = path.join(root, 'state')
  // A space in the path: every remote command must quote it.
  remote = path.join(root, 'host dir', 'incoming', 'walnut-1.gz')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.mkdirSync(path.join(state, 'hide'), { recursive: true })
  fs.copyFileSync(FAKE_SSH, path.join(bin, 'ssh'))
  fs.chmodSync(path.join(bin, 'ssh'), 0o755)
  savedPath = process.env.PATH
  savedState = process.env.FAKE_SSH_STATE
  process.env.PATH = guardedPath([bin])
  process.env.FAKE_SSH_STATE = state
})

afterEach(() => {
  process.env.PATH = savedPath
  if (savedState === undefined) delete process.env.FAKE_SSH_STATE
  else process.env.FAKE_SSH_STATE = savedState
  fs.rmSync(root, { recursive: true, force: true })
})

const chunkDirs = () => fs.readdirSync(path.dirname(remote)).filter((n) => n.includes('.chunks'))

describe('uploadFile over a stand-in ssh, real files', () => {
  // 11 full chunks and a short twelfth.
  const DATA = crypto.randomBytes(3_000_000)

  it('arrives byte-identical through the chunks when the one stream is cut, and a second upload sends nothing', async () => {
    flag('max-bytes', '1000000')
    flag('fail-once', 'chunk_0003')
    const conn = connection()
    await expect(conn.uploadFile(remote, DATA)).resolves.toEqual({ skipped: false })
    expect(fs.readFileSync(remote).equals(DATA)).toBe(true)
    const log = readLog()
    expect(log).toContain('stream cut')
    expect(log.filter((l) => l.startsWith('chunk_0003'))).toEqual(['chunk_0003 cut', 'chunk_0003 ok'])
    expect(chunksOk()).toEqual(range(0, 12))
    expect(chunkDirs()).toEqual([])

    clearLog()
    await expect(connection().uploadFile(remote, DATA)).resolves.toEqual({ skipped: true })
    expect(readLog()).toEqual(['exec ok'])
  })

  it('an upload cut off after six chunks resumes with the rest, and a wrong-size chunk is sent again', async () => {
    flag('max-bytes', '1000000')
    flag('refuse-after', 'chunk_0005')
    await expect(connection().uploadFile(remote, DATA)).rejects.toThrow(/chunk 7\/12 killed 6 times/)
    expect(chunksOk()).toEqual(range(0, 6))
    const [dir] = chunkDirs()
    const sha = crypto.createHash('sha256').update(DATA).digest('hex')
    expect(dir).toBe(`walnut-1.gz.chunks-${sha.slice(0, 16)}`)
    // A chunk the host holds short (a write cut mid-way) and a stale dir of another version.
    fs.truncateSync(path.join(path.dirname(remote), dir, 'chunk_0002'), 1000)
    fs.mkdirSync(`${remote}.chunks-0000000000000000`)

    unflag('refused')
    unflag('refuse-after')
    clearLog()
    await expect(connection().uploadFile(remote, DATA, { sha256: sha })).resolves.toEqual({ skipped: false })
    expect(chunksOk()).toEqual(['chunk_0002', ...range(6, 12)])
    expect(fs.readFileSync(remote).equals(DATA)).toBe(true)
    expect(chunkDirs()).toEqual([])
  })

  it('a joined file that is not the data is removed, and the next upload starts over', async () => {
    flag('max-bytes', '1000000')
    flag('refuse-after', 'chunk_0011')
    await expect(connection().uploadFile(remote, DATA)).rejects.toThrow()
    const [dir] = chunkDirs()
    // Right size, wrong bytes: only the sha can tell.
    const bad = path.join(path.dirname(remote), dir, 'chunk_0004')
    const bytes = fs.readFileSync(bad)
    bytes[0] ^= 0xff
    fs.writeFileSync(bad, bytes)
    unflag('refused')
    unflag('refuse-after')
    // Every chunk is on the host (the join was refused last time), so this attempt sends none and joins.
    await expect(connection().uploadFile(remote, DATA)).rejects.toThrow(/sha256 mismatch/)
    expect(fs.existsSync(remote)).toBe(false)
    expect(chunkDirs()).toEqual([])

    clearLog()
    await expect(connection().uploadFile(remote, DATA)).resolves.toEqual({ skipped: false })
    expect(chunksOk()).toEqual(range(0, 12))
    expect(fs.readFileSync(remote).equals(DATA)).toBe(true)
  })

  it.skipIf(!onMachine('shasum'))('a host with only `shasum -a 256` takes the one stream and the skip', async () => {
    hide('sha256sum')
    await expect(connection().uploadFile(remote, DATA)).resolves.toEqual({ skipped: false })
    expect(readLog()).toEqual(['exec ok', 'stream ok'])
    clearLog()
    await expect(connection().uploadFile(remote, DATA)).resolves.toEqual({ skipped: true })
    expect(fs.readFileSync(remote).equals(DATA)).toBe(true)
  })

  it('a host with neither sha tool still gets the file, checked by size', async () => {
    hide('sha256sum')
    hide('shasum')
    // The one stream cannot be verified without a sha, so the chunks carry it.
    await expect(connection().uploadFile(remote, DATA)).resolves.toEqual({ skipped: false })
    expect(readLog()).toContain('stream ok')
    expect(chunksOk()).toEqual(range(0, 12))
    expect(fs.readFileSync(remote).equals(DATA)).toBe(true)
  })
})
