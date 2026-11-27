/**
 * The running server's side of the sessions in the data home across a switch (home-sessions.ts): the real session
 * store, this machine's own session runtime and its processes. Loaded only by a switch stop, a rollback's settle and
 * the new leader's first lead (web/routes/leader-switch.ts, web/server.ts).
 *
 * The stop goes only through the owning runtime (the `stop` command of this machine's own daemon, reason
 * leader_switch, with this home and the stop's id): the server never signals a pid itself. The daemon answers once
 * the session's process group is gone (an ACP worker by its own strict stop), with its cron supervision off.
 *
 * What a switch left to do here (place the records after the commit, settle the sessions after a rollback) is tried
 * until it is done, on a slow timer, never given up while the server runs: until then those sessions stay held (no
 * message reaches them), and the switch's notes say why (`walnut leader switch --status`).
 */
import type { SessionRecord } from '../../types.js'
import type { HomeStopDeps, RollbackDeps } from './home-sessions.js'
import type { PlaceDeps } from './session-carry.js'

/** The capability a daemon names when it takes the switch's stop and refuses starts in a marked home. */
export const HOME_STOP_CAPABILITY = 'leader-switch-home-stop-v1'

/** The answer of the stop's own time bound when the daemon has not answered. */
export const STOP_ANSWER_MS = 30_000

/** The slowest retry of what a switch left to do here. */
const RETRY_MAX_MS = 5 * 60_000

async function store() {
  return import('../../session-tracker.js')
}

async function save(sid: string, patch: Partial<SessionRecord>): Promise<void> {
  await (await store()).updateSessionRecord(sid, patch as never)
}

/**
 * Why this machine's own session runtime cannot take the switch's stop now, or null (the preflight asks it). `live`:
 * CLIs of the class running now. A runtime not connected stops nothing and starts nothing: refused only when such a
 * CLI runs (nothing could stop it).
 */
export async function homeStopRuntimeRefusal(live: number): Promise<string | null> {
  const [{ getConnectedDaemonConnection }, { needCapability }] = await Promise.all([import('../../../providers/daemon-connection.js'), import('../../../providers/daemon-capability-need.js')])
  const conn = getConnectedDaemonConnection('__local__')
  if (!conn?.connected) return live ? `this machine's session runtime (its own daemon) is not connected, so the ${live} session(s) running in the data home could not be stopped for the switch` : null
  if (!conn.capabilitiesKnown) return 'this machine\'s session runtime has not said what it can do yet'
  if (!needCapability(conn, HOME_STOP_CAPABILITY)) return `this machine's session runtime lacks ${HOME_STOP_CAPABILITY} (update Walnut here): it cannot stop the sessions in the data home for a switch, nor refuse new ones there`
  return null
}

/** The id the runtime knows a session by: an ACP worker's runtime id, else the session's own id. */
export function stopTargetOf(rec: Pick<SessionRecord, 'claudeSessionId' | 'acpRuntimeId'>): string {
  return rec.acpRuntimeId || rec.claudeSessionId
}

/**
 * A runtime's answer to the leader_switch stop, in the stop's terms: done, or why not. Done is a process gone, or
 * nothing of the session held there at all (`not_journaled`, which the runtime answers only then). A runtime that
 * holds the session but would not stop it (`held`: no record of who started it) fails the stop, named: its process
 * could go on writing the old home.
 */
export function stopAnswer(reply: Record<string, unknown>, describe: (r: Record<string, unknown>) => string): { ok: true } | { ok: false; why: string } {
  if (reply.ok === true && (reply.stopped === true || reply.noop === true)) return { ok: true }
  if (reply.ok === true && reply.held !== true && reply.reason === 'not_owned' && reply.detail === 'not_journaled') return { ok: true }
  if (reply.ok === true && reply.held === true && reply.detail === 'no_owner_record') {
    return { ok: false, why: `this machine's session runtime holds it (${String(reply.kind ?? 'a process')}${typeof reply.pid === 'number' ? ` ${reply.pid}` : ''}) with no record of who started it, so it would not stop it: end it by hand, then run the switch again` }
  }
  return { ok: false, why: reply.ok === false ? String(reply.error ?? 'refused') : describe(reply) }
}

