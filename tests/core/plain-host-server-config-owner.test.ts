/**
 * The plain host server (`walnut host-server`, WALNUT_HOST_SERVER=1 alone) is a
 * replica too. The config owner checks read `isCompanion() || isHostReplicaProgram()`,
 * so it was treated as the leader: it stamped the first-run questions into its own
 * config.yaml and settled found hosts there. Every replica now skips both.
 * Real config file in a temp WALNUT_HOME.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import yaml from 'js-yaml'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-plain-host-server-config'))

import { CONFIG_FILE, WALNUT_HOME } from '../../src/constants.js'
import * as cm from '../../src/core/config-manager.js'
import { settlesFoundHosts } from '../../src/core/hosts/found-hosts-store.js'
import { _resetServerRoleForTesting } from '../../src/core/server-role.js'

const KEYS = ['WALNUT_HOST_SERVER', 'WALNUT_ROLE', 'WALNUT_FIRST_RUN_SETUP'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

function asServer(kind: 'leader' | 'plain-host-server'): void {
  delete process.env.WALNUT_ROLE
  if (kind === 'plain-host-server') process.env.WALNUT_HOST_SERVER = '1'
  else delete process.env.WALNUT_HOST_SERVER
  _resetServerRoleForTesting()
}

beforeEach(async () => {
  process.env.WALNUT_FIRST_RUN_SETUP = '1' // a test runner stamps only when asked to
  cm._resetWriteLockForTest()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  await cm._configRepairIdleForTest()
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetServerRoleForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

async function storedFirstRun(): Promise<unknown> {
  const text = await fs.readFile(CONFIG_FILE, 'utf-8').catch(() => '')
  return (yaml.load(text) as Record<string, unknown> | undefined)?.first_run
}

describe('the plain host server is no config owner', () => {
  it('stamps no first-run questions into a fresh config', async () => {
    asServer('plain-host-server')
    await cm.seedConfigDefaults()
    expect(await storedFirstRun()).toBeUndefined()
  })

  it('settles no found hosts', async () => {
    asServer('plain-host-server')
    expect(await settlesFoundHosts()).toBe(false)
  })

  it('the leader still does both', async () => {
    asServer('leader')
    await cm.seedConfigDefaults()
    expect(await storedFirstRun()).toMatchObject({ steps: ['hosts'] })
    expect(await settlesFoundHosts()).toBe(true)
  })
})
