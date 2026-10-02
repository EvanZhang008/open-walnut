/**
 * A local npm registry for release rehearsals: it serves chosen open-walnut
 * tarballs under chosen dist-tags and passes every other request through to the
 * real registry, so `npm install open-walnut` and the updater's dist-tags check
 * behave exactly as they do against npm, but nothing is ever published.
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'

export const PACKAGE = 'open-walnut'
export const UPSTREAM = 'https://registry.npmjs.org'

/** package.json inside a packed tarball (npm packs everything under `package/`). */
export function readPackedManifest(file) {
  return JSON.parse(execFileSync('tar', ['-xzOf', file, 'package/package.json'], { encoding: 'utf8' }))
}

/** The `dist` block npm checks a download against. */
export function distOf(file, url) {
  const bytes = fs.readFileSync(file)
  return {
    tarball: url,
    shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
    integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
  }
}

/**
 * The registry document for open-walnut: one version per tarball, the given
 * dist-tags (each must name a served version), and publish times in order.
 */
export function buildPackument({ tarballs, distTags, baseUrl, now = new Date() }) {
  const versions = {}
  const time = {}
  tarballs.forEach(({ file }, i) => {
    const manifest = readPackedManifest(file)
    if (manifest.name !== PACKAGE) throw new Error(`${file} is ${manifest.name}, not ${PACKAGE}`)
    const v = manifest.version
    versions[v] = { ...manifest, _id: `${PACKAGE}@${v}`, dist: distOf(file, `${baseUrl}/${PACKAGE}/-/${PACKAGE}-${v}.tgz`) }
    time[v] = new Date(now.getTime() - (tarballs.length - i) * 60_000).toISOString()
  })
  for (const [tag, v] of Object.entries(distTags)) {
    if (!versions[v]) throw new Error(`dist-tag ${tag} names ${v}, which is not served`)
  }
  return { name: PACKAGE, 'dist-tags': { ...distTags }, versions, time }
}

// Hop-by-hop and body-encoding headers must not be copied from a decoded fetch body.
const DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'])

async function passThrough(req, res, upstream) {
  try {
    const headers = {}
    for (const h of ['accept', 'npm-command', 'user-agent']) if (req.headers[h]) headers[h] = req.headers[h]
    const up = await fetch(`${upstream}${req.url}`, { headers, redirect: 'follow', signal: AbortSignal.timeout(120_000) })
    const body = Buffer.from(await up.arrayBuffer())
    const out = {}
    up.headers.forEach((v, k) => { if (!DROP.has(k)) out[k] = v })
    res.writeHead(up.status, { ...out, 'content-length': body.length })
    res.end(body)
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`upstream failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Start the registry on a free loopback port. `tarballs` is [{ file }] (each a
 * packed open-walnut), `distTags` maps tag -> version. Returns its URL, the hits
 * it answered itself (so a test can prove the updater asked it), and close().
 */
export async function startRegistry({ tarballs, distTags, upstream = UPSTREAM }) {
  const files = new Map()
  for (const { file } of tarballs) files.set(`${PACKAGE}-${readPackedManifest(file).version}.tgz`, file)
  const hits = []
  let packument = null
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname
    if (pathname === `/${PACKAGE}`) {
      hits.push(pathname)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(packument))
    }
    if (pathname === `/-/package/${PACKAGE}/dist-tags`) {
      hits.push(pathname)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(packument['dist-tags']))
    }
    const tgz = pathname.startsWith(`/${PACKAGE}/-/`) ? files.get(pathname.slice(`/${PACKAGE}/-/`.length)) : null
    if (tgz) {
      hits.push(pathname)
      const bytes = fs.readFileSync(tgz)
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
      return res.end(bytes)
    }
    if (pathname.startsWith(`/${PACKAGE}/`)) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end('{"error":"not found"}')
    }
    void passThrough(req, res, upstream)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  packument = buildPackument({ tarballs, distTags, baseUrl: url })
  return {
    url,
    hits,
    distTagsUrl: `${url}/-/package/${PACKAGE}/dist-tags`,
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}