export async function homeStopDeps(home: string): Promise<HomeStopDeps> {
  const [{ listSessions }, { getConnectedDaemonConnection }, { readSessionSupervision }, { describeStopRefusal }, { processesInFolders }, { judgeOf }, { needCapability }, fs, path, { localEngineDir }] = await Promise.all([
    store(), import('../../../providers/daemon-connection.js'), import('../../sessions/session-supervision.js'),
    import('../../sessions/stop-provenance.js'), import('../../../lib/home-processes.js'), import('../../sessions/judge-of.js'),
    import('../../../providers/daemon-capability-need.js'), import('node:fs'), import('node:path'), import('./session-carry.js'),
  ])
  const engineDir = await localEngineDir().catch(() => null)
  return {
    list: listSessions,
    save,
    supervised: async (sid) => ((await readSessionSupervision(sid)).supervision as { enabled?: unknown } | null)?.enabled === true,
    stop: async (rec, stopRequestId) => {
      // The class holds only rows this leader judges (home-sessions.ts ownDaemonRow); asked again at the send.
      if (judgeOf(rec.claudeSessionId) === 'host') return { ok: false, why: 'a host judges this session, so this machine\'s runtime may not stop it' }
      const conn = getConnectedDaemonConnection('__local__')
      if (!conn?.connected) return { ok: false, why: 'this machine\'s session runtime is not connected' }
      if (!needCapability(conn, HOME_STOP_CAPABILITY)) return { ok: false, why: `this machine's session runtime lacks ${HOME_STOP_CAPABILITY}` }
      // An ACP session's worker is named by its runtime id (the daemon routes it to the worker's strict stop).
      const reply = await conn.send('stop', { sid: stopTargetOf(rec), reason: 'leader_switch', stopRequestId, home, initiator: 'automatic' }, STOP_ANSWER_MS)
      return stopAnswer(reply as Record<string, unknown>, describeStopRefusal as (r: Record<string, unknown>) => string)
    },
    processesInHome: (spellings) => processesInFolders(spellings),
    transcriptExists: async (folder, sid) => !!engineDir && fs.existsSync(path.join(engineDir, 'projects', folder, `${sid}.jsonl`)),
    now: Date.now,
  }
}

export async function rollbackDeps(): Promise<RollbackDeps> {
  const [{ listSessions }, { getConnectedDaemonConnection }, { judgeOf }] = await Promise.all([store(), import('../../../providers/daemon-connection.js'), import('../../sessions/judge-of.js')])
  return {
    list: listSessions,
    save,
    reenable: async (sid, stopFence) => {
      if (judgeOf(sid) === 'host') throw new Error('a host judges this session, so this machine\'s runtime does not supervise it')
      const conn = getConnectedDaemonConnection('__local__')
      if (!conn?.connected) throw new Error('this machine\'s session runtime is not connected')
      // The switch's stop turned supervision off with no fence of its own; a user's earlier stop left its fence there.
      const reply = await conn.send('cron.supervision', { sid, enabled: true, ...(stopFence ? { stopFence } : {}) }, 5_000)
      // The runtime's own refusal (no saved launch settings, say): asking again would not change it.
      if (reply.ok !== true) return `the runtime would not turn its cron supervision on again: ${String(reply.error ?? 'refused')}`
    },
    resume: async () => {
      // Restart recovery's pass over pending losses (a boot runs it again after its reconcile: a tracked one is skipped).
      const { getSessionAutoRecover } = await import('../../session-auto-recover.js')
      await getSessionAutoRecover()?.resumeUnfinished()
    },
    release: releaseHeld,
  }
}

/** The rows held for the switch go out again, and the session's waiting rows are delivered here now. */
async function releaseHeld(sid: string): Promise<void> {
  const [{ releaseMoveHeldRows }, { deliverSessionHere }] = await Promise.all([import('../../sessions/engine-switch-io.js'), import('../../../providers/host-handover.js')])
  await releaseMoveHeldRows(sid)
  deliverSessionHere(sid)
}

export async function placeDeps(): Promise<PlaceDeps> {
  const [{ listSessions }, { log }] = await Promise.all([store(), import('../../../logging/index.js')])
  return {
    list: listSessions,
    save,
    end: async (sid, why) => { await save(sid, { archived: true, archive_reason: 'leader_switch', errorMessage: why } as Partial<SessionRecord>) },
    release: releaseHeld,
    startIdle: async (sid) => {
      const { restartSession } = await import('../../sessions/session-lifecycle.js')
      await restartSession(sid)
    },
    log: (level, msg, data) => log.session[level](msg, data),
  }
}

/** A note of this machine in `switchId` (switch-notes.ts): what it still holds and why, read by `--status`. */
async function sessionsNote(home: string, switchId: string, machine: string, step: 'sessions-held' | 'sessions-settled', why?: string): Promise<void> {
  try {
    const { notesAccessOf, writeSwitchNote } = await import('./switch-notes.js')
    const access = await notesAccessOf(home, process.env)
    if (access) await writeSwitchNote(access, { switchId, machine, step, ...(why ? { why } : {}) })
  } catch { /* a note is only what --status prints */ }
}

