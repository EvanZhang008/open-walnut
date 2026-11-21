/**
 * A trigger loses nothing and delivers nothing twice across a daemon restart, against BOTH real
 * twins (the standalone twin under bun, the source twin under node with its sidecars).
 *
 * The four ways a restart meets a trigger:
 *   1. the daemon dies while a check runs: the run left nothing, so the next daemon's first cycle
 *      reads from the cursor the last FINISHED check saved, and the item the killed run saw fires once;
 *   2. the daemon dies after it sent a fire and before the server acked it: the next daemon sends the
 *      same (id, epoch, seq) again, and the server's dedup (trigger-apply.ts) records it once;
 *   3. the daemon dies after it wrote a fire into a live session itself (a fire no server claimed)
 *      and before that mark was saved: the next daemon delivers it again under the SAME message id
 *      (trigger-check-core.ts fireMessageId), and the session's line record writes nothing;
 *   4. something happened only once while no daemon ran: a check that keeps its place in its own
 *      state ("since the last ack") still finds it, and one that looks only at "now" cannot.
 *
 * What's real: the daemon twins, node check scripts, the state files, the timers, a stand-in CLI
 * reading its FIFO, the server's cron store and dedup. What's faked: the server is a bare WS client.
 * MACHINE SAFETY: every dir is a temp dir; the test signals only processes it started (its daemons'
 * groups, the checks and the CLIs they spawned, by the pids they reported), all > 1.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-trigger-restart-once'))

import { WALNUT_HOME } from '../../src/constants.js'
import * as ops from '../../src/core/cron/ops.js'
import { applyTriggerFired } from '../../src/core/cron/trigger-apply.js'
import type { CronServiceState } from '../../src/core/cron/types.js'
import { fireMessageId, hostBatch, markHostBatch, triggerStateFileName, type PendingFire, type TriggerFiredEvent, type TriggerHostState } from '../../src/providers/trigger-check-core.js'
import { guardedPath } from '../setup/exec-guard.js'
import { TRIGGER_BUN as BUN, TriggerDaemon, buildSourceTwin, killTriggerDaemons, sleep, waitFor, type Twin } from '../helpers/trigger-daemon.js'

describe('hostBatch: a host delivery cut by a restart goes again as the same batch, by the same id', () => {
  const fire = (seq: number): PendingFire => ({ seq, atMs: 1_000 + seq, items: [], durationMs: 1, arbitrated: true })
  it('a first try takes every due fire under a new id; once marked, a later try with a grown due set sends only that batch', () => {
    const state = { pendingFires: [fire(1), fire(2)] } as unknown as TriggerHostState
    const first = hostBatch(state.pendingFires, 'job-1', 'ep1')
    expect(first.seqs).toEqual([1, 2])
    expect(first.messageId).toBe(fireMessageId('job-1', 'ep1', [1, 2]))
    markHostBatch(state, first.seqs, first.messageId)
    // The daemon died after the write, before the mark; a new fire became due meanwhile.
    state.pendingFires.push(fire(3))
    const again = hostBatch(state.pendingFires, 'job-1', 'ep1')
    expect(again.seqs).toEqual([1, 2])
    expect(again.messageId).toBe(first.messageId)
    // Once that batch is marked delivered (and acked away), the new fire goes on its own.
    const next = hostBatch(state.pendingFires.filter((f) => f.seq === 3), 'job-1', 'ep1')
    expect(next).toMatchObject({ seqs: [3], messageId: fireMessageId('job-1', 'ep1', [3]) })
  })
})

describe('fireMessageId: one id per set of fires, whoever delivers it and however often', () => {
  it('is stable for the same trigger, epoch and seqs in any order, and differs for any other', () => {
    const id = fireMessageId('job-1', 'abcdef012345', [3, 1, 2])
    expect(id).toMatch(/^qm-trigger-f[0-9a-f]{20}$/)
    expect(fireMessageId('job-1', 'abcdef012345', [1, 2, 3])).toBe(id)
    expect(fireMessageId('job-1', 'abcdef012345', [2, 3, 1])).toBe(id)
    for (const other of [
      fireMessageId('job-1', 'abcdef012345', [1, 2]),
      fireMessageId('job-1', 'abcdef012345', [1, 2, 3, 4]),
      fireMessageId('job-1', 'abcdef012345', [12, 3]),
      fireMessageId('job-1', '000000000000', [1, 2, 3]),
      fireMessageId('job-2', 'abcdef012345', [1, 2, 3]),
      fireMessageId('job-1', undefined, [1, 2, 3]),
    ]) expect(other).not.toBe(id)
    // The caller's list is not reordered under it.
    const seqs = [3, 1, 2]
    fireMessageId('job-1', 'e', seqs)
    expect(seqs).toEqual([3, 1, 2])
  })
})

const base = BUN ? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-trig-once-'))) : ''
afterAll(() => { if (base.includes('walnut-trig-once-')) fs.rmSync(base, { recursive: true, force: true }) })
const BIN = path.join(base, 'bin')
if (BUN) buildSourceTwin(BIN)

/** Processes the daemons spawned detached (checks, CLIs) that a SIGKILLed daemon leaves behind. */
const orphans = new Set<number>()
afterEach(() => {
  killTriggerDaemons()
  for (const pid of orphans) {
    if (pid > 1) { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
  }
  orphans.clear()
})

/** One host's dirs, kept across its daemon's restarts. */
function host(twin: Twin, name: string, extraEnv: Record<string, string> = {}) {
  const t = fs.mkdtempSync(path.join(base, `${twin}-${name}-`))
  const dir = (n: string) => path.join(t, n)
  for (const n of ['h', 'tmp']) fs.mkdirSync(dir(n))
  const HOME = dir('h')
  const env: Record<string, string> = {
    HOME, PATH: guardedPath([], '/usr/bin:/bin'), TMPDIR: dir('tmp'), LANG: 'C', SHELL: '/bin/sh',
    WALNUT_DAEMON_DIR: dir('run'), WALNUT_TRIGGER_STATE_DIR: dir('durable'),
    WALNUT_STREAMS_DIR: dir('st'), WALNUT_LEGACY_STREAMS_DIR: dir('ls'), WALNUT_SPAWN_JOURNAL: dir('sj.jsonl'),
    WALNUT_JOURNAL_DIR: dir('j'), WALNUT_TASK_DIR_ROOT: dir('tasks'), WALNUT_TRIGGER_REPLAY_MS: '1500',
    // The daemon ends with this test process, whatever happens to the test.
    WALNUT_DAEMON_PARENT_PID: String(process.pid),
    XDG_STATE_HOME: path.join(HOME, '.local', 'state'), XDG_CONFIG_HOME: path.join(HOME, '.config'),
    XDG_CACHE_HOME: path.join(HOME, '.cache'), XDG_DATA_HOME: path.join(HOME, '.local', 'share'),
    ...extraEnv,
  }
  return {
    dir, env,
    /** Start this host's daemon (again), and say hello as a server does. */
    async start(): Promise<TriggerDaemon> {
      const d = await TriggerDaemon.start(twin, { mode: '--start', env, runDir: dir('run'), cwd: HOME, bin: BIN })
      const hello = await d.rpc({ cmd: 'hello' })
      expect(hello.capabilities as string[]).toContain('triggers-v1')
      return d
    },
    statePath: (id: string) => path.join(dir('durable'), triggerStateFileName(id)),
    state(id: string): TriggerHostState { return JSON.parse(fs.readFileSync(this.statePath(id), 'utf8')) as TriggerHostState },
  }
}

const itemIds = (fire: Record<string, unknown>) => (fire.items as Array<{ id: string }>).map((i) => i.id)
const node = (script: string, ...args: string[]) => [process.execPath, script, ...args].map((a) => JSON.stringify(a)).join(' ')
const configure = (d: TriggerDaemon, triggers: Array<Record<string, unknown>>) =>
  d.rpc({ cmd: 'triggers.configure', config: { version: 1, triggers } })

/**
 * A check that keeps its place in an append-only log in its own state: every line after the cursor
 * is an item, and the cursor moves to the end. It notes each run (pid, cursor, what it saw) in
 * `runs`, and while `hold` exists it waits 20 s before it answers (a slow source).
 */
const CURSOR_CHECK = [
  "const fs = require('fs')",
  'const [log, runs, hold] = process.argv.slice(2)',
  "let raw = ''",
  "process.stdin.on('data', (c) => { raw += c }).on('end', () => {",
  "  const input = JSON.parse(raw || '{}')",
  '  const cursor = (input.state && input.state.cursor) || 0',
  "  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean) : []",
  '  const fresh = lines.slice(cursor)',
  "  fs.appendFileSync(runs, JSON.stringify({ pid: process.pid, cursor, saw: fresh }) + '\\n')",
  '  const answer = () => console.log(JSON.stringify({ fire: fresh.length > 0, items: fresh.map((id) => ({ id })), state: { cursor: lines.length } }))',
  '  if (hold && fs.existsSync(hold)) setTimeout(answer, 20000)',
  '  else answer()',
  '})',
].join('\n') + '\n'

/** A check that looks only at "now": it fires while a file exists. */
const PRESENCE_CHECK = [
  "const fs = require('fs')",
  "process.stdin.resume().on('end', () => {",
  '  const there = fs.existsSync(process.argv[2])',
  "  console.log(JSON.stringify({ fire: there, items: there ? [{ id: 'drop' }] : [] }))",
  '})',
].join('\n') + '\n'

function cursorWatch(h: ReturnType<typeof host>, id: string) {
  const files = { check: h.dir('cursor-check.cjs'), log: h.dir('events.log'), runs: h.dir('runs.jsonl'), hold: h.dir('hold') }
  fs.writeFileSync(files.check, CURSOR_CHECK)
  const runs = (): Array<{ pid: number; cursor: number; saw: string[] }> =>
    fs.existsSync(files.runs) ? fs.readFileSync(files.runs, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const def = { id, name: id, everyMs: 3_600_000, check: { run: node(files.check, files.log, files.runs, files.hold), timeoutSeconds: 60 } }
  return { ...files, runs, def }
}

/** The server's store with one check routine of this id (the daemon's trigger id is the job id). */
function cronState(): CronServiceState {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis() } as any
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
  return {
    deps: {
      nowMs: () => Date.now(), log, storePath: path.join(WALNUT_HOME, `cron-${Math.random().toString(36).slice(2)}.json`), cronEnabled: false,
      broadcastCronNotification: vi.fn(), runMainAgentWithPrompt: vi.fn(), runIsolatedAgentJob: vi.fn(), runExecutor: vi.fn(), onEvent: vi.fn(),
    },
    store: null, timer: null, running: false, op: Promise.resolve(), warnedDisabled: false, replayGuard: new Map(),
  } as unknown as CronServiceState
}

/** The event as the server's connection hands it on (daemon-connection.ts dispatchTriggerEvent). */
function asFired(frame: Record<string, unknown>): TriggerFiredEvent {
  const { ev: _ev, replay: _replay, ...rest } = frame
  return { type: 'trigger.fired', ...rest } as unknown as TriggerFiredEvent
}

const TWINS: Twin[] = BUN ? ['standalone', 'source'] : []

describe.skipIf(!BUN).each(TWINS)('a trigger across a daemon restart (%s twin)', (twin) => {
  it('1. a check killed mid-run reruns on the next daemon\'s first cycle from the old cursor: what it saw fires once', async () => {
    const h = host(twin, 'killed')
    const ID = 'log-watch'
    const w = cursorWatch(h, ID)
    fs.writeFileSync(w.log, 'a\nb\n')
    const a = await h.start()
    expect(await configure(a, [w.def])).toMatchObject({ ok: true })
    await a.runOnce(ID)
    const [first] = a.fires(ID)
    expect(itemIds(first)).toEqual(['a', 'b'])
    expect(await a.rpc({ cmd: 'triggers.ack', triggerId: ID, seq: first.seq })).toMatchObject({ acked: true })
    const before = h.state(ID)
    expect(before.state).toEqual({ cursor: 2 })

    // c arrives; the next run reads it (and would move the cursor to 3), but the daemon dies first.
    fs.appendFileSync(w.log, 'c\n')
    fs.writeFileSync(w.hold, '')
    const seen = w.runs().length
    void a.rpc({ cmd: 'triggers.run', triggerId: ID }).catch(() => { /* the daemon is killed under it */ })
    const killed = await waitFor(() => w.runs().slice(seen).find((r) => r.saw.includes('c')), 20_000, 'the run that saw c')
    orphans.add(killed.pid)
    await a.kill()
    try { process.kill(killed.pid, 'SIGKILL') } catch { /* already gone */ }
    // The killed run left nothing: the cursor, the numbering and the queue are the last finished run's.
    const after = h.state(ID)
    expect(after).toMatchObject({ epoch: before.epoch, seq: before.seq, state: { cursor: 2 }, pendingFires: [] })
    expect(after.seen).not.toHaveProperty('c')

    // The next daemon runs it by itself on its first cycle (no triggers.run), from cursor 2.
    fs.rmSync(w.hold)
    const b = await h.start()
    await waitFor(() => (h.state(ID).seq === before.seq + 1 ? true : undefined), 45_000, 'the next daemon\'s first cycle')
    expect(w.runs().at(-1)).toMatchObject({ cursor: 2, saw: ['c'] })
    expect(await configure(b, [w.def])).toMatchObject({ ok: true, count: 1 })
    const rerun = await waitFor(() => b.fires(ID)[0], 10_000, 'the fire of the rerun')
    expect(itemIds(rerun)).toEqual(['c'])
    expect(rerun).toMatchObject({ epoch: before.epoch, seq: before.seq + 1 })
    expect(await b.rpc({ cmd: 'triggers.ack', triggerId: ID, seq: rerun.seq })).toMatchObject({ acked: true })
    expect(h.state(ID).state).toEqual({ cursor: 3 })

    // And c is never told again.
    await b.runOnce(ID)
    expect(b.checks(ID).at(-1)).toMatchObject({ outcome: 'quiet', reason: 'fire-false' })
    const told = [...a.fires(ID), ...b.fires(ID)].flatMap(itemIds)
    expect(told).toEqual(['a', 'b', 'c'])
  }, 150_000)

  it('2. a fire sent but never acked is sent again by the next daemon with the same id, epoch and seq; the server records it once', async () => {
    const h = host(twin, 'unacked')
    const ID = 'pr-watch'
    const cron = cronState()
    await ops.add(cron, {
      name: 'PR watch', enabled: true, wakeMode: 'now', schedule: { kind: 'every', everyMs: 3_600_000 },
      executor: { type: 'session', config: { target: 't-owner', prompt: 'Read the new comments' } },
      check: { run: 'true', host: 'devbox' },
    } as any, { id: ID })
    const w = cursorWatch(h, ID)
    fs.writeFileSync(w.log, 'comment-1\ncomment-2\n')

    const a = await h.start()
    expect(await configure(a, [w.def])).toMatchObject({ ok: true })
    await a.runOnce(ID)
    const [sent] = a.fires(ID)
    expect(itemIds(sent)).toEqual(['comment-1', 'comment-2'])
    // Delivered to the server, and the daemon dies before the ack comes.
    await a.kill()
    expect(h.state(ID).pendingFires.map((f) => f.seq)).toEqual([sent.seq])

    const b = await h.start()
    expect(await configure(b, [w.def])).toMatchObject({ ok: true, count: 1 })
    const again = await waitFor(() => b.fires(ID)[0], 15_000, 'the replay')
    expect(again.replay).toBe(true)
    expect({ id: again.id, epoch: again.epoch, seq: again.seq, items: again.items })
      .toEqual({ id: sent.id, epoch: sent.epoch, seq: sent.seq, items: sent.items })
    // The id the server's delivery gives the message (trigger-events.ts deliverFires) is the same too.
    expect(fireMessageId(ID, again.epoch as string, [again.seq as number])).toBe(fireMessageId(ID, sent.epoch as string, [sent.seq as number]))

    // The server took the first one before the restart; the replay is recorded, never delivered.
    const deliver = vi.fn(async () => ({ status: 'ok' as const, summary: 'sent to session' }))
    const first = await applyTriggerFired(cron, asFired(sent), deliver)
    expect(first).toMatchObject({ found: true, duplicate: false, delivered: true })
    const replay = await applyTriggerFired(cron, asFired(again), deliver)
    expect(replay).toMatchObject({ found: true, duplicate: true, delivered: false })
    expect(deliver).toHaveBeenCalledTimes(1)
    const job = (await ops.list(cron, { includeDisabled: true, recompute: false })).find((j) => j.id === ID)!
    expect(job.state).toMatchObject({ lastFireSeq: sent.seq, lastFireEpoch: sent.epoch, fireCount: 1 })

    // The ack the server sends then ends the replays; the next check tells nothing again.
    expect(await b.rpc({ cmd: 'triggers.ack', triggerId: ID, seq: again.seq })).toMatchObject({ acked: true })
    expect(h.state(ID).pendingFires).toEqual([])
    await b.runOnce(ID)
    expect(b.checks(ID).at(-1)).toMatchObject({ outcome: 'quiet' })
    expect(b.fires(ID)).toHaveLength(1)
  }, 150_000)

  it('3. a host delivery whose mark was lost is delivered again under the same id, and the session keeps one', async () => {
    const h = host(twin, 'host', { WALNUT_TRIGGER_HOST_GRACE_MS: '1500' })
    const ID = 'chat-watch'
    const WALNUT = '/fixture/walnut-home'
    const TASK = 'mchat000-0b27'
    const SID = 'eeeeeeee-6666-4666-8666-666666666666'
    const PROMPT = 'New chat messages are in this fire. Handle each one.'
    const items = h.dir('items.json')
    const inbox = h.dir('inbox.jsonl')
    const cli = h.dir('mock-cli.cjs')
    // A stand-in CLI: every user line it reads lands in its inbox.
    fs.writeFileSync(cli, [
      "const fs = require('fs')",
      'const [sid, inbox] = process.argv.slice(2)',
      "const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')",
      "out({ type: 'system', subtype: 'init', session_id: sid })",
      "out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })",
      "out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })",
      "let buf = ''",
      "process.stdin.on('data', (chunk) => {",
      "  buf += chunk.toString('utf8')",
      '  let nl',
      "  while ((nl = buf.indexOf('\\n')) !== -1) {",
      '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)',
      '    let msg; try { msg = JSON.parse(line) } catch { continue }',
      "    if (msg.type === 'user') fs.appendFileSync(inbox, JSON.stringify({ content: msg.message && msg.message.content }) + '\\n')",
      '  }',
      '})',
      'setInterval(() => {}, 1 << 30)',
    ].join('\n') + '\n')
    fs.writeFileSync(items, JSON.stringify({ fire: true, items: [{ id: 'm1', text: 'msg m1' }] }) + '\n')
    const told = (): string[] => {
      try { return fs.readFileSync(inbox, 'utf8').split('\n').filter(Boolean).map((l) => String(JSON.parse(l).content)) } catch { return [] }
    }
    const fireLines = () => told().filter((c) => c.includes('<walnut-message kind="trigger"') && c.includes('"m1"'))
    // noResume: a session the next daemon has not adopted yet is never started again for the fire.
    const slice = {
      v: 1, home: WALNUT, hash: 'h1', asOf: Date.now(), host: 'devbox',
      sessions: [{ sid: SID, taskId: TASK, title: 'Chat loop', noResume: true }],
      tasks: [{ id: TASK, title: 'Monitor chat', phase: 'IN_PROGRESS', project: 'Ops' }],
      requests: [],
    }
    const def = {
      id: ID, name: 'Chat monitor', everyMs: 3_600_000,
      check: { run: `cat ${JSON.stringify(items)}`, timeoutSeconds: 10 },
      deliver: { home: WALNUT, taskId: TASK, prompt: PROMPT },
    }

    const a = await h.start()
    const started = await a.rpc({
      cmd: 'start', sid: SID, cwd: h.dir('h'), message: 'init',
      args: [process.execPath, cli, SID, inbox], origin: { home: WALNUT, task: TASK },
    })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    if (typeof started.pid === 'number') orphans.add(started.pid)
    await waitFor(() => {
      try { return fs.readFileSync(path.join(h.dir('st'), `${SID}.jsonl`), 'utf8').includes('"state":"idle"') ? true : undefined } catch { return undefined }
    }, 20_000, 'the session idle')
    expect((await a.rpc({ cmd: 'host.slice', slice })).ok).toBe(true)
    expect(await configure(a, [def])).toMatchObject({ ok: true })
    // The server never claims (the Mac asleep behind a connected socket): the host delivers it.
    await a.runOnce(ID)
    await waitFor(() => (fireLines().length > 0 ? true : undefined), 30_000, 'the fire in the session')
    const mark = await waitFor(() => h.state(ID).pendingFires.find((f) => f.seq === 1 && f.host)?.host, 10_000, 'the host delivery recorded')
    const epoch = h.state(ID).epoch
    expect(mark.messageId).toBe(fireMessageId(ID, epoch, [1]))

    // The daemon dies between the write and the mark: what a SIGKILL there leaves on disk is the
    // fire without its mark. The CLI lives on, as it does on a real host.
    await a.kill()
    const raw = JSON.parse(fs.readFileSync(h.statePath(ID), 'utf8')) as TriggerHostState
    for (const f of raw.pendingFires) { delete f.host; delete f.hostTriedAt }
    fs.writeFileSync(h.statePath(ID), JSON.stringify(raw))

    const b = await h.start()
    await b.rpc({ cmd: 'host.slice', slice: { ...slice, asOf: Date.now() } })
    // A minute and a half covers one retry, should the first try beat the session's adoption.
    const again = await waitFor(() => h.state(ID).pendingFires.find((f) => f.seq === 1 && f.host)?.host, 90_000, 'the delivery again')
    expect(again.messageId, 'the same id on the second try').toBe(mark.messageId)
    expect(again.sessionId).toBe(SID)
    await sleep(1_000)
    expect(fireLines(), 'the session got the fire once').toHaveLength(1)
    // And it is the line record that kept it out (send-dedupe-v1), not a delivery that never ran.
    const logs = fs.readdirSync(h.dir('run')).filter((f) => f.endsWith('.log')).map((f) => fs.readFileSync(path.join(h.dir('run'), f), 'utf8')).join('\n')
    expect(logs.split('\n').some((l) => l.includes('the line was not written again') && l.includes(mark.messageId))).toBe(true)
  }, 200_000)

  it('4. a once-only event while no daemon ran is caught by the next check from its saved cursor; a check of "now" misses it', async () => {
    const h = host(twin, 'down')
    const LOG_ID = 'drop-log-watch'
    const NOW_ID = 'drop-file-watch'
    const w = cursorWatch(h, LOG_ID)
    const drop = h.dir('drop.json')
    const presence = h.dir('presence-check.cjs')
    fs.writeFileSync(presence, PRESENCE_CHECK)
    const nowDef = { id: NOW_ID, name: NOW_ID, everyMs: 3_600_000, check: { run: node(presence, drop) } }
    fs.writeFileSync(w.log, 'drop-0\n')

    const a = await h.start()
    expect(await configure(a, [w.def, nowDef])).toMatchObject({ ok: true, count: 2 })
    await a.runOnce(LOG_ID)
    const [first] = a.fires(LOG_ID)
    expect(itemIds(first)).toEqual(['drop-0'])
    expect(await a.rpc({ cmd: 'triggers.ack', triggerId: LOG_ID, seq: first.seq })).toMatchObject({ acked: true })
    await a.runOnce(NOW_ID)
    expect(a.checks(NOW_ID).at(-1)).toMatchObject({ outcome: 'quiet', reason: 'fire-false' })
    await a.stop()

    // While no daemon runs: a file appears and is gone again; its producer logged it.
    fs.writeFileSync(drop, '{}')
    fs.appendFileSync(w.log, 'drop-1\n')
    fs.rmSync(drop)

    const b = await h.start()
    expect(await configure(b, [w.def, nowDef])).toMatchObject({ ok: true, count: 2 })
    // The next daemon's own first cycle finds it, from the cursor the last acked run saved.
    await waitFor(() => (h.state(LOG_ID).seq === first.seq + 1 ? true : undefined), 45_000, 'the first cycle of the next daemon')
    const caught = await waitFor(() => b.fires(LOG_ID)[0], 10_000, 'its fire')
    expect(itemIds(caught)).toEqual(['drop-1'])
    expect(w.runs().at(-1)).toMatchObject({ cursor: 1, saw: ['drop-1'] })
    expect(await b.rpc({ cmd: 'triggers.ack', triggerId: LOG_ID, seq: caught.seq })).toMatchObject({ acked: true })
    // The check of "now" cannot know it ever happened.
    await b.runOnce(NOW_ID)
    expect(b.checks(NOW_ID).at(-1)).toMatchObject({ outcome: 'quiet', reason: 'fire-false' })
    expect(b.fires(NOW_ID)).toEqual([])
    expect(h.state(NOW_ID).seq).toBe(0)
  }, 150_000)
})
