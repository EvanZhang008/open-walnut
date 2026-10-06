/**
 * Load earlier on a phone paired to the cloud companion, end to end.
 *
 *   phone (HTTP, a phone device token)
 *     -> replica (real child process, WALNUT_CLOUD_MODE=1)
 *     -> /bridge -> the primary's local daemon (real, spawned by the primary)
 *     -> primary (this process, startServer): `session.control` action
 *        `transcript` builds the page from the session's JSONL, which that same
 *        daemon reads off disk
 *
 * 2026-10-04 report: on the phone, scrolling up in most sessions ended at a
 * folded "Ran 8 commands" line with nothing above it. The phone was on the
 * companion, which read a session as a 512 KB bridge tail (the newest ~100
 * entries) and refused older pages, so the Mac's paging never reached it. The
 * flow pinned here is the phone's: open a long session through the companion,
 * walk Load earlier back to the opening ask, get exactly the pages the Mac's own
 * route serves, nothing twice; then the Mac goes away, and the newest page is
 * the synced copy (not pageable) while an older page is a 503 to retry.
 *
 * No substitution on the path. Isolation: each server has its own HOME, data
 * dir and daemon dir under one temp base; the session is written here, never
 * copied from user data; auth.json is written fresh with random tokens.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
import { seedPrimaryPairing, startCloudBoxReplica, type CloudBoxReplica } from '../helpers/cloud-box-replica.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-transcript-replica-primary'))

import { WALNUT_HOME, CLAUDE_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../src/core/session-history.js'

const SID = 'sess-replica-paging-0001'
const CWD = '/Users/test/replica-paging'
const ASK = 'Clean up the orphaned records and report back.'
const TURNS = 5

let base = ''
let replica: CloudBoxReplica | null = null
let primaryPort = 0
let primaryUp = false
let primaryConn: { disconnect: () => void } | null = null
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

interface Row { role: string; text: string; timestamp: string; kind?: string; detail?: string }
interface Page { messages: Row[]; truncated: boolean; rich?: boolean; pageable?: boolean; error?: { code: string } }

let seq = 0
const at = (): string => new Date(Date.UTC(2026, 0, 1) + (++seq) * 1000).toISOString()

/** The reported shape: one ask, then turns of many tool calls closed by one line. */
function sessionLines(): string {
  const lines: unknown[] = [{
    type: 'user', uuid: `u-${++seq}`, timestamp: at(),
    message: { role: 'user', content: [{ type: 'text', text: ASK }] },
  }]
  for (let t = 0; t < TURNS; t++) {
    for (let c = 0; c < 90; c++) {
      const id = `m-${t}-${c}`
      lines.push(
        { type: 'assistant', uuid: `t-${++seq}`, timestamp: at(),
          message: { id, role: 'assistant', content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: { command: `step ${t}.${c}` } }] } },
        { type: 'user', uuid: `r-${++seq}`, timestamp: at(),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, content: 'ok' }] } },
      )
    }
    lines.push({ type: 'assistant', uuid: `a-${++seq}`, timestamp: at(),
      message: { id: `p-${t}`, role: 'assistant', content: [{ type: 'text', text: `Turn ${t} done.` }] } })
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

async function phone(qs: string): Promise<{ status: number; body: Page }> {
  const res = await fetch(`http://127.0.0.1:${replica!.port}/api/v1/sessions/${SID}/transcript${qs}`, {
    headers: { Authorization: `Bearer ${replica!.tokens.phone}` },
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Page : ({} as Page) }
}

async function mac(qs: string): Promise<Page> {
  const res = await fetch(`http://127.0.0.1:${primaryPort}/api/v1/sessions/${SID}/transcript${qs}`)
  expect(res.status).toBe(200)
  return await res.json() as Page
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}\n${replica?.log().slice(-3000) ?? ''}`)
}

function stopDaemonIn(dir: string | undefined): void {
  if (!dir) return
  try {
    const pid = Number(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf-8').trim())
    if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM')
  } catch { /* not running */ }
}

const texts = (rows: Row[]): string[] => rows.filter((m) => !m.kind).map((m) => m.text)
const sameRows = (p: Page): unknown => ({ truncated: p.truncated, messages: p.messages })
const SYNCED: Row = { role: 'assistant', text: 'the synced tail', timestamp: '2026-01-01T03:00:00.000Z' }

beforeAll(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-transcript-replica-e2e-'))
  replica = await startCloudBoxReplica(base)
  // What git-sync leaves on the companion: the export sweep's slim newest tail.
  const synced = path.join(replica.box.data, 'sessions', 'transcripts')
  await fsp.mkdir(synced, { recursive: true })
  await fsp.writeFile(path.join(synced, `${SID}.json`), JSON.stringify({
    version: 1, sessionId: SID, exportedAt: '2026-01-01T03:00:00.000Z', truncated: true, messages: [SYNCED],
  }))

  // The Mac: its daemon reads `~/.claude` through its own HOME, so HOME is the
  // throwaway one CLAUDE_HOME sits in, set before the daemon spawns.
  process.env.HOME = path.dirname(CLAUDE_HOME)
  process.env.USERPROFILE = process.env.HOME
  await seedPrimaryPairing(WALNUT_HOME, `127.0.0.1:${replica.port}`, replica.tokens)
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fsp.writeFile(CONFIG_FILE, yaml.dump({
    version: 1, user: { name: 'Tester' }, defaults: { priority: 'none', platform: 'local' },
    provider: { type: 'claude-code' }, agent: { provider: 'claude-code' },
  }))
  await createSessionRecord(SID, '', '', CWD, { title: 'Busy session', initialProcessStatus: 'idle' })
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD))
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${SID}.jsonl`), sessionLines())

  const server: HttpServer = await startServer({ port: 0, dev: true })
  primaryUp = true
  const addr = server.address()
  primaryPort = typeof addr === 'object' && addr ? addr.port : 0
  // The connection a live session would hold: it pushes the bridge config to the daemon.
  const { localDaemon } = await import('../../src/providers/local-daemon.js')
  const { getDirectDaemonConnection } = await import('../../src/providers/daemon-connection.js')
  const wsUrl = localDaemon.wsUrl
  if (!wsUrl) throw new Error('the primary has no local daemon')
  primaryConn = await getDirectDaemonConnection('__local__', wsUrl)
}, 300_000)

