/**
 * A host_exec run never rewrites the grants file by itself (2026-11-24).
 *
 * host-exec-grants.json syncs to every machine. noteRun wrote it on every run, and a loop that
 * polls a host every 20 s kept it changing inside every data-sync pull's window: each pull was
 * deferred for it (46 rewrites in 40 minutes) and nothing synced for hours. Runs are now kept in
 * memory and written with the next change of the file, the flush timer, or shutdown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as grants from '../../../src/core/hosts/exec-grants.js'

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-run-notes-'))
  file = path.join(dir, 'exec-grants.json')
  grants.setExecGrantsFileForTest(file)
})
afterEach(() => {
  vi.useRealTimers()
  grants.setExecGrantsFileForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

const onDisk = (id: string) => (JSON.parse(fs.readFileSync(file, 'utf8')) as { grants: grants.ExecGrant[] }).grants.find((g) => g.id === id)

describe('grant run notes', () => {
  it('many runs leave the file as it was; the list shows them at once; one flush writes them all', async () => {
    const g = await grants.grant('t1', 'boxa', 'letter')
    const before = fs.readFileSync(file, 'utf8')
    for (let i = 0; i < 50; i++) await grants.noteRun(g.id, `echo ${i}`)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(grants.listGrants().find((x) => x.id === g.id)).toMatchObject({ runs: 50, lastCommand: 'echo 49' })
    await grants.flushRunNotes()
    expect(onDisk(g.id)).toMatchObject({ runs: 50, lastCommand: 'echo 49' })
    // Nothing pending: a second flush writes nothing.
    const after = fs.readFileSync(file, 'utf8')
    await grants.flushRunNotes()
    expect(fs.readFileSync(file, 'utf8')).toBe(after)
    expect(grants.listGrants().find((x) => x.id === g.id)?.runs).toBe(50)
  })

  it('the next change of the file carries the runs noted before it', async () => {
    const g = await grants.grant('t1', 'boxa', 'letter')
    await grants.noteRun(g.id, 'ls')
    await grants.noteRun(g.id, 'pwd')
    await grants.grant('t2', 'boxa', 'letter')
    expect(onDisk(g.id)).toMatchObject({ runs: 2, lastCommand: 'pwd' })
    await grants.flushRunNotes()
    expect(onDisk(g.id)?.runs).toBe(2)
  })

  it('the timer writes runs within RUN_NOTE_FLUSH_MS, once for a burst', async () => {
    const g = await grants.grant('t1', 'boxa', 'letter')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await grants.noteRun(g.id, 'a')
    await grants.noteRun(g.id, 'b')
    expect(onDisk(g.id)?.runs).toBe(0)
    await vi.advanceTimersByTimeAsync(grants.RUN_NOTE_FLUSH_MS)
    vi.useRealTimers()
    await vi.waitFor(() => expect(onDisk(g.id)).toMatchObject({ runs: 2, lastCommand: 'b' }))
  })

  it('a revoked grant keeps its runs, and a run on a grant gone from the file is dropped', async () => {
    const g = await grants.grant('t1', 'boxa', 'letter')
    await grants.noteRun(g.id, 'ls')
    await grants.revokeGrant(g.id)
    expect(onDisk(g.id)).toMatchObject({ runs: 1 })
    expect(onDisk(g.id)?.revokedAt).toBeGreaterThan(0)
    await grants.noteRun('xg-not-a-grant', 'ls')
    await grants.flushRunNotes()
    expect(grants.listGrants({ all: true }).map((x) => x.id)).toEqual([g.id])
  })
})
