/**
 * Aliases are one machine by the stable machine id their daemons' hellos gave (host profile
 * `machine`, same-daemon-record.ts rememberMachineId), so two aliases seen at different times are
 * one host (daemon-twins.ts); different ids are two hosts; with no id (an older daemon) only the
 * pair the daemon confirmed joins them, as before. Each id holds only while its row still connects
 * where it did when the id was recorded.
 *
 * MACHINE SAFETY: the host profiles are in the test's WALNUT_HOME (mocked constants); `ssh -G` is
 * a stand-in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-machine-id-twins'))

import { HOST_PROFILES_DIR, readHostProfile } from '../../../src/core/hosts/host-profile.js'
import { __setSshResolverForTest, _resetMachineIdRecordForTest, rememberMachineId } from '../../../src/core/hosts/same-daemon-record.js'
import { daemonTwinGroups, daemonTwins, refreshDaemonTwins, sameDaemonAliases } from '../../../src/core/hosts/daemon-twins.js'
import type { Config } from '../../../src/core/types.js'
import { resetInProcessDaemonWantedForTests } from '../../../src/providers/in-process-daemon.js'

const NET_KEY = 'c'.repeat(64)
const NET_ID = `net:${NET_KEY}`
const SSH_ID = JSON.stringify(['ssh', 'dev', 'box.example.test', '22'])
const ONE = '1'.repeat(32)
const TWO = '2'.repeat(32)

let resolvesTo = 'box.example.test'

function config(): Config {
  return {
    hosts: {
      'box-net': { hostname: 'box.walnut-net.invalid', transport: 'net', endpoint: NET_KEY, label: 'Big box', enabled: true, discovered: false },
      'box-ssh': { hostname: 'box.example.test', user: 'dev', port: 22, enabled: true, discovered: true },
    },
  } as unknown as Config
}

/** A hello on `alias`'s link alone, at its own time, that gave machine id `id`. */
async function hello(alias: string, id: string, dialled: string): Promise<void> {
  await rememberMachineId(alias, id, `target-${dialled}`, async () => dialled)
}

/** The twin snapshot read from `cfg` (twice: a read a write started in the background ends first). */
async function snapshot(cfg: Config): Promise<string[][]> {
  await refreshDaemonTwins(cfg)
  await refreshDaemonTwins(cfg)
  return daemonTwinGroups(cfg.hosts as never)
}

// Machine grouping is the one-service experiment's (A3b): on here, off in its own case below.
const savedSwitch = process.env.WALNUT_IN_PROCESS_DAEMON

beforeEach(async () => {
  process.env.WALNUT_IN_PROCESS_DAEMON = '1'
  resetInProcessDaemonWantedForTests()
  resolvesTo = 'box.example.test'
  __setSshResolverForTest(async () => ({ hostname: resolvesTo, port: 22, user: 'dev' }))
  _resetMachineIdRecordForTest()
  await fs.rm(HOST_PROFILES_DIR, { recursive: true, force: true })
})

afterEach(() => {
  if (savedSwitch === undefined) delete process.env.WALNUT_IN_PROCESS_DAEMON
  else process.env.WALNUT_IN_PROCESS_DAEMON = savedSwitch
  resetInProcessDaemonWantedForTests()
  __setSshResolverForTest(null)
})

describe('one machine id, one host', () => {
  it('two aliases whose hellos gave one id at different times are one host; the person\'s alias keeps it', async () => {
    await hello('box-net', ONE, NET_ID)
    // Later, with box-net's link down: box-ssh's own hello.
    await hello('box-ssh', ONE, SSH_ID)
    expect((await readHostProfile('box-ssh')).machine).toMatchObject({ id: ONE, link: SSH_ID })
    expect(await sameDaemonAliases('box-ssh', config())).toEqual(['box-net', 'box-ssh'])
    expect(await sameDaemonAliases('box-net', config())).toEqual(['box-net', 'box-ssh'])
    expect(await snapshot(config())).toEqual([['box-net', 'box-ssh']])
    expect(daemonTwins(config().hosts as never, { enabled: true })).toEqual([{ alias: 'box-ssh', joined: 'box-net' }])
  })

  it('the one-service experiment off: one machine id joins no aliases', async () => {
    await hello('box-net', ONE, NET_ID)
    await hello('box-ssh', ONE, SSH_ID)
    process.env.WALNUT_IN_PROCESS_DAEMON = '0'
    resetInProcessDaemonWantedForTests()
    expect(await sameDaemonAliases('box-ssh', config())).toEqual(['box-ssh'])
    expect(await snapshot(config())).toEqual([])
  })

  it('different ids are two hosts', async () => {
    await hello('box-net', ONE, NET_ID)
    await hello('box-ssh', TWO, SSH_ID)
    expect(await sameDaemonAliases('box-ssh', config())).toEqual(['box-ssh'])
    expect(await snapshot(config())).toEqual([])
  })

  it('an id recorded for a row that now connects elsewhere joins nothing', async () => {
    await hello('box-net', ONE, NET_ID)
    await hello('box-ssh', ONE, SSH_ID)
    resolvesTo = 'other.example.test'
    expect(await sameDaemonAliases('box-ssh', config())).toEqual(['box-ssh'])
    expect(await snapshot(config())).toEqual([])
  })

  it('with no id (an older daemon), only a confirmed pair joins them, as before', async () => {
    expect(await sameDaemonAliases('box-ssh', config())).toEqual(['box-ssh'])
    expect(await snapshot(config())).toEqual([])
    await fs.mkdir(HOST_PROFILES_DIR, { recursive: true })
    for (const [self, selfId, other, otherId] of [['box-net', NET_ID, 'box-ssh', SSH_ID], ['box-ssh', SSH_ID, 'box-net', NET_ID]]) {
      await fs.writeFile(path.join(HOST_PROFILES_DIR, `${self}.json`), JSON.stringify({ host: self, sameDaemon: { [other]: { self: selfId, other: otherId, at: '2026-11-16T00:00:00.000Z' } } }))
    }
    expect(await sameDaemonAliases('box-ssh', config())).toEqual(['box-net', 'box-ssh'])
    expect(await snapshot(config())).toEqual([['box-net', 'box-ssh']])
  })

  it('a hello that gives the same id again writes nothing; a new id is written', async () => {
    await hello('box-net', ONE, NET_ID)
    // Marked: a rewrite of the profile would put a new updatedAt over the mark.
    const file = path.join(HOST_PROFILES_DIR, 'box-net.json')
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), updatedAt: 'marked' }))
    _resetMachineIdRecordForTest() // a server that just started: the profile already holds it
    await hello('box-net', ONE, NET_ID)
    expect((await readHostProfile('box-net')).updatedAt).toBe('marked')
    await hello('box-net', TWO, NET_ID)
    expect((await readHostProfile('box-net')).machine?.id).toBe(TWO)
    // Not a machine id: never recorded.
    await hello('box-ssh', 'not-an-id', SSH_ID)
    expect((await readHostProfile('box-ssh')).machine).toBeUndefined()
  })
})
