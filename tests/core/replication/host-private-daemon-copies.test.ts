/**
 * The copies a host's daemon takes go through the one kept-local filter too
 * (core/replication/host-private.ts; every such copy and its parts are listed in
 * providers/daemon-twin-state.ts, and host-private-guard.test.ts asks one test here per filtered
 * part, by its "kept fixture: <command> <part>" title):
 *   host.slice          the daemon's read copy: no row of a kept task, nor of a subtask under one,
 *                       nor its Board or a request of its own; a kept task whose own session runs
 *                       on the host keeps its row there
 *   triggers.configure  a check still runs on its host, without what it delivers to a kept task
 *   replica.sync        the notes under a kept task's own folder, and the memory files of a kept
 *                       task (a session summary naming it); the companion takes them all
 *   attachments.sync    the pictures under a kept task's own folder
 * Real stores and real holds (task-manager.ts setTaskSyncHold, the private-tasks module's own write).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-private-daemon', { CLOUD_MODE: false }))
vi.mock('../../../src/core/skill-store.js', () => ({ listAllSkills: async () => [] }))

import { MEMORY_DIR, WALNUT_HOME } from '../../../src/constants.js'
import { addTask, setTaskSyncHold } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { createSessionRequest } from '../../../src/core/session-requests.js'
import { setBoardHtml } from '../../../src/core/boards/board-store.js'
import { buildHostSlice } from '../../../src/core/host-slice.js'
import { compileTriggerDefs } from '../../../src/core/routines/trigger-push.js'
import { keptOffHostNow, tasksRunningOn } from '../../../src/core/replication/host-private.js'
import { artifactsDir } from '../../../src/core/artifacts/paths.js'
import { setNotesRoot } from '../../../src/core/notes/note-paths.js'
import { syncHostReplica, _resetHostReplicaForTesting, _hostReplicaSavedForTesting, type ReplicaTarget } from '../../../src/core/host-replica.js'
import type { CronJob } from '../../../src/core/cron/types.js'

const HOLD = { target: 'acme', state: 'chosen' as const, at: '2026-11-21T00:00:00.000Z' }
const keep = (id: string) => setTaskSyncHold(id, HOLD)
const release = (id: string) => setTaskSyncHold(id, null)

beforeEach(async () => {
  await _hostReplicaSavedForTesting()
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
  setNotesRoot(null)
  _resetHostReplicaForTesting()
})

/** A team on host `devbox`: an open lead and worker, a kept task (with a subtask) whose session is on the Mac, and a kept task running here. */
async function team() {
  const lead = (await addTask({ title: 'Team lead', project: 'Work' })).task
  const kept = (await addTask({ title: 'Appraisal notes', project: 'Work', parent_task_id: lead.id, description: 'private words' })).task
  const keptChild = (await addTask({ title: 'Appraisal follow-up', project: 'Work', parent_task_id: kept.id })).task
  const open = (await addTask({ title: 'Open worker', project: 'Work', parent_task_id: lead.id })).task
  const keptHere = (await addTask({ title: 'Kept, runs here', project: 'Work', parent_task_id: lead.id })).task
  const [sLead, sOpen, sKeptHere, sKeptMac] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  await createSessionRecord(sLead, lead.id, 'Work', WALNUT_HOME, { host: 'devbox' })
  await createSessionRecord(sOpen, open.id, 'Work', WALNUT_HOME, { host: 'devbox' })
  await createSessionRecord(sKeptHere, keptHere.id, 'Work', WALNUT_HOME, { host: 'devbox' })
  await createSessionRecord(sKeptMac, kept.id, 'Work', WALNUT_HOME)
  await setBoardHtml(keptHere.id, '<html><body>kept board</body></html>', { by: `task:${keptHere.id}` })
  await setBoardHtml(lead.id, '<html><body>team board</body></html>', { by: `task:${lead.id}` })
  const toKept = await createSessionRequest({ fromSessionId: sLead, toSessionId: sKeptMac, toTaskId: kept.id, text: 'about the appraisal' })
  const fromKeptHere = await createSessionRequest({ fromSessionId: sKeptHere, toSessionId: sLead, text: 'kept asks' })
  const toOpen = await createSessionRequest({ fromSessionId: sLead, toSessionId: sOpen, toTaskId: open.id, text: 'open ask' })
  return { lead, kept, keptChild, open, keptHere, sLead, sOpen, sKeptHere, sKeptMac, toKept, fromKeptHere, toOpen }
}