/**
 * Runs `attempt` until it says done (true), waiting longer each time (at most RETRY_MAX_MS), or until it gives a final
 * answer (false): a failure or a not-yet is tried again, never given up.
 */
export async function untilDone(attempt: () => Promise<{ done: true } | { done: false; why: string; final?: boolean }>, o: { firstMs?: number; maxMs?: number; onWait?: (why: string, n: number) => Promise<void> | void; onFinal?: (why: string) => Promise<void> | void; sleep?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.() }))
  let every = o.firstMs ?? 1_000
  for (let n = 1; ; n++) {
    let r: { done: true } | { done: false; why: string; final?: boolean }
    try { r = await attempt() } catch (err) { r = { done: false, why: err instanceof Error ? err.message : String(err) } }
    if (r.done) return true
    // A final answer (asking again would not change it): no more tries.
    if (r.final) { await o.onFinal?.(r.why); return false }
    await o.onWait?.(r.why, n)
    await sleep(every)
    every = Math.min(o.maxMs ?? RETRY_MAX_MS, Math.round(every * 1.5))
  }
}

/** One settle of a home's rolled-back sessions per process at a time (a second ask joins it). */
const settling = new Map<string, Promise<void>>()

/**
 * The sessions a rolled-back switch stopped go on here, once no open switch holds them (`isOpenSwitch`): settled,
 * and tried again until each is (a re-enable that failed keeps its session held, named in the switch's notes).
 */
export function settleAfterRollback(home: string, isOpenSwitch: (switchId: string) => boolean): Promise<void> {
  const had = settling.get(home)
  if (had) return had
  const run = (async () => {
    const [{ settleHomeSessionsAfterRollback, homeSessionRows }, { log }, { heldBySwitch }, { deliverSessionHere }] = await Promise.all([
      import('./home-sessions.js'), import('../../../logging/index.js'), import('../../sessions/switch-hold.js'), import('../../../providers/host-handover.js'),
    ])
    // Messages held while the marker stood, for sessions the stop never marked (the switch ended before it): out now.
    for (const { rec } of homeSessionRows(await (await store()).listSessions(), home)) {
      if (!rec.archived && !heldBySwitch(rec)) deliverSessionHere(rec.claudeSessionId)
    }
    const held = new Map<string, string>()
    await untilDone(async () => {
      const r = await settleHomeSessionsAfterRollback({ home, isOpenSwitch, deps: await rollbackDeps() })
      if (r.settled) log.session.info('leader switch: the sessions a rolled-back switch stopped go on here', { sessions: r.settled })
      if (r.unsupervised.length) {
        log.session.warn('leader switch: sessions a rolled-back switch stopped go on here without their cron supervision', { sessions: r.unsupervised })
        const rows = (await (await store()).listSessions()).filter((x) => r.unsupervised.some((u) => u.sid === x.claudeSessionId))
        const st = rows.find((x) => x.leaderSwitch)?.leaderSwitch
        if (st) await sessionsNote(home, st.switchId, st.from.machine, 'sessions-settled', `settled without their cron supervision: ${r.unsupervised.map((u) => `${u.title ?? u.sid}: ${u.why}`).join('; ')}`)
      }
      for (const [switchId, machine] of held) if (!r.failed.length) await sessionsNote(home, switchId, machine, 'sessions-settled')
      if (!r.failed.length) return { done: true }
      // The switch of each held row, for its note.
      const rows = (await (await store()).listSessions()).filter((x) => r.failed.some((f) => f.sid === x.claudeSessionId))
      for (const x of rows) if (x.leaderSwitch) held.set(x.leaderSwitch.switchId, x.leaderSwitch.from.machine)
      return { done: false, why: r.failed.map((f) => `${f.title ?? f.sid}: ${f.why}`).join('; ') }
    }, {
      onWait: async (why, n) => {
        if (n === 1 || n % 10 === 0) log.session.warn('leader switch: sessions a rolled-back switch stopped are still held here; trying again', { why })
        if (n === 1) for (const [switchId, machine] of held) await sessionsNote(home, switchId, machine, 'sessions-held', `sessions stay held after the rollback, tried again until they settle: ${why}`)
      },
    })
  })().finally(() => settling.delete(home))
  settling.set(home, run)
  return run
}

/**
 * A server's lead, before its sessions are reconciled and resumed (web/server.ts): the sessions a leader switch left
 * here go on. On the new leader, their records go from the standby folder into this machine's engine dir
 * (session-carry.ts placeCarriedRecords); on an old leader a switch did not commit (its marker gone), they settle in
 * place (home-sessions.ts settleHomeSessionsAfterRollback). Rows no switch marked cost one pass over the store.
 * Neither is waited for: each runs until done (placeAfterCommit, settleAfterRollback).
 */
