/**
 * A throwaway Walnut with no companion that waits for a machine OUTSIDE this test to join
 * it: the other half of a fresh-machine check (.github/workflows/fresh-mac-join.yml, a
 * macOS runner's own account; windows-join.yml, a Windows PC through WSL). That machine runs
 * the real command a user pastes, with the real install and the real login service; this
 * test only plays the Mac.
 *
 *   this primary (startServer, "the Mac", public relays) ── its daemon ── walnut-net ─┐
 *                                                                                     │ iroh
 *   the outside machine: the pasted command ── walnut net join ── its daemon ── walnut-net
 *
 * Skipped unless WALNUT_OUTSIDE_JOIN names a directory. It writes there:
 *   ticket.txt    the ticket, as soon as the invite exists (the outside side waits for it)
 *   command.txt   the command Settings shows for it (windows-command.txt: its PowerShell line)
 *   result.json   { machine, platform, path, files } once the machine joined and connected
 * and waits WALNUT_OUTSIDE_JOIN_WAIT_S (default 900) for the join.
 *
 * MACHINE SAFETY: the primary's data and daemon dirs are temp dirs (createMockConstants),
 * real ssh is refused (isolateFromRealSsh), and nothing here touches the outside machine's
 * account: it only answers over the host network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { isolateFromRealSsh, type SshIsolation } from '../helpers/isolate-ssh.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-net-outside'))

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'

const OUT = process.env.WALNUT_OUTSIDE_JOIN ?? ''
const WAIT_MS = Number(process.env.WALNUT_OUTSIDE_JOIN_WAIT_S ?? 900) * 1000
const suite = OUT ? describe : describe.skip

let base = ''
let isolation: SshIsolation | null = null
let primaryPort = 0

const api = (p: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${primaryPort}${p}`, {
  ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
})

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`)
}

suite('a machine outside this test joins a Walnut with no companion', () => {
  beforeAll(async () => {
    fs.mkdirSync(OUT, { recursive: true })
    for (const f of ['ticket.txt', 'command.txt', 'windows-command.txt', 'result.json']) fs.rmSync(path.join(OUT, f), { force: true })
    base = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-host-net-outside-'))
    if (process.env.WALNUT_NET_TEST_BIN) {
      process.env.WALNUT_NET_BIN = process.env.WALNUT_NET_TEST_BIN
      process.env.WALNUT_NET_NO_DOWNLOAD = '1'
    }
    // A test server never runs the network on its own (net-mac.ts netActive): this one does.
    process.env.WALNUT_NET_ACTIVE = '1'
    await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
    await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
    await fsp.writeFile(path.join(WALNUT_HOME, 'config.yaml'), 'version: 1\nuser:\n  name: Tester\n')
    isolation = isolateFromRealSsh(base)
    const server = await startServer({ port: 0, dev: true })
    primaryPort = (server.address() as net.AddressInfo).port
    await (await import('../../src/core/net/net-mac.js')).startNet()
  }, 600_000)

  afterAll(async () => {
    try { await stopServer() } catch { /* best-effort */ }
    isolation?.restore()
    for (const k of ['WALNUT_NET_BIN', 'WALNUT_NET_NO_DOWNLOAD', 'WALNUT_NET_ACTIVE']) delete process.env[k]
    if (base.includes('walnut-host-net-outside-')) await fsp.rm(base, { recursive: true, force: true })
  }, 120_000)

  it('hands out a ticket, takes the machine in, and reaches its daemon', async () => {
    const relay = await (await api('/api/hosts/net')).json() as { relay?: string }
    expect(relay.relay).toBe('public')
    // The first invite turns the network on; walnut-net may still be starting (or downloading).
    const invite = await waitFor(async () => {
      const made = await api('/api/hosts/net/invites', { method: 'POST', body: '{}' })
      return made.status === 201 ? await made.json() as { link: string; command: string; windowsCommand?: string } : null
    }, 300_000, 'the invite')
    fs.writeFileSync(path.join(OUT, 'command.txt'), `${invite.command}\n`)
    if (invite.windowsCommand) fs.writeFileSync(path.join(OUT, 'windows-command.txt'), `${invite.windowsCommand}\n`)
    fs.writeFileSync(path.join(OUT, 'ticket.txt'), `${invite.link}\n`)

    const machine = await waitFor(async () => {
      const r = await (await api('/api/hosts/net')).json() as { machines?: Array<{ host: string; platform?: string }> }
      return r.machines?.[0] ?? null
    }, WAIT_MS, 'a machine to join')
    const status = await waitFor(async () => {
      await api(`/api/hosts/${encodeURIComponent(machine.host)}/connect`, { method: 'POST', body: '{}' }).catch(() => null)
      const s = await (await api('/api/hosts/status')).json() as { hosts?: Array<{ host: string; connected: boolean }> }
      return s.hosts?.find((h) => h.host === machine.host && h.connected) ?? null
    }, 180_000, `${machine.host} to connect`)
    const ovAfter = await (await api('/api/hosts/net')).json() as { machines?: Array<{ host: string; path?: string }> }
    // A read on the machine through its daemon: the join made a host Walnut can use.
    const files = await waitFor(async () => {
      const r = await api(`/api/v1/files/list?host=${encodeURIComponent(machine.host)}&path=%2F`, { signal: AbortSignal.timeout(30_000) })
      const body = await r.json() as { entries?: unknown[] }
      return r.ok && Array.isArray(body.entries) && body.entries.length > 0 ? body : null
    }, 120_000, `a directory listing from ${machine.host}`)
    const result = {
      machine: machine.host, platform: machine.platform ?? null, connected: status.connected,
      path: ovAfter.machines?.find((m) => m.host === machine.host)?.path ?? null,
      files: files.entries!.length,
    }
    fs.writeFileSync(path.join(OUT, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    expect(result.files).toBeGreaterThan(0)
  }, WAIT_MS + 600_000)
})