describe('the daemon\'s read copy (host.slice) leaves a kept task out', () => {
  it('kept fixture: host.slice tasks: no row of a kept task or its subtask; one whose own session runs here keeps its row; all back when released', async () => {
    const t = await team()
    expect((await buildHostSlice('devbox')).tasks.map((r) => r.id)).toEqual(expect.arrayContaining([t.kept.id, t.keptChild.id, t.keptHere.id]))
    await keep(t.kept.id)
    await keep(t.keptHere.id)
    const slice = await buildHostSlice('devbox')
    const ids = slice.tasks.map((r) => r.id)
    expect(ids).toEqual(expect.arrayContaining([t.lead.id, t.open.id, t.keptHere.id]))
    expect(ids, 'a kept task and its subtask with no hold of its own').not.toContain(t.kept.id)
    expect(ids).not.toContain(t.keptChild.id)
    expect(JSON.stringify(slice), 'no word of the kept task').not.toContain('private words')
    expect(slice.sessions.map((s) => s.sid).sort()).toEqual([t.sLead, t.sOpen, t.sKeptHere].sort())
    await release(t.kept.id)
    expect((await buildHostSlice('devbox')).tasks.map((r) => r.id)).toEqual(expect.arrayContaining([t.kept.id, t.keptChild.id]))
  })

  it('kept fixture: host.slice boards: a kept task\'s Board stays off, the team\'s goes', async () => {
    const t = await team()
    await keep(t.keptHere.id)
    const slice = await buildHostSlice('devbox')
    expect(slice.boards.map((b) => b.taskId)).toEqual([t.lead.id])
    expect(slice.boardOf[t.keptHere.id]).toBeUndefined()
    expect(slice.boardOf[t.open.id]).toBe(t.lead.id)
  })

  it('kept fixture: host.slice requests: one to or from a kept task stays off, whichever host it runs on', async () => {
    const t = await team()
    expect((await buildHostSlice('devbox')).requests.map((r) => r.id).sort()).toEqual([t.toKept.id, t.fromKeptHere.id, t.toOpen.id].sort())
    await keep(t.kept.id)
    await keep(t.keptHere.id)
    expect((await buildHostSlice('devbox')).requests.map((r) => r.id)).toEqual([t.toOpen.id])
  })

  it('"a session of this task runs on this host" is one rule for every daemon copy (tasksRunningOn)', async () => {
    const t = await team()
    expect([...await tasksRunningOn(['devbox'])].sort()).toEqual([t.lead.id, t.open.id, t.keptHere.id].sort())
    expect([...await tasksRunningOn(['__local__'])]).toEqual([t.kept.id])
    await keep(t.kept.id)
    await keep(t.keptHere.id)
    const { keptOff } = await keptOffHostNow(['devbox'])
    expect([t.kept.id, t.keptChild.id, t.keptHere.id, t.open.id].map(keptOff)).toEqual([true, true, false, false])
  })
})

describe('the daemon\'s checks (triggers.configure) deliver nothing of a kept task', () => {
  const job = (id: string, target: string): CronJob => ({
    id, name: `check ${id}`, enabled: true, schedule: { kind: 'every', everyMs: 60_000 },
    check: { run: 'test -f /tmp/x', host: 'devbox' },
    executor: { type: 'session', config: { target, prompt: 'look at it' } },
    state: {},
  } as unknown as CronJob)

  it('kept fixture: triggers.configure deliver: the check still runs on its host, without the target and prompt of a kept task none of whose sessions runs there', async () => {
    const t = await team()
    await keep(t.kept.id)
    await keep(t.keptHere.id)
    const { keptOff } = await keptOffHostNow(['devbox'])
    const jobs = [job('a', t.kept.id), job('b', t.open.id), job('c', t.keptHere.id)]
    const { payload } = compileTriggerDefs(jobs, 'devbox', [], keptOff)
    const byId = Object.fromEntries(payload.triggers.map((d) => [d.id, d]))
    expect(byId.a!.check.run).toBe('test -f /tmp/x')
    expect(byId.a!.deliver).toBeUndefined()
    expect(byId.b!.deliver).toMatchObject({ taskId: t.open.id, prompt: 'look at it' })
    expect(byId.c!.deliver, 'its own session runs here').toMatchObject({ taskId: t.keptHere.id })
    // Nothing kept: the very set as before, hash included.
    expect(compileTriggerDefs(jobs, 'devbox', [], () => false).hash).toBe(compileTriggerDefs(jobs, 'devbox').hash)
  })
})

