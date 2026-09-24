/**
 * Real daemon + real server end-to-end test for the CRON JOB METADATA wire.
 *
 * Harness copied from tests/e2e/session-cron-supervision.test.ts (own daemon
 * binary built from the JS twin, own fake HOME, own isolated ports) — a
 * different SID and a different mock-constants label so the two files can never
 * share a directory or a daemon.
 *
 * What this file adds over the supervision test: the fixture CLI is DRIVEN BY
 * THE MESSAGES it receives on its FIFO stdin. Each message plays the next
 * scripted phase, writing the rows both to the session JSONL (the way the CLI
 * owns that file) and to stdout as stream-json (with `tool_use_result`, the way
 * the daemon's stream capture sees them) — both ISO-stamped, as the real CLI
 * stamps both. Every phase is then asserted on BOTH read carriers
 * (`/api/sessions/status` and `/api/sessions/:id`) plus the WS
 * `session:cron-metadata` feed a browser sees.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { build } from 'esbuild'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const previousRuntime = vi.hoisted(() => process.env.WALNUT_DAEMON_DIR)
vi.mock('../../src/constants.js', () => {
  const constants = createMockConstants('walnut-cron-wire-server', { IS_EPHEMERAL: true })
  process.env.WALNUT_DAEMON_DIR = path.join(constants.WALNUT_HOME, 'runtime')
  return constants
})

import { WALNUT_HOME } from '../../src/constants.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { disconnectAllDaemons, getDirectDaemonConnection, type DaemonConnection } from '../../src/providers/daemon-connection.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { cliOneShotTime, nextCliCronMinute } from '../../src/providers/daemon-cron-schedule.js'
import { DEFAULT_CRON_RESTORE_CONFIG } from '../../src/providers/daemon-cron-transcript.js'
import { SESSION_CRON_PROMPT_LIMIT, type SessionCronJob, type SessionCronMetadata } from '../../src/core/types.js'
import { startServer, stopServer } from '../../src/web/server.js'

const SID = '10000000-0000-4000-8000-000000000404'
const HOST = '__local__'
const runtime = path.join(WALNUT_HOME, 'runtime')
const state = path.join(WALNUT_HOME, 'state')
const home = path.join(WALNUT_HOME, 'home')
const program = path.join(WALNUT_HOME, 'fixture-cli')
const phasesFile = path.join(WALNUT_HOME, 'phases.json')
const daemonBinary = process.env.WALNUT_CRON_TEST_DAEMON_BINARY
let daemon: ChildProcess | undefined
let connection: DaemonConnection | undefined
let origin: string
let port = 0
let serverStarted = false
let socket: WebSocket | undefined

/** Every session:cron-metadata frame this connection saw for SID, in order. */
const frames: SessionCronMetadata[] = []

// ── The scripted CLI behaviour ───────────────────────────────────────────────
// Job ids look like the CLI's (8 hex chars): cliOneShotTime derives its early
// fire offset from the first 8 characters, so the id must be part of the
// contract the test reproduces.
const DAILY_ID = 'a1b2c3d4'
const ONCE_ID = 'b2c3d4e5'
const SHARED_ID = 'c3d4e5f6'
const PROBE_ID = 'd4e5f607'
const AFTER_ID = 'e5f60718'
const LISTED_ID = 'listed-only'
const SIDECHAIN_ID = 'sidechain-only'
const SUBAGENT_ID = 'subagent-only'
const DAILY_CRON = '23 9 * * *'
// New Year midnight: far enough away that the one-shot cannot fire (and so
// cannot leave the inventory) part-way through the test.
const ONCE_CRON = '0 0 1 1 *'
const SHARED_CRON = '0 12 * * *'
const PROBE_CRON = '*/13 * * * *'
const AFTER_CRON = '41 * * * *'
const LEGACY_ID = 'f6071829'
/** Written straight into the stream file with a stamp older than the process. */
const GHOST_ID = '07182930'
const LEGACY_CRON = '*/19 * * * *'
const IGNORED_CRONS = ['*/7 * * * *', '*/11 * * * *', '*/17 * * * *']
/** 2001 characters: one past the shared prompt limit. */
const LONG_PROMPT = 'Inspect the shared disk and report anything unusual. '.padEnd(2001, '.')
const RECURRING_MAX_AGE = DEFAULT_CRON_RESTORE_CONFIG.recurringMaxAgeMs

type Block = Record<string, unknown>
type Row = Record<string, unknown>
const useRow = (uuid: string, parentUuid: string | null, content: Block[], extra: Row = {}): Row =>
  ({ type: 'assistant', uuid, parentUuid, ...extra, message: { id: `api-${uuid}`, content } })
