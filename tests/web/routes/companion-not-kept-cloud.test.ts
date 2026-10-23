/**
 * 4f of docs/plan/walnut-companion-unified-replica.md on a real CLOUD_MODE server: what the
 * user keeps from the companion (Settings, Phones & Cloud: `cloud_bridge.keep` and
 * `cloud_bridge.copies`) is never answered from the box's copy, nor from its own disk. The
 * Mac is away here (no Mac on the bridge), so each such read answers `503 needs_leader` with
 * why `not_kept_here`; while the Mac answers, the forward takes them (pinned by
 * tests/web/routes/v1-forward-*.test.ts and tests/replica/notes-routes-kept.test.ts).
 *
 * The same process plays the Mac's side: its rounds read this config.yaml for the box's
 * choice, exactly as the Mac's do (core/host-replica.ts hostKeepFor, replica-targets.ts).
 *
 * Pinned:
 *   - a box that keeps everything (the default) answers as before: its notes searches carry
 *     no `partial` field, a missing note is 404;
 *   - one note left out (no `.md`, another case): its reads and saves need the Mac, the rest
 *     reads, and the notes searches (both) and the global search say they are partial;
 *   - memory and skills turned off: their reads need the Mac (not_kept_here);
 *   - copy kinds turned off by the box's choice (the Mac's round reads it, purges the box):
 *     the reads of each need the Mac, never the box's own file or an empty list;
 *   - turned on again: the copy answers again;
 *   - the Mac answering: only what the box leaves out goes to it (a left-out note, the notes
 *     and global searches of a partial copy, a kind turned off); a box that keeps everything
 *     never asks it, and a search of the tasks alone stays here.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-not-kept-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

/**
 * The Mac answering the box's console calls about what the box does not keep: the forward's
 * consoleCopy (v1-forward/proxy.ts), stood in for while `mac.answers`; else the real one,
 * which answers here (no Mac on the bridge).
 */
const mac = { answers: false, calls: [] as string[] }
vi.mock('../../../src/web/v1-forward/proxy.js', async (orig) => {
  const real = await orig<typeof import('../../../src/web/v1-forward/proxy.js')>()
  return {
    ...real,
    getV1Forward: () => {
      const fwd = real.getV1Forward()
      return {
        ...fwd,
        consoleCopy: (req: import('express').Request, res: import('express').Response, here: () => void) => {
          if (!mac.answers) return fwd.consoleCopy(req, res, here)
          mac.calls.push(req.originalUrl)
          res.json({ from: 'mac' })
        },
      }
    },
  }
})

import { CONFIG_FILE, GLOBAL_SKILLS_DIR, MEMORY_FILE, NOTES_DIR, WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetCloudIngestForTesting, postToCloudJournal, postToCloudReplica } from '../../../src/core/cloud-ingest.js'
import { _resetHostReplicaForTesting, forgetCompanionHostReplica, syncCompanionHostReplica } from '../../../src/core/host-replica.js'
import { _resetAttachmentReplicaForTesting } from '../../../src/core/attachment-replica.js'
import { APPLIED_V2_KINDS } from '../../../src/core/offline-merge/apply-v2.js'
import { copyKinds } from '../../../src/core/replication/kinds/index.js'
import { syncCopyKinds, type CopyKind } from '../../../src/core/replication/kinds/copy-kind.js'
import { replicaTargets } from '../../../src/core/replication/replica-targets.js'
import { copyKindOff } from '../../../src/core/replication/kinds/gate.js'
import { configCopyRows } from '../../../src/core/replication/config-allowlist.js'
import type { PersonaRow } from '../../../src/core/replication/kinds/personas.js'
import type { PrefsRow } from '../../../src/core/replication/kinds/prefs.js'
import type { ConversationRow } from '../../../src/core/replication/kinds/conversations.js'
import { bodyRow } from '../../../src/core/replication/kinds/conversation-bodies.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }
const NOW = '2026-10-22T08:00:00.000Z'

