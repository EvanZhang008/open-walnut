import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const previousRuntime = vi.hoisted(() => process.env.WALNUT_DAEMON_DIR)
vi.mock('../../src/constants.js', () => {
  const constants = createMockConstants('walnut-cron-server', { IS_EPHEMERAL: true })
  process.env.WALNUT_DAEMON_DIR = path.join(constants.WALNUT_HOME, 'runtime')
  return constants
})

import { WALNUT_HOME } from '../../src/constants.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { disconnectAllDaemons, getDirectDaemonConnection, type DaemonConnection } from '../../src/providers/daemon-connection.js'
import { createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { enqueueMessage, getQueue } from '../../src/core/session-message-queue.js'
import { startServer, stopServer } from '../../src/web/server.js'

const SID = '10000000-0000-4000-8000-000000000303'
const HOST = '__local__'
const runtime = path.join(WALNUT_HOME, 'runtime')
const state = path.join(WALNUT_HOME, 'state')
const home = path.join(WALNUT_HOME, 'home')
const program = path.join(WALNUT_HOME, 'fixture-cli')
const daemonBinary = process.env.WALNUT_CRON_TEST_DAEMON_BINARY
let daemon: ChildProcess | undefined
let connection: DaemonConnection | undefined
let origin: string
let serverStarted = false
let stopId: string | undefined

async function boot(managed = true) {
  const child = spawn(daemonBinary ?? process.execPath, [
    ...(daemonBinary ? [] : [path.join(WALNUT_HOME, 'daemon.cjs')]), managed ? '--service' : '--start',
  ], {
    env: {
      HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', WALNUT_HOME_OVERRIDE: home,
      WALNUT_DAEMON_DIR: runtime, WALNUT_DAEMON_STATE_DIR: state,
      WALNUT_STREAMS_DIR: path.join(WALNUT_HOME, 'streams'),
      WALNUT_LEGACY_STREAMS_DIR: path.join(WALNUT_HOME, 'legacy'), WALNUT_TURN_RETRY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemon = child
  let stderr = ''
  child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Daemon did not boot: ${stderr}`)), 15_000)
    let output = ''
    child.stdout!.on('data', (chunk) => {
      output += chunk.toString()
      const match = output.match(/^\d+$/m)
      if (match) { clearTimeout(timer); resolve(Number(match[0])) }
    })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Daemon exited ${code}: ${stderr}`)) })
  })
  connection = await getDirectDaemonConnection(HOST, `ws://127.0.0.1:${port}`)
}

async function shutdownDaemon() {
  disconnectAllDaemons()
  connection = undefined
  if (daemon && daemon.exitCode === null) {
    const exited = once(daemon, 'exit', { signal: AbortSignal.timeout(10_000) })
    daemon.kill('SIGTERM')
    await exited
  }
  daemon = undefined
}

beforeAll(async () => {
  for (const dir of [WALNUT_HOME, runtime, state, home]) await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  for (const name of ['daemon-cron-runtime', 'daemon-instance-lock']) {
    await build({ entryPoints: [path.resolve(`src/providers/${name}.ts`)], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(WALNUT_HOME, `${name}.cjs`) })
  }
  await fs.writeFile(path.join(WALNUT_HOME, 'daemon.cjs'), getDaemonSource())
  await fs.writeFile(program, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('--version')) { console.log('2.1.258 (Claude Code)'); process.exit(0); }
const sid = process.argv[process.argv.indexOf('--session-id') + 1];
const now = Date.now();
const rows = [
 {type:'assistant',uuid:'a',parentUuid:null,timestamp:new Date(now).toISOString(),message:{id:'api-1',content:[{type:'tool_use',name:'CronCreate',id:'call-1',input:{cron:'* * * * *',prompt:'Example'}}]}},
 {type:'user',uuid:'b',parentUuid:'a',timestamp:new Date(now+1).toISOString(),message:{content:[{type:'tool_result',tool_use_id:'call-1'}]},toolUseResult:{id:'1234abcd',durable:false,recurring:true}},
 {type:'assistant',uuid:'c',parentUuid:'b',timestamp:new Date(now+2).toISOString(),message:{content:[{type:'text',text:'Scheduled'}]}}
];
const folder = path.join(process.env.HOME,'.claude','projects',process.cwd().replace(/[^a-zA-Z0-9]/g,'-'));
fs.mkdirSync(folder,{recursive:true});
fs.writeFileSync(path.join(folder,sid+'.jsonl'),rows.map(JSON.stringify).join('\\n')+'\\n');
console.log(JSON.stringify({type:'system',subtype:'init',claude_code_version:'2.1.258',session_id:sid}));
for(const row of rows){ delete row.timestamp; if(row.toolUseResult){row.tool_use_result=row.toolUseResult;delete row.toolUseResult;} console.log(JSON.stringify(row)); }
process.stdin.resume();
setTimeout(() => process.exit(0), 120000).unref();
`, { mode: 0o700 })
  await boot()
  const server = await startServer({ port: 0, dev: true })
  serverStarted = true
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not bind TCP')
  origin = `http://127.0.0.1:${address.port}`
  await createSessionRecord(SID, '', '', home, { host: HOST, initialProcessStatus: 'idle' })
}, 45_000)

