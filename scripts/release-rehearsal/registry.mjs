/**
 * A local npm registry for release rehearsals: it serves chosen tarballs (the
 * open-walnut launcher and its @open-walnut/<target> platform packages, or any
 * open-walnut build) under chosen dist-tags and passes every other request
 * through to the real registry, so `npm install open-walnut`, the updater's
 * dist-tags check and the compiled file's own download (binary-install.ts)
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

/** The tarball file name npm gives a package: its name without the scope. */
const tarballName = (name, version) => `${name.split('/').pop()}-${version}.tgz`

/**
 * The registry document for one package (open-walnut unless `name` says
 * otherwise): one version per tarball of that name, the given dist-tags (each
 * must name a served version), and publish times in order. `published` adds
 * versions of open-walnut as the real registry has them (their documents, whose
 * tarballs stay on that registry), older than every tarball here: the release
 * an install runs today, which a dist-tag may name before the update arrives.
 */
export function buildPackument({ tarballs, distTags, baseUrl, now = new Date(), name = PACKAGE, published = {} }) {
  const versions = {}
  const time = {}
  if (name === PACKAGE) {
    Object.values(published).forEach((doc, i, all) => {
      versions[doc.version] = doc
      time[doc.version] = new Date(now.getTime() - (all.length - i + tarballs.length + 1) * 60_000).toISOString()
    })
  }
  const mine = tarballs.map(({ file }) => ({ file, manifest: readPackedManifest(file) }))
  if (name === PACKAGE) {
    for (const { file, manifest } of mine) if (manifest.name !== PACKAGE && !manifest.name.startsWith('@')) throw new Error(`${file} is ${manifest.name}, not ${PACKAGE}`)
  }
  const own = mine.filter(({ manifest }) => manifest.name === name)
  own.forEach(({ file, manifest }, i) => {
    const v = manifest.version
    versions[v] = { ...manifest, _id: `${name}@${v}`, dist: distOf(file, `${baseUrl}/${name}/-/${tarballName(name, v)}`) }
    time[v] = new Date(now.getTime() - (own.length - i) * 60_000).toISOString()
  })
  for (const [tag, v] of Object.entries(distTags)) {
    if (!versions[v]) throw new Error(`dist-tag ${tag} names ${v}, which is not served`)
  }
  return { name, 'dist-tags': { ...distTags }, versions, time }
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
 * Start the registry on a free loopback port. `tarballs` is [{ file }] (packed
 * packages: open-walnut, and any other names, such as its platform packages),
 * `distTags` maps tag -> version for open-walnut; every other package's
 * `latest` is its last tarball. `published` (version -> the real registry's
 * document, publishedVersion) adds released versions of open-walnut. Returns
 * its URL, the hits it answered itself (so a test can prove the updater asked
 * it), and close().
 */
export async function startRegistry({ tarballs, distTags, upstream = UPSTREAM, published = {} }) {
  const names = [...new Set(tarballs.map(({ file }) => readPackedManifest(file).name))]
  if (!names.includes(PACKAGE)) names.push(PACKAGE)
  const files = new Map()
  for (const { file } of tarballs) {
    const m = readPackedManifest(file)
    files.set(`${m.name}/-/${tarballName(m.name, m.version)}`, file)
  }
  const hits = []
  // Packages answered 404 for now: a release still reaching the registry, package by package.
  let withheld = new Set()
  let packuments = null
  const build = (url, tags) => {
    const out = {}
    for (const name of names) {
      const own = tarballs.filter(({ file }) => readPackedManifest(file).name === name)
      const last = own.length ? readPackedManifest(own[own.length - 1].file).version : null
      out[name] = buildPackument({ tarballs, distTags: name === PACKAGE ? tags : (last ? { latest: last } : {}), baseUrl: url, name, published })
    }
    return out
  }
  const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const server = http.createServer((req, res) => {
    // npm asks for a scoped package as /@scope%2fname.
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const tagsOf = /^\/-\/package\/(.+)\/dist-tags$/.exec(pathname)
    if (tagsOf && packuments[tagsOf[1]]) {
      hits.push(pathname)
      return json(res, packuments[tagsOf[1]]['dist-tags'])
    }
    const name = names.find((n) => pathname === `/${n}` || pathname.startsWith(`/${n}/`))
    if (!name) return void passThrough(req, res, upstream)
    if (withheld.has(name)) { hits.push(`withheld ${pathname}`); return json(res, { error: 'not found' }, 404) }
    const rest = pathname.slice(name.length + 1)
    if (rest === '') { hits.push(pathname); return json(res, packuments[name]) }
    const tgz = files.get(`${name}${rest}`)
    if (tgz) {
      hits.push(pathname)
      const bytes = fs.readFileSync(tgz)
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
      return res.end(bytes)
    }
    // One version's document: /<name>/<version> (what the compiled file's update reads).
    const doc = packuments[name].versions[rest.slice(1)]
    if (doc) { hits.push(pathname); return json(res, doc) }
    return json(res, { error: 'not found' }, 404)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  packuments = build(url, distTags)
  return {
    url,
    hits,
    distTagsUrl: `${url}/-/package/${PACKAGE}/dist-tags`,
    /** Move open-walnut's dist-tags (a release published while an install runs). */
    setDistTags: (tags) => { packuments = build(url, tags) },
    /** Answer 404 for these packages until called again (a publish npm has not made visible yet). */
    setWithheld: (list) => { withheld = new Set(list) },
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}

/** One released version's document from the real registry, as `published` takes it. */
export async function publishedVersion(version, { upstream = UPSTREAM, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${upstream}/${PACKAGE}/${encodeURIComponent(version)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`the registry answered HTTP ${res.status} for ${PACKAGE}@${version}`)
  const doc = await res.json()
  if (doc?.version !== version || !doc?.dist?.tarball) throw new Error(`the registry's ${PACKAGE}@${version} has no tarball`)
  return doc
}
