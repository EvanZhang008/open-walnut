/**
 * A daemon upgrade waits while ACP turns are open on its host (acp-busy.json): the swap
 * closes every ACP worker's stdin, which ends a running Codex turn. The wait has an end
 * (lifecycle-waits.ts lists it): a host whose ACP turns stayed open ACP_UPGRADE_HOLD_MAX_MS
 * gets its upgrade anyway, since a turn open that long is almost always one that never
 * closed, and the old daemon would otherwise serve for good.
 *
 * The clock starts when a deferral is first seen and is kept on disk per host
 * (WALNUT_HOME/cache/acp-upgrade-hold.json), because every deploy is a new server: a clock
 * in memory would start over each time and never run out on a host deployed to every hour.
 * A check that finds no open turn clears it, and one not repeated for ACP_UPGRADE_HOLD_STALE_MS
 * no longer counts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'

export const ACP_UPGRADE_HOLD_MAX_MS = 6 * 60 * 60_000

/** The file in the daemon's dir that names its open ACP turns (acp-daemon.ts writeBusyFile). */
export const ACP_BUSY_FILE = 'acp-busy.json'
/** A busy file not refreshed for this long is a daemon that died: not busy, so it never wedges an update. */
export const ACP_BUSY_STALE_MS = 2 * 60_000

/**
 * The open ACP turns an acp-busy.json text names (fresh and non-empty), else []. The one reader
 * of that file for every update path: this Mac's (local-daemon.ts), an SSH host's and a host
 * network machine's over its link (daemon-connection.ts, daemon-net-update.ts).
 */
export function openAcpTurns(raw: string | null | undefined, now: number = Date.now()): string[] {
  if (!raw || !raw.trim()) return []
  try {
    const busy = JSON.parse(raw) as { busySids?: unknown; updatedAt?: unknown }
    if (typeof busy.updatedAt !== 'number' || now - busy.updatedAt >= ACP_BUSY_STALE_MS) return []
    return Array.isArray(busy.busySids) ? busy.busySids.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

/**
 * Do the open ACP turns of `host` (its acp-busy.json text, `raw`) hold its update now: `busySids`
 * open there, `holds` while their wait is under ACP_UPGRADE_HOLD_MAX_MS (the per-host clock below).
 */
export function acpTurnsHold(host: string, raw: string | null | undefined, now: number = Date.now()): { busySids: string[]; holds: boolean; heldMs: number } {
  const busySids = openAcpTurns(raw, now)
  return { busySids, ...acpUpgradeHolds(host, busySids.length > 0, now) }
}

/** Why open ACP turns hold an update, in words, or null for none. */
export function acpTurnsReason(busySids: readonly string[]): string | null {
  const n = busySids.length
  return n > 0 ? `${n} ACP turn${n === 1 ? '' : 's'} open on the host would end with the daemon` : null
}

/** When a host's deferral began, and when it was last seen deferring. */
type Store = Record<string, { since: number; seen: number }>

/**
 * A deferral is re-checked every minute while it lasts; one not seen for this long ended some
 * other way (the daemon came back on the new build, the server was down), so its clock starts
 * over instead of letting a later deploy upgrade at once over turns that just opened.
 */
export const ACP_UPGRADE_HOLD_STALE_MS = 15 * 60_000

let fileOverride: string | null = null
const file = () => fileOverride ?? path.join(WALNUT_HOME, 'cache', 'acp-upgrade-hold.json')

/** Read once per process (a few bytes), then kept in memory; written only when it changes. */
let store: Store | null = null

/** Tests: point the store at a temp file (null = back to WALNUT_HOME), and forget what was read. */
export function setAcpUpgradeHoldFileForTest(f: string | null): void {
  fileOverride = f
  store = null
}

function load(): Store {
  if (store) return store
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8')) as unknown
    store = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Store : {}
  } catch {
    store = {}
  }
  return store
}

let chain: Promise<unknown> = Promise.resolve()
/** Never awaited by a caller: the memory copy is the answer, the file only carries it to the next server. */
function persist(): Promise<void> {
  const target = file()
  const body = JSON.stringify(store ?? {}) + '\n'
  const next = chain.then(async () => {
    const tmp = `${target}.${process.pid}.tmp`
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(tmp, body)
    await fs.promises.rename(tmp, target)
  })
  chain = next.catch(() => {})
  return chain as Promise<void>
}

/** Tests: the writes asked for so far are on disk. */
export function acpUpgradeHoldFlushedForTest(): Promise<void> {
  return chain as Promise<void>
}

/**
 * Whether an upgrade of `host` keeps waiting, given whether ACP turns are open there now.
 * `heldMs` is how long it has waited so far (0 when it does not wait).
 */
export function acpUpgradeHolds(host: string, busy: boolean, now: number = Date.now()): { holds: boolean; heldMs: number } {
  return upgradeHoldClock(host, busy, ACP_UPGRADE_HOLD_MAX_MS, now)
}

/**
 * The same clock for another reason an upgrade waits (`key`, e.g. `exec:<host>` for
 * host_exec runs, exec-runs-hold.ts), with its own limit. `staleMs`: how long a clock
 * not seen again still counts (a check repeated less often than every 15 minutes).
 */
export function upgradeHoldClock(
  key: string, busy: boolean, maxMs: number, now: number = Date.now(), staleMs: number = ACP_UPGRADE_HOLD_STALE_MS,
): { holds: boolean; heldMs: number } {
  const s = load()
  if (!busy) {
    if (key in s) { delete s[key]; void persist() }
    return { holds: false, heldMs: 0 }
  }
  const cur = s[key]
  const valid = !!cur && typeof cur === 'object' && Number.isFinite(cur.since) && Number.isFinite(cur.seen)
    && cur.since <= now && now - cur.seen < staleMs
  if (!valid) {
    s[key] = { since: now, seen: now }
    void persist()
    return { holds: true, heldMs: 0 }
  }
  cur.seen = now
  void persist()
  const heldMs = now - cur.since
  return { holds: heldMs < maxMs, heldMs }
}

/** A clock as it stands, read without touching it (null: none, not seen for `staleMs`, or dated after `now`: the clock stepped back). */
export function readHoldClock(key: string, now: number = Date.now(), staleMs: number = ACP_UPGRADE_HOLD_STALE_MS): { since: number; seen: number } | null {
  const cur = load()[key]
  const valid = !!cur && typeof cur === 'object' && Number.isFinite(cur.since) && Number.isFinite(cur.seen)
    && cur.since <= now && cur.seen <= now && now - cur.seen < staleMs
  return valid ? { since: cur.since, seen: cur.seen } : null
}

/** Drop the clocks whose key starts with `prefix`, all but `keep` (a clock for a state that is over). */
export function dropHoldClocks(prefix: string, keep: string): void {
  const s = load()
  let changed = false
  for (const key of Object.keys(s)) if (key.startsWith(prefix) && key !== keep) { delete s[key]; changed = true }
  if (changed) void persist()
}
