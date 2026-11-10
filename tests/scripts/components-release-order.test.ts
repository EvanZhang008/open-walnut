/**
 * No Walnut release goes out before the optional components it pins.
 *
 * Walnut downloads each optional component (embedding, images, audio capture) the first time a
 * feature needs it, from the `component-<name>-<version>` prerelease that
 * src/core/components/manifest-data.ts pins. Those were published only by running
 * components.yml by hand, so a commit could pin an archive nobody had published, and its first
 * use would 404: the same class as the host network connector of 2026-11-09
 * (tests/scripts/net-release-order.test.ts). Now a push to main that changes the pins publishes
 * what is missing, and every release gate asks scripts/components-release-ready.mjs first, which
 * reads the same pins and URL the client does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { parse as parseYaml } from 'yaml'
import { COMPONENTS_MANIFEST } from '../../src/core/components/manifest-data.js'
import { assetUrl } from '../../src/core/components/manifest.js'
import type { ComponentName } from '../../src/core/components/types.js'
// @ts-expect-error plain JS script without types
import { readManifest, pinnedAssets } from '../../scripts/components-release-ready.mjs'

const ROOT = path.resolve(__dirname, '../..')
const WORKFLOWS = path.join(ROOT, '.github/workflows')
const SCRIPT = path.join(ROOT, 'scripts/components-release-ready.mjs')
const PIN = 'src/core/components/manifest-data.ts'

type Step = { id?: string; run?: string }
type Job = { needs?: string | string[]; if?: string; outputs?: Record<string, string>; steps?: Step[] }
type Workflow = { on?: Record<string, { branches?: string[]; paths?: string[] } | null>; jobs: Record<string, Job> }

const load = (f: string) => parseYaml(fs.readFileSync(path.join(WORKFLOWS, f), 'utf8')) as Workflow
const runs = (j: Job) => (j.steps ?? []).map((s) => s.run ?? '').join('\n')
type Asset = { name: string; platform: string; tag: string; asset: string; url: string }

describe('the check reads the pins the client reads', () => {
  it('finds every archive of manifest-data.ts, at the URL assetUrl gives', () => {
    const m = readManifest(fs.readFileSync(path.join(ROOT, PIN), 'utf8'))
    expect(m).toEqual(COMPONENTS_MANIFEST)
    const prev = process.env.WALNUT_COMPONENTS_BASE_URL
    delete process.env.WALNUT_COMPONENTS_BASE_URL
    try {
      const assets: Asset[] = pinnedAssets(m, undefined)
      const expected = Object.entries(COMPONENTS_MANIFEST.components).flatMap(([name, c]) =>
        Object.values(c.platforms).map((e) => assetUrl(name as ComponentName, e)))
      expect(assets.map((a) => a.url).sort()).toEqual(expected.sort())
      expect(assets.length).toBeGreaterThanOrEqual(Object.keys(COMPONENTS_MANIFEST.components).length)
      // A mirror the client is pointed at is the one the check asks.
      process.env.WALNUT_COMPONENTS_BASE_URL = 'http://mirror.test/c/'
      const [name, c] = Object.entries(COMPONENTS_MANIFEST.components)[0]
      const first = Object.values(c.platforms)[0]
      expect(pinnedAssets(m).find((a: Asset) => a.asset === first.asset)?.url).toBe(assetUrl(name as ComponentName, first))
    } finally {
      if (prev === undefined) delete process.env.WALNUT_COMPONENTS_BASE_URL
      else process.env.WALNUT_COMPONENTS_BASE_URL = prev
    }
  })

  it('reads no manifest out of a file in another shape', () => {
    expect(readManifest('export const X = 1')).toBeNull()
    expect(readManifest('export const COMPONENTS_MANIFEST = { "schema": 1, }')).toBeNull()
  })
})

describe('scripts/components-release-ready.mjs', () => {
  let server: http.Server
  let base = ''
  const missing = new Set<string>()
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const name = decodeURIComponent(path.basename(req.url ?? ''))
      res.writeHead(missing.has(name) ? 404 : 200).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  /** Runs the script in a tree of its own holding `pin` as manifest-data.ts. */
  function ready(pin: string, args: string[] = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'components-ready-'))
    fs.mkdirSync(path.join(dir, path.dirname(PIN)), { recursive: true })
    fs.writeFileSync(path.join(dir, PIN), pin)
    return new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, [SCRIPT, ...args], { cwd: dir, env: { ...process.env, WALNUT_COMPONENTS_BASE_URL: base } })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (out += d))
      p.on('close', (code) => {
        fs.rmSync(dir, { recursive: true, force: true })
        resolve({ code, out })
      })
    })
  }
  const realPin = () => fs.readFileSync(path.join(ROOT, PIN), 'utf8')
  const allAssets = () => Object.values(COMPONENTS_MANIFEST.components).flatMap((c) => Object.values(c.platforms).map((e) => e.asset))

  it('passes when every pinned archive answers', async () => {
    missing.clear()
    const r = await ready(realPin())
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`all ${allAssets().length} pinned component archives are out`)
  })

  it('fails, naming it, when one platform of one component is not out', async () => {
    const one = allAssets()[allAssets().length - 1]
    missing.clear()
    missing.add(one)
    const r = await ready(realPin())
    expect(r.code).toBe(1)
    expect(r.out).toContain(`${one}: HTTP 404`)
    expect(r.out).toMatch(/1 of \d+ pinned component archives are not out/)
  })

  it('stops with 2 on a manifest file it cannot read, or a commit that has none', async () => {
    missing.clear()
    expect((await ready('export const NOTHING = 1\n')).code).toBe(2)
    expect((await ready(realPin(), ['--at', 'no-such-rev'])).code).toBe(2)
  })
})

