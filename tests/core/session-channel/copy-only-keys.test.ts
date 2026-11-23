/**
 * Review round 1, N2: a key only the leader's config copy says (hosts_run_sessions, made from
 * `hosts.<name>.runs_sessions`) means nothing in the leader's own config.yaml. A stray one (a hand
 * edit, a PUT /api/config) is left out of the leader's config read and never written, so it never
 * opens the door, issues a credential or sets the heartbeat flag with no host turned on. The copy
 * still says it, from the hosts map only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-copy-only-keys'))

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { getConfig, saveConfig, updateConfig } from '../../../src/core/config-manager.js'
import { hostRunsSessionsAnyNow } from '../../../src/core/session-channel/switch.js'
import { configCopyRows } from '../../../src/core/replication/config-allowlist.js'
import { COPY_ONLY_CONFIG_KEYS } from '../../../src/core/replication/copy-only-keys.js'

const saved = process.env.WALNUT_HOST_RUNS_SESSIONS
beforeEach(async () => {
  delete process.env.WALNUT_HOST_RUNS_SESSIONS
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(() => { if (saved === undefined) delete process.env.WALNUT_HOST_RUNS_SESSIONS; else process.env.WALNUT_HOST_RUNS_SESSIONS = saved })

const stored = async () => yaml.load(await fsp.readFile(CONFIG_FILE, 'utf8')) as Record<string, unknown>

describe('the leader never honours a copy-only key in its own config', () => {
  it('a stray hosts_run_sessions in config.yaml is left out of the read: the switch stays off', async () => {
    await fsp.writeFile(CONFIG_FILE, yaml.dump({ version: 1, hosts: { 'devbox-a': { hostname: 'devbox-a.example' } }, hosts_run_sessions: ['devbox-a'] }))
    const config = await getConfig()
    expect(config.hosts_run_sessions).toBeUndefined()
    expect(await hostRunsSessionsAnyNow()).toBe(false)
  })

  it('a write that names one stores nothing; a read-modify-write that carries one drops it', async () => {
    await fsp.writeFile(CONFIG_FILE, yaml.dump({ version: 1 }))
    await updateConfig({ hosts_run_sessions: ['devbox-a'] })
    expect(await stored()).not.toHaveProperty('hosts_run_sessions')
    await saveConfig({ ...(await getConfig()), hosts_run_sessions: ['devbox-a'] })
    expect(await stored()).not.toHaveProperty('hosts_run_sessions')
  })

  it('the copy still says the hosts turned on, from the hosts map only', () => {
    expect(COPY_ONLY_CONFIG_KEYS).toEqual(['hosts_run_sessions', 'leader_capabilities'])
    const off = configCopyRows({ version: 1, hosts_run_sessions: ['devbox-a'] })
    expect(off.rows.find((r) => r.key === 'hosts_run_sessions')).toBeUndefined()
    const on = configCopyRows({ version: 1, hosts: { 'devbox-a': { hostname: 'devbox-a.example', runs_sessions: true } } })
    expect(on.rows.find((r) => r.key === 'hosts_run_sessions')?.value).toEqual(['devbox-a'])
  })
})

describe('S2: the leader says it speaks the session channel in its copy (leader_capabilities)', () => {
  const savedChannels = process.env.WALNUT_LEADER_SESSION_CHANNELS
  afterEach(() => { if (savedChannels === undefined) delete process.env.WALNUT_LEADER_SESSION_CHANNELS; else process.env.WALNUT_LEADER_SESSION_CHANNELS = savedChannels })
  const capsOf = (config: Record<string, unknown>) => configCopyRows(config).rows.find((r) => r.key === 'leader_capabilities')?.value

  it('while the switch is on for any host; never while it is off (an older replica, which refuses the row, sees nothing new)', () => {
    delete process.env.WALNUT_LEADER_SESSION_CHANNELS
    expect(capsOf({ version: 1, hosts: { 'devbox-a': { hostname: 'devbox-a.example', runs_sessions: true } } })).toEqual(['session-channel-v1'])
    expect(capsOf({ version: 1, experimental: { host_runs_sessions: true } })).toEqual(['session-channel-v1'])
    expect(capsOf({ version: 1, hosts: { 'devbox-a': { hostname: 'devbox-a.example' } } })).toBeUndefined()
    // A value in config.yaml itself is never copied.
    expect(capsOf({ version: 1, leader_capabilities: ['session-channel-v1'] })).toBeUndefined()
  })

  it('a leader run as one from before the channel says nothing', () => {
    process.env.WALNUT_LEADER_SESSION_CHANNELS = '0'
    expect(capsOf({ version: 1, experimental: { host_runs_sessions: true } })).toBeUndefined()
  })
})
