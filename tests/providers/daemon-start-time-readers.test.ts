/**
 * Start-time readers behind the daemon's pid-identity checks.
 *
 * Incident 2026-09-28: the orphan poll read every adopted CLI's start time with
 * a synchronous `ps` once per second. With 15 orphans after a deploy and ~1s
 * per spawn under load, the daemon's event loop was blocked nearly all the
 * time: hello took 10s+, the server gave up on it, and every local session's
 * history fell back to a cached or empty view. The poll now uses the batched
 * async reader below; boot reconcile uses the batched sync one.
 */

import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { execFile, execSync } from 'node:child_process'

// execSync is watched (and still runs for real): the single-pid reader's ps path.
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return { ...real, execSync: vi.fn(real.execSync) }
})
import {
  parsePsStartTimes,
  createAsyncStartTimeReader,
  defaultReadStartTime,
  defaultReadStartTimes,
} from '../../src/providers/daemon-core.js'

/** fs stand-in for a host without /proc (macOS), so the ps path runs everywhere. */
const noProcFs = {
  readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  existsSync: () => false,
} as unknown as typeof fs

describe('parsePsStartTimes', () => {
  it('maps pid to the exact lstart text, keeping internal padding', () => {
    const out = parsePsStartTimes(
      '    1 Thu Sep 24 16:54:00 2026    \n'
      + '51731 Thu May  6 18:59:15 2026    \n'
      + 'ps: garbage line\n\n',
    )
    expect([...out.entries()]).toEqual([
      [1, 'Thu Sep 24 16:54:00 2026'],
      [51731, 'Thu May  6 18:59:15 2026'],
    ])
  })
})

describe('createAsyncStartTimeReader', () => {
  it('answers every request in one batch window with ONE ps call', async () => {
    const calls: string[][] = []
    const read = createAsyncStartTimeReader({
      fs: noProcFs,
      batchWindowMs: 5,
      execFileFn: (_file, args, _opts, cb) => {
        calls.push(args)
        // pid 4003 is gone: ps prints the live ones and exits 1.
        setTimeout(() => cb(new Error('exit 1'), '4001 Mon Sep 28 10:00:00 2026\n4002 Mon Sep 28 10:00:01 2026\n'), 0)
      },
    })
    const answers = await Promise.all([read(4001), read(4002), read(4003), read(4001)])

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['-o', 'pid=,lstart=', '-p', '4001,4002,4003'])
    expect(answers).toEqual([
      'Mon Sep 28 10:00:00 2026', 'Mon Sep 28 10:00:01 2026', null, 'Mon Sep 28 10:00:00 2026',
    ])
  })

  it('never blocks: the caller gets a pending promise while ps runs', async () => {
    let finish: (() => void) | null = null
    const read = createAsyncStartTimeReader({
      fs: noProcFs,
      batchWindowMs: 0,
      execFileFn: (_f, _a, _o, cb) => { finish = () => cb(null, '4100 Mon Sep 28 10:00:00 2026\n') },
    })
    let settled = false
    const pending = read(4100).then((v) => { settled = true; return v })
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    finish!()
    expect(await pending).toBe('Mon Sep 28 10:00:00 2026')
  })

  it('a spawn that throws answers null for the whole batch; bad pids never reach ps', async () => {
    const execFileFn = vi.fn(() => { throw new Error('EAGAIN') })
    const read = createAsyncStartTimeReader({ fs: noProcFs, batchWindowMs: 0, execFileFn })
    expect(await read(1)).toBeNull()
    expect(await read(-5)).toBeNull()
    expect(execFileFn).not.toHaveBeenCalled()
    expect(await read(4200)).toBeNull()
    expect(execFileFn).toHaveBeenCalledTimes(1)
  })
})

describe('real readers agree with the single-pid reader (identity strings must match)', () => {
  it('batched sync and async reads equal defaultReadStartTime for this process', async () => {
    const single = defaultReadStartTime(fs, process.pid)
    expect(single).toBeTruthy()
    expect(defaultReadStartTimes(fs, [process.pid]).get(process.pid)).toBe(single)
    const read = createAsyncStartTimeReader({
      fs,
      execFileFn: (file, args, options, cb) => execFile(file, args, options, (e, stdout) => cb(e, String(stdout ?? ''))),
    })
    expect(await read(process.pid)).toBe(single)
  })
})

describe('a host without ps (a slim container image)', () => {
  // 2026-10-23: on Linux, a pid with no /proc entry fell through to `ps -p`, which a
  // slim image does not have: the daemon's stderr filled with "ps: not found".
  const linuxFs = {
    readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    existsSync: (p: string) => p === '/proc/self/stat',
  } as unknown as typeof fs

  it('a Linux host answers from /proc alone: a pid with no /proc entry is gone, and no ps is asked', () => {
    vi.mocked(execSync).mockClear()
    expect(defaultReadStartTime(linuxFs, 424242)).toBeNull()
    expect(execSync).not.toHaveBeenCalled()
    expect(defaultReadStartTimes(linuxFs, [424242, 424243]).size).toBe(0)
  })

  it('elsewhere ps answers, and its stderr never reaches the daemon\'s', () => {
    vi.mocked(execSync).mockClear()
    defaultReadStartTime(noProcFs, 424242)
    expect(execSync).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(execSync).mock.calls[0]![1] as { stdio?: unknown[] }
    expect(opts.stdio?.[2]).toBe('ignore')
  })
})
