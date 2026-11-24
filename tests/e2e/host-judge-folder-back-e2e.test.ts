/**
 * A message the host parked because its session's folder was gone, every piece a real process
 * (the cluster of tests/helpers/host-judge-cluster.ts, the switch on at both ends). 2026-11-24:
 * twelve such rows stayed parked on a host for hours after the folder was back and the session ran
 * in it; the console's queue showed none of them and could neither retry nor discard them.
 *
 *   F1 list      the Mac's queue of the session lists the rows its host keeps parked, marked onHost
 *   F2 ride      the Mac's next message to the session takes the row that waited on the folder with
 *                it, ahead of it, on the host (src/core/sessions/folder-wait.ts); a row an older Walnut
 *                parked (no mark) stays parked for a person
 *   F3 discard   the Mac's Discard of that row removes it from the host's queue
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, waitFor } from '../helpers/replica-cluster.js'
import { deliveries, hostStream, writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, type HostJudgeCluster } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'

describe.skipIf(!RUN)('a message the host parked on a gone folder, every piece a real process', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let sid = ''
  let older = ''
  let waited = ''

  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-6000)}\n--- replica ---\n${h.c.logs().replica.slice(-6000)}`
  const linked = async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return !!(s.linked && s.judges) }
  const answered = (text: string) => hostStream(h.c, sid).some((l) => l.type === 'result' && String(l.result).includes(text))
  const hostQueue = async (): Promise<Array<{ id: string; status: string; folderWait: boolean }>> => h.host(`/queue?sid=${sid}`)

  beforeAll(async () => {
    h = await startHostJudgeCluster()
    process.stdout.write(`host-judge-folder-back-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
    await waitFor(linked, 120_000, 'the Mac to link the host\'s session channel')
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Folder back', project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    const st = await h.c.mac('POST', `/api/v1/tasks/${t.json.task.id}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message: 'FOLDER round one' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    sid = st.json.sessionId as string
    await waitFor(() => answered('FOLDER round one'), 120_000, 'the first answer on the host').catch((err) => { throw new Error(say(String(err))) })
    expect(await h.mac(`/judge?sid=${sid}`)).toEqual({ judge: 'host', host: HOST_KEY })
  }, 900_000)

  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`host-judge-folder-back: logs at ${writeClusterLogs(h.c, 'host-judge-folder-back')}\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  it('F1: the Mac\'s queue of the session lists the rows its host keeps parked', async () => {
    older = (await h.host(`/park-gone?sid=${sid}&text=${encodeURIComponent('FOLDER older park')}&cwd=${encodeURIComponent(hostCwd)}&unmarked=1`)).id
    waited = (await h.host(`/park-gone?sid=${sid}&text=${encodeURIComponent('FOLDER waited')}&cwd=${encodeURIComponent(hostCwd)}`)).id
    expect((await hostQueue()).map((m) => `${m.id}:${m.status}:${m.folderWait}`)).toEqual([`${older}:parked:false`, `${waited}:parked:true`])
    const q = await h.c.mac('GET', `/api/v1/sessions/${sid}/queue`)
    expect(q.status, JSON.stringify(q.json)).toBe(200)
    const listed = (q.json.messages as Array<{ id: string; status: string; onHost?: boolean }>).filter((m) => m.onHost)
    expect(listed.map((m) => `${m.id}:${m.status}`)).toEqual([`${older}:parked`, `${waited}:parked`])
  }, 120_000)

  it('F2: the Mac\'s next message takes the row that waited on the folder with it; the older park stays', async () => {
    const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: 'FOLDER round two' })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitFor(() => answered('FOLDER round two'), 120_000, 'the second answer on the host').catch((err) => { throw new Error(say(String(err))) })
    // The row that waited went to the same CLI once, ahead of the new one; the older park never went.
    const injected = hostStream(h.c, sid).filter((l) => l.type === 'user' && l.subtype === 'walnut-injected').map((l) => JSON.stringify(l.message ?? ''))
    const at = (text: string) => injected.findIndex((u) => u.includes(text))
    expect(deliveries(h.c, sid, 'FOLDER waited'), say('the waited row did not reach the CLI once')).toBe(1)
    expect(at('FOLDER waited')).toBeLessThanOrEqual(at('FOLDER round two'))
    expect(deliveries(h.c, sid, 'FOLDER older park')).toBe(0)
    await waitFor(async () => (await hostQueue()).map((m) => `${m.id}:${m.status}`).join() === `${older}:parked`, 60_000, 'only the older park left on the host')
  }, 300_000)

  it('F3: the Mac\'s Discard of the older park removes it from the host\'s queue', async () => {
    const del = await h.c.mac('DELETE', `/api/v1/sessions/${sid}/queue/${older}`)
    expect(del.status, JSON.stringify(del.json)).toBe(200)
    expect(await hostQueue()).toEqual([])
    const q = await h.c.mac('GET', `/api/v1/sessions/${sid}/queue`)
    expect((q.json.messages as Array<{ id: string }>).some((m) => m.id === older)).toBe(false)
  }, 120_000)
})
