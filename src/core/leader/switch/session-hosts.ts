/**
 * Where a session runs, after a switch (promote.ts, the step after the path rewrite).
 *
 * A session row names its host by key; no key (NULL, '' or '__local__') is the leader's own daemon. A
 * session never moves with the leader (home-path-rules.ts, host-places): it stays on the machine that
 * ran it, except one whose folder is the data home or under it, which cannot stay (its CLI would write
 * into the old home) and follows the leader or ends (moveHomeRows, home-sessions.ts). So in the
 * promoted home:
 *
 *   - a row of the old leader's own daemon in the data home runs on the new leader's own daemon, its
 *     folder the same place in the new home; or, when it cannot move, it is ended with why;
 *
 *   - a row of the old leader's own daemon names the old machine's host key: the old machine is a
 *     host of the new leader now (host-follow.ts), and its daemon still holds the session;
 *   - a row on the new machine's host key names no key: that daemon is the new leader's own now.
 *
 * Only rows the leader judges are moved. A row its host's own service judges (`judge: 'host'`,
 * session-row-owner.ts) belongs to that service and to the channel's position for that host
 * (session_channel_cursor): it keeps its key, as do the channel's tables, which are keyed by hosts
 * that did not move.
 *
 * A row whose host means the leader's role, not a machine, never moves either: a router area's own
 * conversation (an area profile, as router/history-write.ts hasAreaProfile reads it) runs on its
 * area's host, `__local__` (history-write.ts areaFor), whichever machine leads. Moved to the old
 * machine, it would no longer be its area's isolated session (router/session-policy.ts
 * isRouterAreaSession) and router/wake.ts would refuse every wake while the new machine leads.
 * Kept, the router goes on on the new leader's own daemon: a resume whose transcript that daemon
 * lacks starts that conversation there under the same id (claude-code-session.ts).
 *
 * Run once per switch: the swap is not its own inverse, so a promotion resumed after a kill must not
 * run it twice. The switch id is kept in the same transaction (leader_switch_session_hosts).
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from '../../../lib/sqlite.js'
import type { LeaderSwitchSessionStamp } from '../../types.js'
import { moveRefusal, relInHome } from './home-sessions.js'

/** The store this step changes (the trial does not compare its size and rows with the copy's: self-check.ts). */
export const SESSION_HOSTS_FILE = 'sessions.sqlite'

/** The step's mark: one row per switch (the trial's row count allows for it, in this table). */
export const SESSION_HOSTS_MARK_TABLE = 'leader_switch_session_hosts'
const DONE_TABLE = SESSION_HOSTS_MARK_TABLE
const LOCAL = "(host IS NULL OR host = '' OR host = '__local__')"
// The rows the leader judges: all but those judgedByHost (session-row-owner.ts) names, judge 'host' on a named host.
// A row with no host is the leader's whatever its payload says (judgedByHost needs a host).
const LEADER_JUDGED = "NOT (host IS NOT NULL AND host <> '' AND payload IS NOT NULL AND instr(payload, '\"judge\"') > 0 AND json_valid(payload) AND json_extract(payload, '$.judge') = 'host')"
/**
 * The rows that carry an area profile, as router/history-write.ts hasAreaProfile reads the record: a profile with an
 * area field (areaId, areaRole or areaPolicyVersion), whose role is not the receiver role 'work' an older build left.
 * Their host is their area's, never the machine's (tests/core/leader/switch/session-hosts.test.ts checks the two agree).
 */
export const AREA_PROFILE_SQL = "(payload IS NOT NULL AND instr(payload, '\"area') > 0 AND json_valid(payload)"
  + " AND json_type(payload, '$.profile') = 'object' AND json_extract(payload, '$.profile.areaRole') IS NOT 'work'"
  + " AND (json_type(payload, '$.profile.areaId') IS NOT NULL OR json_type(payload, '$.profile.areaRole') IS NOT NULL"
  + " OR json_type(payload, '$.profile.areaPolicyVersion') IS NOT NULL))"
/** The rows this step moves: the leader judges them and their host is a machine. */
const MOVES = `${LEADER_JUDGED} AND NOT ${AREA_PROFILE_SQL}`

