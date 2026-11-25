/**
 * The over-ceiling dead-set memo outlives a server restart (src/core/history-dead-set-memo.ts).
 *
 * 2026-11-25: a 154 MB rewound local transcript (past the reader's 32 MB ceiling) took 3.0 s on
 * its first history read after every restart (about 70 a day), because the memo of the host
 * daemon's dead set lived only in memory and the probe streams the whole file. Pinned, on the
 * real readSessionHistory path with the probe stubbed and counted:
 *  - after a flush and a restart, the same read asks the host nothing;
 *  - other cuts, another mtime or another size miss (the key holds all three);
 *  - a drop (invalidateSessionHistoryCaches) removes the disk copy too;
 *  - a corrupt or other-version file reads as empty;
 *  - a read racing the boot's readback waits for it; an entry set meanwhile wins;
 *  - the file keeps the 32-entry LRU and stays under its byte cap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'
import { transcript, cutHere, type TranscriptFixture } from '../helpers/transcript-fixtures.js'
import type { InPlaceRewindCut } from '../../src/core/types.js'

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

let mockRecord: { inPlaceRewinds?: InPlaceRewindCut[] } | undefined
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: vi.fn(async () => mockRecord),
}))
const { probeMock } = vi.hoisted(() => ({ probeMock: vi.fn() }))
vi.mock('../../src/core/sessions/session-rewind.js', () => ({
  probeRewindViaDaemon: (...args: unknown[]) => probeMock(...args),
}))

import { CLAUDE_HOME } from '../../src/constants.js'
import { encodeProjectPath, readSessionHistory, invalidateSessionHistoryCaches, _resetHistoryCacheForTesting } from '../../src/core/session-history.js'
import {
  startDeadSetDisk, flushDeadSetDisk, _stopDeadSetDiskForTesting, getDeadSet, setDeadSet, deadSetKey,
  MAX_DEAD_SET_FILE_BYTES, type DisplayDeadSet,
} from '../../src/core/history-dead-set-memo.js'

const tmpBase = CLAUDE_HOME as string
const CWD = '/proj/dead-set-restart'
const prevReadLimit = process.env.WALNUT_MAX_FILE_READ_BYTES
let dir = ''
let file = ''

const deadSet: DisplayDeadSet = { deadUuids: ['a2', 'u3'], queueDeadKeys: [], skippedCuts: [], truncated: false }

function rewound(): { t: TranscriptFixture; cut: InPlaceRewindCut } {
  let t = transcript().user('u1', 'first ask').assistant('a1', 'first reply')
  for (let i = 0; i < 60; i++) t = t.user(`p${i}`, `padding ${i} ${'x'.repeat(200)}`)
  t = t.user('u2', 'add a feature').assistant('a2', 'ABANDONED reply two').user('u3', 'ABANDONED third ask')
  return { t, cut: cutHere(t, 'u2') }
}

const jsonlOf = (sid: string) => path.join(tmpBase, 'projects', encodeProjectPath(CWD), `${sid}.jsonl`)
async function write(sid: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(jsonlOf(sid)), { recursive: true })
  await fsp.writeFile(jsonlOf(sid), text)
}
const read = (sid: string) => readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true })
const abandonedShown = (msgs: Array<{ text: string }>) => msgs.some((m) => m.text.includes('ABANDONED'))

/** A new server process: nothing in memory, the kept file read back at boot. */
async function restart(): Promise<void> {
  await flushDeadSetDisk()
  _stopDeadSetDiskForTesting()
  _resetHistoryCacheForTesting()
  await startDeadSetDisk(file)
}

/** One over-ceiling read of a rewound session, then a restart. */
async function seed(sid: string): Promise<{ t: TranscriptFixture; cut: InPlaceRewindCut }> {
  const r = rewound()
  await write(sid, r.t.text())
  mockRecord = { inPlaceRewinds: [r.cut] }
  expect(abandonedShown(await read(sid))).toBe(false)
  expect(probeMock).toHaveBeenCalledTimes(1)
  await restart()
  return r
}

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true })
  await fsp.mkdir(tmpBase, { recursive: true })
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-dead-sets-'))
  file = path.join(dir, 'history-dead-sets.json')
  _stopDeadSetDiskForTesting()
  _resetHistoryCacheForTesting()
  await startDeadSetDisk(file)
  mockRecord = undefined
  probeMock.mockReset()
  probeMock.mockResolvedValue(deadSet)
  process.env.WALNUT_MAX_FILE_READ_BYTES = '8192'
})
afterEach(async () => {
  _stopDeadSetDiskForTesting()
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(dir, { recursive: true, force: true })
  if (prevReadLimit === undefined) delete process.env.WALNUT_MAX_FILE_READ_BYTES
  else process.env.WALNUT_MAX_FILE_READ_BYTES = prevReadLimit
})