const withId = (rel: string, text: string): string => `---\nid: n_${crypto.createHash('sha1').update(rel).digest('hex').slice(0, 11)}\n---\n${text}`
async function writeNote(rel: string, text: string): Promise<void> {
  const file = path.join(NOTES_DIR, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, withId(rel, text))
}

async function api(p: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, any> }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${T.phone}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, any> }
}
/** The why of a needs_leader answer, in either shape (v1 `{error:{why}}`, the notes routes' `{why}`). */
const why = (r: { status: number; body: Record<string, any> }) => ({ status: r.status, why: r.body.error?.why ?? r.body.why })
const NOT_KEPT = { status: 503, why: 'not_kept_here' }

/** This process is also the Mac: its config.yaml holds the box's choice. */
async function chooseForBox(bridge: Record<string, unknown>): Promise<void> {
  const raw = (yaml.load(await fs.readFile(CONFIG_FILE, 'utf8').catch(() => '')) ?? {}) as Record<string, unknown>
  await fs.writeFile(CONFIG_FILE, yaml.dump({ ...raw, version: 1, cloud_bridge: bridge }))
}

/** The Mac's copy-kind rows (one of each), the companion target as the Mac has it. */
function macKinds(): CopyKind<any>[] {
  const rowsOf: Record<string, () => Promise<unknown[]>> = {
    requests: async () => [],
    routines: async () => [],
    prefs: async () => [{ key: 'favorites', favorites: { projects: ['Acme'], notes: [] } } satisfies PrefsRow],
    personas: async () => [{ key: 'general', agentId: 'general', name: 'Walnut', systemPrompt: 'You are Walnut.', systemPromptMode: 'append', launchModel: 'opus' } as PersonaRow],
    boards: async () => [],
    config: async () => configCopyRows({ user: { name: 'Ada on the Mac' } }).rows,
    inbox: async () => [],
    'inbox-bodies': async () => [],
    conversations: async () => [{ agent: 'general', meta: { id: 'conv-acme', agentId: 'general', title: 'Acme chat', createdAt: NOW, lastMessageAt: NOW, messageCount: 1, lastDistilledAt: null, lastDistilledMessageCount: 0 } } satisfies ConversationRow],
    'conversation-bodies': async () => [bodyRow('general', 'conv-acme', [{ id: 'm0', role: 'user', text: 'Acme plan?', createdAt: NOW }], [])],
    sessions: async () => [],
    'model-catalogs': async () => [{ key: 'devbox', models: [{ value: 'sonnet', displayName: 'Sonnet' }], fetchedAt: NOW }],
    'stt-vocab': async () => [{ key: 'vocab', words: ['Acme'] }],
    notifications: async () => [{ id: 'n-acme-1', kind: 'cron', severity: 'info', title: 'Acme digest sent', dedupKey: 'cron:acme', timestamp: 1_000, read: false }],
  }
  return copyKinds().map((k) => ({ ...k, watch: () => () => {}, rows: async () => (rowsOf[k.kind] ?? (async () => []))() }))
}
/** The Mac's companion target, its choice read from config.yaml (replica-targets.ts), on the test's transport. */
const companion = () => ({ ...replicaTargets().find((t) => t.id === 'companion')!, available: async () => true, post: postToCloudReplica })

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, user: { name: 'Ada' }, favorites: { projects: ['BoxOnly'], notes: [] } }))
  await writeNote('Acme/launch-plan.md', '# Acme launch plan\n\nShip the beta on Friday.\n')
  await writeNote('Acme/vendors.md', '# Acme vendors\n\nCall the printer on Friday.\n')
  await writeNote('Beta/notes.md', '# Beta notes\n\nFriday is the florist.\n')
  await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true })
  await fs.writeFile(MEMORY_FILE, '# Memory\n\n- Acme launch is on Friday\n')
  await fs.mkdir(path.join(GLOBAL_SKILLS_DIR, 'acme-tool'), { recursive: true })
  await fs.writeFile(path.join(GLOBAL_SKILLS_DIR, 'acme-tool', 'SKILL.md'), '---\nname: acme-tool\ndescription: Run it\n---\n# Acme tool\n')
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.local }
  _resetCloudIngestForTesting()
  _resetHostReplicaForTesting()
  _resetAttachmentReplicaForTesting()
  // The Mac drains note saves (so a save on the box would be a journal record, if kept).
  await postToCloudJournal('offline.drain', { home: '/x', kinds: [...APPLIED_V2_KINDS] })
}, 60_000)

