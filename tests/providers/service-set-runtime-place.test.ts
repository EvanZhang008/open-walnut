/**
 * A service set's service that runs the compiled walnut file unpacks the file's runtime tree in its
 * own install root, and prunes old builds' trees only there.
 *
 * 2026-11-24, a real-systemd drill of two Walnuts on one machine (R1): the set's unit carried no
 * WALNUT_RUNTIME_DIR, so every start of its walnut file unpacked `~/.open-walnut/local/runtime/<build>`,
 * the default Walnut's, and then pruned that dir to the two newest other builds: on a machine whose
 * default Walnut keeps three trees there, a set's start deletes one it may run from. Now every file a
 * set renders (unit, LaunchAgent, boot script, launcher) names `<install root>/runtime`
 * (service-set.ts serviceSetEnv), and the file prunes that dir as its own (runtime-tree.ts).
 *
 * MACHINE SAFETY: HOME and every tree are temp paths; process.env is restored after each test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { packArchive } from '../../src/binary/asset-archive.js'
import { RUNTIME_MARKER, ensureRuntime, mayPruneForArgv } from '../../src/binary/runtime-tree.js'
import { renderDaemonBootScript } from '../../src/providers/daemon-service-boot-script.js'
import { renderDaemonLaunchAgent, renderDaemonSystemdUnit, type DaemonServiceConfig } from '../../src/providers/daemon-service-config.js'
import { createLauncherControl } from '../../src/providers/service-launcher-control.js'
import { serviceSet } from '../../src/providers/service-set.js'

const ID = '0123456789abcdef'
const BUILD = '1.0.0-bbbbbbbbbbbb'
const OLD = ['0.9.0-000000000001', '0.9.0-000000000002', '0.9.0-000000000003']

let home: string
const saved = { ...process.env }
beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-set-rt-'))) })
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  Object.assign(process.env, saved)
  fs.rmSync(home, { recursive: true, force: true })
})

function config(platform: 'linux' | 'darwin', id = ID): DaemonServiceConfig {
  const set = serviceSet(platform, home, id, { uid: 1000, runtimeDir: '/tmp/open-walnut' })
  return {
    platform, home, executable: `${set.installRoot}/versions/abc/daemon`, args: ['--service'],
    runtimeDir: set.runtimeDir, stateDir: set.installRoot, path: '/usr/bin:/bin', ...(id ? { serviceSet: id } : {}),
  }
}

/** The env a rendered unit, LaunchAgent or script gives its program. */
function envOf(kind: 'unit' | 'plist' | 'script', text: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (kind === 'unit') for (const m of text.matchAll(/^Environment="([A-Z_]+)=((?:\\.|[^"\\])*)"$/gm)) env[m[1]!] = m[2]!.replace(/%%/g, '%')
  if (kind === 'plist') for (const m of text.matchAll(/<key>([A-Z_]+)<\/key>\s*<string>([^<]*)<\/string>/g)) env[m[1]!] = m[2]!
  if (kind === 'script') for (const m of text.matchAll(/^export ([A-Z_]+)='([^']*)'$/gm)) env[m[1]!] = m[2]!
  return env
}

function rendered(id = ID): Array<{ name: string; env: Record<string, string> }> {
  const linux = config('linux', id)
  const out = [
    { name: 'user unit', env: envOf('unit', renderDaemonSystemdUnit(linux, 'user')) },
    { name: 'launcher unit', env: envOf('unit', renderDaemonSystemdUnit(linux, 'user', { launcher: `${linux.stateDir}/walnut-launcher.sh` })) },
    { name: 'system unit', env: envOf('unit', renderDaemonSystemdUnit({ ...linux, user: 'walnut' }, 'system')) },
    { name: 'LaunchAgent', env: envOf('plist', renderDaemonLaunchAgent(config('darwin', id))) },
    { name: 'boot script', env: envOf('script', renderDaemonBootScript(linux)) },
  ]
  for (const backend of ['systemd', 'launchd', 'cron'] as const) {
    const L = createLauncherControl({ stateDir: linux.stateDir, backend })
    out.push({ name: `launcher (${backend})`, env: envOf('script', L.render(linux, linux.executable)) })
  }
  return out
}

const archiveFile = (): string => {
  const file = path.join(home, 'assets.bin')
  fs.writeFileSync(file, packArchive([{ path: 'package.json', mode: 0o644, data: Buffer.from('{}\n') }], 3))
  return file
}

