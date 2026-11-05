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

/** Drop the clocks whose key starts with `prefix`, all but `keep` (a clock for a state that is over). */
export function dropHoldClocks(prefix: string, keep: string): void {
  const s = load()
  let changed = false
  for (const key of Object.keys(s)) if (key.startsWith(prefix) && key !== keep) { delete s[key]; changed = true }
  if (changed) void persist()
}
