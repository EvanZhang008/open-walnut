/**
 * The host call entry's tokens (host-call-token-core.ts): one key per daemon dir, made once
 * (0600, never through a link) and kept across daemon restarts; a token per caller sid, checked
 * in constant time. Run as imported and as the text the source twin inlines.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostCallTokens } from '../../src/providers/host-call-token-core.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hct-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const uid = typeof process.getuid === 'function' ? process.getuid() : null
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const inlined = new Function(`"use strict"; return (${createHostCallTokens.toString()})`)() as typeof createHostCallTokens

describe.each([['imported', createHostCallTokens], ['inlined', inlined]] as const)('host call tokens (%s)', (_label, make) => {
  const tokens = () => make({ fs, path, crypto, dir, uid })

  it('makes one private key on first use, and a second daemon in the same dir reads the same one', () => {
    const a = tokens()
    const t = a.tokenFor('sid-1')
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    const st = fs.statSync(path.join(dir, 'host-call.key'))
    expect(st.mode & 0o777).toBe(0o600)
    // A restarted daemon: every running caller's token is still good.
    const b = tokens()
    expect(b.tokenFor('sid-1')).toBe(t)
    expect(b.verify('sid-1', t)).toBe(true)
  })

  it('a token is good for its own sid only, and anything that is not a token is refused', () => {
    const a = tokens()
    const t = a.tokenFor('sid-1')!
    expect(a.verify('sid-2', t)).toBe(false)
    expect(a.verify('sid-1', t.toUpperCase())).toBe(false)
    expect(a.verify('sid-1', t.slice(1))).toBe(false)
    expect(a.verify('sid-1', '')).toBe(false)
    expect(a.verify('sid-1', undefined)).toBe(false)
    expect(a.verify(undefined, t)).toBe(false)
    expect(a.verify('', t)).toBe(false)
    expect(a.tokenFor('')).toBeNull()
    // HMAC-SHA256 of the sid under the key file's bytes.
    const key = Buffer.from(fs.readFileSync(path.join(dir, 'host-call.key'), 'utf8').trim(), 'hex')
    expect(t).toBe(crypto.createHmac('sha256', key).update('sid-1').digest('hex'))
  })

  it('a key file another user could read is never used nor replaced: no tokens, the socket stays the way', () => {
    fs.writeFileSync(path.join(dir, 'host-call.key'), 'ab'.repeat(32) + '\n', { mode: 0o644 })
    fs.chmodSync(path.join(dir, 'host-call.key'), 0o644)
    const logs: string[] = []
    const a = make({ fs, path, crypto, dir, uid, log: (_l, msg) => { logs.push(msg) } })
    expect(a.tokenFor('sid-1')).toBeNull()
    expect(a.verify('sid-1', 'ab'.repeat(32))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'host-call.key'), 'utf8').trim()).toBe('ab'.repeat(32))
    expect(logs.some((m) => m.includes('no token key'))).toBe(true)
  })

  it('a key file that is a link is never followed', () => {
    const target = path.join(dir, 'elsewhere')
    fs.writeFileSync(target, 'cd'.repeat(32) + '\n', { mode: 0o600 })
    fs.symlinkSync(target, path.join(dir, 'host-call.key'))
    expect(tokens().tokenFor('sid-1')).toBeNull()
  })

  it('a key file with no key in it gives no tokens', () => {
    fs.writeFileSync(path.join(dir, 'host-call.key'), 'not a key\n', { mode: 0o600 })
    expect(tokens().tokenFor('sid-1')).toBeNull()
  })
})

describe('host call tokens in the source twin', () => {
  it('the generated daemon carries the inlined factory with no placeholder left', () => {
    const generated = getDaemonSource()
    expect(generated).not.toContain('__CREATE_HOST_CALL_TOKENS__')
    expect(generated).toContain(`var hostCallTokens = (${createHostCallTokens.toString()})(`)
  })
})