/** Trees of older builds in `parent`, oldest first (their markers' mtimes). */
function plantOld(parent: string): void {
  OLD.forEach((id, i) => {
    fs.mkdirSync(path.join(parent, id), { recursive: true })
    fs.writeFileSync(path.join(parent, id, RUNTIME_MARKER), `${id}\n`)
    const t = new Date(Date.now() - (OLD.length - i) * 3600_000)
    fs.utimesSync(path.join(parent, id, RUNTIME_MARKER), t, t)
  })
}

const ls = (dir: string): string[] => { try { return fs.readdirSync(dir).sort() } catch { return [] } }

/** Start "the file" with exactly the env its service file gives it (HOME, and the runtime place keys). */
function startWith(env: Record<string, string>): string {
  delete process.env.OPEN_WALNUT_HOME
  delete process.env.WALNUT_RUNTIME_DIR
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  return ensureRuntime(archiveFile(), BUILD)
}

describe('a service set\'s files give the walnut file a runtime place of its own', () => {
  it('every file a set renders names <install root>/runtime', () => {
    const R = `${home}/.open-walnut-host/walnuts/${ID}`
    for (const { name, env } of rendered()) expect(env.WALNUT_RUNTIME_DIR, name).toBe(`${R}/daemon/runtime`)
  })

  it('a start of the file with the set unit\'s env unpacks and prunes only in the set\'s dir', () => {
    const defaultTrees = path.join(home, '.open-walnut', 'local', 'runtime')
    const setTrees = path.join(home, '.open-walnut-host', 'walnuts', ID, 'daemon', 'runtime')
    plantOld(defaultTrees)
    plantOld(setTrees)
    const root = startWith(rendered().find((r) => r.name === 'launcher unit')!.env)
    expect(root).toBe(path.join(setTrees, BUILD))
    // The default Walnut's trees are exactly as they were: none added, none pruned.
    expect(ls(defaultTrees)).toEqual([...OLD].sort())
    // Its own dir is pruned as a data home's is: this build and the two newest others.
    expect(ls(setTrees)).toEqual([OLD[1]!, OLD[2]!, BUILD].sort())
  })

  it('the default set\'s unit is today\'s: the data home\'s dir, pruned there', () => {
    for (const { name, env } of rendered('')) expect(env.WALNUT_RUNTIME_DIR, name).toBeUndefined()
    const defaultTrees = path.join(home, '.open-walnut', 'local', 'runtime')
    plantOld(defaultTrees)
    expect(startWith({ HOME: home })).toBe(path.join(defaultTrees, BUILD))
    expect(ls(defaultTrees)).toEqual([OLD[1]!, OLD[2]!, BUILD].sort())
  })
})

describe('a leader\'s `walnut daemon ... --walnut <id>` line run by the walnut file prunes nothing', () => {
  it('only the on-host CLI line naming a Walnut is kept from pruning', () => {
    const exe = '/x/walnut'
    expect(mayPruneForArgv([exe, '/$bunfs/root/walnut', 'walnut', 'daemon', 'install', '--yes', '--walnut', 'a'.repeat(32)], exe)).toBe(false)
    expect(mayPruneForArgv([exe, '/$bunfs/root/walnut', exe, 'wn', 'daemon', 'status', '--walnut', 'a'.repeat(32)], exe)).toBe(false)
    expect(mayPruneForArgv([exe, '/$bunfs/root/walnut', 'walnut', 'daemon', 'status'], exe)).toBe(true)
    expect(mayPruneForArgv([exe, '/$bunfs/root/walnut', '--service'], exe)).toBe(true)
    expect(mayPruneForArgv([exe, '/$bunfs/root/walnut', 'web'], exe)).toBe(true)
  })

  it('with prune off the file unpacks where it always did and leaves the other trees there', () => {
    const defaultTrees = path.join(home, '.open-walnut', 'local', 'runtime')
    plantOld(defaultTrees)
    delete process.env.OPEN_WALNUT_HOME
    delete process.env.WALNUT_RUNTIME_DIR
    process.env.HOME = home
    expect(ensureRuntime(archiveFile(), BUILD, { prune: false })).toBe(path.join(defaultTrees, BUILD))
    expect(ls(defaultTrees)).toEqual([...OLD, BUILD].sort())
  })
})
