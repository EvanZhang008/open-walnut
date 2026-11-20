#!/usr/bin/env bun
/**
 * Publish a new version of the Walnut extension to the Chrome Web Store through its API (V2),
 * with a service account the store's publisher added in the Developer Dashboard (Settings,
 * Service account). It builds the store package (extension-store-package.mjs), scans the zip
 * with the public leak scan, and uploads and submits it only when this Walnut's version is
 * newer than the store's and no review is pending. The store reviews it, then publishes it.
 *
 *   WALNUT_CWS_KEY_FILE=<service account key.json> WALNUT_CWS_PUBLISHER=<publisher id> \
 *   WALNUT_CWS_ITEM=<item id> bun scripts/extension-store-publish.mjs [--dry-run] [--rules <leak rules>]
 *
 * --dry-run does everything but the upload and the submit. --rules defaults to
 * ~/.config/walnut-leak/leak-rules.json. Exit: 0 submitted or nothing to do, 1 refused (a leak
 * hit, an older version), 2 an error.
 */
import { createSign } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const API = 'https://chromewebstore.googleapis.com'
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore'

/** -1, 0 or 1: dotted numeric versions, as Chrome compares them (missing parts are 0). */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number(n) || 0)
  const pb = String(b).split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

/** The store's published version, from fetchStatus. */
export function publishedVersion(status) {
  const ch = status?.publishedItemRevisionStatus?.distributionChannels ?? []
  return ch.map((c) => c.crxVersion).filter(Boolean).sort(compareVersions).pop() ?? null
}

/**
 * What to do with `version` given the store's fetchStatus answer:
 *   { act: 'publish' } | { act: 'skip', why } (nothing to do) | { act: 'refuse', why }.
 */
export function decide(status, version) {
  const pending = status?.submittedItemRevisionStatus?.state
  if (pending && pending !== 'PUBLISHED') return { act: 'skip', why: `a submitted version is still ${pending}` }
  const live = publishedVersion(status)
  if (live) {
    const c = compareVersions(version, live)
    if (c === 0) return { act: 'skip', why: `the store already has ${live}` }
    if (c < 0) return { act: 'refuse', why: `this Walnut's ${version} is older than the store's ${live}` }
  }
  return { act: 'publish' }
}

function b64url(buf) { return Buffer.from(buf).toString('base64url') }

/** An access token for the service account (OAuth 2.0 JWT bearer grant). */
export async function accessToken(key, fetchImpl = fetch, now = Date.now()) {
  const iat = Math.floor(now / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: key.token_uri, iat, exp: iat + 3600 }))
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.private_key)
  const res = await fetchImpl(key.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64url(sig)}` }),
  })
  const body = await res.json()
  if (!res.ok || !body.access_token) throw new Error(`token: ${res.status} ${body.error_description ?? body.error ?? ''}`)
  return body.access_token
}

async function call(fetchImpl, token, method, url, body) {
  const res = await fetchImpl(url, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/zip' } : {}) }, ...(body ? { body } : {}) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${method} ${url.replace(API, '')}: ${res.status} ${json?.error?.message ?? text.slice(0, 300)}`)
  return json ?? {}
}

async function main() {
  const argv = process.argv.slice(2)
  const dry = argv.includes('--dry-run')
  const ri = argv.indexOf('--rules')
  const rules = ri >= 0 ? argv[ri + 1] : join(homedir(), '.config/walnut-leak/leak-rules.json')
  const keyFile = process.env.WALNUT_CWS_KEY_FILE
  const publisher = process.env.WALNUT_CWS_PUBLISHER
  const item = process.env.WALNUT_CWS_ITEM
  if (!keyFile || !publisher || !item) throw new Error('set WALNUT_CWS_KEY_FILE, WALNUT_CWS_PUBLISHER and WALNUT_CWS_ITEM')
  if (!existsSync(rules)) throw new Error(`no leak rules at ${rules}: the zip is never uploaded unscanned`)
  const key = JSON.parse(readFileSync(keyFile, 'utf8'))
  const base = `${API}/v2/publishers/${encodeURIComponent(publisher)}/items/${encodeURIComponent(item)}`

  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const out = mkdtempSync(join(tmpdir(), 'walnut-ext-publish-'))
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts/extension-store-package.mjs'), '--out', out], { stdio: 'inherit' })
    const zipName = readdirSync(out).find((f) => /^walnut-extension-chrome-.+\.zip$/.test(f))
    if (!zipName) throw new Error('the store package holds no zip')
    const version = zipName.replace(/^walnut-extension-chrome-|\.zip$/g, '')

    const token = await accessToken(key)
    const status = await call(fetch, token, 'GET', `${base}:fetchStatus`)
    const next = decide(status, version)
    console.log(`extension-store-publish: ${version}; the store has ${publishedVersion(status) ?? 'nothing published'}: ${next.act}${next.why ? ` (${next.why})` : ''}`)
    if (next.act === 'skip') return 0
    if (next.act === 'refuse') return 1

    const scan = spawnSync(process.execPath, [join(ROOT, 'scripts/leak-scan/leak-scan.mjs'), '--rules', rules, '--redact', join(out, zipName)], { stdio: 'inherit' })
    if (scan.status !== 0) { console.error(`extension-store-publish: the leak scan of ${zipName} did not pass (exit ${scan.status}); nothing uploaded`); return 1 }
    if (dry) { console.log('extension-store-publish: --dry-run, so no upload and no submit'); return 0 }

    const up = await call(fetch, token, 'POST', `${API}/upload/v2/publishers/${encodeURIComponent(publisher)}/items/${encodeURIComponent(item)}:upload`, readFileSync(join(out, zipName)))
    let state = up.uploadState
    for (let i = 0; state === 'IN_PROGRESS' && i < 30; i++) {
      await new Promise((r) => setTimeout(r, 5000))
      state = (await call(fetch, token, 'GET', `${base}:fetchStatus`)).lastAsyncUploadState
    }
    if (state !== 'SUCCEEDED') throw new Error(`upload ended ${state}: ${JSON.stringify(up).slice(0, 400)}`)
    const pub = await call(fetch, token, 'POST', `${base}:publish`)
    console.log(`extension-store-publish: ${version} submitted for review (${pub.state ?? JSON.stringify(pub).slice(0, 200)})`)
    return 0
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code), (err) => { console.error(`extension-store-publish: ${err instanceof Error ? err.message : String(err)}`); process.exit(2) })
}