export async function settleHomeSessionsAtLead(home: string, o: { place?: typeof placeAfterCommit; settle?: typeof settleAfterRollback; list?: () => Promise<SessionRecord[]> } = {}): Promise<void> {
  const list = o.list ?? (await store()).listSessions
  const { heldBySwitch } = await import('../../sessions/switch-hold.js')
  const held = (await list()).filter(heldBySwitch)
  if (!held.length) return
  const placing = new Map<string, { machine: string; carry: { standbyDir: string; homeFolder: string } }>()
  for (const r of held) {
    const m = r.leaderSwitch!.moved
    if (m?.records === 'pending' && m.carry) placing.set(r.leaderSwitch!.switchId, { machine: m.machine, carry: m.carry })
  }
  // Placed only once the switch committed (this server may be its commit start): until then this machine writes
  // nothing outside its standby folder, and the rows stay held (no resume, no message goes to them).
  for (const [switchId, p] of placing) void (o.place ?? placeAfterCommit)(home, switchId, p.carry, p.machine)
  if (held.some((r) => !r.leaderSwitch!.moved)) {
    const { readMarker } = await import('./records.js')
    void (o.settle ?? settleAfterRollback)(home, (id) => readMarker(home)?.switchId === id)
  }
}

/** Whether `switchId` committed for this home: its record says so, or this process leads above its handover. */
export async function committedHere(home: string, switchId: string, o: { permit?: () => ReturnType<typeof import('./boot.js')['currentLeaderPermit']> } = {}): Promise<boolean | 'wait'> {
  const [{ readPromoted, readHistory }, { currentLeaderPermit }] = await Promise.all([import('./records.js'), import('./boot.js')])
  if (readHistory(home).some((h) => h.switchId === switchId)) return true
  const p = readPromoted(home)
  if (p?.switchId === switchId && p.state === 'led') return true
  const permit = (o.permit ?? currentLeaderPermit)()
  if (!permit || permit.trial) return false
  const st = permit.runtime.status()
  if (p?.switchId === switchId && st.state === 'leading' && st.record?.holder === permit.machine && typeof p.handover === 'number' && st.record.number > p.handover) return true
  return st.state === 'stopped' ? false : 'wait'
}

/**
 * Waits for the commit of `switchId` here, then places its sessions' records and resumes them. Tried until done,
 * never given up while this server runs (a process that does not lead yet may lead later): until then the sessions
 * stay held, and after the first wait the switch's notes say why.
 */
export async function placeAfterCommit(home: string, switchId: string, c: { standbyDir: string; homeFolder: string }, machine: string, o: { committed?: typeof committedHere; place?: () => Promise<void>; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const { log } = await import('../../../logging/index.js')
  const place = o.place ?? (async () => {
    const [{ placeCarriedRecords, localEngineDir }, deps] = await Promise.all([import('./session-carry.js'), placeDeps()])
    await placeCarriedRecords({ switchId, home, standbyDir: c.standbyDir, homeFolderFrom: c.homeFolder, engineDir: await localEngineDir(), deps })
    const { getSessionAutoRecover } = await import('../../session-auto-recover.js')
    await getSessionAutoRecover()?.resumeUnfinished()
  })
  let noted = false
  await untilDone(async () => {
    const v = await (o.committed ?? committedHere)(home, switchId)
    // No permit in this process, or one that stopped: it will not lead above the handover; the next lead places them.
    if (v === false) return { done: false, final: true, why: 'no permit leads in this process above the handover' }
    if (v !== true) return { done: false, why: 'the commit is not known here yet' }
    await place()
    if (noted) await sessionsNote(home, switchId, machine, 'sessions-settled')
    return { done: true }
  }, {
    firstMs: 250,
    ...(o.sleep ? { sleep: o.sleep } : {}),
    onFinal: async (why) => {
      log.session.warn('leader switch: this process will not place the moved sessions\' records; they stay held until a server here leads above the switch', { switchId, why })
      await sessionsNote(home, switchId, machine, 'sessions-held', `the moved sessions stay held until a server here leads: ${why}`)
    },
    onWait: async (why, n) => {
      // The first waits are the commit's own few seconds: said after a minute or so.
      if (n === 12 || (n > 12 && n % 10 === 0)) {
        log.session.warn('leader switch: the sessions\' records are not in place yet; they stay held and this is tried again', { switchId, why })
        if (!noted) { noted = true; await sessionsNote(home, switchId, machine, 'sessions-held', `the moved sessions stay held until their records are in place: ${why}`) }
      }
    },
  })
}