afterAll(async () => {
  _resetAttachmentReplicaForTesting()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the box keeps everything (the default)', () => {
  it('its notes searches carry no partial field, and a missing note is 404', async () => {
    await syncCompanionHostReplica()
    const v2 = await api('/api/notes-v2/search?q=friday&mode=string')
    expect(v2.status).toBe(200)
    expect(v2.body).not.toHaveProperty('partial')
    expect(v2.body.results.length).toBe(3)
    const v1 = await api('/api/v1/notes/search?q=friday&mode=string')
    expect(v1.status).toBe(200)
    expect(v1.body).not.toHaveProperty('partial')
    const all = await api('/api/search?q=friday&slim=1')
    expect(all.status).toBe(200)
    expect(all.body).not.toHaveProperty('partial')
    expect((await api('/api/notes-v2/content/Acme/vendors')).status).toBe(200)
    expect((await api('/api/notes-v2/content/Acme/nothing-here')).status).toBe(404)
  })
})

describe('notes, memory and skills the box does not keep (cloud_bridge.keep)', () => {
  it('one note left out: its reads and saves need the Mac, the rest reads, the searches say they are partial', async () => {
    await chooseForBox({ keep: { notes_exclude: ['acme/VENDORS'] } })
    forgetCompanionHostReplica()
    await syncCompanionHostReplica()
    expect(why(await api('/api/notes-v2/content/Acme/vendors'))).toEqual(NOT_KEPT)
    expect(why(await api('/api/v1/notes/content/Acme/vendors.md'))).toEqual(NOT_KEPT)
    expect(why(await api('/api/notes-v2/content/Acme/vendors', { method: 'PUT', body: JSON.stringify({ content: '# Changed\n' }) }))).toEqual(NOT_KEPT)
    expect((await api('/api/notes-v2/content/Acme/launch-plan')).status).toBe(200)
    const v2 = await api('/api/notes-v2/search?q=friday&mode=string')
    expect(v2.status).toBe(200)
    expect(v2.body.partial).toEqual({ why: 'not_kept_here', message: 'Some notes are kept only on your Mac, so they are not in these results.' })
    expect(v2.body.results.map((r: { path: string }) => r.path)).not.toContain('Acme/vendors.md')
    expect((await api('/api/v1/notes/search?q=friday&mode=string')).body.partial).toMatchObject({ why: 'not_kept_here' })
    expect((await api('/api/search?q=friday&slim=1')).body.partial).toMatchObject({ why: 'not_kept_here' })
    // A search of the tasks alone leaves nothing out.
    expect((await api('/api/search?q=friday&types=task&slim=1')).body).not.toHaveProperty('partial')
  })

  it('notes turned off: every notes search needs the Mac, the semantic one too', async () => {
    await chooseForBox({ keep: { notes: false } })
    forgetCompanionHostReplica()
    await syncCompanionHostReplica()
    for (const p of ['/api/notes-v2/search?q=friday&mode=semantic', '/api/notes-v2/search?q=friday&mode=string', '/api/v1/notes/search?q=friday', '/api/notes-v2/content/Acme/vendors']) {
      expect([p, why(await api(p))]).toEqual([p, NOT_KEPT])
    }
    await chooseForBox({})
    forgetCompanionHostReplica()
    await syncCompanionHostReplica()
  })

  it('memory and skills turned off: their reads need the Mac', async () => {
    await chooseForBox({ keep: { memory: false, skills: false } })
    forgetCompanionHostReplica()
    await syncCompanionHostReplica()
    for (const p of ['/api/memory/global', '/api/v1/memory/global', '/api/skills', '/api/skills/acme-tool', '/api/v1/skills']) {
      expect([p, why(await api(p))]).toEqual([p, NOT_KEPT])
    }
    // Notes are kept in full again: no partial notes search.
    expect((await api('/api/notes-v2/search?q=friday&mode=string')).body).not.toHaveProperty('partial')
    // The global search leaves the memory out, and says so.
    expect((await api('/api/search?q=friday&slim=1')).body.partial).toMatchObject({ why: 'not_kept_here' })
    await chooseForBox({})
    forgetCompanionHostReplica()
    await syncCompanionHostReplica()
    expect((await api('/api/memory/global')).status).toBe(200)
    expect((await api('/api/search?q=friday&slim=1')).body).not.toHaveProperty('partial')
  })
})