afterAll(async () => {
  try {
    if (connection?.connected) await connection.send('stop', { sid: SID, reason: 'user', ...(stopId ? { stopRequestId: stopId } : {}) })
  } finally {
    try {
      if (serverStarted) await stopServer()
    } finally {
      disconnectAllDaemons()
      try {
        await shutdownDaemon()
      } finally {
        if (previousRuntime === undefined) delete process.env.WALNUT_DAEMON_DIR
        else process.env.WALNUT_DAEMON_DIR = previousRuntime
        const { closeDb } = await import('../../src/core/session-db.js')
        closeDb()
        await fs.rm(WALNUT_HOME, { recursive: true, force: true })
      }
    }
  }
})

it('real server and daemon persist toggle and stop across daemon restart', async () => {
  const started = await connection!.send('start', { sid: SID, cwd: home, args: [program, '-p', '--session-id', SID], mode: 'default' })
  expect(started.ok).toBe(true)
  const readMetadata = async () => {
    const response = await fetch(`${origin}/api/sessions/status?ids=${SID}`)
    expect(response.status).toBe(200)
    return (await response.json()).cron?.[SID]
  }
  await expect.poll(async () => (await readMetadata())?.presence, { timeout: 10_000 }).toBe('active')
  // The job rides the same feed end to end: daemon tracker → RPC → server store → HTTP.
  const liveJobs = (await readMetadata()).jobs
  expect(liveJobs).toEqual([expect.objectContaining({
    id: '1234abcd', cron: '* * * * *', prompt: 'Example', promptTruncated: false, recurring: true, durable: false,
    createdAt: expect.any(Number), nextRunAt: expect.any(Number), expiresAt: expect.any(Number),
  })])
  expect(liveJobs[0].nextRunAt).toBeGreaterThan(Date.now() - 60_000)
  const read = async () => {
    const response = await fetch(`${origin}/api/sessions/${SID}/supervision`)
    expect(response.status).toBe(200)
    return response.json()
  }
  await expect.poll(async () => (await read()).supervision?.enabled, { timeout: 40_000, interval: 250 }).toBe(true)
  for (const enabled of [false, true, false, true]) {
    const response = await fetch(`${origin}/api/sessions/${SID}/supervision`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
    })
    expect(response.status).toBe(200)
    expect((await response.json()).supervision.enabled).toBe(enabled)
    const status = await connection!.send('status', { sid: SID })
    expect(status.pid).toBe(started.pid)
    expect(status.alive).toBe(true)
  }
  const registry = JSON.parse(await fs.readFile(path.join(state, 'sessions.json'), 'utf8'))
  expect(registry.sessions[SID].cronMetadataOrigin).toMatchObject({ offset: 0, startedAt: expect.any(Number) })
  await shutdownDaemon()
  await boot()
  try {
    await expect.poll(async () => (await readMetadata())?.presence, { timeout: 10_000, interval: 250 }).toBe('active')
  } catch (error) {
    throw new Error(JSON.stringify({ metadata: await connection!.send('cron.metadata', {}), status: await connection!.send('status', { sid: SID }), registry: JSON.parse(await fs.readFile(path.join(state, 'sessions.json'), 'utf8')) }), { cause: error })
  }
  expect((await connection!.send('status', { sid: SID })).pid).toBe(started.pid)
  // Re-adopted from an unstamped stream: the job is still listed, its creation
  // time honestly unknown rather than borrowed from the process start.
  expect((await readMetadata()).jobs).toEqual([expect.objectContaining({ id: '1234abcd', cron: '* * * * *', prompt: 'Example', createdAt: null })])
  const renamedSid = '10000000-0000-4000-8000-000000000304'
  try {
    expect((await connection!.send('rename', { oldSid: SID, newSid: renamedSid })).renamed).toBe(true)
    const metadata = await connection!.send('cron.metadata', {})
    expect(metadata.values).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: renamedSid, presence: 'active' })]))
    expect(metadata.values).not.toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: SID })]))
  } finally {
    expect((await connection!.send('rename', { oldSid: renamedSid, newSid: SID })).renamed).toBe(true)
  }
  await enqueueMessage(SID, 'Do not deliver after stop')
  const stopped = await fetch(`${origin}/api/sessions/${SID}/terminate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }),
  })
  expect(stopped.status).toBe(200)
  expect((await stopped.json()).status).toBe('terminated')
  const record = await getSessionByClaudeId(SID)
  expect(record?.stopRequest?.state).toBe('confirmed')
  stopId = record!.stopRequest!.id
  expect(await getQueue(SID)).toEqual([expect.objectContaining({ status: 'parked' })])
  await shutdownDaemon()
  await boot()
  const after = await read()
  expect(after.stopRequest).toMatchObject({ id: stopId, state: 'confirmed' })
  expect(after.supervision.enabled).toBe(false)
  expect((await connection!.send('status', { sid: SID })).alive).not.toBe(true)
  await shutdownDaemon()
  await boot(false)
  const unmanaged = await connection!.send('start', { sid: SID, cwd: home, args: [program, '-p', '--session-id', SID], mode: 'default' })
  expect(unmanaged.ok).toBe(true)
  await expect.poll(async () => (await readMetadata())?.presence, { timeout: 10_000 }).toBe('active')
  expect((await read()).supervision).toBeNull()
  expect(connection!.hasCapability('cron-supervision-v1')).toBe(false)
  const stream = path.join(WALNUT_HOME, 'streams', `${SID}.jsonl`)
  const append = async (rows: unknown[]) => fs.appendFile(stream, rows.map(JSON.stringify).join('\n') + '\n')
  await append([
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ScheduleWakeup', id: 'wake-1', input: { delaySeconds: 60 } }] } },
    { type: 'user', tool_use_result: { scheduledFor: Date.now() + 60_000 }, message: { content: [{ type: 'tool_result', tool_use_id: 'wake-1' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'CronDelete', id: 'delete-1', input: { id: '1234abcd' } }] } },
    { type: 'user', tool_use_result: {}, message: { content: [{ type: 'tool_result', tool_use_id: 'delete-1' }] } },
  ])
  await expect.poll(async () => (await readMetadata())?.presence, { timeout: 10_000 }).toBe('inactive')
  await append([
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ScheduleWakeup', id: 'wake-stop', input: { stop: true } }] } },
    { type: 'user', tool_use_result: { scheduledFor: 0, stopped: true, cancelledWakeups: 1 }, message: { content: [{ type: 'tool_result', tool_use_id: 'wake-stop' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'CronCreate', id: 'create-2', input: { cron: '* * * * *', prompt: 'Second job' } }] } },
    { type: 'user', tool_use_result: { id: 'cron-2', humanSchedule: 'Every minute', durable: false, recurring: true }, message: { content: [{ type: 'tool_result', tool_use_id: 'create-2' }] } },
  ])
  await expect.poll(async () => (await readMetadata())?.presence, { timeout: 10_000 }).toBe('active')
  // The deleted first job is gone from the details; only the new one is listed.
  expect((await readMetadata()).jobs).toEqual([expect.objectContaining({ id: 'cron-2', cron: '* * * * *', schedule: 'Every minute', prompt: 'Second job', recurring: true, durable: false })])
  // Two live jobs: listed by next run (the nightly one runs later), each with its own details.
  await append([
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'CronCreate', id: 'create-3', input: { cron: '0 0 * * *', prompt: 'Nightly job' } }] } },
    { type: 'user', tool_use_result: { id: 'cron-3', humanSchedule: 'Every day at midnight', durable: false, recurring: true }, message: { content: [{ type: 'tool_result', tool_use_id: 'create-3' }] } },
  ])
  await expect.poll(async () => (await readMetadata())?.jobs?.length, { timeout: 10_000 }).toBe(2)
  const pair = (await readMetadata()).jobs
  expect(pair.map((job: { id: string }) => job.id)).toEqual(['cron-2', 'cron-3'])
  expect(pair[1]).toMatchObject({ cron: '0 0 * * *', schedule: 'Every day at midnight', prompt: 'Nightly job' })
  expect(pair[0].nextRunAt).toBeLessThanOrEqual(pair[1].nextRunAt)
  // Deleting one of two keeps the badge and drops exactly that row.
  await append([
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'CronDelete', id: 'delete-2', input: { id: 'cron-2' } }] } },
    { type: 'user', tool_use_result: {}, message: { content: [{ type: 'tool_result', tool_use_id: 'delete-2' }] } },
  ])
  await expect.poll(async () => (await readMetadata())?.jobs?.map((job: { id: string }) => job.id), { timeout: 10_000 }).toEqual(['cron-3'])
  expect((await readMetadata()).presence).toBe('active')
  await fs.appendFile(stream, Buffer.alloc(33 * 1024 * 1024, 32))
  await expect.poll(async () => (await readMetadata())?.presence, { timeout: 10_000 }).toBe('unknown')
  expect((await readMetadata())?.known).toBe(true)
  await fs.appendFile(stream, '\n' + [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'CronCreate', id: 'call-after-gap', input: { cron: '* * * * *' } }] } },
    { type: 'user', tool_use_result: { id: 'after-gap', durable: false, recurring: true }, message: { content: [{ type: 'tool_result', tool_use_id: 'call-after-gap' }] } },
  ].map(JSON.stringify).join('\n') + '\n')
  await expect.poll(async () => (await readMetadata())?.presence, { timeout: 10_000 }).toBe('active')
  // The gap invalidated the earlier inventory: only the job confirmed after it is listed.
  expect((await readMetadata()).jobs.map((job: { id: string }) => job.id)).toEqual(['after-gap'])
  await fs.appendFile(stream, '{"type":"user","tool_use_result":"CronDelete"\n')
  await expect.poll(async () => (await readMetadata())?.presence, { timeout: 10_000 }).toBe('unknown')
}, 90_000)
