/**
 * Guard: a request from this computer counts as the person only with what his own clients send
 * (src/web/routes/local-person-proof.ts), on every person-only decision.
 *
 * 2026-11-28: any local process (a session's own `curl localhost:3456`) sent no caller mark and
 * passed every person-only route as the person, a plugin console's post in his name included. The
 * rule lives in one place, isPersonCaller, and reaches plugins through the dispatcher's caller-kind
 * stamp; the ratchet at the end fails when a route grows its own copy of the person rule again.
 */
import fs from 'node:fs'
import path from 'node:path'
import express, { Router } from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { IntegrationRegistry } from '../../../src/core/integration-registry.js'
import { createPluginBodyParser, createPluginRouteDispatcher } from '../../../src/web/plugin-route-dispatcher.js'
import { forwardProofHeader } from '../../../src/lib/forward-proof.js'
import { isPersonCaller } from '../../../src/web/routes/person-caller.js'
import {
  initLocalPersonProof, localPersonProof, takeForwardProof, localProofMode, parseLocalProofMode, setLocalProofModeForTest, UNPROVEN_LOCAL_SENDER, type LocalProofMode,
} from '../../../src/web/routes/local-person-proof.js'
import { createMockPlugin } from '../../core/plugin-test-utils.js'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..')
const LOOPBACK = { remoteAddress: '127.0.0.1', localPort: 3456 }
const HOST = { host: 'localhost:3456' }

/** The Mac app's web view and a browser here: fetch metadata on every request, Origin on writes and sockets. */
const BROWSER_GET = { ...HOST, 'sec-fetch-site': 'same-origin', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)' }
const BROWSER_WS = { ...HOST, origin: 'http://localhost:3456', upgrade: 'websocket' }
const TYPED_URL = { ...HOST, 'sec-fetch-site': 'none' }
/** The person's `walnut` CLI at his terminal: the executor's mark, no session, no automation. */
const PERSON_CLI = { ...HOST, 'x-walnut-op-call': '1', 'x-walnut-origin': '__local__' }
/** What must not pass: a plain local process, and the CLI as a session's or a script's. */
const CURL = { ...HOST, 'user-agent': 'curl/8.7.1' }
const SESSION_CLI = { ...PERSON_CLI, 'x-walnut-caller-sid': 'sess-1' }
const SCRIPT_CLI = { ...PERSON_CLI, 'x-walnut-caller-kind': 'automation' }
const CROSS_SITE = { ...HOST, 'sec-fetch-site': 'cross-site' }
/** The Mac app's own native calls (quick capture, dictation): URLSession's agent string. */
const MAC_NATIVE = { ...HOST, 'user-agent': 'Walnut/1.0 CFNetwork/3860.700.1 Darwin/25.6.0' }
/** A loopback request that writes the paired-device label itself (2026-11-28 review: it read as the person). */
const CLAIMS_REMOTE = { ...CURL, 'x-walnut-origin': 'remote-http' }
/** This server's own forward for the phone: the same label, with the in-process proof. */
const OWN_FORWARD = { ...HOST, 'x-walnut-origin': 'remote-http', ...forwardProofHeader() }

function local(headers: Record<string, string>) {
  return { headers, socket: LOOPBACK, url: '/api/approvals/x/answer', method: 'POST' }
}

afterEach(() => setLocalProofModeForTest('off'))

describe('what proves a local request is one of the person\'s clients', () => {
  it('is a browser\'s fetch metadata or Origin, or the person\'s CLI mark; nothing a plain process sends', () => {
    expect(localPersonProof(BROWSER_GET)).toBe('browser')
    expect(localPersonProof(BROWSER_WS)).toBe('browser')
    expect(localPersonProof(TYPED_URL)).toBe('browser')
    expect(localPersonProof(PERSON_CLI)).toBe('cli')
    expect(localPersonProof(MAC_NATIVE)).toBe('mac-app')
    for (const h of [CURL, SESSION_CLI, SCRIPT_CLI, CROSS_SITE, HOST]) expect(localPersonProof(h)).toBeNull()
  })

  it('reads the mode from WALNUT_LOCAL_PERSON_PROOF, and keeps the old rule off the person\'s own install', async () => {
    expect(parseLocalProofMode('enforce')).toBe('enforce')
    expect(parseLocalProofMode('1')).toBe('enforce')
    expect(parseLocalProofMode('observe')).toBe('observe')
    expect(parseLocalProofMode('0')).toBe('off')
    expect(parseLocalProofMode('')).toBeUndefined()
    expect(await initLocalPersonProof({ WALNUT_LOCAL_PERSON_PROOF: 'enforce' })).toBe('enforce')
    // A test server is no real install: unset, the old rule stays.
    expect(await initLocalPersonProof({})).toBe('off')
    expect(localProofMode()).toBe('off')
  })
})