describe('copy kinds the box does not keep (cloud_bridge.copies)', () => {
  it('kept: the reads answer the copy', async () => {
    const results = await syncCopyKinds(macKinds(), { targets: () => [companion()] })
    // An empty store's first round may be unchanged; nothing failed.
    expect(results.filter((r) => r.action !== 'synced' && r.action !== 'unchanged').map((r) => `${r.kind}:${r.action}:${r.error ?? ''}`)).toEqual([])
    expect((await api('/api/v1/favorites')).body).toEqual({ projects: ['Acme'], notes: [] })
    expect((await api('/api/v1/stt/vocab')).body).toEqual({ words: ['Acme'] })
  })

  it('turned off: the Mac\'s round purges each, and every read of it needs the Mac', async () => {
    await chooseForBox({ copies: { prefs: false, config: false, personas: false, conversations: false, sessions: false, requests: false } })
    const results = await syncCopyKinds(macKinds(), { targets: () => [companion()] })
    // A kind turned off: its purge step, answered as not copied (kinds/copy-kind.ts).
    expect(results.filter((r) => r.error === 'kind_not_copied').map((r) => r.kind).sort())
      .toEqual(['config', 'conversation-bodies', 'conversations', 'model-catalogs', 'personas', 'prefs', 'requests', 'sessions', 'stt-vocab'])
    for (const kind of ['prefs', 'config', 'personas', 'conversations', 'conversation-bodies', 'stt-vocab', 'model-catalogs', 'requests']) expect([kind, await copyKindOff(kind)]).toEqual([kind, true])
    const reads = [
      '/api/v1/favorites', '/api/favorites', '/api/ui-prefs',
      '/api/v1/config',
      '/api/v1/stt/vocab', '/api/stt/vocab',
      '/api/sessions/ask-walnut-launch',
      '/api/v1/conversations?agentId=general', '/api/agents/general/conversations',
      '/api/chat/history?agentId=general&conversationId=conv-acme',
      '/api/v1/conversations/conv-acme/messages?agentId=general',
      '/api/sessions/host-model-catalogs',
      '/api/v1/requests/rq-acac01',
      // The sessions: never the projection the box keeps to route a phone's message.
      '/api/v1/sessions', '/api/sessions', '/api/v1/sessions/s-mac-1', '/api/v1/sessions/s-mac-1/transcript',
    ]
    for (const p of reads) expect([p, why(await api(p))]).toEqual([p, NOT_KEPT])
    // A read under /sessions that reads no session still answers.
    expect(why(await api('/api/sessions/working-dirs')).why).not.toBe('not_kept_here')
    // A word added here needs the Mac too.
    expect(why(await api('/api/v1/stt/vocab', { method: 'POST', body: JSON.stringify({ word: 'Beta' }) }))).toEqual({ status: 503, why: 'stt_vocab_writes_need_mac' })
  })

  it('turned on again: the copy answers again', async () => {
    await chooseForBox({})
    await syncCopyKinds(macKinds(), { targets: () => [companion()] })
    expect(await copyKindOff('prefs')).toBe(false)
    expect((await api('/api/v1/favorites')).body).toEqual({ projects: ['Acme'], notes: [] })
    expect((await api('/api/v1/config')).status).toBe(200)
  })
})