const resultRow = (uuid: string, parentUuid: string, toolUseId: string, result: unknown, extra: Row = {}): Row =>
  ({ type: 'user', uuid, parentUuid, ...extra, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] }, result })
const textRow = (uuid: string, parentUuid: string, text: string): Row =>
  ({ type: 'assistant', uuid, parentUuid, message: { content: [{ type: 'text', text }] } })
const use = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: 'tool_use', id, name, input })

const PHASES: Row[][] = [
  // P1 — three creates in ONE assistant message, each answered by its own
  // result line (the CLI answers parallel tool calls one line each, and a single
  // user line carries exactly one `tool_use_result` object, so three results
  // cannot ride one line).
  [
    useRow('p1-a', null, [
      use('call-daily', 'CronCreate', { cron: DAILY_CRON, prompt: LONG_PROMPT }),
      use('call-once', 'CronCreate', { cron: ONCE_CRON, prompt: 'Ring in the new year', recurring: false }),
      use('call-shared', 'CronCreate', { cron: SHARED_CRON, prompt: 'Midday sweep', durable: true }),
    ]),
    resultRow('p1-b', 'p1-a', 'call-daily', { id: DAILY_ID, cron: DAILY_CRON, humanSchedule: 'Every day at 9:23 AM', recurring: true, durable: false }),
    resultRow('p1-c', 'p1-b', 'call-once', { id: ONCE_ID, cron: ONCE_CRON, humanSchedule: 'On January 1 at 12:00 AM', recurring: false, durable: false }),
    resultRow('p1-d', 'p1-c', 'call-shared', { id: SHARED_ID, cron: SHARED_CRON, humanSchedule: 'Every day at 12:00 PM', recurring: true, durable: true }),
    textRow('p1-e', 'p1-d', 'Scheduled three jobs.'),
  ],
  // P2 — a list that refreshes the daily job's wording, repeats the one-shot and
  // the durable job, and adds a row the daemon never watched being created.
  [
    useRow('p2-a', 'p1-e', [use('call-list', 'CronList', {})]),
    resultRow('p2-b', 'p2-a', 'call-list', {
      jobs: [
        { id: DAILY_ID, cron: DAILY_CRON, humanSchedule: 'Daily at 9:23 AM', prompt: LONG_PROMPT, recurring: true, durable: false },
        { id: ONCE_ID, cron: ONCE_CRON, humanSchedule: 'On January 1 at 12:00 AM', prompt: 'Ring in the new year', recurring: false, durable: false },
        { id: SHARED_ID, cron: SHARED_CRON, humanSchedule: 'Every day at 12:00 PM', prompt: 'Midday sweep', recurring: true, durable: true },
        { id: LISTED_ID, cron: '0 6 * * 1', humanSchedule: 'Every Monday at 6:00 AM', prompt: 'Weekly report', recurring: true, durable: false },
      ],
    }),
    textRow('p2-c', 'p2-b', 'Listed four jobs.'),
  ],
  // P3 — three creates that must be ignored, then a probe create+delete pair.
  // The probe is the synchronisation point: the ignored lines publish nothing,
  // so without it there is no edge to wait for.
  [
    useRow('p3-a', 'p2-c', [use('call-bad', 'CronCreate', { cron: IGNORED_CRONS[0], prompt: 'Wrong result types' })]),
    resultRow('p3-b', 'p3-a', 'call-bad', { id: 123, recurring: true, durable: false }),
    useRow('p3-c', 'p2-c', [use('call-side', 'CronCreate', { cron: IGNORED_CRONS[1], prompt: 'Sidechain job' })], { isSidechain: true }),
    resultRow('p3-d', 'p3-c', 'call-side', { id: SIDECHAIN_ID, recurring: true, durable: false }, { isSidechain: true }),
    useRow('p3-e', 'p2-c', [use('call-sub', 'CronCreate', { cron: IGNORED_CRONS[2], prompt: 'Subagent job' })], { parent_tool_use_id: 'call-agent' }),
    resultRow('p3-f', 'p3-e', 'call-sub', { id: SUBAGENT_ID, recurring: true, durable: false }, { parent_tool_use_id: 'call-agent' }),
    useRow('p3-g', 'p3-b', [use('call-probe', 'CronCreate', { cron: PROBE_CRON, prompt: 'Probe job' })]),
    resultRow('p3-h', 'p3-g', 'call-probe', { id: PROBE_ID, cron: PROBE_CRON, humanSchedule: 'Every 13 minutes', recurring: true, durable: false }),
    useRow('p3-i', 'p3-h', [use('call-probe-delete', 'CronDelete', { id: PROBE_ID })]),
    resultRow('p3-j', 'p3-i', 'call-probe-delete', {}),
    textRow('p3-k', 'p3-j', 'Cleaned up the probe.'),
  ],
  // P4 — delete the daily job.
  [
    useRow('p4-a', 'p3-k', [use('call-delete-daily', 'CronDelete', { id: DAILY_ID })]),
    resultRow('p4-b', 'p4-a', 'call-delete-daily', {}),
    textRow('p4-c', 'p4-b', 'Removed the daily job.'),
  ],
  // P5 — delete the list-only row and the one-shot: only the durable job is left.
  [
    useRow('p5-a', 'p4-c', [
      use('call-delete-listed', 'CronDelete', { id: LISTED_ID }),
      use('call-delete-once', 'CronDelete', { id: ONCE_ID }),
    ]),
    resultRow('p5-b', 'p5-a', 'call-delete-listed', {}),
    resultRow('p5-c', 'p5-b', 'call-delete-once', {}),
    textRow('p5-d', 'p5-c', 'Only the shared job is left.'),
  ],
  // P6 — after the first daemon restart: proves the re-adopted process is still
  // observed LIVE (a create it watches carries a real creation time), and gives
  // the second restart a recurring job to replay.
  [
    useRow('p6-a', 'p5-d', [use('call-after', 'CronCreate', { cron: AFTER_CRON, prompt: 'Sweep after the restart' })]),
    resultRow('p6-b', 'p6-a', 'call-after', { id: AFTER_ID, cron: AFTER_CRON, humanSchedule: 'Every hour at :41', recurring: true, durable: false }),
    textRow('p6-c', 'p6-b', 'Scheduled the post-restart job.'),
  ],
  // P7 — a create watched live by a daemon that adopted this process WITHOUT any
  // cron bookkeeping in the registry (the pre-feature shape).
  [
    useRow('p7-a', 'p6-c', [use('call-legacy', 'CronCreate', { cron: LEGACY_CRON, prompt: 'Watch the queue' })]),
    resultRow('p7-b', 'p7-a', 'call-legacy', { id: LEGACY_ID, cron: LEGACY_CRON, humanSchedule: 'Every 19 minutes', recurring: true, durable: false }),
    textRow('p7-c', 'p7-b', 'Scheduled after a bookkeeping-free adopt.'),
  ],
]

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
  const daemonPort = await new Promise<number>((resolve, reject) => {
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
  connection = await getDirectDaemonConnection(HOST, `ws://127.0.0.1:${daemonPort}`)
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
  await fs.writeFile(phasesFile, JSON.stringify(PHASES))
  // The fixture CLI: one scripted phase per message it reads from its FIFO.
  // Each phase lands in the CLI-owned JSONL and on stdout as stream-json, both
  // ISO-stamped, then ends the turn with a `result` row. Stamped on both carriers
  // because that is what the real CLI does: every one of the 108 cron tool lines
  // in a 1GB production stream carries a `timestamp` (checked on 2.1.265), and
  // that stamp is what an adopted session's attribution rests on.
  await fs.writeFile(program, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('--version')) { console.log('2.1.258 (Claude Code)'); process.exit(0); }
const sid = process.argv[process.argv.indexOf('--session-id') + 1];
const phasesFile = ${JSON.stringify(phasesFile)};
const folder = path.join(process.env.HOME,'.claude','projects',process.cwd().replace(/[^a-zA-Z0-9]/g,'-'));
fs.mkdirSync(folder,{recursive:true});
const jsonl = path.join(folder, sid + '.jsonl');
fs.appendFileSync(jsonl, '');
console.log(JSON.stringify({type:'system',subtype:'init',claude_code_version:'2.1.258',session_id:sid}));
let turn = 0;
function emit(rows) {
  const now = Date.now();
  const stamped = rows.map(function (row, i) {
    const copy = Object.assign({}, row, { timestamp: new Date(now + i).toISOString() });
    if ('result' in copy) { copy.toolUseResult = copy.result; delete copy.result; }
    return JSON.stringify(copy);
  });
  fs.appendFileSync(jsonl, stamped.join('\\n') + '\\n');
  for (let i = 0; i < rows.length; i++) {
    const copy = Object.assign({}, rows[i], { timestamp: new Date(now + i).toISOString() });
    if ('result' in copy) { copy.tool_use_result = copy.result; delete copy.result; }
    console.log(JSON.stringify(copy));
  }
  console.log(JSON.stringify({type:'result',subtype:'success',session_id:sid,is_error:false,num_turns:1,duration_ms:1,result:'done'}));
}
let buffer = '';
process.stdin.on('data', function (chunk) {
  buffer += chunk.toString();
  for (;;) {
    const nl = buffer.indexOf('\\n');
    if (nl === -1) break;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const phases = JSON.parse(fs.readFileSync(phasesFile, 'utf8'));
    if (turn < phases.length) emit(phases[turn++]);
  }
});
process.stdin.resume();
// Referenced (not unref'd) on purpose: the daemon owns the write end of this
// FIFO, so a SIGTERMed daemon would otherwise end stdin and let the fixture
// exit in the middle of the restart cases. Also caps any orphan's lifetime.
setTimeout(function () { process.exit(0); }, 240000);
`, { mode: 0o700 })
  await boot()
  const server = await startServer({ port: 0, dev: true })
  serverStarted = true
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not bind TCP')
  port = address.port
  origin = `http://127.0.0.1:${port}`
  await createSessionRecord(SID, '', '', home, { host: HOST, initialProcessStatus: 'idle' })
  // A real browser-shaped client: the third carrier of the same feed.
  socket = await new Promise<WebSocket>((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    client.on('open', () => resolve(client))
    client.on('error', reject)
  })
  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as { type?: string; name?: string; data?: SessionCronMetadata }
    if (frame.type === 'event' && frame.name === 'session:cron-metadata' && frame.data?.sessionId === SID) frames.push(frame.data)
  })
}, 60_000)

