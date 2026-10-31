/**
 * "@" sources end to end below the browser: the routes the picker reads, and a launch
 * message carrying a picked row (`<source-ref/>`) reaching the CLI with the source's own
 * words in the reference card.
 *
 * Real server (startServer) and the real send pipeline down to the MockDaemon, which
 * records the exact `start` command; only the CLI is mocked. The source is registered the
 * way a plugin's would be (registerMentionSource), so the test needs no plugin folder.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-mention-sources-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { registerMentionSource } from '../../src/core/mention-sources/registry.js'
import { REFERENCE_CARDS_CLOSE, REFERENCE_CARDS_OPEN } from '../../src/core/sessions/reference-cards.js'
import { sourceRefTag } from '../../src/utils/entity-refs.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon
let cwd: string
const disposers: Array<{ dispose(): void }> = []

const url = (p: string) => `http://localhost:${port}${p}`
async function getJson<T>(p: string): Promise<{ status: number; json: T }> {
  const res = await fetch(url(p))
  return { status: res.status, json: await res.json() as T }
}

async function waitFor<T>(read: () => T | undefined, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = read()
    if (v !== undefined) return v
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('timed out waiting')
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-mention-src-'))
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  disposers.push(registerMentionSource('team-chat', {
    id: 'team-chat',
    label: 'Team chat',
    keyword: 'chat',
    aliases: ['tc'],
    kinds: ['person', 'channel'],
    order: 20,
    async search(q) {
      const all = [
        { ref: 'user:U1', title: 'Alice Chen', subtitle: '@alice · DM 2h ago', kind: 'person', keys: ['alice', '@alice'] },
        { ref: 'channel:C9', title: '#deploy-alerts', subtitle: 'channel', kind: 'channel', keys: ['deploy-alerts'] },
      ]
      return all.filter((r) => !q || r.title.toLowerCase().includes(q.toLowerCase()))
    },
    async resolve(ref) {
      return ref === 'user:U1' ? 'Chat person Alice Chen (@alice, user id U1). Read DMs with chat_dms user="U1".' : null
    },
  }))
  disposers.push(registerMentionSource('stuck', {
    id: 'stuck', label: 'Stuck', keyword: 'stuck', timeoutMs: 200,
    search: () => new Promise(() => {}),
    resolve: async () => null,
  }))
})

afterAll(async () => {
  for (const d of disposers) d.dispose()
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(cwd, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/mention-sources', () => {
  it('lists the core notes source first, then the registered ones, with their keywords', async () => {
    const { status, json } = await getJson<{ sources: Array<{ id: string; label: string; keywords: string[] }> }>('/api/mention-sources')
    expect(status).toBe(200)
    expect(json.sources.map((s) => s.id)).toEqual(['notes', 'team-chat', 'stuck'])
    expect(json.sources[1]).toMatchObject({ label: 'Team chat', keywords: ['chat', 'tc'], inAll: true, lane: 'below' })
    expect(json.sources[0]).toMatchObject({ id: 'notes', inAll: true, lane: 'top' })
  })

  it('searches one source, answers a stuck one with an error instead of hanging, and 404s an unknown one', async () => {
    const hit = await getJson<{ items: Array<{ ref: string; title: string }> }>('/api/mention-sources/team-chat/search?q=alice')
    expect(hit.status).toBe(200)
    expect(hit.json.items.map((i) => i.ref)).toEqual(['user:U1'])
    const empty = await getJson<{ items: unknown[] }>('/api/mention-sources/team-chat/search?q=')
    expect(empty.json.items).toHaveLength(2)
    const started = Date.now()
    const stuck = await getJson<{ items: unknown[]; error?: string }>('/api/mention-sources/stuck/search?q=x')
    expect(stuck.status).toBe(200)
    expect(stuck.json).toMatchObject({ items: [], error: 'timeout' })
    expect(Date.now() - started).toBeLessThan(3000)
    expect((await getJson('/api/mention-sources/nope/search?q=x')).status).toBe(404)
    expect((await getJson('/api/mention-sources/Bad%20Id/search?q=x')).status).toBe(400)
  })
})

describe('a picked source row in a launch message', () => {
  it('reaches the CLI with the source\'s own words in the reference card, the human\'s words first', async () => {
    const message = `ping ${sourceRefTag('team-chat', 'user:U1', 'Alice Chen')} about the deploy`
    const res = await fetch(url('/api/sessions/quick-start'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, message }),
    })
    const body = await res.json() as { sessionId?: string; error?: string }
    expect(res.status, body.error).toBe(200)
    const start = await waitFor(() => daemon.getCommandHistoryFor('start').find((c) => c.payload.sid === body.sessionId))
    const wire = start.payload.message as string
    expect(wire.startsWith(message)).toBe(true)
    const card = wire.slice(wire.indexOf(REFERENCE_CARDS_OPEN), wire.indexOf(REFERENCE_CARDS_CLOSE))
    // Core's head (source label, row kind from the search above, title, ref), then the source's words.
    expect(card).toContain('- Team chat person "Alice Chen" (ref team-chat:user:U1): Chat person Alice Chen (@alice, user id U1).')
  })
})
