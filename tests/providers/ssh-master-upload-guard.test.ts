/**
 * Nothing uploads over a host's shared SSH master (src/providers/ssh-upload-budget.ts).
 * A relay ends an SSH connection a few MB up, and the master carries the session
 * link: an upload there dropped every session on the host (2026-11-11: a 1 MB fold
 * prewarm upload and large scripts rode it). Every use of the master args in the
 * connection is listed here with why it sends no data up; a new one fails until it
 * is classified, and a fresh-connection upload stays fresh.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { MASTER_STDIN_MAX_BYTES, rideMaster } from '../../src/providers/ssh-upload-budget'

const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/providers/daemon-connection.ts'), 'utf8')

/** The enclosing method of each use, and why it carries no upload. */
const MASTER_USES: Record<string, string> = {
  'get baseSshArgs': 'the getter itself',
  sshExec: 'a script over MASTER_STDIN_MAX_BYTES goes fresh (rideMaster)',
  dialPortForward: 'a -N port forward: no stdin, its traffic is a service the user opened',
  retireIsolatedDaemon: "a test server's short retire script",
  createTunnel: 'the session link itself (-N forward)',
}

function enclosingMethod(at: number): string {
  const before = SRC.slice(0, at)
  const re = /\n  (?:private |public |protected )?(?:static )?(?:async )?(get [A-Za-z]+|[A-Za-z_]+)\s*\(/g
  let name = '?'
  for (let m = re.exec(before); m; m = re.exec(before)) name = m[1]
  return name
}

describe('uploads never ride the shared SSH master', () => {
  it('every use of the master args is classified', () => {
    const uses = [...SRC.matchAll(/this\.baseSshArgs/g)].map((m) => enclosingMethod(m.index!))
    uses.push('get baseSshArgs')
    expect([...new Set(uses)].sort()).toEqual(Object.keys(MASTER_USES).sort())
  })

  it('a call that writes stdin data names the fresh args, or goes through sshExec', () => {
    const calls = [...SRC.matchAll(/runSshBounded\(([^)]*?)\{\s*input:/gs)]
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      const head = c[1]
      const ok = /freshSshArgs|\bsshArgs\b|\bargs\b/.test(head) && !/baseSshArgs/.test(head)
      expect(ok, `stdin upload over the master: ${head.slice(0, 120)}`).toBe(true)
    }
  })

  it('the source and sidecar uploads take the fresh args', () => {
    expect(SRC).toMatch(/const sshArgs = this\.freshSshArgs\n/)
  })

  it('rideMaster draws the line at MASTER_STDIN_MAX_BYTES', () => {
    expect(rideMaster(10_000)).toBe(true)
    expect(rideMaster(MASTER_STDIN_MAX_BYTES)).toBe(true)
    expect(rideMaster(MASTER_STDIN_MAX_BYTES + 1)).toBe(false)
  })

  it('sshExec checks the script size before picking the master', () => {
    const body = SRC.slice(SRC.indexOf('private async sshExec('), SRC.indexOf('private async sshExec(') + 700)
    expect(body).toMatch(/rideMaster\(Buffer\.byteLength\(remoteCmd\)\) \? this\.baseSshArgs : this\.freshSshArgs/)
  })
})
