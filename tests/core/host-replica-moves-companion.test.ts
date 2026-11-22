/**
 * The cloud companion's copy takes moves when its build says so: its `replica.status` reply
 * names HOST_REPLICA_MOVES in `features` (core/companion-host-replica.ts), the Mac's round
 * (syncCompanionHostReplica) reads it and sends `renamed`. A box whose reply names no such
 * feature (an older build) gets no `renamed` and takes the move in two steps its own half rule
 * judges (manifest-moves.ts bridgeEntries). The real
 * companion command handler and copy core; only the HTTPS hop is in-process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-replica-moves-companion'))
vi.mock('../../src/core/skill-store.js', () => ({ listAllSkills: async () => [] }))
vi.mock('../../src/core/config-manager.js', () => ({ getConfig: async () => ({}) }))
vi.mock('../../src/core/server-role.js', async (orig) => ({ ...(await orig<typeof import('../../src/core/server-role.js')>()), followerKind: () => 'companion' }))

/** The box answers as an older build would: no `features` in its status. */
let olderBox = false
const sent: Array<{ cmd: string; params: Record<string, unknown> }> = []
vi.mock('../../src/core/cloud-ingest.js', () => ({
  cloudHostReplicaAvailable: async () => true,
  postToCloudHostReplica: async (cmd: string, params: Record<string, unknown> = {}) => {
    sent.push({ cmd, params })
    if (cmd.startsWith('attachments.')) return { ok: false, error: 'not here', errorKind: 'unsupported' }
    const { companionHostReplicaCommand } = await import('../../src/core/companion-host-replica.js')
    // JSON both ways, as over HTTPS.
    const reply = companionHostReplicaCommand(cmd, JSON.parse(JSON.stringify(params))) as Record<string, unknown>
    if (olderBox && cmd === 'replica.status') delete reply.features
    return JSON.parse(JSON.stringify(reply))
  },
}))

import { NOTES_DIR, MEMORY_FILE, WALNUT_HOME } from '../../src/constants.js'
import { syncCompanionHostReplica, forgetCompanionHostReplica, _resetHostReplicaForTesting, _hostReplicaSavedForTesting } from '../../src/core/host-replica.js'
import { COMPANION_REPLICA_HOME, companionHostReplica, companionHostReplicaDir, _resetCompanionHostReplicaForTesting } from '../../src/core/companion-host-replica.js'
import { HOST_REPLICA_MOVES } from '../../src/core/replication/manifest-moves.js'
import { setNoteMoves } from '../../src/core/notes/note-path-moves.js'

const COUNT = 220
const write = (rel: string, body: string): void => {
  const abs = path.join(NOTES_DIR, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}
const notesSyncs = () => sent.filter((c) => c.cmd === 'replica.sync' && c.params.kind === 'notes').map((c) => c.params)

function moveIntoTree(): void {
  const pairs: Array<[string, string]> = []
  for (const name of fs.readdirSync(path.join(NOTES_DIR, 'acme'))) pairs.push([`acme/${name}`, `projects/Acme/notes/${name}`])
  fs.mkdirSync(path.join(NOTES_DIR, 'projects/Acme'), { recursive: true })
  fs.renameSync(path.join(NOTES_DIR, 'acme'), path.join(NOTES_DIR, 'projects/Acme/notes'))
  setNoteMoves({ exact: {}, rules: [{ from: 'acme/', to: 'projects/Acme/notes/' }, { from: '', to: 'notes/' }] }, pairs)
}

beforeEach(async () => {
  await _hostReplicaSavedForTesting()
  fs.rmSync(NOTES_DIR, { recursive: true, force: true })
  fs.rmSync(companionHostReplicaDir(), { recursive: true, force: true })
  fs.rmSync(path.join(WALNUT_HOME, 'cache', 'host-replica'), { recursive: true, force: true })
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true })
  fs.writeFileSync(MEMORY_FILE, '# Memory\n')
  for (let i = 0; i < COUNT; i++) write(`acme/day-${String(i).padStart(3, '0')}.md`, `# Day ${i}\nShipped build ${i}.`)
  sent.length = 0
  olderBox = false
  setNoteMoves(null)
  _resetHostReplicaForTesting()
  _resetCompanionHostReplicaForTesting()
  forgetCompanionHostReplica()
})
afterEach(() => { setNoteMoves(null) })

describe('the companion as a target of moves', () => {
  it('says it takes moves in its status, and the Mac\'s round sends them: the move is taken, no body again', async () => {
    expect((await syncCompanionHostReplica())[0]).toMatchObject({ kind: 'notes', action: 'synced', entries: COUNT })
    expect(sent.find((c) => c.cmd === 'replica.status')).toBeTruthy()
    sent.length = 0
    moveIntoTree()
    const [notes] = await syncCompanionHostReplica()
    // The status reply of this round named the feature.
    expect(notes).toMatchObject({ kind: 'notes', action: 'synced', sent: 0, moved: COUNT })
    expect((notesSyncs()[0].renamed as unknown[]).length).toBe(COUNT)
    expect(sent.filter((c) => c.cmd === 'replica.put' && c.params.kind === 'notes')).toEqual([])
    expect(companionHostReplica()!.read(COMPANION_REPLICA_HOME, 'notes', 'projects/Acme/notes/day-017.md')?.body).toBe('# Day 17\nShipped build 17.')
  })

  it('names the feature by the shared constant', async () => {
    const { companionHostReplicaCommand } = await import('../../src/core/companion-host-replica.js')
    expect(companionHostReplicaCommand('replica.status', {})).toMatchObject({ ok: true, features: [HOST_REPLICA_MOVES] })
  })

  it('a box of an older build (no features) gets no renamed and takes the move in two steps (2026-11-20)', async () => {
    // The real companion was held on a build from before moves and refused the one tree's move
    // every round from 2026-11-20 11:41Z: its copy of the notes stood still at the old paths.
    olderBox = true
    await syncCompanionHostReplica()
    sent.length = 0
    moveIntoTree()
    const [notes] = await syncCompanionHostReplica()
    expect(notes).toMatchObject({ kind: 'notes', action: 'synced', entries: COUNT, sent: COUNT })
    expect(notesSyncs().every((p) => p.renamed === undefined)).toBe(true)
    expect(notesSyncs().slice(-2).map((p) => (p.entries as unknown[]).length)).toEqual([2 * COUNT, COUNT])
    expect(companionHostReplica()!.read(COMPANION_REPLICA_HOME, 'notes', 'projects/Acme/notes/day-017.md')?.body).toBe('# Day 17\nShipped build 17.')
    expect(companionHostReplica()!.read(COMPANION_REPLICA_HOME, 'notes', 'acme/day-017.md')).toBeNull()
    // Taken: the next round has nothing to say.
    sent.length = 0
    expect((await syncCompanionHostReplica())[0]).toMatchObject({ kind: 'notes', action: 'unchanged' })
  })
})
