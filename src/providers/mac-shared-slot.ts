/**
 * Over SSH, before this Walnut's own service set there exists (service-set-move.ts), the daemon dir a
 * connect picks (remote-daemon-dir.ts chooseDaemonDir) is the machine's default one, which on a Mac
 * shared with another person's Walnut is that Walnut's. Writing this build into its slot, or starting
 * a daemon from it, would put this Walnut's program next to theirs on someone else's computer. So on
 * a Mac (the experiment macos_one_service: a Mac is set up over SSH only with it), with a shared
 * (real, not a test's) isolation and no own set, the slot is written and started only when that dir
 * serves no other Walnut lately: its daemon's hello (`served`), else the dir's serves record
 * (daemon-serves.ts SERVES_FILE). A dir no Walnut ever served (a Mac nobody else uses) is free.
 * Linux keeps today's sharing.
 */
import { ownFollowerDirs } from '../core/host-server/own-follower-dirs.js'
import { parseServes, SERVES_FILE, walnutKeyOf, type DaemonServes } from './daemon-serves.js'
import { otherWalnutKeys } from './daemon-shared.js'
import { shq } from './remote-sh.js'

export interface SharedMacSlotFacts {
  system: 'linux' | 'darwin'
  /** The connection's isolation mode (remote-isolation.ts): only 'shared', a real server's, is guarded. */
  isolation: string
  /** The link points at this Walnut's own service set dir. */
  ownSet: boolean
  dir: string
  /** The last hello's serves record, when there was one on this connection. */
  serves: DaemonServes | null
  /** This Walnut's data dir. */
  home: string
  /** The host's key: this Walnut's own servers' data dirs there are not another Walnut (own-follower-dirs.ts). */
  hostKey?: string
  run(command: string, timeoutMs?: number): Promise<string>
  now?: number
}

/** The other Walnuts (their keys) a serves record names, by daemon-shared.ts's one rule. */
export function otherWalnuts(serves: DaemonServes | null, home: string, now: number, ownFollowerKeys: readonly string[] = []): string[] {
  return serves ? otherWalnutKeys(serves.walnuts, { ourKey: walnutKeyOf(home), ownFollowerKeys, now }) : []
}

/** Why nothing of this Walnut goes into that dir's slot now, or null when it may. */
export async function sharedMacSlotWhy(f: SharedMacSlotFacts): Promise<string | null> {
  if (f.system !== 'darwin' || f.isolation !== 'shared' || f.ownSet) return null
  const now = f.now ?? Date.now()
  let serves = f.serves
  if (!serves) {
    const text = await f.run(`cat ${shq(`${f.dir}/${SERVES_FILE}`)} 2>/dev/null || true`, 15_000).catch(() => null)
    // No answer is no proof: nothing goes there this time.
    if (text === null) return `the daemon dir on this Mac (${f.dir}) could not be read, so Walnut does not know whether another Walnut uses it, and puts nothing there yet`
    serves = parseServes(text)
  }
  let others = otherWalnuts(serves, f.home, now)
  // This Walnut's own servers there (a host replica's data dir) are no other Walnut; read only when someone else shows.
  if (others.length && f.hostKey) others = otherWalnuts(serves, f.home, now, (await ownFollowerDirs(f.hostKey).catch(() => [] as string[])).map(walnutKeyOf))
  if (others.length === 0) return null
  return `the daemon dir on this Mac (${f.dir}) serves ${others.length === 1 ? 'another Walnut' : `${others.length} other Walnuts`}; Walnut puts nothing of its own there and starts nothing from it until this Walnut's own service there is installed`
}
