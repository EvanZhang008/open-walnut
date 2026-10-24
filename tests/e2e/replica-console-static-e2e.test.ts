/**
 * The console's page comes from the host replica itself while the Mac is away
 * (docs/plan/walnut-replica-servers-impl.md, WP7): a real build of this tree on
 * both sides (tests/helpers/replica-cluster.ts app 'built': the replica runs
 * `node <app>/dist/cli.js web --replica`, dev:false over its own web/static),
 * and a request the way the tunnel sends it, every path to the replica's public
 * port. With the Mac asleep, `/` (a browser's navigation) is the SPA's root page
 * and one hashed asset it names loads; both while the Mac answers too (then
 * forwarded to it), byte for byte the same build.
 *
 * Needs the build: `bun run build`, then `cd web && bun x vite build`. Without it
 * the file fails at once and says so (never a skipped test).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { builtAppMissing, startReplicaCluster, WINDOWS, type ReplicaCluster } from '../helpers/replica-cluster.js'

const NAV = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }

/** The first hashed script the page names (`/assets/index-<hash>.js`). */
function entryAsset(html: string): string | null {
  return /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? null
}

describe('the console page from the host replica (a real build)', () => {
  let c: ReplicaCluster
  let token = ''
  const awake: { html: string; asset: string; assetBytes: number } = { html: '', asset: '', assetBytes: 0 }

  beforeAll(async () => {
    const missing = builtAppMissing()
    if (missing) throw new Error(`this test runs a real build and ${missing} is missing: bun run build, then cd web && bun x vite build`)
    c = await startReplicaCluster({ twin: 'source', app: 'built' })
    // Awake: the page is forwarded to the Mac, which serves the same build.
    const page = await c.replica('GET', '/', { headers: NAV })
    expect(page.status, page.text.slice(0, 300)).toBe(200)
    expect(page.headers['x-walnut-answered-via']).toBe('leader')
    awake.html = page.text
    awake.asset = entryAsset(page.text) ?? ''
    expect(awake.asset).toMatch(/^\/assets\/.+\.js$/)
    const asset = await c.replica('GET', awake.asset)
    expect(asset.status).toBe(200)
    awake.assetBytes = Buffer.byteLength(asset.text)
    token = await c.pairDevice('marina-browser')
    c.sleepMac()
    await c.waitAway(token)
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('away: `/` is the SPA root page, from the replica', async () => {
    const t0 = Date.now()
    const page = await c.replica('GET', '/', { headers: NAV })
    expect(page.status, page.text.slice(0, 300)).toBe(200)
    expect(String(page.headers['content-type'])).toMatch(/^text\/html/)
    expect(page.text).toContain('<div id="root"')
    expect(page.headers['x-walnut-answered-via']).toBe('replica')
    // The same build the Mac served: the same entry bundle.
    expect(entryAsset(page.text)).toBe(awake.asset)
    expect(Date.now() - t0).toBeLessThan(3_000)
  })

  it('away: a deep link is the same page, and a hashed asset it names loads, the same bytes', async () => {
    const deep = await c.replica('GET', '/notes', { headers: NAV })
    expect(deep.status).toBe(200)
    expect(deep.text).toContain('<div id="root"')
    const asset = await c.replica('GET', awake.asset)
    expect(asset.status).toBe(200)
    expect(String(asset.headers['content-type'])).toMatch(/javascript/)
    expect(Buffer.byteLength(asset.text)).toBe(awake.assetBytes)
    // A chunk no build has stays loud (the client's reload recovery needs it).
    const gone = await c.replica('GET', '/assets/index-0000000000.js')
    expect(gone.status).toBe(404)
  })

  it('back: the Mac serves the page again', async () => {
    c.wakeMac()
    const ms = await c.waitBack(token)
    expect(ms).toBeLessThan(WINDOWS.quietMs + 60_000)
    const page = await c.replica('GET', '/', { headers: NAV })
    expect(page.status).toBe(200)
    expect(page.headers['x-walnut-answered-via']).toBe('leader')
    expect(entryAsset(page.text)).toBe(awake.asset)
  })
})
