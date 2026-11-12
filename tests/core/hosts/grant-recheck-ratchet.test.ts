/**
 * Every call that lets work start on another host under the user's grant (grantFor with a preview:
 * host_exec, host_mcp, host_http, host_copy, host_daemon_update) reads the grant and the host's
 * hard stop again AFTER its last wait (the slot, the dial) and BEFORE the work is sent.
 * 2026-11-04: host_exec checked only at the start of a call, which then waited for a slot and the
 * host; a revoke in between still ran the command. A new caller of grantFor fails here until it is
 * listed below with where it waits, where it checks and what it sends. A read or a stop (grantFor
 * with null) starts nothing.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../../../src')

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) ? [p] : []
  })
}

/**
 * Per caller: the last wait before each send, the check that must follow it, the send, and how many
 * of the file's grant calls lead to it (`grants`, 1 unless said: host_exec takes its grant from
 * grantFor or, pinned, from pinnedGrant).
 */
const DISPATCH: Record<string, Array<{ after: string; check: string; send: string; grants?: number }>> = {
  'core/hosts/host-exec.ts': [{ after: 'runRequest(', check: 'assertStillGranted(', send: "'exec.run'", grants: 2 }],
  'core/hosts/host-mcp.ts': [
    { after: 'dial(', check: 'assertStillGranted(', send: "'mcp.list'" },
    { after: 'dial(', check: 'assertStillGranted(', send: 'ask(conn, host, cmd' },
  ],
  'core/hosts/host-http.ts': [{ after: 'dial(', check: 'assertStillGranted(', send: "'http.request'" }],
  // The update waits again inside the updater: it gets the gate, read before each of its steps
  // (tests/providers/daemon-net-update.test.ts proves the updater reads it).
  'core/hosts/host-daemon-update.ts': [{ after: 'link(host)', check: 'assertStillGranted(', send: 'requestDaemonUpdate(gate)' }],
  // The copy checks once before the relay, then the relay asks its gate before every part.
  'core/hosts/host-copy.ts': [{ after: 'planTarget(', check: 'gate()', send: 'relayFile(job.fromHost' }],
}

/** Every call in `src` that takes a grant to start work: grantFor with a preview, and pinnedGrant. */
function grantCalls(src: string): number {
  const body = src.replace(/function (grantFor|pinnedGrant)\(/g, '')
  const calls = (body.match(/\b(grantFor|pinnedGrant)\(/g) ?? []).length
  const reads = (body.match(/\bgrantFor\(\s*\w+\s*,\s*\w+\s*,\s*null\s*\)/g) ?? []).length
  return calls - reads
}

const at = (src: string, needle: string) => [...src.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map((m) => m.index!)

describe('grant recheck ratchet', () => {
  it('every grant that lets work start is listed with its check, file by file and call by call', () => {
    const starters = Object.fromEntries(files(SRC).flatMap((f) => {
      const rel = path.relative(SRC, f)
      if (rel === 'core/hosts/host-exec-grant.ts') return []
      const n = grantCalls(fs.readFileSync(f, 'utf8'))
      return n > 0 ? [[rel, n]] : []
    }))
    const listed = Object.fromEntries(Object.entries(DISPATCH).map(([f, sites]) => [f, sites.reduce((n, s) => n + (s.grants ?? 1), 0)]))
    expect(starters, 'a new grant that starts work: add its send to DISPATCH with its check after its last wait').toEqual(listed)
  })

  it('each check comes after the last wait and before the send, at every place the send is', () => {
    for (const [file, sites] of Object.entries(DISPATCH)) {
      const src = fs.readFileSync(path.join(SRC, file), 'utf8')
      for (const { after, check, send } of sites) {
        const sends = at(src, send)
        expect(sends.length, `${file}: ${send} not found`).toBeGreaterThan(0)
        for (const i of sends) {
          const waited = src.lastIndexOf(after, i)
          const checked = src.lastIndexOf(check, i)
          expect(waited, `${file}: ${after} not found before ${send}`).toBeGreaterThan(0)
          expect(checked, `${file}: ${check} must come after ${after} and before ${send}`).toBeGreaterThan(waited)
        }
      }
    }
  })

  it('the copy hands its gate to the probes and the relay, and the client asks it right before each send', () => {
    const copy = fs.readFileSync(path.join(SRC, 'core/hosts/host-copy.ts'), 'utf8')
    expect(copy).toMatch(/relayFile\([^)]*\{[^}]*\bgate,/)
    expect(copy).toMatch(/sourceSize\([^)]*, gate\)/)
    expect(copy).toMatch(/probe\(job\.toHost, p, gate\)/)
    const text = fs.readFileSync(path.join(SRC, 'core/transfer/daemon-transfer-client.ts'), 'utf8')
    const client = text.split('\n')
    // Every command leaves through sendOn (it reads this server's stop), which sends at once: nothing awaits between.
    const sends = client.flatMap((l, i) => (/(await|return) sendOn\(conn, host, (command|'fs\.readRange')/.test(l) ? [i] : []))
    expect(sends).toHaveLength(3)
    for (const i of sends) expect(client[i - 1], `the line before "${client[i].trim()}"`).toMatch(/^\s*gate\?\.\(/)
    expect(text).toMatch(/async function sendOn\([^)]*\)[^{]*\{\n\s*try \{\n\s*return await conn\.send\(command, params, timeoutMs\)/)
  })

  // 2026-11-04 review: a wait that began before a revoke went on reading the job's new lines.
  it('every read of a job\'s output on the server goes through readJob, which reads the grant before the send and after the answer', () => {
    const readers = files(SRC).filter((f) => !f.includes(`${path.sep}providers${path.sep}`)).flatMap((f) => {
      const n = (fs.readFileSync(f, 'utf8').match(/'exec\.read'/g) ?? []).length
      return n ? [[path.relative(SRC, f), n]] : []
    })
    expect(Object.fromEntries(readers)).toEqual({ 'core/hosts/host-exec.ts': 1 })
    const src = fs.readFileSync(path.join(SRC, 'core/hosts/host-exec.ts'), 'utf8')
    const body = src.slice(src.indexOf('export async function readJob('), src.indexOf('\n}\n', src.indexOf('export async function readJob(')))
    const send = body.indexOf("'exec.read'")
    expect(body.lastIndexOf('assertMayRead(', send), 'a check before the send').toBeGreaterThan(0)
    expect(body.indexOf('assertMayRead(', send), 'a check after the answer').toBeGreaterThan(send)
    // A read that swallows its errors must still let a revoke through.
    for (const f of ['core/hosts/host-exec.ts', 'core/hosts/host-exec-wait.ts']) {
      const text = fs.readFileSync(path.join(SRC, f), 'utf8')
      for (const m of text.matchAll(/readJob\([^\n]*\n?[^\n]*\.catch\(([^\n]*)/g)) expect(m[1], `${f}: a catch on readJob`).toContain('isReadStop(err)')
    }
  })
})
