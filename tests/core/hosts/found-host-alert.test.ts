/**
 * A found host that cannot be added or cannot connect is ONE Notifications entry, never a block on
 * Home (src/core/hosts/found-host-alert.ts). 2026-11-13, the user, of a Mac found in ~/.ssh/config
 * that read "Could not connect" on Home after every reload: "I don't want it keep showing ... Just
 * show it inside notification is fine". And a host answered Not now stays answered.
 *
 * Real: config.yaml and notifications.json in a temp Walnut home, getConfig, the marks' writes,
 * the notification store, answerFoundHost. Only the daemon's phase frames are handed in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-found-host-alert'))

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { getConfig, updateConfig } from '../../../src/core/config-manager.js'
import { handleFoundHostPhase, newFoundHostAlertMemory, type FoundHostAlertDeps, type FoundHostPhase } from '../../../src/core/hosts/found-host-alert.js'
import { clearNotLinux, markNotLinux } from '../../../src/core/hosts/found-host-marks.js'
import { consentedFoundHosts, foundHostCardKey, foundHostsToAsk } from '../../../src/core/hosts/found-host-offer.js'
import { answerFoundHost, settleFoundHostsDoc } from '../../../src/core/hosts/found-hosts-store.js'
import { dismissNotifications, listNotifications, recoverNotifications, upsertNotification } from '../../../src/core/notifications/store.js'
import { notLinuxSentence } from '../../../src/core/sessions/host-connect-hint.js'
import { firstRunHostRows } from '../../../web/src/components/first-run/first-run-model'

const MAC = 'a'.repeat(64)

const deps: FoundHostAlertDeps = {
  onPhase: () => () => {},
  readHosts: async () => ((await getConfig()).hosts ?? {}) as never,
  readNet: async () => (await getConfig()).net,
  markNotLinux: (alias, os) => markNotLinux(alias, os),
  clearNotLinux: (alias) => clearNotLinux(alias),
  publish: async (card) => { await upsertNotification(card) },
}

async function stored(): Promise<Record<string, Record<string, unknown>>> {
  return ((yaml.load(await fs.readFile(CONFIG_FILE, 'utf8')) as { hosts: Record<string, Record<string, unknown>> }).hosts)
}
const failed = (host: string, error: string): FoundHostPhase => ({ host, phase: 'failed', error })
const feed = async () => (await listNotifications()).feed

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await updateConfig({
    hosts_found: { asking_since: '2026-11-01T00:00:00.000Z' },
    net: { enabled: true },
    hosts: {
      // The reported case: found in ~/.ssh/config, said Connect to once; it is a Mac.
      'studio-mac': { hostname: '10.20.30.40', user: 'sam', discovered: true, connect: 'yes', enabled: true },
      'Studio-MacBook': { hostname: 'Studio-MacBook.walnut-net.invalid', label: 'Studio-MacBook', transport: 'net', endpoint: MAC, enabled: true },
      devbox: { hostname: 'devbox.example.test', label: 'Dev box', discovered: true, connect: 'yes', enabled: true },
      labbox: { hostname: 'labbox.example.test', discovered: true, connect: 'ask', enabled: false },
      mine: { hostname: 'mine.example.test', enabled: true },
    },
  } as never)
})

describe('a found host that is not Linux', () => {
  it('its first answer marks it off for good, leaves every list, and raises one entry that says how to add it', async () => {
    await handleFoundHostPhase(failed('studio-mac', notLinuxSentence('studio-mac', 'Darwin')), newFoundHostAlertMemory(), deps)
    expect((await stored())['studio-mac']).toMatchObject({ connect: 'yes', enabled: false, not_offered: { reason: 'not_linux', os: 'Darwin' } })
    const hosts = (await getConfig()).hosts
    expect(consentedFoundHosts(hosts).map((h) => h.host)).toEqual(['devbox'])
    expect(foundHostsToAsk(hosts).map((h) => h.host)).toEqual(['labbox'])
    expect(firstRunHostRows(hosts).map((r) => r.alias)).not.toContain('studio-mac')
    const cards = await feed()
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      dedupKey: foundHostCardKey('studio-mac'), kind: 'operation-error', severity: 'warning', host: 'studio-mac',
      title: 'studio-mac cannot be added over SSH', recoveryKey: 'host:studio-mac',
      action: { label: 'Open Remote Hosts', to: '/settings#remote-hosts' },
    })
    expect(cards[0].body).toMatch(/^studio-mac is a Mac, and Walnut adds only Linux machines/)
    expect(cards[0].body).toContain('Settings › Remote Hosts › Add host › Join a machine with a link')
  })

  it('one entry however many failures, reloads or restarts; dismissed, it does not come back', async () => {
    for (let restart = 0; restart < 3; restart++) {
      const mem = newFoundHostAlertMemory()
      for (let i = 0; i < 3; i++) await handleFoundHostPhase(failed('studio-mac', notLinuxSentence('studio-mac', 'Darwin')), mem, deps)
    }
    expect((await feed()).map((n) => n.dedupKey)).toEqual([foundHostCardKey('studio-mac')])
    await dismissNotifications({ dedupKeys: [foundHostCardKey('studio-mac')] })
    // Turned back on by hand and still a Mac: marked off again, and the dismissed entry stays gone.
    await updateConfig({ hosts: { ...(await stored()), 'studio-mac': { ...(await stored())['studio-mac'], enabled: true } } } as never)
    await handleFoundHostPhase(failed('studio-mac', notLinuxSentence('studio-mac', 'Darwin')), newFoundHostAlertMemory(), deps)
    expect((await stored())['studio-mac'].enabled).toBe(false)
    expect(await feed()).toEqual([])
  })

  it('a connect that works later clears the mark (the alias names another machine now)', async () => {
    await handleFoundHostPhase(failed('studio-mac', notLinuxSentence('studio-mac', 'Darwin')), newFoundHostAlertMemory(), deps)
    await handleFoundHostPhase({ host: 'studio-mac', phase: 'connected' }, newFoundHostAlertMemory(), deps)
    expect((await stored())['studio-mac']).not.toHaveProperty('not_offered')
  })
})

describe('a found host the person said Connect to that does not connect', () => {
  it('is one entry in the words every host surface uses, retired when the host connects', async () => {
    for (let reload = 0; reload < 3; reload++) {
      await handleFoundHostPhase(failed('devbox', 'Permission denied (publickey,password).'), newFoundHostAlertMemory(), deps)
    }
    const cards = await feed()
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ dedupKey: foundHostCardKey('devbox'), severity: 'error', title: 'Could not connect to Dev box', action: { to: '/settings#rh-host-devbox' } })
    expect(cards[0].count ?? 1).toBe(1)
    // The host connecting (web/server.ts publishRecovery on connect) retires it.
    await recoverNotifications(['host:devbox'])
    expect((await feed())[0].resolved).toBe('recovered')
  })

  it('a host added by hand, or one still waiting for the yes, raises nothing here', async () => {
    await handleFoundHostPhase(failed('mine', 'Permission denied (publickey).'), newFoundHostAlertMemory(), deps)
    await handleFoundHostPhase(failed('labbox', 'ssh: connect to host labbox.example.test port 22: Connection timed out'), newFoundHostAlertMemory(), deps)
    await handleFoundHostPhase(failed('mine', notLinuxSentence('mine', 'Darwin')), newFoundHostAlertMemory(), deps)
    expect(await feed()).toEqual([])
    expect((await stored()).mine).not.toHaveProperty('not_offered')
  })
})

describe('Not now sticks', () => {
  it('from the question and from a host already said Connect to: written, and never asked or shown again after a reload or a restart', async () => {
    expect(await answerFoundHost('labbox', 'not_now')).toMatchObject({ ok: true })
    // A host said Connect to that kept failing, put aside.
    expect(await answerFoundHost('devbox', 'not_now')).toMatchObject({ ok: true })
    const rows = await stored()
    expect(rows.labbox).toMatchObject({ connect: 'not_now', enabled: false })
    expect(rows.devbox).toMatchObject({ connect: 'not_now', enabled: false })
    // A reload reads them from the server: neither is asked or shown on Home.
    const hosts = (await getConfig()).hosts
    expect(foundHostsToAsk(hosts, (await getConfig()).net)).toEqual([])
    // studio-mac is the fixture's other host said Connect to; devbox is gone from Home's setup rows.
    expect(consentedFoundHosts(hosts, (await getConfig()).net).map((h) => h.host)).toEqual(['studio-mac'])
    // A restart's settle keeps the answer.
    const doc = { hosts: rows, hosts_found: { asking_since: '2026-11-01T00:00:00.000Z' } } as Record<string, unknown>
    settleFoundHostsDoc(doc, { facts: { sessionHosts: new Set(), taskHosts: new Set(), connectedHosts: new Set(), serverHosts: new Set() }, scanned: new Map(), now: new Date() })
    expect((doc.hosts as typeof rows).labbox).toMatchObject({ connect: 'not_now', enabled: false })
    // And a failure frame for it afterwards raises nothing.
    await handleFoundHostPhase(failed('devbox', 'Permission denied (publickey).'), newFoundHostAlertMemory(), deps)
    expect(await feed()).toEqual([])
  })
})
