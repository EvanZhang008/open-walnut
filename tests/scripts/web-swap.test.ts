/**
 * scripts/web-swap.mjs swaps a freshly built web app under the running server, with no restart
 * (2026-11-27: 22% of the deploys that restarted production changed only web/). Pinned against a
 * throwaway stage tree and a stand-in /api/config that, like the real server, names the bundle of
 * the index.html it serves.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { MARKER, bundleIdInHtml, isStageStaticDir, swapInto } from '../../scripts/web-swap.mjs'
import { bundleIdInHtml as serverBundleId } from '../../src/web/static-mirror.js'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'web-swap.mjs')
const roots: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const html = (bundle: string) => `<!doctype html><script type="module" src="/assets/index-${bundle}.js"></script>`
function write(dir: string, files: Record<string, string>) {
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true })
    fs.writeFileSync(path.join(dir, p), body)
  }
}
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-swap-')))
  roots.push(root)
  const served = path.join(root, 'open-walnut-stage.1.2', 'runtime', '0.6.37-abc', 'dist', 'web', 'static')
  write(served, { 'index.html': html('OLD1'), 'assets/index-OLD1.js': 'old entry', 'assets/chunk-SAME.js': 'same', 'icon.png': 'old icon' })
  const fresh = path.join(root, 'build', 'dist', 'web', 'static')
  write(fresh, { 'index.html': html('NEW2'), 'assets/index-NEW2.js': 'new entry', 'assets/chunk-SAME.js': 'same', 'icon.png': 'new icon', 'downloads/ext.zip': 'zip' })
  return { root, served, fresh }
}
/** /api/config as the server answers it: the bundle of the index.html in `dir`, read per request. */
async function config(dir: () => string | null, build: () => { commit: string; dirty: boolean } = () => ({ commit: 'abc1234', dirty: false }), mirrorDir?: string): Promise<string> {
  const server = http.createServer((_req, res) => {
    const d = dir()
    let bundle: string | null = null
    try { bundle = d ? serverBundleId(fs.readFileSync(path.join(d, 'index.html'), 'utf8')) : null } catch { /* none */ }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ build: build(), webAssets: d ? { staticDir: d, bundle, ok: true, mirrorDir } : null }))
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api/config`
}
const SERVED = ['--expect-commit', 'abc1234def']
const WEB = ['--web-commit', 'fedcba9876543210']
function run(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('bun', [SCRIPT, ...SERVED, ...(args.includes('--check') ? [] : WEB), ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (b) => { out += b })
    child.stderr.on('data', (b) => { out += b })
    child.on('close', (code) => resolve({ code, out }))
  })
}

describe('web-swap.mjs', () => {
  it('reads the entry bundle the way the server does', () => {
    for (const h of [html('AbC_-9'), '<script src="./assets/index-x1.js" type="module">', '<p>none</p>']) {
      expect(bundleIdInHtml(h)).toBe(serverBundleId(h))
    }
  })

  it('only a deploy\'s stage tree is a place to swap into', () => {
    expect(isStageStaticDir('/var/T/open-walnut-stage.1795.86155/runtime/0.6.37-8a95/dist/web/static')).toBe(true)
    expect(isStageStaticDir('/Users/u/walnut/dist/web/static')).toBe(false)
    expect(isStageStaticDir('relative/open-walnut-stage.1/runtime/x/dist/web/static')).toBe(false)
    expect(isStageStaticDir('/var/T/open-walnut-stage.1/runtime/x/dist/web/static/assets')).toBe(false)
  })

  it('copies the new build in additively, leaves files that did not change alone, and moves index.html', () => {
    const { served, fresh } = setup()
    const same = fs.statSync(path.join(served, 'assets', 'chunk-SAME.js')).ino
    swapInto(fresh, served)
    // A window still on the old build keeps fetching its old entry and chunks.
    expect(fs.readFileSync(path.join(served, 'assets', 'index-OLD1.js'), 'utf8')).toBe('old entry')
    expect(fs.readFileSync(path.join(served, 'assets', 'index-NEW2.js'), 'utf8')).toBe('new entry')
    expect(fs.readFileSync(path.join(served, 'icon.png'), 'utf8')).toBe('new icon')
    expect(fs.readFileSync(path.join(served, 'downloads', 'ext.zip'), 'utf8')).toBe('zip')
    expect(fs.statSync(path.join(served, 'assets', 'chunk-SAME.js')).ino).toBe(same)
    expect(bundleIdInHtml(fs.readFileSync(path.join(served, 'index.html'), 'utf8'))).toBe('NEW2')
    expect(fs.readdirSync(served, { recursive: true }).filter((n) => String(n).includes('.swap-'))).toEqual([])
  })

  it('swaps under a running server, waits until it names the new bundle, marks the tree and adds the build to the mirror', async () => {
    const { root, served, fresh } = setup()
    const mirror = path.join(root, 'home', 'cache', 'web-static')
    const url = await config(() => served, undefined, mirror)
    const out = path.join(root, 'bundle.txt')
    const r = await run(['--from', fresh, '--config-url', url, '--out', out, '--wait', '10'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/bundle OLD1 -> NEW2/)
    // The web id: the bundle and the web app's commit, which the marker in the served dir names.
    expect(fs.readFileSync(out, 'utf8').trim()).toBe('NEW2@fedcba987654')
    expect(fs.readFileSync(path.join(served, MARKER), 'utf8').trim()).toBe('fedcba987654')
    // Its chunks outlive the next deploy's stage sweep (src/web/static-mirror.ts generations).
    expect(fs.readFileSync(path.join(mirror, 'gens', 'NEW2', 'assets', 'index-NEW2.js'), 'utf8')).toBe('new entry')
    // Again: nothing changed, nothing is written, no wait.
    const again = await run(['--from', fresh, '--config-url', url, '--out', out, '--wait', '10'])
    expect(again.code, again.out).toBe(0)
    expect(again.out).toMatch(/bundle NEW2 -> NEW2, 0 file\(s\)/)
  }, 30_000)

  it('a change to the web app\'s plain files alone (web/public, an inline script) is copied too, with no bundle to wait for', async () => {
    const { root, served, fresh } = setup()
    write(fresh, { 'index.html': html('OLD1').replace('<!doctype html>', '<!doctype html><script>window.x=2</script>'), 'assets/index-OLD1.js': 'old entry', 'walnut-app-sdk.js': 'v2' })
    fs.rmSync(path.join(fresh, 'assets', 'index-NEW2.js'))
    const url = await config(() => served)
    const r = await run(['--from', fresh, '--config-url', url, '--out', path.join(root, 'o'), '--wait', '1'])
    expect(r.code, r.out).toBe(0)
    expect(fs.readFileSync(path.join(served, 'walnut-app-sdk.js'), 'utf8')).toBe('v2')
    expect(fs.readFileSync(path.join(served, 'index.html'), 'utf8')).toContain('window.x=2')
    expect(fs.readFileSync(path.join(root, 'o'), 'utf8').trim()).toBe('OLD1@fedcba987654')
  }, 30_000)

  it('--check makes every check and changes nothing', async () => {
    const { served } = setup()
    const r = await run(['--check', '--config-url', await config(() => served)])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/can be swapped/)
    expect(fs.existsSync(path.join(served, MARKER))).toBe(false)
  }, 30_000)

  it('refuses (75) a server it cannot swap under: no answer, no web assets, a checkout\'s dist, an index that is not what it serves', async () => {
    const { root, served, fresh } = setup()
    const checkout = path.join(root, 'walnut', 'dist', 'web', 'static')
    write(checkout, { 'index.html': html('OLD1') })
    const cases: Array<[string, RegExp]> = [
      ['http://127.0.0.1:1/api/config', /did not answer/],
      [await config(() => null), /no web assets of its own/],
      [await config(() => checkout), /not a deploy's stage tree/],
      // Another server than the one the change was judged against (a deploy outside the queue
      // replaced it during the build), or a build from a dirty tree.
      [await config(() => served, () => ({ commit: '9999999', dirty: false })), /runs 9999999, not abc1234def/],
      [await config(() => served, () => ({ commit: 'abc1234', dirty: true })), /not a clean build/],
    ]
    for (const [url, why] of cases) {
      const r = await run(['--from', fresh, '--config-url', url, '--wait', '1'])
      expect(r.code, r.out).toBe(75)
      expect(r.out).toMatch(/^Web swap refused: /m)
      expect(r.out).toMatch(why)
    }
    // The server names another bundle than the file on disk (a tree it no longer serves from).
    const lying = http.createServer((_q, res) => res.end(JSON.stringify({ build: { commit: 'abc1234', dirty: false }, webAssets: { staticDir: served, bundle: 'ELSE' } })))
    servers.push(lying)
    await new Promise<void>((r) => lying.listen(0, '127.0.0.1', r))
    const r = await run(['--from', fresh, '--config-url', `http://127.0.0.1:${(lying.address() as { port: number }).port}/`, '--wait', '1'])
    expect(r.code, r.out).toBe(75)
    expect(r.out).toMatch(/is not the bundle the server serves/)
    // Nothing was written in any of them.
    expect(bundleIdInHtml(fs.readFileSync(path.join(served, 'index.html'), 'utf8'))).toBe('OLD1')
    expect(fs.existsSync(path.join(served, 'assets', 'index-NEW2.js'))).toBe(false)
  }, 60_000)

  it('fails (1) when the server keeps naming the old bundle after the swap', async () => {
    const { served, fresh } = setup()
    const stuck = http.createServer((_q, res) => res.end(JSON.stringify({ build: { commit: 'abc1234', dirty: false }, webAssets: { staticDir: served, bundle: 'OLD1' } })))
    servers.push(stuck)
    await new Promise<void>((r) => stuck.listen(0, '127.0.0.1', r))
    const r = await run(['--from', fresh, '--config-url', `http://127.0.0.1:${(stuck.address() as { port: number }).port}/`, '--wait', '2'])
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/still names bundle OLD1 2s after the swap/)
  }, 30_000)
})
