/**
 * fs.writePart (staged, resumable chunk writes) and transfer.reach / fetch
 * (ssh and scp from the receiving host) in transfer-core.ts.
 *
 * MACHINE SAFETY: files live in one temp dir; `ssh` and `scp` are fake scripts
 * first on PATH that log their argv and copy local files, so no test makes a real
 * SSH connection.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTransferCore, type TransferCoreDeps } from '../../src/providers/transfer-core.js'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-transfer-core-')))
afterAll(() => { if (tmp.includes('walnut-transfer-core-')) fs.rmSync(tmp, { recursive: true, force: true }) })
const home = path.join(tmp, 'home')
const bin = path.join(tmp, 'bin')
const argvLog = path.join(tmp, 'argv.log')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(bin, { recursive: true })
// Fake ssh: `down` refuses, `slow` hangs, anything else answers.
fs.writeFileSync(path.join(bin, 'ssh'), [
  '#!/bin/sh',
  'printf "ssh" >> "$ARGV_LOG"; for a in "$@"; do printf " [%s]" "$a" >> "$ARGV_LOG"; done; echo >> "$ARGV_LOG"',
  'for a in "$@"; do last2="$last1"; last1="$a"; done',
  'case "$last2" in *down*) echo "debug noise" >&2; echo "ssh: connect to host down port 22: Connection refused" >&2; exit 255;; esac',
  'case "$last2" in *slow*) sleep 8;; esac',
  'exit 0',
].join('\n'), { mode: 0o755 })
// Fake scp: copies `host:path` (prefix stripped, ~ expanded) to the last argument.
fs.writeFileSync(path.join(bin, 'scp'), [
  '#!/bin/sh',
  'printf "scp" >> "$ARGV_LOG"; for a in "$@"; do printf " [%s]" "$a" >> "$ARGV_LOG"; done; echo >> "$ARGV_LOG"',
  'for a in "$@"; do src="$dst"; dst="$a"; done',
  'p="${src#*:}"',
  'case "$p" in "~/"*) p="$HOME/${p#\\~/}";; esac',
  'if [ ! -f "$p" ]; then echo "scp: $p: No such file or directory" >&2; exit 1; fi',
  'cp "$p" "$dst"',
].join('\n'), { mode: 0o755 })

const env = { PATH: bin + ':/usr/bin:/bin', HOME: home, ARGV_LOG: argvLog }
const core = createTransferCore({ fs, path, crypto, spawn: spawn as unknown as TransferCoreDeps['spawn'], env, home })
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const b64 = (b: Buffer) => b.toString('base64')
const argv = () => (fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean) : [])
beforeEach(() => { fs.rmSync(argvLog, { force: true }) })

describe('fs.writePart', () => {
  const MB = 1024 * 1024
  const body = crypto.randomBytes(2 * MB + 12_345)
  const chunks = [body.subarray(0, MB), body.subarray(MB, 2 * MB), body.subarray(2 * MB)]

  it('chunks land as the source file; retries are no-ops; a final retry after the rename is done', async () => {
    const target = path.join(tmp, 'w1', 'deep', 'file.bin')
    const r0 = await core.writePart({ path: target, offset: 0, data: b64(chunks[0]) })
    expect(r0).toEqual({ staged: MB })
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.statSync(target + '.walnut-part').size).toBe(MB)
    await core.writePart({ path: target, offset: MB, data: b64(chunks[1]) })
    // The reply to chunk 1 was lost: the same chunk again writes nothing.
    const again = await core.writePart({ path: target, offset: MB, data: b64(chunks[1]) })
    expect(again).toEqual({ staged: 2 * MB })
    expect(fs.statSync(target + '.walnut-part').size).toBe(2 * MB)
    const fin = { path: target, offset: 2 * MB, data: b64(chunks[2]), final: true, size: body.length, sha256: sha(body) }
    expect(await core.writePart(fin)).toEqual({ staged: body.length, done: true, sha256: sha(body) })
    expect(fs.readFileSync(target).equals(body)).toBe(true)
    expect(fs.existsSync(target + '.walnut-part')).toBe(false)
    expect(await core.writePart(fin)).toEqual({ staged: body.length, done: true, sha256: sha(body) })
  })

  it('a part past the staged end answers gap with have', async () => {
    const target = path.join(tmp, 'w2', 'f.bin')
    await core.writePart({ path: target, offset: 0, data: b64(chunks[0]) })
    await expect(core.writePart({ path: target, offset: 2 * MB, data: b64(chunks[2]) })).rejects.toMatchObject({ code: 'gap', data: { have: MB } })
    // Nothing staged at all (the receiver restarted and lost it): have 0.
    await expect(core.writePart({ path: path.join(tmp, 'w2', 'other.bin'), offset: MB, data: b64(chunks[1]) })).rejects.toMatchObject({ code: 'gap', data: { have: 0 } })
  })

  it('offset 0 starts over; a part over a torn tail replaces it', async () => {
    const target = path.join(tmp, 'w3', 'f.txt')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target + '.walnut-part', 'stale bytes from an older transfer')
    await core.writePart({ path: target, offset: 0, data: b64(Buffer.from('abc')) })
    fs.appendFileSync(target + '.walnut-part', 'de') // a torn write of the next part
    await core.writePart({ path: target, offset: 3, data: b64(Buffer.from('DEF')) })
    expect(await core.writePart({ path: target, offset: 6, data: b64(Buffer.from('g')), final: true })).toMatchObject({ staged: 7, done: true })
    expect(fs.readFileSync(target, 'utf8')).toBe('abcDEFg')
  })

  it('a checksum or size mismatch leaves no target file and keeps the staging', async () => {
    const target = path.join(tmp, 'w4', 'f.bin')
    await expect(core.writePart({ path: target, offset: 0, data: b64(chunks[0]), final: true, sha256: 'a'.repeat(64) }))
      .rejects.toMatchObject({ code: 'checksum_mismatch', data: { have: MB, sha256: sha(chunks[0]) } })
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.statSync(target + '.walnut-part').size).toBe(MB)
    const t2 = path.join(tmp, 'w4', 'g.bin')
    await core.writePart({ path: t2, offset: 0, data: b64(chunks[0]) })
    await expect(core.writePart({ path: t2, offset: MB, data: '', final: true, size: MB + 1 }))
      .rejects.toMatchObject({ code: 'size_mismatch', data: { have: MB, expected: MB + 1 } })
    expect(fs.existsSync(t2)).toBe(false)
  })

  it('an empty file, ~ paths, and two parts sent at once', async () => {
    expect(await core.writePart({ path: '~/empty.txt', offset: 0, data: '', final: true, size: 0 })).toMatchObject({ staged: 0, done: true })
    expect(fs.statSync(path.join(home, 'empty.txt')).size).toBe(0)
    const target = path.join(tmp, 'w5', 'f.bin')
    const [a, b] = await Promise.all([
      core.writePart({ path: target, offset: 0, data: b64(chunks[0]) }),
      core.writePart({ path: target, offset: MB, data: b64(chunks[1]), final: true }),
    ])
    expect(a).toEqual({ staged: MB })
    expect(b).toMatchObject({ staged: 2 * MB, done: true })
  })

  it('refuses bad input', async () => {
    const t = path.join(tmp, 'w6', 'f')
    await expect(core.writePart({ path: 'rel/f', offset: 0, data: '' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(core.writePart({ path: t + '\u0000x', offset: 0, data: '' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(core.writePart({ path: t, offset: -1, data: '' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(core.writePart({ path: t, offset: 1.5, data: '' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(core.writePart({ path: t, offset: 0, data: 'not base64!' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(core.writePart({ path: t, offset: 0, data: b64(Buffer.alloc(4 * MB + 1)) })).rejects.toMatchObject({ code: 'too_large' })
    await expect(core.writePart({ path: t, offset: 0, data: '', sha256: 'xyz' })).rejects.toMatchObject({ code: 'bad_request' })
  })
})

describe('transfer.reach', () => {
  it('runs ssh in batch mode with a fixed argv', async () => {
    const r = await core.reach({ host: 'host-a.example', user: 'dev', port: 2222 })
    expect(r.reachable).toBe(true)
    expect(r.error).toBeUndefined()
    expect(argv()).toEqual(['ssh [-o] [BatchMode=yes] [-o] [ConnectTimeout=5] [-o] [StrictHostKeyChecking=yes] [-o] [UpdateHostKeys=no] [-o] [ForwardAgent=no] [-o] [ClearAllForwardings=yes] [-p] [2222] [--] [dev@host-a.example] [true]'])
  })

  it('reports the last stderr line when ssh fails, and a timeout when it hangs', async () => {
    const down = await core.reach({ host: 'down' })
    expect(down).toMatchObject({ reachable: false, error: 'ssh: connect to host down port 22: Connection refused' })
    const started = Date.now()
    const slow = await core.reach({ host: 'slow', timeoutMs: 600 })
    expect(slow.reachable).toBe(false)
    expect(slow.error).toMatch(/timed out/)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('rejects host, user and port values that are not plain', async () => {
    for (const bad of [
      { host: 'a;rm -rf ~' }, { host: '-oProxyCommand=evil' }, { host: '-v' }, { host: 'a b' }, { host: '' },
      { host: 'a$(id)' }, { host: 'x', user: 'u@v' }, { host: 'u@x', user: 'u' }, { host: 'x', user: '-l' },
      { host: 'x', port: 70000 }, { host: 'x', port: '22' }, { host: 'x', port: 2.5 },
    ]) {
      await expect(core.reach(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'bad_request' })
    }
    expect(argv()).toEqual([])
  })
})

describe('transfer.fetch', () => {
  const remoteDir = path.join(home, 'outbox')
  const a = crypto.randomBytes(5000)
  const b = Buffer.from('second file\n')
  fs.mkdirSync(remoteDir, { recursive: true })
  fs.writeFileSync(path.join(remoteDir, 'a.bin'), a)
  fs.writeFileSync(path.join(remoteDir, 'b.txt'), b)

  it('pulls each file with scp and verifies it before the rename', async () => {
    const dest = path.join(tmp, 'f1', 'in')
    const r = await core.fetch({
      host: 'host-a', port: 2200,
      files: [
        { remotePath: path.join(remoteDir, 'a.bin'), localPath: path.join(dest, 'a.bin'), size: a.length, sha256: sha(a) },
        { remotePath: '~/outbox/b.txt', localPath: path.join(dest, 'sub', 'b.txt'), sha256: sha(b).toUpperCase() },
      ],
    })
    expect(r).toEqual({ ok: true, results: [
      { localPath: path.join(dest, 'a.bin'), ok: true, size: a.length, sha256: sha(a) },
      { localPath: path.join(dest, 'sub', 'b.txt'), ok: true, size: b.length, sha256: sha(b) },
    ] })
    expect(fs.readFileSync(path.join(dest, 'a.bin')).equals(a)).toBe(true)
    const lines = argv()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(new RegExp('^scp \\[-B\\] \\[-q\\] \\[-o\\] \\[BatchMode=yes\\] \\[-o\\] \\[ConnectTimeout=5\\] \\[-o\\] \\[StrictHostKeyChecking=yes\\] \\[-o\\] \\[UpdateHostKeys=no\\] \\[-o\\] \\[ForwardAgent=no\\] \\[-P\\] \\[2200\\] \\[--\\] \\[host-a:' + remoteDir.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '/a\\.bin\\] \\[' + dest.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '/a\\.bin\\.walnut-fetch-[0-9a-f]+\\]$'))
    expect(lines[1]).toContain('[host-a:~/outbox/b.txt]')
    expect(fs.readdirSync(dest).filter((f) => f.includes('walnut-fetch'))).toEqual([])
  })

  it('a sha256 or size mismatch, or a missing remote file, lands nothing', async () => {
    const dest = path.join(tmp, 'f2')
    const r = await core.fetch({
      host: 'host-a',
      files: [
        { remotePath: path.join(remoteDir, 'a.bin'), localPath: path.join(dest, 'a.bin'), sha256: 'b'.repeat(64) },
        { remotePath: path.join(remoteDir, 'b.txt'), localPath: path.join(dest, 'b.txt'), size: 1 },
        { remotePath: path.join(remoteDir, 'missing.txt'), localPath: path.join(dest, 'c.txt') },
        { remotePath: path.join(remoteDir, 'b.txt'), localPath: path.join(dest, 'ok.txt') },
      ],
    })
    expect(r.ok).toBe(false)
    expect(r.results.map((x) => x.ok)).toEqual([false, false, false, true])
    expect(r.results[0].error).toMatch(/^sha256 /)
    expect(r.results[1].error).toMatch(/^size /)
    expect(r.results[2].error).toMatch(/No such file/)
    expect(fs.readdirSync(dest).sort()).toEqual(['ok.txt'])
  })

  it('rejects bad hosts and paths before running anything', async () => {
    const ok = { remotePath: '/x/a', localPath: path.join(tmp, 'f3', 'a') }
    for (const bad of [
      { host: 'a|b', files: [ok] },
      { host: 'a', files: [] },
      { host: 'a', files: [{ ...ok, remotePath: 'relative/a' }] },
      { host: 'a', files: [{ ...ok, remotePath: '/x/a b' }] },
      { host: 'a', files: [{ ...ok, remotePath: '/x/$(id)' }] },
      { host: 'a', files: [{ ...ok, remotePath: '/x/../etc/passwd' }] },
      { host: 'a', files: [{ ...ok, localPath: 'relative' }] },
      { host: 'a', files: [{ ...ok, localPath: '/x\u0000y' }] },
      { host: 'a', files: [{ ...ok, sha256: 'nothex' }] },
    ]) {
      await expect(core.fetch(bad as Record<string, unknown>), JSON.stringify(bad)).rejects.toMatchObject({ code: 'bad_request' })
    }
    expect(argv()).toEqual([])
  })
})

describe('transfer.realpath', () => {
  it('names a directory through its symlinks, expands ~, and refuses a missing one with not_found', async () => {
    const real = path.join(tmp, 'real-dir')
    const link = path.join(tmp, 'link-dir')
    fs.mkdirSync(real, { recursive: true })
    fs.rmSync(link, { force: true })
    fs.symlinkSync(real, link)
    expect(await core.realpath({ path: link })).toEqual({ path: real })
    fs.mkdirSync(path.join(home, 'w'), { recursive: true })
    expect(await core.realpath({ path: '~/w' })).toEqual({ path: path.join(home, 'w') })
    await expect(core.realpath({ path: path.join(tmp, 'nope') })).rejects.toMatchObject({ code: 'not_found' })
    await expect(core.realpath({ path: 'relative' })).rejects.toMatchObject({ code: 'bad_request' })
  })
})
