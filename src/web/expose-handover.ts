/**
 * The record that a host holds this Walnut's tunnel (web/expose-runtime.ts), and when
 * it is let go again.
 *
 * Written once the host holds it: this computer's own stopped and the host was asked to
 * connect again, so its connection is the newest. With it, a restart here starts nothing
 * here (a newer connection here would take the name from the host silently).
 *
 * It is kept only while the host keeps holding. When the host has not been seen holding
 * it for RELEASE_GRACE_MS (down, rebooting, reinstalling, its tunnel retrying or asking
 * for a sign-in), this computer asks the address itself (core/expose/probe.ts): a Walnut
 * that answers there keeps the record (this computer may only have lost its link to a
 * healthy host); an address nobody answers releases it, and the tunnel runs here again
 * until the host holds it again. A sign-in page in front of the address answers for
 * everyone: then the host's own report decides, when this computer can see it.
 *
 * The file lives under WALNUT_HOME/local/ (machine-local, never synced: another
 * machine's copy would stop the tunnel here, or start one beside the host's).
 */

import fs from 'node:fs'
import path from 'node:path'
import { log } from '../logging/index.js'
import type { ProbeAnswer } from '../core/expose/probe.js'
import type { PlacementHostView } from '../core/expose/placement.js'

/** The host that holds this Walnut's tunnel, which tunnel (placement.ts tunnelKey), and its address there. */
export interface ExposeHandover { hostKey: string; key: string; url?: string }

/** How long the recorded host may go without being seen holding the tunnel before this computer asks the address. */
export const RELEASE_GRACE_MS = 5 * 60_000
/** How often it asks again while a Walnut still answers there. */
export const RELEASE_RECHECK_MS = 60_000

export function handoverStore(file: string) {
  return {
    read(): ExposeHandover | null {
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8')) as { hostKey?: unknown; key?: unknown; url?: unknown }
        if (typeof v.hostKey !== 'string' || typeof v.key !== 'string') return null
        return { hostKey: v.hostKey, key: v.key, ...(typeof v.url === 'string' ? { url: v.url } : {}) }
      } catch { return null }
    },
    write(rec: ExposeHandover): void {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
        const tmp = `${file}.${process.pid}.tmp`
        fs.writeFileSync(tmp, JSON.stringify({ ...rec, at: Date.now() }), { mode: 0o600 })
        fs.renameSync(tmp, file)
      } catch (err) {
        // Not fatal: after a restart here the tunnel starts here, and the next handover runs again.
        log.web.warn('expose: the handover was not recorded', { host: rec.hostKey, error: err instanceof Error ? err.message : String(err) })
      }
    },
    clear(): void { try { fs.rmSync(file, { force: true }) } catch { /* nothing to clear */ } },
  }
}

/** This computer can see the host's state (its daemon answers), so the host's own report is not a guess. */
export function hostVisible(view: PlacementHostView | null): boolean {
  return !!view && view.phase !== 'waiting-for-host' && view.phase !== 'off'
}

/**
 * After RELEASE_GRACE_MS without seeing the host hold the tunnel: whether the address still
 * has someone behind it. A Walnut answering keeps the record; an answer that names nobody
 * (a sign-in page in front) keeps it only while the host cannot be seen; no answer releases it.
 */
export function stillServed(answer: ProbeAnswer, view: PlacementHostView | null): boolean {
  if (answer === 'mine' || answer === 'other') return true
  if (answer === 'unverified') return !hostVisible(view)
  return false
}
