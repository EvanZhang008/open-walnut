/**
 * A small relying party (a site that uses passkeys) for the passkey specs: it registers a passkey
 * and signs a person in with it, checking every answer the way a real site's server does
 * (WebAuthn §7: the client data's type, challenge and origin; the rp id hash; the user-present and
 * user-verified flags; the attestation object's credential public key; the assertion's signature
 * with the key it kept). Nothing of Walnut's is used to check Walnut's answers.
 */
import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

// ── a minimal CBOR reader (what attestation objects and COSE keys use) ──

function readCbor(buf: Buffer, at = 0): { value: unknown; end: number } {
  const ib = buf[at]
  const major = ib >> 5
  const info = ib & 31
  let p = at + 1
  let n: number
  if (info < 24) n = info
  else if (info === 24) { n = buf[p]; p += 1 }
  else if (info === 25) { n = buf.readUInt16BE(p); p += 2 }
  else if (info === 26) { n = buf.readUInt32BE(p); p += 4 }
  else throw new Error(`cbor: unsupported length ${info}`)
  switch (major) {
    case 0: return { value: n, end: p }
    case 1: return { value: -1 - n, end: p }
    case 2: return { value: buf.subarray(p, p + n), end: p + n }
    case 3: return { value: buf.subarray(p, p + n).toString('utf8'), end: p + n }
    case 4: { const out: unknown[] = []; for (let i = 0; i < n; i++) { const r = readCbor(buf, p); out.push(r.value); p = r.end } return { value: out, end: p } }
    case 5: { const out = new Map<unknown, unknown>(); for (let i = 0; i < n; i++) { const k = readCbor(buf, p); const v = readCbor(buf, k.end); out.set(k.value, v.value); p = v.end } return { value: out, end: p } }
    default: throw new Error(`cbor: unsupported major ${major}`)
  }
}

const b64u = (b: Buffer) => b.toString('base64url')
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest()

interface Cred { id: string; key: crypto.KeyObject; counter: number; userId: string; userName: string }

export interface RpSite {
  url: (host?: string) => string
  creds: Map<string, Cred>
  log: string[]
  close: () => Promise<void>
}

