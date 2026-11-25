/**
 * Which hosts can reach the one Walnut service, by system and link (src/providers/one-service-targets.ts).
 *
 * Class guard: every walnut file target the build makes (host-target.ts HOST_FILE_TARGETS) on every
 * link a host's daemon is updated over (SERVE_LINKS) reaches the service with the experiments on,
 * its daemon slot is one the stop command and the live scan know (DAEMON_BINARY_NAMES), and every
 * path that puts the walnut file in a slot asks the one table, with no system test of its own beside
 * it. A new target, link or slot path that cannot reach the service fails here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_FILE_TARGETS } from '../../src/core/host-server/host-target.js'
import { DAEMON_BINARY_NAMES } from '../../src/providers/daemon-live-sh.js'
import {
  daemonSlotName, MACOS_OFF_WHY, macosOneServiceWanted, macSlotArch, SERVE_LINKS, servePlatformWhy, serveSlotWhy, slotArchOf, slotSystemOf, sshTakesSystem,
} from '../../src/providers/one-service-targets.js'
import { EXPERIMENTAL_FEATURES, experimentalEnabled, keepsOwnSwitch } from '../../src/core/experimental.js'

const SRC = path.join(__dirname, '../../src/providers')
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8')

describe('every target on every link reaches the one Walnut service', () => {
  for (const target of HOST_FILE_TARGETS) {
    for (const link of SERVE_LINKS) {
      it(`${target} over ${link}`, () => {
        expect(serveSlotWhy(target, link, { macos: true })).toBeNull()
        // The SSH link sets the host up at all, and names its slot one the scripts know.
        expect(sshTakesSystem(target.split('-')[0]!, { macos: true })).toBe(true)
        expect(DAEMON_BINARY_NAMES).toContain(daemonSlotName(target))
      })
    }
  }

  it('the slot an SSH connect names for each target is the one the target\'s file goes in', () => {
    const uname: Record<string, [string, string]> = {
      'darwin-arm64': ['Darwin', 'arm64'], 'darwin-x64': ['Darwin', 'x86_64'],
      'linux-x64': ['Linux', 'x86_64'], 'linux-arm64': ['Linux', 'aarch64'],
      'linux-x64-musl': ['Linux', 'x86_64'], 'linux-arm64-musl': ['Linux', 'aarch64'],
    }
    for (const target of HOST_FILE_TARGETS) {
      const [os, machine] = uname[target]!
      expect(`daemon-${slotSystemOf(os)}-${slotArchOf(machine)}`).toBe(daemonSlotName(target))
    }
  })
})

describe('with the experiment off', () => {
  it('a Mac is not offered, on either link, and says why; Linux is', () => {
    for (const link of SERVE_LINKS) {
      expect(serveSlotWhy('darwin-arm64', link, { macos: false })).toBe(MACOS_OFF_WHY)
      expect(serveSlotWhy('linux-x64', link, { macos: false })).toBeNull()
    }
    expect(servePlatformWhy('darwin', { macos: false })).toBe(MACOS_OFF_WHY)
    expect(servePlatformWhy('linux', { macos: false })).toBeNull()
    expect(servePlatformWhy('darwin', { macos: true })).toBeNull()
    expect(servePlatformWhy('freebsd', { macos: true })).toMatch(/runs freebsd/)
  })

  it('the SSH link sets up Linux only, as before (not_linux); a system no file is built for never', () => {
    expect(sshTakesSystem('Linux', { macos: false })).toBe(true)
    expect(sshTakesSystem('Darwin', { macos: false })).toBe(false)
    expect(sshTakesSystem('Darwin', { macos: true })).toBe(true)
    expect(sshTakesSystem('FreeBSD', { macos: true })).toBe(false)
    expect(serveSlotWhy('freebsd-x64', 'ssh', { macos: true })).toMatch(/not built for/)
  })
})

describe('the flag', () => {
  const env = process.env.WALNUT_MACOS_ONE_SERVICE
  afterEach(() => { if (env === undefined) delete process.env.WALNUT_MACOS_ONE_SERVICE; else process.env.WALNUT_MACOS_ONE_SERVICE = env })

  it('is registered off by default and keeps its own switch', () => {
    const f = EXPERIMENTAL_FEATURES.find((x) => x.id === 'macos_one_service')
    expect(f?.default).toBe(false)
    expect(keepsOwnSwitch('macos_one_service')).toBe(true)
    expect(experimentalEnabled({ every_experiment: true }, 'macos_one_service')).toBe(false)
    expect(experimentalEnabled({ macos_one_service: true }, 'macos_one_service')).toBe(true)
  })

  it('WALNUT_MACOS_ONE_SERVICE decides for one process', async () => {
    process.env.WALNUT_MACOS_ONE_SERVICE = '1'
    expect(await macosOneServiceWanted()).toBe(true)
    process.env.WALNUT_MACOS_ONE_SERVICE = '0'
    expect(await macosOneServiceWanted()).toBe(false)
  })
})

describe('every path that puts the walnut file in a slot asks the one table', () => {
  it('the SSH link: the connect probe and deployWalnutFile', () => {
    const src = read('daemon-connection.ts')
    // No system test of its own beside the table.
    expect(src).not.toMatch(/startsWith\('linux-'\)/)
    expect(src).not.toMatch(/toLowerCase\(\) !== 'linux'/)
    expect(src).not.toMatch(/`daemon-linux-\$\{/)
    expect(src).toMatch(/serveSlotWhy\(target\.target, 'ssh'/)
    expect(src).toMatch(/sshTakesSystem\(os, \{ macos: await macosOneServiceWanted\(\) \}\)/)
  })

  it('the mode decision and every offer check ask the same table, with the flag', () => {
    const mode = read('one-service-mode.ts')
    expect(mode).toMatch(/servePlatformWhy\(f\.platform, \{ macos: f\.macos === true \}\)/)
    const conn = read('daemon-connection.ts')
    expect(conn).toMatch(/macosWanted: \(\) => macosOneServiceWanted\(\)/)
    expect(conn).toMatch(/servePlatformWhy\(platform, \{ macos: platform === 'darwin' && await macosOneServiceWanted\(\) \}\)/)
    // No platform test of its own beside the table.
    for (const [f, src] of [['one-service-mode.ts', mode], ['daemon-connection.ts', conn]] as const) {
      expect(src, f).not.toMatch(/platform !== 'linux'|platform\(\)\.catch\(\(\) => null\) === 'linux'/)
    }
  })

  it('the host network link: the probed target before --serve, and a set\'s install', () => {
    const net = read('daemon-net-update.ts')
    expect(net).toMatch(/serveSlotWhy\(facts\.target, 'net'/)
    expect(net).toMatch(/serveSlotWhy\(target, 'net'/)
  })

  it('the files that pick, stage or keep a slot\'s file know every slot name', () => {
    expect(read('daemon-trial-cmd.ts')).toMatch(/const BINARY_NAMES = DAEMON_BINARY_NAMES/)
    for (const f of ['daemon-net-update.ts', 'daemon-net-update-source.ts', 'service-set-provision.ts', 'daemon-file-slot.ts', 'daemon-trial-cmd.ts']) {
      expect(read(f), f).not.toMatch(/startsWith\('linux-'\)|'daemon-linux-x64', 'daemon-linux-arm64'\]/)
    }
  })
})

describe('a Mac\'s slot arch (review L3: one answer with the walnut file\'s target)', () => {
  it('an x86_64 shell under Rosetta on Apple silicon is the arm64 Mac it runs on, as the target says', async () => {
    const run = vi.fn(async () => 'os=Darwin\narch=x86_64\ntranslated=1\n')
    expect(await macSlotArch(run, 'x86_64')).toBe('arm64')
    expect(slotArchOf('x86_64')).toBe('x64')
  })

  it('an Intel Mac stays x64; a probe with no answer falls back to uname', async () => {
    expect(await macSlotArch(async () => 'os=Darwin\narch=x86_64\ntranslated=0\n', 'x86_64')).toBe('x64')
    expect(await macSlotArch(async () => { throw new Error('link down') }, 'arm64')).toBe('arm64')
    expect(await macSlotArch(async () => 'garbage', 'x86_64')).toBe('x64')
  })

  it('the connect probe takes a Mac\'s arch from it', () => {
    expect(read('daemon-connection.ts')).toMatch(/this\._remoteSystem === 'darwin' \? await macSlotArch\(/)
  })
})
