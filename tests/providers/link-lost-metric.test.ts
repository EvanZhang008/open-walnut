/**
 * A host link's loss counts for the "Host link keeps dropping" alarm only when the link was
 * really lost, never when this server closed it on its own way out (a deploy or an update
 * stops the server, and every link it holds goes with it). 2026-11-24: deploys alone put
 * about one loss an hour on every host, and home-pc's alarm rang on them plus a flaky link.
 *   - L1: an ordinary loss counts once for its host;
 *   - L2: a loss while this server stops is not counted and says why;
 *   - L3 (ratchet): the metric is counted in one place only, so a new way of counting it
 *     cannot skip the server-stopping rule.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { countLinkLost, LINK_LOST_METRIC } from '../../src/providers/link-lost-metric.js'
import { resetMetrics, snapshot } from '../../src/core/observability/metrics.js'
import { markServerStopping, resetServerStopping } from '../../src/core/server-stopping.js'

const ROOT = join(__dirname, '..', '..')

function lostFor(host: string): number {
  return snapshot().series.find((s) => s.name === LINK_LOST_METRIC && s.labels?.host === host)?.count ?? 0
}

afterEach(() => { resetServerStopping(); resetMetrics() })

describe('countLinkLost', () => {
  it('L1: an ordinary loss counts once for its host', () => {
    expect(countLinkLost('home-pc')).toBeNull()
    expect(lostFor('home-pc')).toBe(1)
    expect(lostFor('clouddev')).toBe(0)
  })

  it('L2: a loss while this server stops is not counted', () => {
    markServerStopping()
    expect(countLinkLost('home-pc')).toBe('server-stopping')
    expect(lostFor('home-pc')).toBe(0)
  })

  it('L3: only link-lost-metric.ts counts host.link.lost', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!/\.(ts|tsx)$/.test(name)) continue
        const rel = relative(ROOT, p)
        if (rel === join('src', 'providers', 'link-lost-metric.ts')) continue
        // The health monitor names the metric to read it; that is not a count.
        if (rel === join('src', 'core', 'health-monitor', 'collect.ts')) continue
        if (/['"`]host\.link\.lost['"`]/.test(readFileSync(p, 'utf8'))) offenders.push(rel)
      }
    }
    walk(join(ROOT, 'src'))
    expect(offenders).toEqual([])
  })
})