describe('isPersonCaller, the rule every person-only route shares', () => {
  const cases: Array<[string, Record<string, string>, Record<LocalProofMode, boolean>]> = [
    ['the Mac app\'s web view', BROWSER_GET, { enforce: true, observe: true, off: true }],
    ['a browser socket', BROWSER_WS, { enforce: true, observe: true, off: true }],
    ['the person\'s CLI', PERSON_CLI, { enforce: true, observe: true, off: true }],
    ['the Mac app\'s native call', MAC_NATIVE, { enforce: true, observe: true, off: true }],
    ['this server\'s own forward for the phone', OWN_FORWARD, { enforce: true, observe: true, off: true }],
    ['a plain curl on this computer', CURL, { enforce: false, observe: true, off: true }],
    ['a curl that claims to be the phone', CLAIMS_REMOTE, { enforce: false, observe: true, off: true }],
    ['a session\'s CLI', SESSION_CLI, { enforce: false, observe: false, off: false }],
    ['a script\'s CLI', SCRIPT_CLI, { enforce: false, observe: false, off: false }],
  ]
  for (const [who, headers, expected] of cases) {
    it(`${who}: ${JSON.stringify(expected)}`, () => {
      for (const mode of ['enforce', 'observe', 'off'] as const) {
        setLocalProofModeForTest(mode)
        expect(isPersonCaller(local(headers)), `${who} in ${mode}`).toBe(expected[mode])
      }
    })
  }

  it('leaves a paired device alone: the phone is not loopback and needs no browser signal', () => {
    setLocalProofModeForTest('enforce')
    const phone = { headers: { host: 'macbox.lan:3456', authorization: 'Bearer device-token', 'user-agent': 'Walnut/1.0 CFNetwork/3860.700.1 Darwin/25.6.0' }, socket: { remoteAddress: '192.168.1.20', localPort: 3456 } }
    expect(isPersonCaller(phone)).toBe(true)
  })
})

describe('the forward proof never reaches a route or a plugin', () => {
  it('is read once and taken off the request, and the request keeps its verdict', () => {
    setLocalProofModeForTest('enforce')
    const own = local({ ...OWN_FORWARD })
    takeForwardProof(own)
    expect(Object.keys(own.headers).some((h) => /forward-proof/.test(h))).toBe(false)
    expect(isPersonCaller(own)).toBe(true)
    // A wrong proof is taken off too, and proves nothing.
    const forged = local({ ...CLAIMS_REMOTE, 'x-walnut-forward-proof': 'guess' })
    takeForwardProof(forged)
    expect(Object.keys(forged.headers).some((h) => /forward-proof/.test(h))).toBe(false)
    expect(isPersonCaller(forged)).toBe(false)
  })
})

describe('plugins get the same verdict through the dispatcher', () => {
  function app() {
    const registry = new IntegrationRegistry()
    const router = Router()
    router.post('/', (req, res) => {
      expect(req.headers['x-walnut-sender'] ?? UNPROVEN_LOCAL_SENDER).toBe(UNPROVEN_LOCAL_SENDER)
      res.json({ kind: req.headers['x-walnut-caller-kind'] ?? null })
    })
    registry.register('sample', createMockPlugin({ id: 'sample', httpRoutes: [{ method: 'post' as const, path: '/send', handler: router }] }))
    const a = express()
    a.use('/api/plugins', createPluginBodyParser(), createPluginRouteDispatcher(registry))
    return a
  }

  it('marks an unproven local request, and a loopback claim of the phone without proof, as an automation in enforce', async () => {
    setLocalProofModeForTest('enforce')
    const curl = await request(app()).post('/api/plugins/sample/send').set('user-agent', 'curl/8.7.1').send({})
    expect(curl.body).toEqual({ kind: 'automation' })
    const claims = await request(app()).post('/api/plugins/sample/send').set('x-walnut-origin', 'remote-http').send({})
    expect(claims.body).toEqual({ kind: 'automation' })
    const browser = await request(app()).post('/api/plugins/sample/send').set('sec-fetch-site', 'same-origin').send({})
    expect(browser.body).toEqual({ kind: null })
    const script = await request(app()).post('/api/plugins/sample/send').set('x-walnut-caller-kind', 'automation').send({})
    expect(script.body).toEqual({ kind: 'automation' })
  })

  it('marks nothing in observe or off', async () => {
    for (const mode of ['observe', 'off'] as const) {
      setLocalProofModeForTest(mode)
      const curl = await request(app()).post('/api/plugins/sample/send').set('user-agent', 'curl/8.7.1').send({})
      expect(curl.body, mode).toEqual({ kind: null })
    }
  })
})

describe('ratchet: no route keeps its own copy of the person rule', () => {
  /** Files that may read the caller marks with the origin classes themselves, each with why. */
  const ALLOWED: Record<string, string> = {
    'src/web/routes/person-caller.ts': 'the rule itself',
    'src/integrations/mail/agent-caller.ts': 'a plugin reads the marks the dispatcher stamps, the unproven-local kind included',
  }

  function files(dir: string): string[] {
    const out: string[] = []
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) out.push(...files(p))
      else if (/\.tsx?$/.test(e.name)) out.push(p)
    }
    return out
  }

  it('finds the person rule (no caller mark, and this computer or a paired device) only in person-caller.ts', () => {
    const copies = files(path.join(REPO, 'src')).filter((file) => {
      const text = fs.readFileSync(file, 'utf8')
      return /REMOTE_HTTP_ORIGIN/.test(text) && /x-walnut-caller-sid|CALLER_SID_HEADER/.test(text)
        && /=== LOCAL_ORIGIN \|\| \w+ === REMOTE_HTTP_ORIGIN|=== REMOTE_HTTP_ORIGIN \|\| \w+ === LOCAL_ORIGIN/.test(text.replace(/\n\s*/g, ' '))
    }).map((file) => path.relative(REPO, file)).filter((rel) => !Object.hasOwn(ALLOWED, rel))
    expect(copies, 'use isPersonCaller (src/web/routes/person-caller.ts) instead of a copy of its rule').toEqual([])
  })
})
