/**
 * The running server's side of the sessions in the data home across a switch (home-sessions.ts): the real session
 * store, this machine's own session runtime and its processes. Loaded only by a switch stop, a rollback's settle and
 * the new leader's first lead (web/routes/leader-switch.ts, web/server.ts).
 *
 * The stop goes only through the owning runtime (the `stop` command of this machine's own daemon, reason
 * leader_switch, with this home and the stop's id): the server never signals a pid itself. The daemon answers once
 * the session's process group is gone (an ACP worker by its own strict stop), with supervision off under that id.
 */
import type { SessionRecord } from '../../types.js'
import type { HomeStopDeps, RollbackDeps } from './home-sessions.js'
import type { PlaceDeps } from './session-carry.js'

/** The capability a daemon names when it takes the switch's stop and refuses starts in a marked home. */
export const HOME_STOP_CAPABILITY = 'leader-switch-home-stop-v1'

/** The answer of the stop's own time bound when the daemon has not answered. */
export const STOP_ANSWER_MS = 30_000

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
  const { getConnectedDaemonConnection } = await import('../../../providers/daemon-connection.js')
  const conn = getConnectedDaemonConnection('__local__')
  if (!conn?.connected) return live ? `this machine's session runtime (its own daemon) is not connected, so the ${live} session(s) running in the data home could not be stopped for the switch` : null
  if (!conn.capabilitiesKnown) return 'this machine\'s session runtime has not said what it can do yet'
  if (!conn.hasCapability(HOME_STOP_CAPABILITY)) return `this machine's session runtime lacks ${HOME_STOP_CAPABILITY} (update Walnut here): it cannot stop the sessions in the data home for a switch, nor refuse new ones there`
  return null
}

export async function homeStopDeps(home: string): Promise<HomeStopDeps> {
  const [{ listSessions }, { getConnectedDaemonConnection }, { readSessionSupervision }, { describeStopRefusal }, { processesInFolders }] = await Promise.all([
    store(), import('../../../providers/daemon-connection.js'), import('../../sessions/session-supervision.js'),
    import('../../sessions/stop-provenance.js'), import('../../../lib/home-processes.js'),
  ])
  return {
    list: listSessions,
    save,
    supervised: async (sid) => ((await readSessionSupervision(sid)).supervision as { enabled?: unknown } | null)?.enabled === true,
    stop: async (rec, stopRequestId) => {
      const conn = getConnectedDaemonConnection('__local__')
      if (!conn?.connected) return { ok: false, why: 'this machine\'s session runtime is not connected' }
      if (!conn.hasCapability(HOME_STOP_CAPABILITY)) return { ok: false, why: `this machine's session runtime lacks ${HOME_STOP_CAPABILITY}` }
      const reply = await conn.send('stop', { sid: rec.claudeSessionId, reason: 'leader_switch', stopRequestId, home, initiator: 'automatic' }, STOP_ANSWER_MS)
      if (reply.ok === true && (reply.stopped === true || reply.noop === true)) return { ok: true }
      // The runtime holds no start of it by this Walnut (a start still on its way here, the record ahead of its
      // spawn): nothing of it runs to stop, and its spawn now meets the marker. The scan after the stops still fails
      // the stop on a process of it in the home.
      if (reply.ok === true && reply.reason === 'not_owned' && reply.detail === 'not_journaled') return { ok: true }
      return { ok: false, why: reply.ok === false ? String(reply.error ?? 'refused') : describeStopRefusal(reply) }
    },
    processesInHome: (spellings) => processesInFolders(spellings),
    now: Date.now,
  }
}