describe('the daemon\'s file copies (replica.sync, attachments.sync) leave a kept task\'s files out', () => {
  function fakeTarget(companion = false): ReplicaTarget & { manifests: Record<string, string[]> } {
    const manifests: Record<string, string[]> = {}
    return {
      hostKey: companion ? 'cloud' : 'devbox', attachments: true, ...(companion ? { companion: true as const } : {}), manifests,
      send: async (cmd, params) => {
        // A whole manifest, or the changes to the one taken before (its additions).
        if (cmd === 'replica.sync') manifests[String(params.kind)] = ((params.entries ?? params.changed ?? []) as Array<{ k: string }>).map((e) => e.k)
        if (cmd === 'attachments.sync') manifests.attachments = ((params.entries ?? []) as Array<{ k: string }>).map((e) => e.k)
        if (cmd === 'attachments.status') return { ok: true, asOf: null }
        return { ok: true, need: [] }
      },
    }
  }
  const write = (abs: string, body: string | Buffer) => { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body) }

  async function setup() {
    const kept = (await addTask({ title: 'Appraisal notes', project: 'Work' })).task
    const open = (await addTask({ title: 'Open work', project: 'Work' })).task
    const keptSid = randomUUID()
    await createSessionRecord(keptSid, kept.id, 'Work', WALNUT_HOME)
    // The one tree: the vault holds the tasks' own folders.
    setNotesRoot(artifactsDir())
    write(path.join(artifactsDir(), 'nodes', kept.id, 'notes', 'appraisal.md'), '# Appraisal\nprivate words')
    write(path.join(artifactsDir(), 'nodes', kept.id, 'notes', 'scan.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    write(path.join(artifactsDir(), 'nodes', open.id, 'notes', 'plan.md'), '# Plan')
    write(path.join(artifactsDir(), 'nodes', open.id, 'notes', 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]))
    write(path.join(MEMORY_DIR, 'sessions', 'appraisal-session.md'), `# Session: appraisal\nTask: ${kept.id}\n\n## Summary\nprivate words`)
    write(path.join(MEMORY_DIR, 'compaction', `${keptSid}.md`), '# snapshot')
    write(path.join(MEMORY_DIR, 'sessions', 'plan-session.md'), `# Session: plan\nTask: ${open.id}\n`)
    write(path.join(MEMORY_DIR, 'MEMORY.md'), '# Memory\n')
    await keep(kept.id)
    return { kept, open }
  }

  it('kept fixture: replica.sync notes: a kept task\'s own folder stays off a host, the companion takes it', async () => {
    const { kept, open } = await setup()
    const host = fakeTarget()
    await syncHostReplica(host)
    expect(host.manifests.notes).toEqual(expect.arrayContaining([`nodes/${open.id}/notes/plan.md`]))
    expect(host.manifests.notes!.some((k) => k.includes(kept.id))).toBe(false)
    const box = fakeTarget(true)
    await syncHostReplica(box)
    expect(box.manifests.notes).toEqual(expect.arrayContaining([`nodes/${kept.id}/notes/appraisal.md`]))
  })

  it('kept fixture: replica.sync memory: a kept task\'s session summary and its session\'s snapshot stay off a host, the companion takes them', async () => {
    const { kept } = await setup()
    const host = fakeTarget()
    await syncHostReplica(host)
    expect(host.manifests.memory).toEqual(expect.arrayContaining(['f/sessions/plan-session.md']))
    expect(host.manifests.memory).not.toContain('f/sessions/appraisal-session.md')
    expect(host.manifests.memory!.some((k) => k.startsWith('f/compaction/'))).toBe(false)
    const box = fakeTarget(true)
    await syncHostReplica(box)
    expect(box.manifests.memory).toEqual(expect.arrayContaining(['f/sessions/appraisal-session.md', 'f/sessions/plan-session.md']))
    // Released: they go to the host again.
    await release(kept.id)
    _resetHostReplicaForTesting()
    const again = fakeTarget()
    await syncHostReplica(again)
    expect(again.manifests.memory).toEqual(expect.arrayContaining(['f/sessions/appraisal-session.md']))
  })

  it('kept fixture: attachments.sync files: a kept task\'s pictures stay off a host', async () => {
    const { kept, open } = await setup()
    const host = fakeTarget()
    await syncHostReplica(host)
    expect(host.manifests.attachments).toEqual([`nodes/${open.id}/notes/chart.png`])
    expect(host.manifests.attachments).not.toContain(`nodes/${kept.id}/notes/scan.png`)
  })
})
