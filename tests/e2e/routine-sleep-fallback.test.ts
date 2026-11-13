import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeOpId } from '../../src/lib/op-call-id.js'
import { HOST_KEY, MAC_NOTE, MAC_SID, ROOT, startReplicaCluster, waitFor, type ReplicaCluster, type SeedMac, type Twin } from '../helpers/replica-cluster.js'

// Portable API work needs walnut-mcp-v1, advertised by the binary twin only.
// The source twin's refusal is covered by clock-portable.test.ts.
const TWINS = (process.env.REPLICA_CLUSTER_TWINS ?? 'standalone').split(',').filter((s): s is Twin => s === 'standalone')
const PROMPT = 'Read the server notes and write the scheduled report.'
const EVERY = 10 * 60_000

const seedClockFacts: SeedMac = ({ base, macData, env }) => {
  const home = path.join(base, 'hh')
  fs.mkdirSync(path.join(home, '.open-walnut'), { recursive: true })
  const hook = path.join(base, 'mh', 'clock-facts.mts')
  // Only external host readiness, home and room are injected. The clocks,
  // trusted daemon template, process start, journal and adoption stay real.
  fs.writeFileSync(hook, `
const p = await import(${JSON.stringify(path.join(ROOT, 'src/core/routines/run-placement.ts'))})
p.__setRunPlacementDepsForTesting({ remoteHome: async () => ${JSON.stringify(home)}, engineBlocker: async () => null })
const clock = await import(${JSON.stringify(path.join(ROOT, 'src/core/routines/clock-portable.ts'))})
const env = clock.defaultPortableClockEnv()
clock.__setPortableClockEnvForTesting({ free: async () => true, allowed: async () => true,
  run: { ...env.run, capabilities: async () => ({ tags: ['always-on', 'linux'], unknown: [] }) } })
`)
  const transcriptDir = path.join(base, 'mh', '.claude', 'projects', path.join(base, 'mh', 'work').replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(transcriptDir, { recursive: true })
  const at = new Date().toISOString()
  const rows = [
    { type: 'user', uuid: 'owner-user-1', parentUuid: null, sessionId: MAC_SID, timestamp: at,
      message: { role: 'user', content: 'Today the user asked us to fix recurring late reports. Keep the correction in owner memory.' } },
    { type: 'assistant', uuid: 'owner-answer-1', parentUuid: 'owner-user-1', sessionId: MAC_SID, timestamp: at,
      message: { role: 'assistant', content: [{ type: 'text', text: 'I recorded the report timing correction.' }] } },
  ]
  fs.writeFileSync(path.join(transcriptDir, `${MAC_SID}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  env.WALNUT_CLUSTER_CLOCK_FACTS = hook
  env.WALNUT_LOG_LEVEL = 'debug'
  const file = path.join(macData, 'config.yaml')
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('    hostname: devbox.invalid', '    capabilities: [always-on]\n    hostname: devbox.invalid'))
}

function gateway(c: ReplicaCluster, sid: string, name: string, args: Record<string, unknown>, callId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(c.base, 'hd', 'agent-gateway.sock'))
    let text = ''
    socket.setTimeout(15_000, () => socket.destroy(new Error('fixture gateway timed out')))
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name, args, callId } }) + '\n'))
    socket.on('data', chunk => {
      text += chunk.toString('utf8')
      if (!text.includes('\n')) return
      try { resolve(JSON.parse(text.split('\n')[0])) } catch (error) { reject(error) }
      socket.end()
    })
    socket.on('end', () => { if (!text.includes('\n')) reject(new Error('fixture gateway closed without an answer')) })
  })
}

function states(c: ReplicaCluster, id: string): Record<string, any> | null {
  const base = path.join(c.base, 'hd', 'trigger-state')
  const dirs = [base]
  try { dirs.push(...fs.readdirSync(path.join(base, 'walnuts')).map(k => path.join(base, 'walnuts', k))) } catch { /* not armed yet */ }
  for (const dir of dirs) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) } catch { /* next tenant */ }
  }
  return null
}

function results(c: ReplicaCluster, sid: string, prompt = PROMPT, daemon = 'hd'): Record<string, any>[] {
  try {
    return fs.readFileSync(path.join(c.base, daemon, 'streams', `${sid}.jsonl`), 'utf8').split('\n')
      .flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
      .filter(row => row.type === 'result' && String(row.result).includes(prompt))
  } catch { return [] }
}

describe.each(TWINS)('a portable routine keeps time while its primary sleeps (%s)', twin => {
  let c: ReplicaCluster
  let id = ''
  let due = 0
  let sid = ''
  let taskId = ''

  beforeAll(async () => {
    c = await startReplicaCluster({ twin, daemonBuilt: process.env.REPLICA_CLUSTER_DAEMON_BUILT === '1', seedMac: seedClockFacts })
    due = Date.now() + 90_000
    const made = await c.mac('POST', '/api/routines', {
      name: 'Portable report during sleep', enabled: true,
      schedule: { kind: 'every', everyMs: EVERY, anchorMs: due - EVERY },
      executor: { type: 'claude-code', config: { instructions: PROMPT, cwd: path.join(c.base, 'mh', 'data'), placement: { portable: true } } },
    })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    id = made.json.job.id
    await waitFor(async () => (await c.mac('GET', `/api/routines/${id}`)).json.job?.state?.clockHost === HOST_KEY, 60_000, 'the always-on host to take the clock')
      .catch(error => { console.error(c.logs()); throw error })
    await waitFor(() => states(c, id)?.clock?.fromMs === due, 30_000, 'the daemon to arm the slot')
    expect(Date.now()).toBeLessThan(due)
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('the daemon starts the original work while both primary processes are suspended', async () => {
    c.sleepMac()
    const fire = await waitFor(() => states(c, id)?.pendingFires?.find((f: any) => f.host?.started), due - Date.now() + 150_000, 'the independent scheduled start')
    expect(fire.clock.slotMs).toBe(due)
    expect(fire.host.atMs).toBeGreaterThanOrEqual(due)
    expect(fire.host.atMs - due).toBeLessThan(90_000)
    sid = fire.host.sessionId
    taskId = fire.host.taskId
    await waitFor(() => results(c, sid).length === 1, 60_000, 'the mock CLI to do the scheduled work')
    expect(states(c, id)?.clock?.nextRunAtMs).toBe(due + EVERY)
  }, 300_000)

  it('waking records and adopts the run once without starting it again', async () => {
    c.wakeMac()
    const job = await waitFor(async () => {
      const one = (await c.mac('GET', `/api/routines/${id}`)).json.job
      return one?.state?.fireCount === 1 ? one : null
    }, 120_000, 'the primary to record the host result')
    expect(job.executor.config.host).toBeUndefined()
    expect(job.state.clockHost).toBe(HOST_KEY)
    expect(job.state.runLog.filter((r: any) => r.slotMs === due)).toHaveLength(1)
    expect(job.state.fireLog[0].delivery.sessionId).toBe(sid)
    await waitFor(async () => (await c.mac('GET', `/api/tasks/${taskId}`)).status === 200, 60_000, 'the task journal to be adopted')
    await waitFor(() => states(c, id)?.pendingFires?.length === 0, 60_000, 'the fire acknowledgement')
    expect(results(c, sid)).toHaveLength(1)
    const sessions = (await c.mac('GET', `/api/sessions/task/${taskId}`)).json.sessions
    expect(sessions).toHaveLength(1)
    expect(sessions[0].host).toBe(HOST_KEY)
  }, 300_000)

  it('runs task and Main reflections without copying their conversations, and merges Mac-only slots at wake', async () => {
    const owner = c.ids.board
    const main = await c.mac('POST', '/api/v1/org/main')
    expect(main.status, JSON.stringify(main.json)).toBe(200)
    const mainId = main.json.task.id
    const memory = await c.mac('PUT', `/api/v1/tasks/${owner}/agent-memory`, { content: 'The owner keeps the timing correction.', mode: 'replace' })
    expect(memory.status, JSON.stringify(memory.json)).toBe(200)
    const slot = Date.now() + 90_000
    const reflection = `Sample today's corrections in your own chat, update your MEMORY.md, and write the daily report at "${path.join(c.macData, 'notes', MAC_NOTE.path)}". Report the result to your owner.`
    const mainPrompt = 'Sample the day and record the Main reflection in your own MEMORY.md.'
    const nativePrompt = 'Read /Users/me/private/report.csv using AppleScript and write the Mac-only report.'
    const create = async (name: string, executor: Record<string, unknown>, everyMs = EVERY) => {
      const made = await c.mac('POST', '/api/routines', { name, enabled: true, wakeMode: 'now', schedule: { kind: 'every', everyMs, anchorMs: everyMs === 10_000 ? slot : slot - everyMs }, executor })
      expect(made.status, JSON.stringify(made.json)).toBe(201)
      return made.json.job.id as string
    }
    const reflectionId = await create('Owner reflection during sleep', { type: 'session', config: { target: owner, prompt: reflection, placement: { portable: true } } })
    const mainRoutineId = await create('Main reflection during sleep', { type: 'main-agent', config: { instructions: mainPrompt } })
    const nativeId = await create('Mac-only report during sleep', { type: 'claude-code', config: { instructions: nativePrompt, cwd: path.join(c.base, 'mh', 'work') } }, 10_000)
    for (const rid of [reflectionId, mainRoutineId]) {
      await waitFor(async () => (await c.mac('GET', `/api/routines/${rid}`)).json.job?.state?.clockHost === HOST_KEY, 60_000, `the clock for ${rid}`)
      await waitFor(() => states(c, rid)?.clock?.fromMs === slot, 30_000, 'the reflection clock to arm')
    }
    const nativeBefore = (await c.mac('GET', `/api/routines/${nativeId}`)).json.job
    expect(nativeBefore.state.clockHost).toBeUndefined()
    expect(nativeBefore.state.nextRunAtMs).toBe(slot)
    expect(Date.now()).toBeLessThan(slot)
    const token = await c.pairDevice('reflection-phone')
    await waitFor(async () => {
      const r = await c.replica('GET', `/api/v1/tasks/${owner}/agent-memory`, { token })
      return r.status === 200 && r.json.memory?.text === 'The owner keeps the timing correction.'
    }, 60_000, 'the owner memory copy')
    c.sleepMac()
    await c.waitAway(token)
    const runs: Array<{ rid: string; fire: any; prompt: string }> = []
    for (const [rid, prompt] of [[reflectionId, reflection], [mainRoutineId, mainPrompt]]) {
      const fire = await waitFor(() => states(c, rid)?.pendingFires?.find((f: any) => f.host?.started), slot - Date.now() + 150_000, 'the detached reflection start')
      expect(fire.clock.slotMs).toBe(slot)
      expect(fire.host.atMs - slot).toBeLessThan(90_000)
      expect(fire.host.taskId).not.toBe(owner)
      expect(fire.host.taskId).not.toBe(mainId)
      await waitFor(() => results(c, fire.host.sessionId, prompt).length === 1, 60_000, 'the original reflection instructions to run')
      if (rid === reflectionId) {
        const launch = JSON.parse(fs.readFileSync(path.join(c.base, 'hh', '.claude', 'fixture-launches', `${fire.host.sessionId}.json`), 'utf8'))
        expect(launch.context).toContain('Today the user asked us to fix recurring late reports.')
        expect(launch.context).toContain(owner)
        expect(launch.context).toContain(MAC_NOTE.path)
      }
      runs.push({ rid, fire, prompt })
    }
    const read = await c.replica('GET', `/api/v1/tasks/${owner}/agent-memory`, { token })
    expect(read.status, read.text).toBe(200)
    expect(read.json.memory.text).toContain('timing correction')
    const memoryArgs = { task: owner, content: 'The reflection ran on time while the Mac slept.', mode: 'append' }
    const workerSid = runs.find(run => run.rid === reflectionId)!.fire.host.sessionId
    const write = await gateway(c, workerSid, 'agent_memory_write', memoryArgs, 'oc-reflection_memory_0001')
    expect(write, JSON.stringify(write)).toMatchObject({ ok: true, result: { queued: true, offline: true } })
    const retry = await gateway(c, workerSid, 'agent_memory_write', memoryArgs, 'oc-reflection_memory_0001')
    expect(retry.ok, JSON.stringify(retry)).toBe(true)
    const noteRead = await gateway(c, workerSid, 'note_read', { path: MAC_NOTE.path }, 'oc-reflection_note_read_0001')
    expect(noteRead.ok, JSON.stringify(noteRead)).toBe(true)
    const note = await gateway(c, workerSid, 'note_write', {
      path: MAC_NOTE.path, content: 'The scheduled reflection report is complete.', expectedHash: noteRead.result.contentHash,
    }, 'oc-reflection_note_write_0001')
    expect(note, JSON.stringify(note)).toMatchObject({ ok: true, result: { queued: true, offline: true } })
    const owedSlot = slot + 20_000
    await waitFor(() => Date.now() >= owedSlot, Math.max(1, owedSlot - Date.now()) + 10_000, 'three Mac-only slots to come due')
    expect(states(c, nativeId)).toBeNull()
    c.wakeMac()
    for (const { rid, fire, prompt } of runs) {
      const job = await waitFor(async () => {
        const j = (await c.mac('GET', `/api/routines/${rid}`)).json.job
        return j?.state?.fireCount === 1 ? j : null
      }, 120_000, 'the reflection to be adopted once')
      expect(job.state.runLog.filter((r: any) => r.slotMs === slot)).toHaveLength(1)
      expect(results(c, fire.host.sessionId, prompt)).toHaveLength(1)
      const record = await c.mac('GET', `/api/tasks/${fire.host.taskId}`)
      expect(record.status).toBe(200)
      expect(record.json.task.org_role).toBeUndefined()
    }
    const finalMemory = await waitFor(async () => {
      const memory = (await c.mac('GET', `/api/v1/tasks/${owner}/agent-memory`)).json.memory
      return memory?.text.includes('ran on time') ? memory : null
    }, 120_000, 'the owner memory write to reach the primary')
    expect(finalMemory.text.match(/The reflection ran on time/g)).toHaveLength(1)
    // The lost answer can be retried after the primary wakes through its online
    // route. It must find the same drained op, not append the entry a second time.
    const onlineRetry = await c.mac('PUT', `/api/v1/tasks/${owner}/agent-memory`, memoryArgs, {
      'x-walnut-op-id': writeOpId('oc-reflection_memory_0001', 'PUT', `/tasks/${owner}/agent-memory`, 0),
    })
    expect(onlineRetry.status, JSON.stringify(onlineRetry.json)).toBe(200)
    expect((await c.mac('GET', `/api/v1/tasks/${owner}/agent-memory`)).json.memory.text.match(/The reflection ran on time/g)).toHaveLength(1)
    expect(finalMemory.text).toContain('The owner keeps the timing correction.')
    expect(finalMemory.by).toBe(`task:${runs.find(run => run.rid === reflectionId)!.fire.host.taskId}`)
    expect(fs.readFileSync(path.join(c.macData, 'notes', MAC_NOTE.path), 'utf8')).toContain('scheduled reflection report')
    const native = await waitFor(async () => {
      const j = (await c.mac('GET', `/api/routines/${nativeId}`)).json.job
      return j?.state?.runLog?.find((r: any) => r.firstSlotMs === slot && r.slotMs >= owedSlot) ? j : null
    }, 120_000, 'the Mac-only slots to merge at wake')
    expect(native.missed ?? []).toEqual([])
    expect(native.state.runLog.filter((r: any) => r.firstSlotMs === slot && r.slotMs >= owedSlot)).toHaveLength(1)
    expect((await c.mac('PATCH', `/api/routines/${nativeId}`, { enabled: false })).status).toBe(200)
    expect((await c.mac('GET', `/api/sessions/task/${owner}`)).json.sessions).toHaveLength(1)
    expect((await c.mac('GET', `/api/tasks/${mainId}`)).json.task.org_role).toBe('main')
  }, 480_000)
})