const PAGE = (rpId: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Passkey test shop</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 20px;color:#222}
button{font:inherit;padding:8px 14px;margin:4px 6px 4px 0;border-radius:8px;border:1px solid #888;background:#fff;cursor:pointer}
button.primary{background:#2f6f9f;color:#fff;border-color:#2f6f9f}input{font:inherit;padding:7px 10px;border:1px solid #aaa;border-radius:8px;width:260px}
#status{margin-top:18px;padding:12px 14px;border-radius:10px;background:#f2f4f7;min-height:24px}.ok{color:#1a7f37}.bad{color:#cf222e}</style></head>
<body><h1>Passkey test shop</h1><p>A local test site (${rpId}). It checks every passkey answer itself.</p>
<p><input id="name" placeholder="Account name" value="evan-test"></p>
<p><button class="primary" id="register">Create a passkey</button><button id="signin">Sign in with a passkey</button><button id="signout">Sign out</button></p>
<div id="status" role="status">Signed out.</div>
<script>
const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/') + '==='.slice((s.length+3)%4)), c => c.charCodeAt(0))
const status = (t, cls) => { const s = document.getElementById('status'); s.textContent = t; s.className = cls || '' }
const post = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(r => r.json())
document.getElementById('register').onclick = async () => {
  try {
    const o = await post('/reg/options', { name: document.getElementById('name').value })
    const cred = await navigator.credentials.create({ publicKey: { ...o, challenge: fromB64u(o.challenge), user: { ...o.user, id: fromB64u(o.user.id) }, excludeCredentials: o.excludeCredentials.map(c => ({ ...c, id: fromB64u(c.id) })) } })
    const r = await post('/reg/verify', { id: cred.id, rawId: b64u(cred.rawId), type: cred.type, isPkc: cred instanceof PublicKeyCredential, clientDataJSON: b64u(cred.response.clientDataJSON), attestationObject: b64u(cred.response.attestationObject), ext: cred.getClientExtensionResults() })
    status(r.ok ? 'Passkey created for ' + r.userName + '. The site checked it.' : 'The site refused it: ' + r.error, r.ok ? 'ok' : 'bad')
  } catch (e) { status(e.name + ': ' + e.message, 'bad') }
}
document.getElementById('signin').onclick = async () => {
  try {
    const o = await post('/auth/options')
    const cred = await navigator.credentials.get({ publicKey: { ...o, challenge: fromB64u(o.challenge) } })
    const r = await post('/auth/verify', { id: cred.id, isPkc: cred instanceof PublicKeyCredential, clientDataJSON: b64u(cred.response.clientDataJSON), authenticatorData: b64u(cred.response.authenticatorData), signature: b64u(cred.response.signature), userHandle: cred.response.userHandle ? b64u(cred.response.userHandle) : null })
    status(r.ok ? 'Signed in as ' + r.userName + ' with a passkey. The site checked the signature.' : 'The site refused it: ' + r.error, r.ok ? 'ok' : 'bad')
  } catch (e) { status(e.name + ': ' + e.message, 'bad') }
}
document.getElementById('signout').onclick = async () => { await post('/signout'); status('Signed out.') }
</script></body></html>`

/** Start the site. `rpId` is the relying party id (its hosts must be it or under it). */
export async function startRpSite(rpId: string): Promise<RpSite> {
  const creds = new Map<string, Cred>()
  const log: string[] = []
  let regChallenge = ''
  let regUser: { id: string; name: string } | null = null
  let authChallenge = ''
  let port = 0
  const origins = () => [`http://${rpId}:${port}`]

  const body = (req: http.IncomingMessage) => new Promise<any>((resolve) => {
    let s = ''
    req.on('data', (c) => { s += c })
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch { resolve({}) } })
  })

  function checkClientData(b64: string, type: string, challenge: string): Buffer {
    const json = Buffer.from(b64, 'base64url')
    const cd = JSON.parse(json.toString('utf8'))
    if (cd.type !== type) throw new Error(`clientData type ${cd.type}`)
    if (cd.challenge !== challenge) throw new Error('challenge mismatch')
    if (!origins().includes(cd.origin)) throw new Error(`origin ${cd.origin}`)
    return json
  }

  function checkAuthData(ad: Buffer): number {
    if (!ad.subarray(0, 32).equals(sha(rpId))) throw new Error('rp id hash mismatch')
    const flags = ad[32]
    if (!(flags & 0x01)) throw new Error('user not present')
    if (!(flags & 0x04)) throw new Error('user not verified')
    return flags
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const json = (v: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
    try {
      if (req.method === 'GET' && u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE(rpId)); return }
      const b = req.method === 'POST' ? await body(req) : {}
      if (u.pathname === '/reg/options') {
        regChallenge = b64u(crypto.randomBytes(32))
        const name = String(b.name || 'evan-test')
        regUser = { id: b64u(sha(`user:${name}`).subarray(0, 16)), name }
        json({
          challenge: regChallenge, rp: { id: rpId, name: 'Passkey test shop' },
          user: { id: regUser.id, name, displayName: name },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          excludeCredentials: [...creds.values()].filter((c) => c.userId === regUser!.id).map((c) => ({ type: 'public-key', id: c.id })),
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          attestation: 'none', timeout: 120000, extensions: { credProps: true },
        })
        return
      }
      if (u.pathname === '/reg/verify') {
        if (!b.isPkc) throw new Error('not a PublicKeyCredential')
        checkClientData(b.clientDataJSON, 'webauthn.create', regChallenge)
        regChallenge = ''
        const att = readCbor(Buffer.from(b.attestationObject, 'base64url')).value as Map<string, unknown>
        const ad = att.get('authData') as Buffer
        const flags = checkAuthData(ad)
        if (!(flags & 0x40)) throw new Error('no attested credential data')
        const idLen = ad.readUInt16BE(53)
        const credId = ad.subarray(55, 55 + idLen)
        if (b64u(credId) !== b.id) throw new Error('credential id mismatch')
        const cose = readCbor(ad, 55 + idLen).value as Map<number, unknown>
        if (cose.get(3) !== -7 || cose.get(-1) !== 1) throw new Error('not an ES256 key')
        const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2) as Buffer), y: b64u(cose.get(-3) as Buffer) }, format: 'jwk' })
        creds.set(b.id, { id: b.id, key, counter: ad.readUInt32BE(33), userId: regUser!.id, userName: regUser!.name })
        log.push(`registered ${regUser!.name} fmt=${att.get('fmt')} credProps=${JSON.stringify(b.ext?.credProps ?? null)}`)
        json({ ok: true, userName: regUser!.name })
        return
      }
      if (u.pathname === '/auth/options') {
        authChallenge = b64u(crypto.randomBytes(32))
        json({ challenge: authChallenge, rpId, userVerification: 'required', allowCredentials: [], timeout: 120000 })
        return
      }
      if (u.pathname === '/auth/verify') {
        if (!b.isPkc) throw new Error('not a PublicKeyCredential')
        const cd = checkClientData(b.clientDataJSON, 'webauthn.get', authChallenge)
        authChallenge = ''
        const c = creds.get(b.id)
        if (!c) throw new Error('unknown credential')
        const ad = Buffer.from(b.authenticatorData, 'base64url')
        checkAuthData(ad)
        if (!crypto.verify('sha256', Buffer.concat([ad, sha(cd)]), c.key, Buffer.from(b.signature, 'base64url'))) throw new Error('bad signature')
        if (b.userHandle && b.userHandle !== c.userId) throw new Error('user handle mismatch')
        const counter = ad.readUInt32BE(33)
        if (counter !== 0 && counter <= c.counter) throw new Error('counter went back')
        c.counter = counter
        log.push(`signed in ${c.userName}`)
        json({ ok: true, userName: c.userName })
        return
      }
      if (u.pathname === '/signout') { json({ ok: true }); return }
      res.writeHead(404); res.end('not found')
    } catch (e) {
      log.push(`refused: ${(e as Error).message}`)
      json({ ok: false, error: (e as Error).message })
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => { port = (server.address() as AddressInfo).port; r() }))
  return {
    url: (host = rpId) => `http://${host}:${port}/`,
    creds, log,
    // The browser keeps its connections open: end them too, or close waits for them.
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections() }),
  }
}