afterAll(async () => {
  try {
    socket?.close()
    if (connection?.connected) await connection.send('stop', { sid: SID, reason: 'user' })
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

const readStatusCron = async (): Promise<SessionCronMetadata | undefined> => {
  const response = await fetch(`${origin}/api/sessions/status?ids=${SID}`)
  expect(response.status).toBe(200)
  return (await response.json()).cron?.[SID]
}
const readDetailCron = async (): Promise<SessionCronMetadata | null> => {
  const response = await fetch(`${origin}/api/sessions/${SID}`)
  expect(response.status).toBe(200)
  return (await response.json()).cron
}
/** Both read carriers, once they agree — the deep-equality half of the contract. */
async function agreedValue(): Promise<SessionCronMetadata> {
  let agreed: SessionCronMetadata | undefined
  await expect.poll(async () => {
    const detail = await readDetailCron()
    const status = await readStatusCron()
    if (!status || !detail || JSON.stringify(status) !== JSON.stringify(detail)) return false
    agreed = status
    return true
  }, { timeout: 15_000, interval: 100 }).toBe(true)
  return agreed!
}
const ids = (value: SessionCronMetadata | undefined): string[] => (value?.jobs ?? []).map((job) => job.id)
const job = (value: SessionCronMetadata, id: string): SessionCronJob => {
  const found = (value.jobs ?? []).find((entry) => entry.id === id)
  if (!found) throw new Error(`job ${id} is not reported: ${JSON.stringify(value.jobs)}`)
  return found
}
/** The reported order is by next run — computed, never hardcoded to a clock. */
const byNextRun = (pairs: Array<[string, string]>, at: number): string[] =>
  [...pairs].sort((a, b) => (nextCliCronMinute(a[1], at) ?? Infinity) - (nextCliCronMinute(b[1], at) ?? Infinity)
    || (a[0] < b[0] ? -1 : 1)).map(([id]) => id)
/** nextRunAt is the next matching minute after the create; a refresh may only
 *  have advanced it if that minute passed while the phase ran. */
function expectNextRun(actual: number | null, cron: string, from: number, until: number): void {
  expect([nextCliCronMinute(cron, from), nextCliCronMinute(cron, until)]).toContain(actual)
  expect(actual).toBeGreaterThan(from)
}

it('carries cron job metadata from the CLI stream to both REST carriers and the WS feed', async () => {
  const started = await connection!.send('start', { sid: SID, cwd: home, args: [program, '-p', '--session-id', SID], mode: 'default' })
  expect(started.ok).toBe(true)
  const runPhase = async (label: string) => {
    expect(await connection!.send('send', { sid: SID, message: label })).toMatchObject({ ok: true })
  }
  // The session exists on the wire before any cron work: presence is honest.
  await expect.poll(async () => (await readStatusCron())?.sessionId, { timeout: 20_000, interval: 100 }).toBe(SID)

  // ── P1: three creates, two reported ───────────────────────────────────────
  const p1From = Date.now()
  await runPhase('play phase 1')
  await expect.poll(async () => (await readStatusCron())?.jobs?.length, { timeout: 20_000, interval: 100 }).toBe(2)
  const p1 = await agreedValue()
  const p1Until = Date.now()
  expect(p1Until - p1From).toBeLessThan(20_000)
  expect(p1).toMatchObject({ presence: 'active', source: 'cron', known: true, stale: false })
  // The durable job is tracked but never active: a directory-shared row is not
  // this session's to claim.
  expect(ids(p1)).toEqual(byNextRun([[DAILY_ID, DAILY_CRON], [ONCE_ID, ONCE_CRON]], p1From))
  expect(ids(p1)).not.toContain(SHARED_ID)
  const daily = job(p1, DAILY_ID)
  expect(daily).toMatchObject({
    cron: DAILY_CRON, schedule: 'Every day at 9:23 AM', recurring: true, durable: false, promptTruncated: true,
  })
  expect(daily.prompt).toBe(LONG_PROMPT.slice(0, SESSION_CRON_PROMPT_LIMIT))
  expect(daily.prompt).toHaveLength(SESSION_CRON_PROMPT_LIMIT)
  expect(daily.createdAt).toBeGreaterThanOrEqual(p1From)
  expect(daily.createdAt).toBeLessThanOrEqual(p1Until)
  expect(daily.expiresAt).toBe(daily.createdAt! + RECURRING_MAX_AGE)
  expectNextRun(daily.nextRunAt, DAILY_CRON, daily.createdAt!, p1Until)
  const once = job(p1, ONCE_ID)
  expect(once).toMatchObject({
    cron: ONCE_CRON, schedule: 'On January 1 at 12:00 AM', prompt: 'Ring in the new year',
    promptTruncated: false, recurring: false, durable: false,
  })
  expect(once.createdAt).toBeGreaterThanOrEqual(p1From)
  // A one-shot expires at the CLI's own (deliberately early) fire time, derived
  // from the cron expression, the creation time and the job id.
  expect(once.expiresAt).toBe(cliOneShotTime(ONCE_CRON, once.createdAt!, ONCE_ID, DEFAULT_CRON_RESTORE_CONFIG))
  expectNextRun(once.nextRunAt, ONCE_CRON, once.createdAt!, p1Until)
  expect(p1.validUntil).toBe(Math.max(daily.expiresAt!, once.expiresAt!))

  // ── P2: a list refreshes details without inventing a creation time ────────
  await runPhase('play phase 2')
  await expect.poll(async () => {
    const value = await readStatusCron()
    return value && ids(value).includes(DAILY_ID) ? job(value, DAILY_ID).schedule : null
  }, { timeout: 20_000, interval: 100 }).toBe('Daily at 9:23 AM')
  const p2 = await agreedValue()
  expect(p2).toMatchObject({ presence: 'active', source: 'cron', known: true })
  expect(ids(p2)).toEqual(ids(p1))
  const dailyListed = job(p2, DAILY_ID)
  expect(dailyListed.schedule).toBe('Daily at 9:23 AM')
  expect(dailyListed.createdAt).toBe(daily.createdAt)
  expect(dailyListed.expiresAt).toBe(daily.expiresAt)
  // The list carried the full prompt again, so the cut is still reported as one.
  expect(dailyListed.prompt).toHaveLength(SESSION_CRON_PROMPT_LIMIT)
  expect(dailyListed.promptTruncated).toBe(true)
  expect(job(p2, ONCE_ID)).toEqual(once)
  // A row seen ONLY in a list is deliberately never reported: the daemon does
  // not know when it was created, so `until` is the list time itself
  // (daemon-cron-metadata.ts CronList branch) and it is already expired by the
  // time the value is emitted. It still counts as a known job, which is why a
  // list-only row can only ever hold presence at 'unknown' — never 'active'.
  expect(ids(p2)).not.toContain(LISTED_ID)

  // ── P3: malformed, sidechain and subagent creates are ignored ─────────────
  const beforeNoise = frames.length
  await runPhase('play phase 3')
  // The probe pair is the only thing in P3 that publishes, so it is also the
  // proof that every earlier line in the phase has been through the tracker.
  await expect.poll(() => {
    const seen = frames.slice(beforeNoise)
    const probe = seen.findIndex((value) => ids(value).includes(PROBE_ID))
    return probe !== -1 && seen.slice(probe + 1).some((value) => !ids(value).includes(PROBE_ID))
  }, { timeout: 20_000, interval: 100 }).toBe(true)
  const p3 = await agreedValue()
  const noise = frames.slice(beforeNoise)
  // Nothing else ever entered the inventory during the phase.
  for (const value of noise) {
    expect(ids(value).every((id) => [DAILY_ID, ONCE_ID, PROBE_ID].includes(id))).toBe(true)
  }
  const probeFrame = noise.find((value) => ids(value).includes(PROBE_ID))!
  expect(ids(probeFrame)).toEqual(byNextRun([[DAILY_ID, DAILY_CRON], [ONCE_ID, ONCE_CRON], [PROBE_ID, PROBE_CRON]], p1From))
  // The details are back exactly where P2 left them.
  expect(p3.jobs).toEqual(p2.jobs)
  const wire = JSON.stringify(frames)
  for (const ignored of [SIDECHAIN_ID, SUBAGENT_ID, ...IGNORED_CRONS]) expect(wire).not.toContain(ignored)
  expect(wire).not.toContain('"id":123')

  // ── P4: deleting one of two keeps the other intact ────────────────────────
  await runPhase('play phase 4')
  await expect.poll(async () => ids(await readStatusCron()), { timeout: 20_000, interval: 100 }).toEqual([ONCE_ID])
  const p4 = await agreedValue()
  expect(p4).toMatchObject({ presence: 'active', source: 'cron', known: true, stale: false })
  expect(job(p4, ONCE_ID)).toEqual(once)
  expect(p4.validUntil).toBe(once.expiresAt)

  // ── P5: only the durable job is left — known, but never active ────────────
  await runPhase('play phase 5')
  await expect.poll(async () => (await readStatusCron())?.presence, { timeout: 20_000, interval: 100 }).toBe('unknown')
  const p5 = await agreedValue()
  expect(p5).toMatchObject({ presence: 'unknown', source: 'cron', known: true, stale: false, validUntil: null })
  expect(p5.jobs).toEqual([])

  // ── Restart 1: the same CLI is re-adopted and the state comes from replay ──
  await shutdownDaemon()
  await boot()
  const shape = (value: SessionCronMetadata | undefined) =>
    value && `${value.presence}/${value.source}/${value.known}/${value.stale}/${(value.jobs ?? []).length}`
  try {
    // source 'cron' can only come from a non-empty job map, so this is the
    // replay having rebuilt the durable row rather than a blank new daemon.
    await expect.poll(async () => shape(await readStatusCron()), { timeout: 30_000, interval: 100 }).toBe('unknown/cron/true/false/0')
  } catch (error) {
    throw new Error(JSON.stringify({
      metadata: await connection!.send('cron.metadata', {}),
      status: await connection!.send('status', { sid: SID }),
    }), { cause: error })
  }
  const replayed = await agreedValue()
  expect(replayed.jobs).toEqual([])
  expect((await connection!.send('status', { sid: SID })).pid).toBe(started.pid)

  // ── P6: the re-adopted process is still observed live ────────────────────
  const p6From = Date.now()
  await runPhase('play phase 6')
  await expect.poll(async () => ids(await readStatusCron()), { timeout: 20_000, interval: 100 }).toEqual([AFTER_ID])
  const p6 = await agreedValue()
  const p6Until = Date.now()
  expect(p6).toMatchObject({ presence: 'active', source: 'cron', known: true, stale: false })
  const after = job(p6, AFTER_ID)
  expect(after).toMatchObject({
    cron: AFTER_CRON, schedule: 'Every hour at :41', prompt: 'Sweep after the restart',
    promptTruncated: false, recurring: true, durable: false,
  })
  expect(after.createdAt).toBeGreaterThanOrEqual(p6From)
  expect(after.createdAt).toBeLessThanOrEqual(p6Until)
  expect(after.expiresAt).toBe(after.createdAt! + RECURRING_MAX_AGE)
  expectNextRun(after.nextRunAt, AFTER_CRON, after.createdAt!, p6Until)

  // ── Restart 2: replay reproduces the row, and takes its time from the CLI ──
  // The daemon never borrows its own clock for a replayed create: the row's
  // creation time is the stamp the CLI wrote, which is the same value the live
  // watcher took from the same line. So a job rebuilt from replay must come back
  // IDENTICAL to the one watched live, expiry included.
  await shutdownDaemon()
  await boot()
  await expect.poll(async () => ids(await readStatusCron()), { timeout: 30_000, interval: 100 }).toEqual([AFTER_ID])
  const afterRestart = await agreedValue()
  expect(afterRestart).toMatchObject({ presence: 'active', source: 'cron', known: true, stale: false })
  const replayedJob = job(afterRestart, AFTER_ID)
  expect(replayedJob.createdAt).toBeGreaterThanOrEqual(p6From)
  expect(replayedJob.createdAt).toBeLessThanOrEqual(p6Until)
  expect(replayedJob.expiresAt).toBe(replayedJob.createdAt! + RECURRING_MAX_AGE)
  // nextRunAt is compared on its own: it is recomputed against the clock, so the
  // two reads legitimately differ if the scheduled minute passes between them.
  expect({ ...replayedJob, nextRunAt: null }).toEqual({ ...after, nextRunAt: null })
  expectNextRun(replayedJob.nextRunAt, AFTER_CRON, replayedJob.createdAt!, Date.now())
  expect(p1From).toBeLessThanOrEqual(replayedJob.createdAt!)

  // ── The WS feed: one epoch, strictly increasing revisions, same tail ──────
  await expect.poll(async () => {
    const value = await readStatusCron()
    return value !== undefined && JSON.stringify(frames.at(-1)) === JSON.stringify(value)
  }, { timeout: 20_000, interval: 100 }).toBe(true)
  expect(frames.length).toBeGreaterThan(5)
  expect(new Set(frames.map((value) => value.epoch)).size).toBe(1)
  for (let i = 1; i < frames.length; i++) expect(frames[i].revision).toBeGreaterThan(frames[i - 1].revision)
  expect(frames.at(-1)).toEqual(await readStatusCron())
}, 240_000)

/**
 * A session spawned before cron bookkeeping existed has no `cronMetadataOrigin`
 * in the registry, so there is no spawn offset to attribute replayed lines by.
 * The daemon used to answer that by replaying from byte 0 and calling EVERY line
 * historical: the live process kept firing its crons while the pill was gone (the
 * 2026-09-16 report), and on a 1GB stream the 10s budget aborted on top of that.
 *
 * Adoption now attributes by TIME instead: the OS says when the live process
 * started, and a create the CLI stamped after that moment belongs to the process
 * that is still running. This test gives the adopt both kinds of evidence in one
 * stream — a create the live process really made (AFTER_ID, watched in P6) and a
 * create stamped an hour before the process existed (appended straight to the
 * stream file, the way a dead earlier process's output would sit there) — and
 * requires the first back and the second refused.
 */
it('recovers an adopted session job by process start time and refuses one older than the process', async () => {
  await shutdownDaemon()
  const registryFile = path.join(state, 'sessions.json')
  const registry = JSON.parse(await fs.readFile(registryFile, 'utf8'))
  const entries: Record<string, Record<string, unknown>> = registry.sessions ?? registry
  const entry = entries[SID]
  expect(entry, 'the fixture session must be in the registry').toBeTruthy()
  expect(entry.cronMetadataOrigin, 'a spawned session carries an origin').toBeTruthy()
  const spawnedOrigin = entry.cronMetadataOrigin as { offset: number; identity: string }
  delete entry.cronMetadataOrigin
  await fs.writeFile(registryFile, JSON.stringify(registry))

  // The dead earlier process's leftovers: a complete, well-formed create pair
  // whose only disqualification is its stamp.
  const streamFile = path.join(WALNUT_HOME, 'streams', `${SID}.jsonl`)
  const ancient = new Date(Date.now() - 3_600_000).toISOString()
  await fs.appendFile(streamFile, [
    JSON.stringify({ type: 'assistant', uuid: 'ghost-a', parentUuid: null, timestamp: ancient, message: { id: 'api-ghost', content: [{ type: 'tool_use', id: 'call-ghost', name: 'CronCreate', input: { cron: '*/29 * * * *', prompt: 'Job of a process that is gone' } }] } }),
    JSON.stringify({ type: 'user', uuid: 'ghost-b', parentUuid: 'ghost-a', timestamp: ancient, message: { content: [{ type: 'tool_result', tool_use_id: 'call-ghost' }] }, tool_use_result: { id: GHOST_ID, cron: '*/29 * * * *', humanSchedule: 'Every 29 minutes', recurring: true, durable: false } }),
  ].join('\n') + '\n')
  const bootedAt = Date.now()
  await boot()

  await expect.poll(async () => (await connection!.send('status', { sid: SID })).alive, { timeout: 30_000, interval: 100 }).toBe(true)
  // The armed job comes back with its own details, and the ghost never appears —
  // in either direction this is the discriminating evidence, because both rows
  // sit in the same replay and differ only in the stamp the CLI wrote.
  await expect.poll(async () => ids(await readStatusCron()), { timeout: 30_000, interval: 100 }).toEqual([AFTER_ID])
  const adopted = await agreedValue()
  expect(adopted).toMatchObject({ presence: 'active', source: 'cron', known: true, stale: false })
  const recovered = job(adopted, AFTER_ID)
  expect(recovered).toMatchObject({
    cron: AFTER_CRON, schedule: 'Every hour at :41', prompt: 'Sweep after the restart',
    promptTruncated: false, recurring: true, durable: false,
  })
  expect(recovered.createdAt).not.toBeNull()
  expect(recovered.expiresAt).toBe(recovered.createdAt! + RECURRING_MAX_AGE)
  expect(JSON.stringify(adopted)).not.toContain(GHOST_ID)
  expect(JSON.stringify(adopted)).not.toContain('Job of a process that is gone')

  // ── The record an EARLIER generation left behind ─────────────────────────────
  // Shipped live on 2026-09-16 and observed on the user's own host: the first fix
  // stamped a boundary origin at adopt, the registry kept it, and the next daemon
  // inherited that guess and reported no jobs again. A derived record is a guess
  // about a process this daemon never spawned, so it is re-derived — and a record
  // written before the marker existed is caught by its own inconsistency, because
  // an origin recorded at THIS process's spawn cannot claim a start long after the
  // OS says the process began.
  // Both shapes such a record comes in: marked (every record this build writes)
  // and unmarked (what the 2026-09-16 build left in live registries, recognised
  // by claiming a start later than the OS reports for the running process — here
  // the gap is manufactured, because the fixture process is seconds old while the
  // real one had been running for six days).
  for (const stale of [
    { marked: true, origin: { identity: spawnedOrigin.identity, startedAt: Date.now(), fresh: false, derived: true, byTime: false } },
    { marked: false, origin: { identity: spawnedOrigin.identity, startedAt: Date.now() + 60_000, fresh: false } },
  ]) {
    await shutdownDaemon()
    const stalest = JSON.parse(await fs.readFile(registryFile, 'utf8'))
    const staleEntries: Record<string, Record<string, unknown>> = stalest.sessions ?? stalest
    staleEntries[SID].cronMetadataOrigin = { ...stale.origin, offset: (await fs.stat(streamFile)).size }
    await fs.writeFile(registryFile, JSON.stringify(stalest))
    await boot()
    const label = stale.marked ? 'marked derived origin' : 'pre-marker derived origin'
    await expect.poll(async () => ids(await readStatusCron()), { timeout: 30_000, interval: 100 }).toEqual([AFTER_ID])
    const rederived = await agreedValue()
    expect(rederived, label).toMatchObject({ presence: 'active', source: 'cron', known: true, stale: false })
    expect({ ...job(rederived, AFTER_ID), nextRunAt: null }, label).toEqual({ ...recovered, nextRunAt: null })
    expect(JSON.stringify(rederived), label).not.toContain(GHOST_ID)
  }

  const logs = (await fs.readdir(runtime)).filter((name) => name.startsWith('daemon-') && name.endsWith('.log'))
  const text = (await Promise.all(logs.map((name) => fs.readFile(path.join(runtime, name), 'utf8')))).join('')
  expect(text).not.toContain('cron metadata replay failed')

  // And the live process is still watched: its next create is reported in full,
  // alongside the one the replay recovered.
  const from = Date.now()
  expect(await connection!.send('send', { sid: SID, message: 'play phase 7' })).toMatchObject({ ok: true })
  await expect.poll(async () => [...ids(await readStatusCron())].sort(), { timeout: 30_000, interval: 100 })
    .toEqual([AFTER_ID, LEGACY_ID].sort())
  const value = await agreedValue()
  const until = Date.now()
  expect(value).toMatchObject({ presence: 'active', source: 'cron', known: true, stale: false })
  const legacy = job(value, LEGACY_ID)
  expect(legacy).toMatchObject({
    cron: LEGACY_CRON, schedule: 'Every 19 minutes', prompt: 'Watch the queue',
    promptTruncated: false, recurring: true, durable: false,
  })
  expect(legacy.createdAt).toBeGreaterThanOrEqual(from)
  expect(legacy.createdAt).toBeLessThanOrEqual(until)
  expect(legacy.expiresAt).toBe(legacy.createdAt! + RECURRING_MAX_AGE)
  expectNextRun(legacy.nextRunAt, LEGACY_CRON, legacy.createdAt!, until)

  // A pure adopt does not flush the registry (only start, reap and the init line
  // do), so the synthesized origin lives in memory until the next flush. That is
  // fine: each generation re-derives the process start from the OS, and this run
  // proves that derived start is what the tracker attributed by.
  const stillMissing = JSON.parse(await fs.readFile(registryFile, 'utf8'))
  expect((stillMissing.sessions ?? stillMissing)[SID]).toBeTruthy()
  expect(spawnedOrigin.offset).toBeGreaterThanOrEqual(0)
  expect(bootedAt).toBeLessThanOrEqual(from)
}, 180_000)
