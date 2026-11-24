/**
 * Where a session runs, after a switch between machines (promote.ts, the step after the path rewrite).
 *
 * A session row names its host by key; no key (NULL, '' or '__local__') is the leader's own daemon. A
 * session never moves with the leader (home-path-rules.ts, host-places): it stays on the machine that
 * ran it. So in the promoted home:
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
  /** The old leader machine's host key, as the new leader's config names it in hosts. */
  oldMachine: string
  /** The new leader machine's host key, when the config gives it one. */
  newMachine?: string
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

export interface SessionHostsResult { toOldMachine: number; toOwnDaemon: number; alreadyDone: boolean }

export function moveSessionHosts(home: string, switchId: string, move: SessionHostsMove): SessionHostsResult {
  const none = { toOldMachine: 0, toOwnDaemon: 0, alreadyDone: false }
  const file = path.join(home, SESSION_HOSTS_FILE)
  if (!fs.existsSync(file) || !move.oldMachine || move.oldMachine === move.newMachine) return none
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
      // Marked first, so the rows of the new machine set free below are not taken for the old leader's.
      db.exec(`CREATE TEMP TABLE was_local AS SELECT claude_session_id FROM sessions WHERE ${LOCAL} AND ${MOVES}`)
      const toOwnDaemon = move.newMachine
        ? Number(db.prepare(`UPDATE sessions SET host = NULL WHERE host = ? AND ${MOVES}`).run(move.newMachine).changes ?? 0)
        : 0
      const toOldMachine = Number(db.prepare('UPDATE sessions SET host = ? WHERE claude_session_id IN (SELECT claude_session_id FROM temp.was_local)').run(move.oldMachine).changes ?? 0)
      db.exec('DROP TABLE temp.was_local')
      db.prepare(`INSERT INTO ${DONE_TABLE} (switch_id, at) VALUES (?, ?)`).run(switchId, new Date().toISOString())
      db.exec('COMMIT')
      return { toOldMachine, toOwnDaemon, alreadyDone: false }
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* none open */ }
      throw err
    }
  } finally {
    db.close()
  }
}
