/**
 * A host failure as a person reads it never carries Walnut's internal evidence tags
 * (`walnut-ssh-evidence: ...`, ssh-credential-evidence.ts). The tags ride the raw error so
 * Walnut's own readers (the hint, the auth letter) can read a key path back; on a row they
 * only repeated the hint in Walnut's internal form (2026-11-10 owner check in Mac WebKit:
 * "[walnut-ssh-evidence: key-missing (/.../id_ed25519_devbox)]" on the Remote Hosts row).
 *
 * The guard below lists every web file that reads a host status's raw `error` or a listing's
 * `hostError.message`; each must pass it through shownFailureSummary (or hostProblemOf, which
 * does). A new reader that shows the raw text fails here.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { hostProblemOf, listingProblemOf, shownFailureSummary } from '../../src/core/hosts/host-problem'

const ROOT = path.resolve(__dirname, '../..')

describe('shownFailureSummary', () => {
  it('drops a bracketed evidence tag and keeps what ssh said', () => {
    expect(shownFailureSummary('ssh: no such identity: /x/key [walnut-ssh-evidence: key-missing (/x/key)]'))
      .toBe('ssh: no such identity: /x/key')
  })
  it('drops an evidence line of its own', () => {
    expect(shownFailureSummary('Permission denied (publickey).\nwalnut-ssh-evidence: cert-expired (SSH certificate expired)'))
      .toBe('Permission denied (publickey).')
  })
  it('leaves plain text and empty input alone', () => {
    expect(shownFailureSummary('ssh: connect to host 127.0.0.1 port 3461: Connection refused'))
      .toBe('ssh: connect to host 127.0.0.1 port 3461: Connection refused')
    expect(shownFailureSummary(undefined)).toBe('')
  })
  it('hostProblemOf and listingProblemOf carry the shown words', () => {
    const p = hostProblemOf({ host: 'h', phase: 'failed', connected: false, kind: 'auth',
      error: 'ssh: no such identity: /k [walnut-ssh-evidence: key-missing (/k)]' } as never)
    expect(p && 'summary' in p ? p.summary : '').toBe('ssh: no such identity: /k')
    const l = listingProblemOf({ kind: 'listing', message: 'boom [walnut-ssh-evidence: agent-missing (no key)]' }, 'h')
    expect(l && 'summary' in l ? l.summary : '').toBe('boom')
  })
})

describe('every web reader of a raw host error shows the shown words', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
    }
    return out
  }
  // A raw host error: a HostStatus `error` or a listing's `hostError.message`.
  const RAW = /\b(?:status|hostStatus|host)\.error\b(?!\s*[!=]==?)|\bhostError\??\.message\b/
  it('passes it through shownFailureSummary or hostProblemOf', () => {
    const offenders: string[] = []
    for (const file of walk(path.join(ROOT, 'web/src'))) {
      const src = fs.readFileSync(file, 'utf8')
      if (!/HostStatus|hostError/.test(src)) continue
      for (const line of src.split('\n')) {
        if (!RAW.test(line) || /shownFailureSummary\(|hostProblemOf\(|listingProblemOf\(/.test(line)) continue
        // Reading it only to test that one exists, or to compare it (dedup), says nothing to a person.
        if (/hostError\.message\s*===/.test(line)) continue
        if (/!!\s*\w+\.error|\(\s*!?\w+\.error\s*&&|\.error\s*\?\s*$/.test(line)) continue
        offenders.push(`${path.relative(ROOT, file)}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