describe('the Mac answers: only what the box leaves out goes to it', () => {
  afterEach(() => { mac.answers = false; mac.calls = [] })

  it('keeping everything: nothing goes to the Mac', async () => {
    await chooseForBox({})
    forgetCompanionHostReplica()
    await syncCompanionHostReplica()
    await syncCopyKinds(macKinds(), { targets: () => [companion()] })
    mac.answers = true
    const all = await api('/api/search?q=friday&slim=1')
    expect(all.status).toBe(200)
    expect(all.body).not.toHaveProperty('partial')
    expect(Array.isArray(all.body.results)).toBe(true)
    expect((await api('/api/notes-v2/search?q=friday&mode=string')).body.results.length).toBe(3)
    expect((await api('/api/notes-v2/content/Acme/vendors')).body.content).toContain('Call the printer')
    for (const p of ['/api/ui-prefs', '/api/favorites', '/api/stt/vocab', '/api/memory/global', '/api/skills']) expect([p, (await api(p)).status]).toEqual([p, 200])
    expect(mac.calls).toEqual([])
  })

  it('one note left out: its read and both searches go to the Mac; a kept note and a task search stay here', async () => {
    await chooseForBox({ keep: { notes_exclude: ['acme/VENDORS'] } })
    forgetCompanionHostReplica()
    await syncCompanionHostReplica()
    mac.answers = true
    expect((await api('/api/notes-v2/content/Acme/vendors')).body).toEqual({ from: 'mac' })
    expect((await api('/api/notes-v2/search?q=friday&mode=string')).body).toEqual({ from: 'mac' })
    expect((await api('/api/search?q=friday&slim=1')).body).toEqual({ from: 'mac' })
    expect((await api('/api/notes-v2/content/Acme/launch-plan')).body.content).toContain('Ship the beta')
    const tasks = await api('/api/search?q=friday&types=task&slim=1')
    expect(tasks.body).not.toHaveProperty('from')
    expect(tasks.body).not.toHaveProperty('partial')
    expect(mac.calls).toEqual(['/api/notes-v2/content/Acme/vendors', '/api/notes-v2/search?q=friday&mode=string', '/api/search?q=friday&slim=1'])
  })

  it('memory off: its reads go to the Mac, the notes stay here', async () => {
    await chooseForBox({ keep: { memory: false } })
    forgetCompanionHostReplica()
    await syncCompanionHostReplica()
    mac.answers = true
    expect((await api('/api/memory/global')).body).toEqual({ from: 'mac' })
    expect((await api('/api/notes-v2/content/Acme/vendors')).status).toBe(200)
    expect(mac.calls).toEqual(['/api/memory/global'])
  })

  it('a kind turned off: its console reads go to the Mac; a kind kept stays here', async () => {
    await chooseForBox({ copies: { prefs: false } })
    forgetCompanionHostReplica()
    await syncCompanionHostReplica()
    await syncCopyKinds(macKinds(), { targets: () => [companion()] })
    mac.answers = true
    expect((await api('/api/ui-prefs')).body).toEqual({ from: 'mac' })
    expect((await api('/api/favorites')).body).toEqual({ from: 'mac' })
    expect((await api('/api/stt/vocab')).body).toMatchObject({ words: ['Acme'] })
    expect(mac.calls).toEqual(['/api/ui-prefs', '/api/favorites'])
    await chooseForBox({})
    await syncCopyKinds(macKinds(), { targets: () => [companion()] })
  })
})
