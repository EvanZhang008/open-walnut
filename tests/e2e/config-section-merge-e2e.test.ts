/**
 * E2E: PUT /api/config on a real server writes a partial section without losing
 * the rest of it (src/core/config-section-write.ts).
 *
 * The 2026-11-14 incident: an agent sent `{"session":{"skill_listing_desc_chars":200}}`
 * and the whole `session` section (reply language, cron policy, retries, idle
 * timeouts) was dropped from config.yaml, its backup overwritten with the same.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { vi } from 'vitest'
import fs from 'node:fs/promises'
import yaml from 'js-yaml'
import type { Server as HttpServer } from 'node:http'

import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-config-section-merge'))

import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { CONFIG_MERGE_HEADER, CONFIG_SECTION_WRITE } from '../../src/core/config-section-write.js'
import { COPY_ONLY_CONFIG_KEYS } from '../../src/core/replication/copy-only-keys.js'

let server: HttpServer
let port = 0

const SESSION = {
  reply_language: 'en',
  cron_policy: 'session-only',
  tag_requests: true,
  idle_timeout_minutes: 45,
  turn_retry: { max: 3, delay_s: 5 },
  local_idle_exit_minutes: 20,
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'Test' },
    defaults: { priority: 'none', platform: 'local' },
    provider: { type: 'claude-code' },
    session: SESSION,
  }), 'utf-8')
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

async function send(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://localhost:${port}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
}

async function put(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<void> {
  const res = await send(body, headers)
  expect(res.status, await res.clone().text()).toBe(200)
}

/** What a browser page adds to its own PUT (a forward through a replica keeps both). */
const browser = () => ({ origin: `http://localhost:${port}`, 'sec-fetch-mode': 'cors' })
/** A session's call: not the person at this machine (routes/expose.ts isPersonAtThisMachine). */
const AGENT = { 'x-walnut-caller-sid': 'config-merge-e2e-session' }

async function stored(): Promise<Record<string, any>> {
  return yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>
}

describe('PUT /api/config with a partial section', () => {
  it('keeps every session setting the body leaves out (the incident body)', async () => {
    await put({ session: { skill_listing_desc_chars: 200 } })
    expect((await stored()).session).toEqual({ ...SESSION, skill_listing_desc_chars: 200 })
    // The backup copy holds the same, not a shrunken section.
    const bak = yaml.load(await fs.readFile(`${CONFIG_FILE}.bak`, 'utf-8')) as Record<string, any>
    expect(bak.session).toEqual({ ...SESSION, skill_listing_desc_chars: 200 })
  })

  it('a key sent as null is removed, and only that one', async () => {
    await put({ session: { skill_listing_desc_chars: null } })
    expect((await stored()).session).toEqual(SESSION)
    await put({ session: { tag_requests: null } })
    const { tag_requests: _gone, ...rest } = SESSION
    expect((await stored()).session).toEqual(rest)
  })

  it('an object below the first level is replaced whole', async () => {
    await put({ session: { turn_retry: { max: 1 } } })
    const s = (await stored()).session
    expect(s.turn_retry).toEqual({ max: 1 })
    expect(s.reply_language).toBe('en')
    expect(s.local_idle_exit_minutes).toBe(20)
  })

  it('other sections are untouched by a write of one section', async () => {
    const c = await stored()
    expect(c.user).toEqual({ name: 'Test' })
    expect(c.defaults).toMatchObject({ priority: 'none', platform: 'local' })
  })
})