export async function rollbackDeps(): Promise<RollbackDeps> {
  const [{ listSessions }, { getConnectedDaemonConnection }] = await Promise.all([store(), import('../../../providers/daemon-connection.js')])
  return {
    list: listSessions,
    save,
    reenable: async (sid, stopRequestId) => {
      const conn = getConnectedDaemonConnection('__local__')
      if (!conn?.connected) throw new Error('this machine\'s session runtime is not connected')
      const reply = await conn.send('cron.supervision', { sid, enabled: true, stopFence: stopRequestId }, 5_000)
      if (reply.ok !== true) throw new Error(String(reply.error ?? 'supervision not re-enabled'))
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

/**
 * A server's lead, before its sessions are reconciled and resumed (web/server.ts): the sessions a leader switch left
 * here go on. On the new leader, their records go from the standby folder into this machine's engine dir
 * (session-carry.ts placeCarriedRecords); on an old leader a switch did not commit (its marker gone), they settle in
 * place (home-sessions.ts settleHomeSessionsAfterRollback). Rows no switch marked cost one pass over the store.
 */
export async function settleHomeSessionsAtLead(home: string): Promise<void> {
  const { listSessions } = await store()
  const { heldBySwitch } = await import('../../sessions/switch-hold.js')
  const held = (await listSessions()).filter(heldBySwitch)
  if (!held.length) return
  const { log } = await import('../../../logging/index.js')
  const placing = new Map<string, { standbyDir: string; homeFolder: string }>()
  for (const r of held) {
    const m = r.leaderSwitch!.moved
    if (m?.records === 'pending' && m.carry) placing.set(r.leaderSwitch!.switchId, m.carry)
  }
  // Placed only once the switch committed (this server may be its commit start): until then this machine writes
  // nothing outside its standby folder, and the rows stay held (no resume, no message goes to them).
  for (const [switchId, c] of placing) void placeAfterCommit(home, switchId, c)
  if (held.some((r) => !r.leaderSwitch!.moved)) {
    const [{ settleHomeSessionsAfterRollback }, { readMarker }] = await Promise.all([import('./home-sessions.js'), import('./records.js')])
    const n = await settleHomeSessionsAfterRollback({ home, isOpenSwitch: (id) => readMarker(home)?.switchId === id, deps: await rollbackDeps() })
    if (n) log.session.info('leader switch: the sessions a rolled-back switch stopped go on here', { sessions: n })
  }
}

/** Whether `switchId` committed for this home: its record says so, or this process leads above its handover. */
export async function committedHere(home: string, switchId: string): Promise<boolean | 'wait'> {
  const [{ readPromoted, readHistory }, { currentLeaderPermit }] = await Promise.all([import('./records.js'), import('./boot.js')])
  if (readHistory(home).some((h) => h.switchId === switchId)) return true
  const p = readPromoted(home)
  if (p?.switchId === switchId && p.state === 'led') return true
  const permit = currentLeaderPermit()
  if (!permit || permit.trial) return false
  const st = permit.runtime.status()
  if (p?.switchId === switchId && st.state === 'leading' && st.record?.holder === permit.machine && typeof p.handover === 'number' && st.record.number > p.handover) return true
  return st.state === 'stopped' ? false : 'wait'
}

/** Waits (at most 15 min) for the commit of `switchId`, then places its sessions' records and resumes them. */
async function placeAfterCommit(home: string, switchId: string, c: { standbyDir: string; homeFolder: string }): Promise<void> {
  const { log } = await import('../../../logging/index.js')
  try {
    let every = 250
    for (const until = Date.now() + 15 * 60_000; ;) {
      const v = await committedHere(home, switchId)
      if (v === true) break
      if (v === false || Date.now() > until) {
        log.session.warn('leader switch: the switch did not commit here, so its sessions\' records are not put in place', { switchId, why: v === false ? 'no permit leads in this process' : 'no commit within 15 min' })
        return
      }
      await new Promise((r) => setTimeout(r, every))
      every = Math.min(5_000, Math.round(every * 1.5))
    }
    const [{ placeCarriedRecords, localEngineDir }, deps] = await Promise.all([import('./session-carry.js'), placeDeps()])
    await placeCarriedRecords({ switchId, home, standbyDir: c.standbyDir, homeFolderFrom: c.homeFolder, engineDir: await localEngineDir(), deps })
    const { getSessionAutoRecover } = await import('../../session-auto-recover.js')
    await getSessionAutoRecover()?.resumeUnfinished()
  } catch (err) {
    log.session.warn('leader switch: the sessions\' records could not be put in place; they stay held', { switchId, error: err instanceof Error ? err.message : String(err) })
  }
}
