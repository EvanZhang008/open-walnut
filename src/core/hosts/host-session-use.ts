/**
 * Which remote hosts Walnut's work leans on for sessions (2026-11-05, the user: "fix all the
 * errors in errors fix the root cause"; the first card in System attention was a fleet Mac
 * with no Claude Code, though no session ran there or was meant to). A host is used for
 * sessions when a project starts its sessions there (its `default_host`), an open task last
 * started there, or a session process is open there. A Claude Code problem on a host none of
 * that points at stops nothing: placement never picks such a host on its own
 * (start-placement.ts), and a person who picks it meets the problem in the picker and at
 * Start. So it is a line in Settings, not an attention card (`readiness.usedForSessions:
 * false`, read in host-problem.ts). The moment something points at the host the card is back.
 *
 * Kept as one cached set, refreshed every minute and read synchronously by the readiness
 * view (host-readiness-store.ts); a host whose answer flips is re-pushed.
 */
import { log } from '../../logging/index.js'

const REFRESH_MS = 60_000

let used: ReadonlySet<string> | null = null
/** The Playwright host fixture answers for its own hosts, whose stores hold no projects or tasks. */
let override: ((host: string) => boolean | undefined) | null = null

export function setHostSessionUseOverride(fn: ((host: string) => boolean | undefined) | null): void { override = fn }

const isRemote = (host: unknown): host is string =>
  typeof host === 'string' && host !== '' && host !== '__local__' && host !== 'local'

/** true / false once known, undefined before the first read (an older answer: card as before). */
export function hostUsedForSessions(host: string): boolean | undefined {
  const fixed = override?.(host)
  if (fixed !== undefined) return fixed
  return used ? used.has(host) : undefined
}

/** The hosts Walnut's work leans on for sessions, read from the stores. */
export async function readHostsUsedForSessions(): Promise<Set<string>> {
  const [{ getStoreProjects, listOpenTaskViews }, { countOpenSessionsByHost }] = await Promise.all([
    import('../task-manager.js'), import('../session-tracker.js'),
  ])
  const out = new Set<string>()
  for (const p of Object.values(await getStoreProjects())) {
    const h = (p.metadata as { default_host?: unknown } | undefined)?.default_host
    if (isRemote(h)) out.add(h)
  }
  // Every open task: a cap would read an older one's host as unused (a read-only view, no copies).
  for (const t of await listOpenTaskViews(Number.MAX_SAFE_INTEGER)) {
    const h = t.last_start?.host
    if (isRemote(h)) out.add(h)
  }
  for (const [h, n] of Object.entries(await countOpenSessionsByHost())) if (n > 0 && isRemote(h)) out.add(h)
  return out
}

/** Read again; the hosts whose answer changed, or 'all' on the first read (every answer was unknown). */
export async function refreshHostSessionUse(read: () => Promise<Set<string>> = readHostsUsedForSessions): Promise<string[] | 'all'> {
  const next = await read()
  const prev = used
  used = next
  if (!prev) return 'all'
  const changed: string[] = []
  for (const h of next) if (!prev.has(h)) changed.push(h)
  for (const h of prev) if (!next.has(h)) changed.push(h)
  return changed
}

/**
 * Server wiring: read now and every minute; each host whose answer changed is passed to
 * `onChange` (on the first read, every host `hosts` names), so its status is pushed again.
 */
export function wireHostSessionUse(
  onChange: (host: string) => void,
  opts: { hosts: () => Iterable<string>; everyMs?: number; read?: () => Promise<Set<string>> },
): () => void {
  let stopped = false
  const tick = async (): Promise<void> => {
    try {
      const changed = await refreshHostSessionUse(opts.read)
      if (stopped) return
      for (const h of changed === 'all' ? [...opts.hosts()] : changed) onChange(h)
    } catch (err) {
      log.session.warn('host session use: the stores could not be read', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  void tick()
  const timer = setInterval(() => { void tick() }, opts.everyMs ?? REFRESH_MS)
  timer.unref?.()
  return () => { stopped = true; clearInterval(timer) }
}

/** Test seam. */
export function _setHostsUsedForSessions(hosts: Iterable<string> | null): void {
  used = hosts ? new Set(hosts) : null
}