describe('PUT /api/config with a map of named entries', () => {
  const replaced = Object.entries(CONFIG_SECTION_WRITE)
    .filter(([, mode]) => mode === 'replace')
    .map(([key]) => key)
  /** The page's own write (web/src/api/config.ts): it holds the whole map. */
  const page = () => ({ ...browser(), [CONFIG_MERGE_HEADER]: 'merge' })

  it('hosts: the page removes a host by leaving it out (the Remote Hosts editor\'s Remove)', async () => {
    expect(replaced).toContain('hosts')
    await put({ hosts: { a: { hostname: 'a.example.test', enabled: false }, b: { hostname: 'b.example.test', enabled: false } } }, page())
    expect(Object.keys((await stored()).hosts).sort()).toEqual(['a', 'b'])
    await put({ hosts: { a: { hostname: 'a.example.test', enabled: false } } }, page())
    expect(Object.keys((await stored()).hosts)).toEqual(['a'])
    // The same removal sent as null (what Settings sends now) works too.
    await put({ hosts: { a: null } }, page())
    expect((await stored()).hosts).toEqual({})
  })

  it('hosts: an agent writing one host keeps every other host, net rows included, as stored', async () => {
    const { updateConfig } = await import('../../src/core/config-manager.js')
    await put({ hosts: { a: { hostname: 'a.example.test', enabled: false } } }, page())
    // A machine on the host network is written by the network only (core/net/net-hosts.ts).
    await updateConfig({ hosts: { net1: { hostname: 'net1', transport: 'net', endpoint: 'e1', enabled: true } } } as never, { mergeEntries: true })
    await put({ hosts: { a: { label: 'A' } } }, AGENT)
    expect((await stored()).hosts).toEqual({
      a: { hostname: 'a.example.test', enabled: false, label: 'A' },
      net1: { hostname: 'net1', transport: 'net', endpoint: 'e1', enabled: true },
    })
    await put({ hosts: { a: null, net1: null } }, page())
  })

  it('hosts: an agent changing a found host\'s answer drops who gave the old one', async () => {
    await put({ hosts: { f: { hostname: 'f.example.test', discovered: true, connect: 'yes', connect_by: 'walnut', enabled: true } } }, page())
    await put({ hosts: { f: { connect: 'not_now' } } }, AGENT)
    const f = (await stored()).hosts.f
    expect(f.connect).toBe('not_now')
    expect(f.connect_by).toBeUndefined()
    expect(f.hostname).toBe('f.example.test')
    await put({ hosts: { f: null } }, page())
  })

  it('plugins: an agent writing one plugin keeps every other plugin and that plugin\'s other keys (the 2026-11-18 incident body)', async () => {
    const plugins = {
      wechat: { enabled: true, node_id: 'n1', account_id: 'acct-1' },
      'mail-imap': { accounts: { a1: { address: 'a@example.test', imap_host: 'imap.example.test' } } },
      slack: { enabled: true, letters_enabled: false },
    }
    await put({ plugins }, page())
    await put({ plugins: { wechat: { send_host: 'home', send_enabled: true } } }, AGENT)
    expect((await stored()).plugins).toEqual({
      ...plugins,
      wechat: { ...plugins.wechat, send_host: 'home', send_enabled: true },
    })
    // A script with no headers at all (the incident's Python urllib) merges the same way.
    await put({ plugins: { slack: { letters_enabled: true } } })
    expect((await stored()).plugins.slack).toEqual({ enabled: true, letters_enabled: true })
    expect((await stored()).plugins['mail-imap']).toEqual(plugins['mail-imap'])
    // null removes a key of an entry, or a whole entry, and nothing else.
    await put({ plugins: { wechat: { send_host: null }, slack: null } }, AGENT)
    expect((await stored()).plugins).toEqual({
      'mail-imap': plugins['mail-imap'],
      wechat: { ...plugins.wechat, send_enabled: true },
    })
  })

  it('every map section: the page removes an entry by leaving it out, any other writer keeps it', async () => {
    const samples: Record<string, [Record<string, unknown>, string]> = {
      providers: [{ x: { api: 'openai-chat' }, y: { api: 'openai-chat' } }, 'x'],
      engines: [{ x: { enabled: false }, y: { enabled: false } }, 'x'],
      plugins: [{ x: { enabled: false }, y: { enabled: false } }, 'x'],
      plugin_ai: [{ x: { enabled: false }, y: { enabled: false } }, 'x'],
      plugin_jobs: [{ x: { run_on: 'h' }, y: { run_on: 'h' } }, 'x'],
      session_limits: [{ x: 1, y: 2 }, 'x'],
      placement_weights: [{ x: 1, y: 2 }, 'x'],
      tag_display: [{ x: 'shown', y: 'hidden' }, 'x'],
      tag_links: [{ x: 'u', y: 'v' }, 'x'],
      link_tags: [{ x: 'u', y: 'v' }, 'x'],
      stt_corrections: [{ x: ['a'], y: ['b'] }, 'x'],
    }
    const objectMaps = replaced.filter((k) => k !== 'hosts' && k in samples)
    // A map section added to the table without a sample here fails, so it gets one.
    // The copy-only rows (replication/copy-only-keys.ts): a host reads them from its config copy, and the
    // leader never takes or writes them in its own config.yaml. Read from the source, so a new one needs no edit here.
    const notObjects = ['version', 'plugin_sources', 'local_capabilities', 'ssh_login_files', 'ssh_login_hint', 'ssh_cert_letter', 'host_service_offer', 'api_keys', 'push_tokens', 'placement_min_disk_gb', ...COPY_ONLY_CONFIG_KEYS]
    expect(replaced.filter((k) => k !== 'hosts' && !notObjects.includes(k)).sort()).toEqual(Object.keys(samples).sort())
    for (const key of objectMaps) {
      const [both, keep] = samples[key]
      await put({ [key]: both }, page())
      expect(Object.keys((await stored())[key]).sort(), key).toEqual(['x', 'y'])
      // An agent's write of one entry keeps the other.
      await put({ [key]: { [keep]: both[keep] } }, AGENT)
      expect(Object.keys((await stored())[key]).sort(), `${key} (agent)`).toEqual(['x', 'y'])
      // The page holds the whole map: what it leaves out is removed.
      await put({ [key]: { [keep]: both[keep] } }, page())
      expect((await stored())[key], `${key} (page)`).toEqual({ [keep]: both[keep] })
    }
  })
})