afterAll(async () => {
  try { primaryConn?.disconnect() } catch { /* already closed */ }
  if (primaryUp) { try { await stopServer() } catch { /* already down */ } }
  stopDaemonIn(process.env.WALNUT_DAEMON_DIR)
  await replica?.stop().catch(() => {})
  if (process.env.DEBUG_BOX) process.stderr.write(replica?.log().slice(-8000) ?? '')
  process.env.HOME = savedHome.HOME
  process.env.USERPROFILE = savedHome.USERPROFILE
  if (base) await fsp.rm(base, { recursive: true, force: true }).catch(() => {})
}, 90_000)

describe('Load earlier through the companion', () => {
  it('pages a long session back to the opening ask, exactly as the Mac serves it', async () => {
    // The first page is the Mac's once its daemon's bridge is up.
    const first = await waitFor(async () => {
      const r = await phone('?fresh=1&rich=1&visible=3')
      return r.status === 200 && r.body.pageable === true ? r.body : null
    }, 120_000, 'the companion to page through the Mac')
    expect(first.rich).toBe(true)
    expect(first.truncated).toBe(true)
    expect(sameRows(first)).toEqual(sameRows(await mac('?fresh=1&rich=1&visible=3')))
    expect(texts(first.messages)).not.toContain(SYNCED.text)

    const pages: Row[][] = [first.messages]
    let page = first
    while (page.truncated) {
      const cursor = page.messages[0].timestamp
      const qs = `?fresh=1&rich=1&visible=3&before=${encodeURIComponent(cursor)}`
      const r = await phone(qs)
      expect(r.status).toBe(200)
      expect(r.body.pageable).toBe(true)
      expect(sameRows(r.body)).toEqual(sameRows(await mac(qs)))
      for (const m of r.body.messages) expect(m.timestamp < cursor).toBe(true)
      page = r.body
      pages.push(page.messages)
      expect(pages.length).toBeLessThan(40)
    }
    expect(pages.length).toBeGreaterThan(1)
    const stitched = pages.reverse().flat()
    expect(stitched[0]).toMatchObject({ role: 'user', text: ASK })
    expect(texts(stitched).filter((t) => t.startsWith('Turn '))).toEqual(
      Array.from({ length: TURNS }, (_, t) => `Turn ${t} done.`))
    expect(stitched.filter((m) => m.kind === 'tool')).toHaveLength(TURNS * 90)
    const keys = stitched.map((m) => `${m.timestamp}|${m.kind ?? ''}|${m.text}|${m.detail ?? ''}`)
    expect(new Set(keys).size).toBe(keys.length)
  }, 240_000)

  it('with the Mac away, the newest page is the synced copy and an older page is a 503', async () => {
    try { primaryConn?.disconnect() } catch { /* already closed */ }
    primaryConn = null
    await stopServer()
    primaryUp = false
    stopDaemonIn(process.env.WALNUT_DAEMON_DIR)

    const newest = await waitFor(async () => {
      const r = await phone('?fresh=1&rich=1&visible=3')
      return r.status === 200 && r.body.pageable === undefined ? r.body : null
    }, 90_000, 'the companion to notice the Mac is gone')
    expect(newest.rich).toBe(false)
    // The companion's own copy: the file written above, or the newer tail the
    // Mac's export sweep pushed over the bridge while it was up.
    expect([SYNCED.text, `Turn ${TURNS - 1} done.`]).toContain(newest.messages.at(-1)?.text)

    const older = await phone(`?fresh=1&rich=1&visible=3&before=${encodeURIComponent(SYNCED.timestamp)}`)
    expect(older.status).toBe(503)
    expect(older.body.error?.code).toBe('page_unavailable')
  }, 180_000)
})
