/**
 * Whether a host replica's search leaves something out (src/replica/search-kept.ts): only
 * what the user chose (a folder or a note left out, notes, memory or skills off). A note over
 * the size cap is in the search copy, so a copy that leaves out only such a note answers its
 * searches whole. The copy is the REAL host-replica core, read through the replica's reader.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _resetServerRoleForTesting } from '../../src/core/server-role.js'
import { createHostReplica } from '../../src/providers/host-replica-core.js'
import { createCopyNotesSource, installReplicaNotesSource, notesCopyReaderOver } from '../../src/replica/notes-source.js'
import { searchLeavesOut } from '../../src/replica/search-kept.js'

const HOME = '/fixture/marina-home'
const sha12 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)
const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
let dir = ''
let replica: ReturnType<typeof createHostReplica>

function push(opts: { keepExclude?: string[]; tooBig?: string[] } = {}): void {
  const all: Record<string, string> = { 'Projects/Plan.md': '# Plan\n', 'Garden/Lantern.md': '# Lantern\n' }
  // The Mac never sends what it leaves out.
  const notes = Object.fromEntries(Object.entries(all).filter(([k]) => !(opts.keepExclude ?? []).some((e) => k.toLowerCase().startsWith(e.toLowerCase()))))
  const entries = Object.entries(notes).map(([k, body]) => ({ k, h: sha12(body), n: body.length }))
  const { need } = replica.sync(HOME, 'notes', entries, Date.now(), opts)
  replica.put(HOME, 'notes', need.map((k) => ({ k, body: notes[k]! })))
}

beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k]
  Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  _resetServerRoleForTesting()
})
afterAll(() => {
  installReplicaNotesSource(null)
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
})
beforeEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsk-'))
  replica = createHostReplica({ fs, path, dir, now: () => Date.now(), keyOf: sha12, hash: sha12, log: () => {} })
  const ask = async (cmd: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (cmd === 'replica.list') return { ok: true, ...(replica.list(HOME, String(params.kind)) ?? {}) }
    return { ok: true, ...(replica.readMany(HOME, String(params.kind), params.keys, 4 * 1024 * 1024) ?? {}) }
  }
  installReplicaNotesSource(createCopyNotesSource(notesCopyReaderOver(ask), { listTtlMs: 0 }))
})

describe('searchLeavesOut on a host replica', () => {
  it('a copy that keeps everything: false', async () => {
    push()
    expect(await searchLeavesOut()).toBe(false)
  })

  it('only a note over the size cap left out: false (the search copy keeps it)', async () => {
    push({ tooBig: ['Archive/huge.md'] })
    expect(await searchLeavesOut()).toBe(false)
  })

  it('a folder or a note the user left out, notes off, or memory off: true', async () => {
    push({ keepExclude: ['Garden'] })
    expect(await searchLeavesOut()).toBe(true)
    push({ keepExclude: ['projects/plan'], tooBig: ['Archive/huge.md'] })
    expect(await searchLeavesOut()).toBe(true)
    push()
    replica.drop(HOME, 'memory')
    expect(await searchLeavesOut()).toBe(true)
    replica.drop(HOME, 'notes')
    expect(await searchLeavesOut()).toBe(true)
  })

  it('a copy that cannot be read: false (the search answers what it has)', async () => {
    installReplicaNotesSource(createCopyNotesSource(notesCopyReaderOver(async () => { throw new Error('daemon gone') }), { listTtlMs: 0 }))
    expect(await searchLeavesOut()).toBe(false)
  })

  it('off a replica: false', async () => {
    push({ keepExclude: ['Garden'] })
    delete process.env.WALNUT_ROLE
    _resetServerRoleForTesting()
    try { expect(await searchLeavesOut()).toBe(false) } finally { process.env.WALNUT_ROLE = 'replica'; _resetServerRoleForTesting() }
  })
})