export interface SessionHostsMove {
  /** The old leader machine's host key, as the new leader's config names it in hosts (between machines only). */
  oldMachine?: string
  /** The new leader machine's host key, when the config gives it one. */
  newMachine?: string
  /**
   * The sessions in the data home (home-sessions.ts): the old home as its rows name it, this home, both machines'
   * ids, and where their records wait (this machine's standby dir, the old home's engine folder as the final mark
   * names it). The switch checked the records came (target-job.ts carryRefusal) before it promotes.
   */
  homes?: { from: string; to: string; fromMachine: string; toMachine: string; carry: { standbyDir: string; homeFolder: string } }
}

/** Whether this step ran for `switchId` in `home` (its mark is the one row it adds: the trial's row count allows for it). */
export function sessionHostsMarked(home: string, switchId: string): boolean {
  const file = path.join(home, SESSION_HOSTS_FILE)
  if (!fs.existsSync(file)) return false
  const db = new Database(file, { readonly: true })
  try {
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${DONE_TABLE}'`).get()) return false
    return !!db.prepare(`SELECT 1 FROM ${DONE_TABLE} WHERE switch_id = ?`).get(switchId)
  } finally {
    db.close()
  }
}

export interface SessionHostsResult {
  toOldMachine: number
  toOwnDaemon: number
  /** Sessions in the data home that moved with the leader (archived ones included), and those that ended. */
  homeMoved: number
  homeEnded: number
  alreadyDone: boolean
}

type HomeRow = { claude_session_id: string; cwd: string | null; provider: string | null; archived: number | null; host: string | null; archive_reason: string | null; engine: string | null; stamp: string | null }