describe('the component releases come first', () => {
  it('no Walnut release goes out before the components it pins, at every gate the connector has', () => {
    const jobs = load('release.yml').jobs
    // The same three places net-release-order.test.ts pins for the connector.
    expect(runs(jobs['nightly-build'])).toMatch(/elif ! bun scripts\/components-release-ready\.mjs --at "\$green"; then\n(?:\s*#.*\n)*\s*echo "publish=false"/)
    expect(runs(jobs['promote-plan'])).toMatch(/elif ! bun scripts\/components-release-ready\.mjs --at "\$SHA"; then\n(?:\s*#.*\n)*\s*echo "publish=false"/)
    expect(runs(jobs['stable-build'])).toMatch(/^bun scripts\/components-release-ready\.mjs$/m)
    // Any job that asks for the connector asks for the components too.
    for (const [name, j] of Object.entries(jobs)) {
      if (/net-release-ready\.sh/.test(runs(j))) expect(runs(j), name).toMatch(/components-release-ready\.mjs/)
    }
  })

  it('components.yml publishes what is missing when a push to main changes the pins, and builds nothing when all is out', () => {
    const w = load('components.yml')
    expect(w.on?.push?.branches).toEqual(['main'])
    expect(w.on?.push?.paths).toContain(PIN)
    expect(w.on).toHaveProperty('workflow_dispatch')
    expect(w.jobs.plan.if).toBe("github.event_name == 'push'")
    expect(w.jobs.plan.outputs?.publish).toBe('${{ steps.p.outputs.publish }}')
    // A pull request and a run by hand still check and publish as before (plan is skipped there).
    expect(w.jobs.verify.if).toBe("${{ !cancelled() && (github.event_name != 'push' || needs.plan.outputs.publish == 'true') }}")
    expect(w.jobs.release.if).toMatch(/^\$\{\{ !cancelled\(\) && /)
    expect(w.jobs.release.needs).toEqual(['plan', 'verify'])
    expect(w.jobs.release.if).toContain("github.event_name == 'push' && needs.plan.outputs.publish == 'true'")
    expect(w.jobs.release.if).toContain("github.event_name == 'workflow_dispatch' && inputs.publish")
    expect(w.jobs.release.if).toContain("needs.verify.result == 'success'")
  })

  /** Runs the plan step of components.yml with the readiness check stubbed to exit `code`. */
  function planStep(code: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'components-plan-'))
    try {
      const step = load('components.yml').jobs.plan.steps!.find((s) => s.id === 'p')!
      fs.mkdirSync(path.join(dir, 'bin'))
      fs.writeFileSync(path.join(dir, 'bin/bun'), `#!/bin/sh\necho "$*" >> "${dir}/asked"; exit ${code}\n`, { mode: 0o755 })
      fs.writeFileSync(path.join(dir, 'out'), '')
      const r = spawnSync('bash', ['-e', '-c', step.run!], {
        cwd: dir,
        env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, GITHUB_OUTPUT: path.join(dir, 'out') },
        encoding: 'utf8',
      })
      const text = fs.readFileSync(path.join(dir, 'out'), 'utf8').trim()
      const output = Object.fromEntries(text ? text.split('\n').map((l) => l.split('=')) : [])
      return { status: r.status, publish: output.publish, asked: fs.readFileSync(path.join(dir, 'asked'), 'utf8').trim() }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('a push whose archives are out builds nothing; one with an archive missing publishes; an unreadable manifest fails', () => {
    expect(planStep(0)).toEqual({ status: 0, publish: 'false', asked: 'scripts/components-release-ready.mjs' })
    expect(planStep(1)).toEqual({ status: 0, publish: 'true', asked: 'scripts/components-release-ready.mjs' })
    expect(planStep(2)).toEqual({ status: 2, publish: undefined, asked: 'scripts/components-release-ready.mjs' })
  })
})
