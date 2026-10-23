/**
 * A cloud companion box set up before the compiled walnut file moves to it with
 * no step on the box (docs/plan/walnut-single-binary.md, "The cloud companion").
 *
 * The box is a container laid out the way v0.6.17 left one (old-box/box-setup.sh):
 * Node 22, root's code tree /opt/walnut with v0.6.17's launcher, the walnut
 * user's data dir and hub, and the v0.6.17 build a Mac on v0.6.17 installed,
 * named by companion/current. walnut.service is old-box/supervise.sh, which does
 * what systemd does for the v0.6.17 unit and its drop-ins (Node, the launcher,
 * Restart=always, KillMode=process). Nothing in the container is ever changed
 * by hand, except in the last step, which does what a later setup.sh does.
 *
 * The Mac is this checkout's driver (core/companion-build/mac.ts), in this
 * process, over HTTP with the machine credential, packing the real companion
 * package (core/companion-build/package.ts). Its walnut file source is stubbed
 * only to hand out two real compiled files for the box's Linux, built by
 * old-box/run.sh from this checkout's HEAD and from one empty commit later.
 *
 *   0  the box runs v0.6.17 (Node, the v0.6.17 launcher)
 *   A  a Mac on file A: v0.6.17's box code installs it and its launcher starts
 *      it through the shim; the file confirms itself
 *   -  a restart of walnut.service keeps A
 *   B  file A's box code installs file B (the file runs the shim as bun)
 *   C  a build that never serves is given up; B keeps running
 *   -  setup.sh again: the unit runs the new launcher on bun; B keeps running
 *
 * Opt in: WALNUT_OLD_BOX_E2E=1, with the inputs run.sh prepares (run that):
 * WALNUT_OLD_BOX_RELEASE (the v0.6.17 Linux archive), WALNUT_OLD_BOX_FILES
 * (<dir>/{a,b}/{walnut,build-info.json}), WALNUT_OLD_BOX_BUN (bun's Linux file,
 * optional: the last step), WALNUT_OLD_BOX_EVIDENCE (where the process trees and
 * the box log go).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BOX_DIR = path.join(REPO, 'tests', 'e2e', 'old-box')
const ON = process.env.WALNUT_OLD_BOX_E2E === '1'
const R = '/var/lib/walnut/.open-walnut-host'
const IMAGE = 'walnut-old-box:debian12'

const h = vi.hoisted(() => ({
  endpoint: null as { url: string; token: string } | null,
  build: null as { id: string; version: string; commit: string; file: string } | null,
}))

vi.mock('../../src/constants.js', () => createMockConstants('walnut-companion-old-box-e2e'))
vi.mock('../../src/core/cloud-ingest.js', () => ({
  cloudSessionEndpoint: async () => h.endpoint,
  recoverCloudSessionCredential: async () => {},
}))
vi.mock('../../src/core/host-server/index.js', async () => {
  const crypto = await import('node:crypto')
  const fs = await import('node:fs')
  const zlib = await import('node:zlib')
  return {
    sharedHostFileSource: () => ({
      async buildId() {
        if (!h.build) throw new Error('no build')
        return { id: h.build.id, version: h.build.version, commit: h.build.commit }
      },
      async file(target: string) {
        const b = h.build!
        const body = fs.readFileSync(b.file)
        const gz = zlib.gzipSync(body, { level: 6 })
        const sha = (x: Buffer) => crypto.createHash('sha256').update(x).digest('hex')
        return { id: b.id, version: b.version, commit: b.commit, target, gz, sha256: sha(body), gzSha256: sha(gz) }
      },
    }),
  }
})
vi.mock('../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfig: async () => ({ cloud_bridge: { auto_update: true } }),
}))

import { buildIdOf, type BoxBuildStatus } from '../../src/core/companion-build/wire.js'
import { _resetCompanionBuildForTesting, companionBuildView, tickCompanionBuild } from '../../src/core/companion-build/mac.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')

/** docker with the real user's docker config: the test home is a fake one. */
function docker(args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string; err: string }> {
  const env = { ...process.env, DOCKER_CONFIG: process.env.DOCKER_CONFIG || path.join(os.userInfo().homedir, '.docker') }
  return new Promise((resolve) => {
    execFile('docker', args, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, out, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, out: String(out), err: String(stderr) })
    })
  })
}
async function must(args: string[], timeoutMs?: number): Promise<string> {
  const r = await docker(args, timeoutMs)
  if (r.code !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed (${r.code}): ${r.err.slice(-2000)}`)
  return r.out
}

function readBuild(dir: string): NonNullable<typeof h.build> {
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'build-info.json'), 'utf8'))
  return { id: buildIdOf(info), version: info.version, commit: info.commit, file: path.join(dir, 'walnut') }
}

interface Proc { pid: number; ppid: number; user: string; args: string }

describe.skipIf(!ON)('a companion box from before the compiled file moves to it (a container laid out like v0.6.17)', () => {
  const name = `walnut-old-box-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
  const token = crypto.randomBytes(16).toString('hex')
  const evidence = process.env.WALNUT_OLD_BOX_EVIDENCE || path.join(os.tmpdir(), 'walnut-old-box-evidence')
  let inDir = ''
  let started = false
  let oldId = ''
  let fileA: NonNullable<typeof h.build>
  let fileB: NonNullable<typeof h.build>
  let fileC: NonNullable<typeof h.build>

  async function status(): Promise<BoxBuildStatus | null> {
    try {
      const r = await fetch(`${h.endpoint!.url}/build`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) })
      return r.status === 200 ? await r.json() as BoxBuildStatus : null
    } catch { return null }
  }
  async function boxLog(): Promise<string> {
    const r = await docker(['logs', name])
    return r.out + r.err
  }
  async function waitFor(what: string, ok: (s: BoxBuildStatus) => boolean, ms: number): Promise<BoxBuildStatus> {
    const deadline = Date.now() + ms
    let last: BoxBuildStatus | null = null
    while (Date.now() < deadline) {
      last = await status()
      if (last && ok(last)) return last
      await sleep(1_000)
    }
    throw new Error(`${what}: not within ${ms} ms. Last status: ${JSON.stringify(last)}\n--- box log ---\n${(await boxLog()).slice(-8000)}`)
  }
  async function sh(script: string): Promise<string> {
    return must(['exec', name, '/bin/sh', '-c', script])
  }
  async function procs(): Promise<Proc[]> {
    const out = await sh('ps -eo pid=,ppid=,user=,args=')
    return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = /^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)!
      return { pid: Number(m[1]), ppid: Number(m[2]), user: m[3], args: m[4] }
    })
  }
  /** The service's process tree, from its main pid: [launcher, its child, the child's child]. */
  async function serviceChain(): Promise<Proc[]> {
    const main = Number((await sh('cat /run/box/main.pid')).trim())
    const all = await procs()
    const chain: Proc[] = []
    let p = all.find((x) => x.pid === main)
    while (p && chain.length < 3) {
      chain.push(p)
      const parent: Proc = p
      p = all.find((x) => x.ppid === parent.pid && !/\bdaemon\b|__daemon/.test(x.args))
    }
    return chain
  }
  async function keep(label: string): Promise<void> {
    await fsp.mkdir(evidence, { recursive: true })
    const tree = (await procs()).map((p) => `${String(p.pid).padStart(6)} ${String(p.ppid).padStart(6)} ${p.user.padEnd(8)} ${p.args}`).join('\n')
    const s = await status()
    await fsp.writeFile(path.join(evidence, `${label}.txt`), `# ${label}\n\n## status\n${JSON.stringify(s, null, 2)}\n\n## processes (pid ppid user args)\n${tree}\n`)
  }
  async function restartService(): Promise<void> {
    const before = Number((await sh('cat /run/box/main.pid')).trim())
    await sh(`kill -TERM ${before}`)
    for (const end = Date.now() + 60_000; Date.now() < end; await sleep(500)) {
      const now = (await docker(['exec', name, 'cat', '/run/box/main.pid'])).out.trim()
      if (now && Number(now) !== before) return
    }
    throw new Error(`walnut.service did not start again after pid ${before} was stopped`)
  }
  const servesWeb = (p: Proc, dir: string) => p.args.includes(`${R}/app/${dir}/`) && / web --port 3456$/.test(p.args)

  beforeAll(async () => {
    const release = process.env.WALNUT_OLD_BOX_RELEASE ?? ''
    const files = process.env.WALNUT_OLD_BOX_FILES ?? ''
    for (const f of [release, path.join(files, 'a', 'walnut'), path.join(files, 'a', 'build-info.json'), path.join(files, 'b', 'walnut'), path.join(files, 'b', 'build-info.json')]) {
      if (!f || !fs.existsSync(f)) throw new Error(`input ${f || '(unset)'} is missing: run tests/e2e/old-box/run.sh`)
    }
    fileA = readBuild(path.join(files, 'a'))
    fileB = readBuild(path.join(files, 'b'))
    expect(fileA.id).not.toBe(fileB.id)

    inDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-old-box-in-'))
    // The 0.6.17 build's id, from the archive's own build-info.
    const top = path.basename(release).replace(/\.tar\.gz$/, '')
    const info = await new Promise<string>((resolve, reject) => execFile('tar', ['-xzOf', release, `${top}/runtime/lib/node_modules/open-walnut/dist/build-info.json`], (err, out) => err ? reject(err) : resolve(String(out))))
    oldId = buildIdOf(JSON.parse(info))
    // The launcher ensure-harness.sh's drop-in started on v0.6.17.
    const launcher = await new Promise<string>((resolve, reject) => execFile('git', ['-C', REPO, 'show', 'v0.6.17:scripts/cloud/companion-launch.mjs'], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => err ? reject(err) : resolve(String(out))))
    fs.writeFileSync(path.join(inDir, 'companion-launch.mjs'), launcher)
    const now = new Date().toISOString()
    fs.writeFileSync(path.join(inDir, 'auth.json'), JSON.stringify({ devices: [
      { name: 'bridge-local', id: `d${crypto.randomBytes(8).toString('hex')}`, tokenHash: sha(token), createdAt: now, kind: 'machine' },
    ] }))
    // The unit's EnvironmentFile: knobs that keep the box quiet (no model
    // downloads, no self update) and its trial confirmation short.
    fs.writeFileSync(path.join(inDir, 'walnut.env'), [
      'WALNUT_COMPANION_CONFIRM_MS=5000',
      'WALNUT_COMPANION_SMOKE_MS=300000',
      'WALNUT_COMPANION_TRIAL_DEADLINE_MS=300000',
      'WALNUT_DISABLE_SEARCH=1',
      'WALNUT_DISABLE_BACKGROUND_AI=1',
      'WALNUT_STT_AUTO_SETUP=0',
      'WALNUT_LOCAL_CLAUDE_PROBE=0',
      'WALNUT_NO_AUTO_UPDATE=1',
      '',
    ].join('\n'))
    fs.chmodSync(inDir, 0o755)
    for (const n of fs.readdirSync(inDir)) fs.chmodSync(path.join(inDir, n), 0o644)

    // C answers --version (the install's check) and never serves (the smoke boot's).
    const cFile = path.join(inDir, 'walnut-c')
    fs.writeFileSync(cFile, '#!/bin/sh\nif [ "$1" = --version ]; then echo 0.0.0; exit 0; fi\necho "build C does not serve" >&2\nexit 7\n', { mode: 0o755 })
    fileC = { id: `${fileB.version}-e2ec00001`, version: fileB.version, commit: 'e2ec00001', file: cFile }

    await must(['build', '-q', '-t', IMAGE, '-f', path.join(BOX_DIR, 'Dockerfile'), BOX_DIR], 900_000)
    // --init: a real init as pid 1 reaps what the daemons leave, as systemd's would.
    await must(['run', '-d', '--init', '--name', name, '--label', 'walnut-old-box=1', '-p', '127.0.0.1::8080',
      '-e', `OLD_ID=${oldId}`, '-v', `${inDir}:/in:ro`, '-v', `${BOX_DIR}:/box:ro`, '-v', `${release}:/rel/release.tgz:ro`,
      ...(process.env.WALNUT_OLD_BOX_BUN ? ['-v', `${process.env.WALNUT_OLD_BOX_BUN}:/rel/bun:ro`] : []),
      IMAGE, '/bin/bash', '/box/box-setup.sh'])
    started = true
    const mapped = (await must(['port', name, '8080/tcp'])).trim().split('\n')[0]!
    h.endpoint = { url: `http://${mapped}/bridge`, token }
    process.env.WALNUT_COMPANION_BUILD_POLL_MS = '1000'
    await waitFor('the box serves its v0.6.17 build', (s) => s.running.id === oldId && !s.running.base, 600_000)
  }, 1_200_000)

  afterAll(async () => {
    delete process.env.WALNUT_COMPANION_BUILD_POLL_MS
    await _resetCompanionBuildForTesting().catch(() => {})
    if (started) {
      await fsp.mkdir(evidence, { recursive: true }).catch(() => {})
      await fsp.writeFile(path.join(evidence, 'box.log'), await boxLog()).catch(() => {})
      await docker(['rm', '-f', name], 60_000)
    }
    if (inDir) await fsp.rm(inDir, { recursive: true, force: true }).catch(() => {})
  }, 120_000)

  it('starts on the v0.6.17 build a Mac sent, run by Node through the v0.6.17 launcher', async () => {
    const s = (await status())!
    expect(s.accepts).toBe(true)
    expect(s.running).toMatchObject({ id: oldId, base: false, trial: false })
    expect(s.current).toBe(oldId)
    expect(s.platform).toBe('linux')
    const [launcher, server] = await serviceChain()
    expect(launcher!.args).toBe('/usr/local/bin/node /opt/walnut/scripts/cloud/companion-launch.mjs web --port 3456')
    expect(launcher!.user).toBe('walnut')
    expect(server!.args).toBe(`/usr/local/bin/node ${R}/app/${oldId}/dist/cli.js web --port 3456`)
    await keep('0-v0.6.17')
  })

  it('a Mac on the compiled file moves it to the file: the v0.6.17 box code installs it, its launcher starts it', async () => {
    h.build = fileA
    await tickCompanionBuild('retry')
    expect(companionBuildView(), (await boxLog()).slice(-6000)).toMatchObject({ state: 'current', mine: fileA.id, theirs: fileA.id })
    const s = (await status())!
    // The server the launcher started as A's trial, which confirmed itself: A is
    // current and no trial is left. It keeps its trial env until it next starts.
    expect(s.running).toMatchObject({ id: fileA.id, base: false, trial: true })
    expect(s.current).toBe(fileA.id)
    expect(s.trial).toBeNull()
    // The build is the file and the shim; nothing was installed beside it.
    expect((await sh(`cd ${R}/app/${fileA.id} && ls -A | sort`)).trim().split('\n')).toEqual(['.ready', 'dist', 'node_modules', 'package.json', 'walnut'])
    expect((await sh(`cd ${R}/app/${fileA.id} && test -x walnut && ls dist && sha256sum walnut`)).trim()).toBe(
      `cli.js\n${crypto.createHash('sha256').update(fs.readFileSync(fileA.file)).digest('hex')}  walnut`)
    // The unchanged launcher, on Node, runs the shim, which runs the file.
    const [launcher, shim, file] = await serviceChain()
    expect(launcher!.args).toBe('/usr/local/bin/node /opt/walnut/scripts/cloud/companion-launch.mjs web --port 3456')
    expect(shim!.args).toBe(`/usr/local/bin/node ${R}/app/${fileA.id}/dist/cli.js web --port 3456`)
    expect(file!.args).toBe(`${R}/app/${fileA.id}/walnut web --port 3456`)
    expect(Number((await sh(`cat ${R}/companion/file-server.pid`)).trim())).toBe(file!.pid)
    // The v0.6.17 server is gone.
    expect((await procs()).filter((p) => servesWeb(p, oldId))).toEqual([])
    await keep('1-file-a')
  }, 1_800_000)

  it('a restart of walnut.service keeps the file (current, not a trial), with one server', async () => {
    await restartService()
    await waitFor('the box is back on A after a restart', (s) => s.running.id === fileA.id && !s.running.trial && s.current === fileA.id, 300_000)
    const servers = (await procs()).filter((p) => / web --port 3456$/.test(p.args) && p.args.includes('/walnut web'))
    expect(servers.map((p) => p.args)).toEqual([`${R}/app/${fileA.id}/walnut web --port 3456`])
    await tickCompanionBuild('retry')
    expect(companionBuildView()).toMatchObject({ state: 'current', mine: fileA.id })
    await keep('2-file-a-restarted')
  }, 600_000)

  it('the file installs the next file: B, through the box code inside A', async () => {
    // A Mac changes its build only by restarting: the driver keeps its id per process.
    await _resetCompanionBuildForTesting()
    h.build = fileB
    await tickCompanionBuild('retry')
    expect(companionBuildView(), (await boxLog()).slice(-6000)).toMatchObject({ state: 'current', mine: fileB.id, theirs: fileB.id })
    const s = (await status())!
    expect(s.running).toMatchObject({ id: fileB.id, base: false, trial: true })
    expect(s.current).toBe(fileB.id)
    expect(s.trial).toBeNull()
    // A's box code tried B's shim on the runtime it is: the file, as bun.
    expect((await sh(`cat ${R}/app/${fileB.id}/.runtime`)).trim()).toBe('bun')
    const [, shim, file] = await serviceChain()
    expect(shim!.args).toBe(`/usr/local/bin/node ${R}/app/${fileB.id}/dist/cli.js web --port 3456`)
    expect(file!.args).toBe(`${R}/app/${fileB.id}/walnut web --port 3456`)
    expect((await procs()).filter((p) => servesWeb(p, fileA.id))).toEqual([])
    await keep('3-file-b')
  }, 1_800_000)

  it('a build that never serves is given up after its smoke boot; B keeps running', async () => {
    await _resetCompanionBuildForTesting()
    h.build = fileC
    await tickCompanionBuild('retry')
    const view = companionBuildView()
    expect(view.state, JSON.stringify(view)).toBe('failed')
    const s = (await status())!
    expect(s.running.id).toBe(fileB.id)
    expect(s.current).toBe(fileB.id)
    expect(s.failed.map((f) => f.id)).toContain(fileC.id)
    await keep('4-c-given-up')
  }, 1_200_000)

  it.skipIf(!process.env.WALNUT_OLD_BOX_BUN)('after setup.sh runs again (bun, the new launcher), the box keeps running the file', async () => {
    // What setup.sh and ensure-harness.sh of this checkout do to the unit: bun in
    // ExecStart, the launcher from the new code tree.
    await sh('install -m 755 /rel/bun /usr/local/bin/bun')
    const launcher = fs.readFileSync(path.join(REPO, 'scripts', 'cloud', 'companion-launch.mjs'))
    const tmp = path.join(inDir, '..', `${path.basename(inDir)}-launch.mjs`)
    fs.writeFileSync(tmp, launcher)
    try { await must(['cp', tmp, `${name}:/opt/walnut/scripts/cloud/companion-launch.mjs`]) } finally { fs.rmSync(tmp, { force: true }) }
    await sh('chown root:root /opt/walnut/scripts/cloud/companion-launch.mjs && chmod 644 /opt/walnut/scripts/cloud/companion-launch.mjs')
    const L = '/opt/walnut/scripts/cloud/companion-launch.mjs'
    await sh(`printf '%s\\n' "/bin/sh -c 'if [ -f ${L} ]; then exec /usr/local/bin/bun ${L} web --port 3456; else exec /usr/local/bin/bun /opt/walnut/dist/cli.js web --port 3456; fi'" > /run/box/exec-start`)
    await restartService()
    await waitFor('the box runs B under the new launcher', (s) => s.running.id === fileB.id && !s.running.trial && s.current === fileB.id, 300_000)
    const [l, shim, file] = await serviceChain()
    expect(l!.args).toBe(`/usr/local/bin/bun ${L} web --port 3456`)
    expect(shim!.args).toBe(`/usr/local/bin/bun ${R}/app/${fileB.id}/dist/cli.js web --port 3456`)
    expect(file!.args).toBe(`${R}/app/${fileB.id}/walnut web --port 3456`)
    expect(await boxLog()).toContain(`running current build ${fileB.id}`)
    await keep('5-new-launcher-on-bun')
  }, 600_000)
})