describe('the over-ceiling dead set after a restart', () => {
  it('is read back: the first read after a restart asks the host nothing', async () => {
    await seed('s-restart')
    // Old code: the memo lived only in memory, so this read probed the whole file again.
    expect(abandonedShown(await read('s-restart'))).toBe(false)
    expect(probeMock).toHaveBeenCalledTimes(1)
    // And again after a second restart (the readback is written back out as it was).
    await restart()
    await read('s-restart')
    expect(probeMock).toHaveBeenCalledTimes(1)
  })

  it('other cuts miss, whichever process recorded them', async () => {
    const { cut } = await seed('s-cuts')
    // Same file, a cut recorded while this process was not running.
    mockRecord = { inPlaceRewinds: [cut, { ...cut, uuid: 'p3', at: '2026-08-30T00:01:00.000Z' }] }
    await read('s-cuts')
    expect(probeMock).toHaveBeenCalledTimes(2)
    // A field the probe reads (its trailing queue keys) changed alone: a miss too.
    mockRecord = { inPlaceRewinds: [{ ...cut, trailingQueueKeys: ['k1'] }] }
    await read('s-cuts')
    expect(probeMock).toHaveBeenCalledTimes(3)
    // The commit time is for humans only: not part of the key.
    mockRecord = { inPlaceRewinds: [{ ...cut, at: '2026-09-01T00:00:00.000Z' }] }
    await read('s-cuts')
    expect(probeMock).toHaveBeenCalledTimes(3)
  })

  it('another mtime or another size misses', async () => {
    const { t } = await seed('s-stat')
    const later = new Date(Date.now() + 60_000)
    await fsp.utimes(jsonlOf('s-stat'), later, later)
    await read('s-stat')
    expect(probeMock).toHaveBeenCalledTimes(2)
    await write('s-stat', t.user('u9', 'a new ask').text())
    await read('s-stat')
    expect(probeMock).toHaveBeenCalledTimes(3)
  })

  it('a drop removes the disk copy too', async () => {
    await seed('s-drop')
    await invalidateSessionHistoryCaches('s-drop')
    await restart()
    // Same cuts and bytes: only the drop can make this miss.
    await read('s-drop')
    expect(probeMock).toHaveBeenCalledTimes(2)
  })

  it('a corrupt or other-version file reads as empty', async () => {
    await seed('s-bad')
    const good = await fsp.readFile(file, 'utf8')
    expect(good).toContain('s-bad|')
    const bodies = [good.slice(0, Math.floor(good.length / 2)), good.replace('"v":1', '"v":2'), '[]', '']
    for (const [i, body] of bodies.entries()) {
      _stopDeadSetDiskForTesting()
      _resetHistoryCacheForTesting()
      await fsp.writeFile(file, body)
      await startDeadSetDisk(file)
      await read('s-bad')
      expect(probeMock).toHaveBeenCalledTimes(2 + i)
    }
  })

  it('a read racing the readback waits for it, and an entry set meanwhile wins', async () => {
    const a = deadSetKey('s-a', undefined, 1, 2, [])
    const b = deadSetKey('s-b', undefined, 1, 2, [])
    setDeadSet(a, deadSet)
    setDeadSet(b, deadSet)
    await flushDeadSetDisk()
    _stopDeadSetDiskForTesting()
    const booting = startDeadSetDisk(file)
    const newer: DisplayDeadSet = { ...deadSet, deadUuids: ['newer'] }
    setDeadSet(b, newer)
    expect(await getDeadSet(a)).toEqual(deadSet)
    expect(await getDeadSet(b)).toEqual(newer)
    await booting
  })

  it('a readback never grows the memo past its 32 entries', async () => {
    const key = (tag: string, i: number) => deadSetKey(`s-${tag}${i}`, undefined, 1, 2, [])
    for (let i = 0; i < 32; i++) setDeadSet(key('old', i), deadSet)
    await flushDeadSetDisk()
    _stopDeadSetDiskForTesting()
    const booting = startDeadSetDisk(file)
    for (let i = 0; i < 32; i++) setDeadSet(key('new', i), deadSet)
    await booting
    // Set since the boot: newer than every kept one, so the memo is full without them.
    expect(await getDeadSet(key('old', 31))).toBeUndefined()
    expect(await getDeadSet(key('new', 0))).toEqual(deadSet)
  })

  it('keeps the 32 most recent entries and stays under its byte cap', async () => {
    for (let i = 0; i < 40; i++) setDeadSet(deadSetKey(`s-${i}`, undefined, 1, 2, []), deadSet)
    // One answer bigger than the whole file may be: kept in memory, never written.
    const big: DisplayDeadSet = { ...deadSet, deadUuids: Array.from({ length: 130_000 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`) }
    const bigKey = deadSetKey('s-big', undefined, 1, 2, [])
    setDeadSet(bigKey, big)
    await flushDeadSetDisk()
    expect((await fsp.stat(file)).size).toBeLessThanOrEqual(MAX_DEAD_SET_FILE_BYTES)
    _stopDeadSetDiskForTesting()
    await startDeadSetDisk(file)
    expect(await getDeadSet(bigKey)).toBeUndefined()
    // Memory held s-9 .. s-39 and s-big (32): every small one was written, nothing older.
    expect(await getDeadSet(deadSetKey('s-9', undefined, 1, 2, []))).toEqual(deadSet)
    expect(await getDeadSet(deadSetKey('s-39', undefined, 1, 2, []))).toEqual(deadSet)
    expect(await getDeadSet(deadSetKey('s-8', undefined, 1, 2, []))).toBeUndefined()
  })
})