describe('PUT /api/config from a browser page', () => {
  it('says it merges marked writes', async () => {
    const res = await fetch(`http://localhost:${port}/api/config`, { signal: AbortSignal.timeout(20_000) })
    expect(((await res.json()) as { configWrites?: string }).configWrites).toBe('merge')
  })

  it('an unmarked write (a Settings page from before the merge) keeps writing sections whole', async () => {
    await put({ ui: { show_priority: true, session_panels: 2 } })
    // An older page turns one setting off by sending the section without it.
    await put({ ui: { session_panels: 2 } }, browser())
    expect((await stored()).ui).toEqual({ session_panels: 2 })
  })

  it('a marked write from the page merges', async () => {
    await put({ ui: { show_priority: true } }, { ...browser(), 'x-walnut-config-write': 'merge' })
    expect((await stored()).ui).toEqual({ session_panels: 2, show_priority: true })
    await put({ ui: { show_priority: null } }, { ...browser(), 'x-walnut-config-write': 'merge' })
    expect((await stored()).ui).toEqual({ session_panels: 2 })
  })

  it('an older page switching back to a legacy backup bucket keeps the bucket', async () => {
    await put({ backup: { enabled: false, destination: { type: 's3', bucket: 'enc-bucket', region: 'us-west-2' } } })
    await put({ backup: { enabled: false, bucket: 'legacy-bucket', region: 'us-west-2' } }, browser())
    expect((await stored()).backup).toEqual({ enabled: false, bucket: 'legacy-bucket', region: 'us-west-2' })
  })
})

describe('person-only sections, written by a session', () => {
  it('backup: a partial write that keeps where backups go is allowed; one that removes the destination is refused', async () => {
    await put({ backup: { enabled: false, destination: { type: 's3', bucket: 'enc-bucket', region: 'us-west-2' } } })
    await put({ backup: { enabled: false } }, AGENT)
    expect((await stored()).backup.destination).toEqual({ type: 's3', bucket: 'enc-bucket', region: 'us-west-2' })
    const refused = await send({ backup: { destination: null } }, AGENT)
    expect(refused.status).toBe(403)
    expect((await stored()).backup.destination).toEqual({ type: 's3', bucket: 'enc-bucket', region: 'us-west-2' })
  })

  it('expose: the same section sent back partially is allowed; a removed key is refused', async () => {
    await put({ expose: { enabled: false, provider: 'command' } })
    await put({ expose: { enabled: false } }, AGENT)
    expect((await stored()).expose).toEqual({ enabled: false, provider: 'command' })
    expect((await send({ expose: { provider: null } }, AGENT)).status).toBe(403)
    expect((await stored()).expose).toEqual({ enabled: false, provider: 'command' })
  })
})

describe('null where a section refuses or takes it', () => {
  it('experimental: a flag sent as null is removed', async () => {
    await put({ experimental: { some_flag: true, other_flag: false } })
    await put({ experimental: { some_flag: null } })
    expect((await stored()).experimental).toEqual({ other_flag: false })
  })

  it('approvals.ask_me is never removed: null is refused and says so', async () => {
    const res = await send({ approvals: { ask_me: null } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/cannot be removed/)
  })
})
