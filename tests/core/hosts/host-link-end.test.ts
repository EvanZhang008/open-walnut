/**
 * Turn off and Remove end Walnut's own link to a host (core/hosts/host-link-end.ts; 2026-11-10
 * review: after Turn off or Remove the pooled connection and its SSH master stayed up, so Turn on
 * and Connect came back without a real sign-in while the row said "Walnut does not connect to
 * it"). Only Walnut's own sockets are ended, never a master the person's ssh config runs.
 *
 * Guard: every place that tells the surfaces a host left Settings (a `pushHostRemoved` call)
 * also ends its link, or is listed here with why it has no link to end.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { endHostLink, endsLinkWhenLeft, hostsThatLeft } from '../../../src/core/hosts/host-link-end.js'
import { exitOwnedControlMaster } from '../../../src/providers/ssh-control-master.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

describe('which hosts left, and whose link ends', () => {
  it('the hosts shown before and not after (removed, turned off, a found host back to waiting)', () => {
    expect(hostsThatLeft(new Set(['a', 'b', 'c']), new Set(['b']))).toEqual(['a', 'c'])
    expect(hostsThatLeft(new Set(['a']), new Set(['a', 'new']))).toEqual([])
  })

  it('never this Mac, the cloud companion row (it follows the pairing), or a direct: pool entry', () => {
    expect(endsLinkWhenLeft('devbox')).toBe(true)
    expect(endsLinkWhenLeft('__local__')).toBe(false)
    expect(endsLinkWhenLeft('__cloudbox__')).toBe(false)
    expect(endsLinkWhenLeft('direct:http://x')).toBe(false)
  })

  it('drops the pooled connection and ends the terminal master', async () => {
    const calls: string[] = []
    const r = await endHostLink('devbox', {
      dropConnection: (h) => { calls.push(`drop ${h}`); return true },
      endTerminalMaster: async (h) => { calls.push(`term ${h}`); return true },
    })
    expect(r).toEqual({ connection: true, terminal: true })
    expect(calls).toEqual(['drop devbox', 'term devbox'])
  })

  it('a failure in one step still runs the other, and never throws', async () => {
    const calls: string[] = []
    const r = await endHostLink('devbox', {
      dropConnection: () => { throw new Error('boom') },
      endTerminalMaster: async (h) => { calls.push(h); return false },
    })
    expect(r).toEqual({ connection: false, terminal: false })
    expect(calls).toEqual(['devbox'])
  })
})

describe('exitOwnedControlMaster: only a socket this user owns', () => {
  const dir = () => {
    const d = fs.mkdtempSync(path.join('/tmp', 'hle-'))
    cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }))
    return d
  }

  it('sends -O exit to a live socket of this user, with no ssh config read', async () => {
    const sock = path.join(dir(), 'm')
    const server = net.createServer().listen(sock)
    await new Promise((r) => server.once('listening', r))
    cleanups.push(() => server.close())
    const runs: string[][] = []
    const ended = await exitOwnedControlMaster(sock, 'devbox', { run: async (args) => { runs.push(args); return { stdout: '', stderr: '', code: 0, timedOut: false } } })
    expect(ended).toBe(true)
    expect(runs).toHaveLength(1)
    expect(runs[0].slice(0, 2)).toEqual(['-F', '/dev/null'])
    expect(runs[0]).toContain('-O')
    expect(runs[0][runs[0].indexOf('-O') + 1]).toBe('exit')
  })

  it('a socket another user owns, a plain file, or nothing: left alone, no ssh run', async () => {
    const d = dir()
    const sock = path.join(d, 'm')
    const server = net.createServer().listen(sock)
    await new Promise((r) => server.once('listening', r))
    cleanups.push(() => server.close())
    const file = path.join(d, 'f')
    fs.writeFileSync(file, '')
    const runs: string[][] = []
    const run = async (args: string[]) => { runs.push(args); return { stdout: '', stderr: '', code: 0, timedOut: false } }
    expect(await exitOwnedControlMaster(sock, 'devbox', { run, uid: (process.getuid?.() ?? 0) + 1 })).toBe(false)
    expect(await exitOwnedControlMaster(file, 'devbox', { run })).toBe(false)
    expect(await exitOwnedControlMaster(path.join(d, 'none'), 'devbox', { run })).toBe(false)
    expect(runs).toEqual([])
  })
})

describe('guard: a host that left Settings has its link ended', () => {
  // Files that tombstone a host with no link of Walnut's to end, and why.
  const NO_LINK: Record<string, string> = {
    'src/web/routes/test-host-fixture.ts': 'fixture hosts are answered by the fixture, never dialled over ssh',
    'src/core/hosts/host-connect-action.ts': 'defines pushHostRemoved',
  }
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name)
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })

  it('every file calling pushHostRemoved also calls endHostLink, or is listed with why', () => {
    const offenders: string[] = []
    for (const file of walk(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file)
      const src = fs.readFileSync(file, 'utf8')
      if (!/\bpushHostRemoved\(/.test(src) || NO_LINK[rel]) continue
      if (!/\bendHostLink\(/.test(src)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
    for (const rel of Object.keys(NO_LINK)) expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true)
  })

  it('the server ends the link of each host it tombstones, in the same loop', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/web/server.ts'), 'utf8')
    expect(src).toMatch(/for \(const host of hostsThatLeft\(before, after\)\) \{\s*pushHostRemoved\(host\)\s*void endHostLink\(host\)/)
  })

  it('the row words say what Turn off and Remove do (no "sessions stop", no link kept)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'web/src/components/settings/sections/RemoteHostSshRow.tsx'), 'utf8')
    expect(src).not.toMatch(/sessions (there )?stop/i)
    expect(src).toMatch(/TURN_OFF_NOTE = '[^']*disconnects[^']*signs in again[^']*keep running/)
    expect(src).toMatch(/REMOVE_NOTE = '[^']*disconnects[^']*keep running/)
  })
})