export function moveSessionHosts(home: string, switchId: string, move: SessionHostsMove): SessionHostsResult {
  const none = { toOldMachine: 0, toOwnDaemon: 0, homeMoved: 0, homeEnded: 0, alreadyDone: false }
  const file = path.join(home, SESSION_HOSTS_FILE)
  const machines = !!move.oldMachine && move.oldMachine !== move.newMachine
  if (!fs.existsSync(file) || (!machines && !move.homes)) return none
  const db = new Database(file)
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()) return none
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS ${DONE_TABLE} (switch_id TEXT PRIMARY KEY, at TEXT NOT NULL)`)
      if (db.prepare(`SELECT 1 FROM ${DONE_TABLE} WHERE switch_id = ?`).get(switchId)) {
        db.exec('ROLLBACK')
        return { ...none, alreadyDone: true }
      }
      // The sessions in the data home first: they follow the leader (or end), never the old machine's key.
      db.exec('CREATE TEMP TABLE IF NOT EXISTS home_rows (claude_session_id TEXT PRIMARY KEY)')
      const home_ = move.homes ? moveHomeRows(db, switchId, move.homes, machines ? move.oldMachine! : null) : { moved: 0, ended: 0 }
      let toOwnDaemon = 0
      let toOldMachine = 0
      if (machines) {
        // Marked first, so the rows of the new machine set free below are not taken for the old leader's.
        db.exec(`CREATE TEMP TABLE was_local AS SELECT claude_session_id FROM sessions WHERE ${LOCAL} AND ${MOVES} AND claude_session_id NOT IN (SELECT claude_session_id FROM temp.home_rows)`)
        toOwnDaemon = move.newMachine
          ? Number(db.prepare(`UPDATE sessions SET host = NULL WHERE host = ? AND ${MOVES} AND claude_session_id NOT IN (SELECT claude_session_id FROM temp.home_rows)`).run(move.newMachine).changes ?? 0)
          : 0
        toOldMachine = Number(db.prepare('UPDATE sessions SET host = ? WHERE claude_session_id IN (SELECT claude_session_id FROM temp.was_local)').run(move.oldMachine!).changes ?? 0)
        db.exec('DROP TABLE temp.was_local')
      }
      db.exec('DROP TABLE IF EXISTS temp.home_rows')
      db.prepare(`INSERT INTO ${DONE_TABLE} (switch_id, at) VALUES (?, ?)`).run(switchId, new Date().toISOString())
      db.exec('COMMIT')
      return { toOldMachine, toOwnDaemon, homeMoved: home_.moved, homeEnded: home_.ended, alreadyDone: false }
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* none open */ }
      throw err
    }
  } finally {
    db.close()
  }
}

/**
 * The sessions in the data home (home-sessions.ts), in the transaction of the switch's mark: each one of the old
 * leader's own daemon whose folder is the old home or under it moves to this machine's own daemon, its folder the same
 * place in this home (with a notice of the move for its next message, sessions/folder-gone.ts) and its records still
 * to be placed after the commit (session-carry.ts); archived ones too, by their folder. One that cannot move keeps the
 * old machine as its host (its history stays readable there) and is ended with why. Only the payload keys
 * `leaderSwitch` and `folderMoved` change (json_set: the rest of the payload is left as written). The rows handled are
 * listed in temp.home_rows, so the swap of hosts below leaves them.
 */
function moveHomeRows(db: InstanceType<typeof Database>, switchId: string, h: NonNullable<SessionHostsMove['homes']>, oldMachine: string | null): { moved: number; ended: number } {
  const json = (k: string) => `CASE WHEN json_valid(payload) THEN json_extract(payload, '$.${k}') END`
  const rows = db.prepare(`SELECT claude_session_id, cwd, provider, archived, host, archive_reason, ${json('engine')} AS engine, CASE WHEN json_valid(payload) THEN json_extract(payload, '$.leaderSwitch') END AS stamp FROM sessions WHERE ${LOCAL} AND ${MOVES} AND cwd IS NOT NULL`).all() as HomeRow[]
  const at = new Date().toISOString()
  const stamps = new Map<string, LeaderSwitchSessionStamp | undefined>()
  const spellings = new Set([path.resolve(h.from)])
  for (const r of rows) {
    let st: LeaderSwitchSessionStamp | undefined
    try { st = r.stamp ? JSON.parse(r.stamp) as LeaderSwitchSessionStamp : undefined } catch { st = undefined }
    if (st?.switchId !== switchId) st = undefined
    stamps.set(r.claude_session_id, st)
    // The old leader stamped its rows with the home as it ran them: that spelling counts too.
    if (st?.from?.home) spellings.add(path.resolve(st.from.home))
  }
  // Its CLI ended on the old machine (the switch stop waited for that): none runs for it here, whatever the row said.
  const update = db.prepare(`UPDATE sessions SET host = ?, cwd = ?, archived = ?, archive_reason = ?,
    process_status = CASE WHEN process_status IN ('running', 'idle') THEN 'stopped' ELSE process_status END,
    payload = CASE WHEN ? IS NULL THEN json_set(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END, '$.leaderSwitch', json(?))
      ELSE json_set(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END, '$.leaderSwitch', json(?), '$.folderMoved', json(?)) END
    WHERE claude_session_id = ?`)
  const mark = db.prepare('INSERT OR IGNORE INTO temp.home_rows (claude_session_id) VALUES (?)')
  let moved = 0
  let ended = 0
  for (const r of rows) {
    const own = stamps.get(r.claude_session_id)
    // The old leader's own stamp says where in its home the row ran (its spelling of the home may be one this
    // machine cannot see: its real path); a row it did not stamp (an archived one) is found by the home's spellings.
    const rel = own ? own.rel : relInHome(r.cwd, [...spellings])
    if (rel === null) continue
    const stamp: LeaderSwitchSessionStamp = own ?? { switchId, plan: 'move', from: { machine: h.fromMachine, home: h.from, cwd: r.cwd! }, rel, stopped: 'none', at }
    const archived = !!r.archived
    const why = own ? (own.plan === 'end' ? own.why ?? 'it could not move with the leader' : null)
      : moveRefusal({ engine: r.engine ?? undefined, provider: r.provider ?? undefined, cwd: r.cwd! } as never, rel)
    if (why) {
      const st = JSON.stringify({ ...stamp, plan: 'end', why })
      update.run(oldMachine ?? r.host, r.cwd, 1, archived ? r.archive_reason : 'leader_switch', null, st, st, null, r.claude_session_id)
      ended++
    } else {
      const cwd = rel ? path.join(h.to, ...rel.split('/')) : h.to
      const st = JSON.stringify({ ...stamp, plan: 'move', moved: { machine: h.toMachine, home: h.to, cwd, at, records: 'pending', carry: h.carry } })
      const notice = archived ? null : JSON.stringify({ from: r.cwd, to: cwd, at, by: `leader switch ${switchId}`, why: 'leader-switch', fromMachine: h.fromMachine, toMachine: h.toMachine })
      update.run(null, cwd, archived ? 1 : 0, r.archive_reason, notice, st, st, notice, r.claude_session_id)
      moved++
    }
    mark.run(r.claude_session_id)
  }
  return { moved, ended }
}
