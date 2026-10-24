// This machine's platform package (@open-walnut/<target>), fetched the way npm
// would have fetched it, for when npm left it out: a registry that did not
// serve it yet (npm treats a failed optional dependency as no error, so its
// install still succeeds). The registry's document for that version names
// the tarball and its sha512 integrity; the tarball is checked against it,
// unpacked beside the launcher (its own node_modules, where require finds it),
// and the file must print the version before it is put in place.
//
// Used by lib/postinstall.js (npm's install, which fails, and so keeps the
// version installed before, when this does) and by lib/launch.js (a start that
// finds no file, after an install that ran no scripts). Plain Node, no
// dependencies, and like launch.js CommonJS, ES2017 and Node 8 APIs only
// (http and https, not fetch).
'use strict'
const childProcess = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const url = require('url')
const zlib = require('zlib')

const SCOPE = '@open-walnut'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DIST_TAGS_SUFFIX = '/-/package/open-walnut/dist-tags'
// Idle limits: a connection that sends nothing this long is given up.
const DOC_TIMEOUT_MS = 30000
const DOWNLOAD_TIMEOUT_MS = 60000
const VERSION_TIMEOUT_MS = 60000

/**
 * The registry to fetch from: the one npm runs against (it hands its config to
 * install scripts as npm_config_*, and a person may set it), else the one the
 * update check reads, else npm's own.
 */
function registryFor(env) {
  if (env === undefined) env = process.env
  const npm = (env.npm_config_registry || '').trim()
  if (npm) return npm.replace(/\/+$/, '')
  const tags = (env.WALNUT_UPDATE_REGISTRY_URL || '').trim()
  if (tags && tags.slice(-DIST_TAGS_SUFFIX.length) === DIST_TAGS_SUFFIX) return tags.slice(0, -DIST_TAGS_SUFFIX.length)
  return DEFAULT_REGISTRY
}

/** GET `target`, following redirects: { status, body } (a Buffer). */
function get(target, opts) {
  const o = Object.assign({ timeoutMs: DOC_TIMEOUT_MS, accept: '*/*', redirects: 5 }, opts)
  return new Promise((resolve, reject) => {
    // The WHATWG URL (Node 7+): the legacy parser warns on new Node.
    const parsed = new url.URL(target)
    const mod = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null
    if (!mod) return reject(new Error(`cannot fetch ${target}`))
    const request = {
      protocol: parsed.protocol,
      hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      headers: { accept: o.accept, 'user-agent': 'open-walnut-launcher' },
    }
    const req = mod.get(request, (res) => {
      const status = res.statusCode
      if (status >= 300 && status < 400 && res.headers.location && o.redirects > 0) {
        res.resume()
        return resolve(get(new url.URL(res.headers.location, target).toString(), Object.assign({}, o, { redirects: o.redirects - 1 })))
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.setTimeout(o.timeoutMs, () => {
      reject(new Error(`${parsed.host} sent nothing for ${Math.round(o.timeoutMs / 1000)}s`))
      req.abort()
    })
    req.on('error', reject)
  })
}

/**
 * The regular files under `package/` in a tar (ustar, pax and GNU long names),
 * by their path inside the package. Anything that would land outside it is refused.
 */
function packageFiles(tar) {
  const out = new Map()
  let offset = 0
  let longName = null
  const cut = (s) => s.replace(/\0[\s\S]*$/, '')
  while (offset + 512 <= tar.length) {
    const header = tar.slice(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const field = (start, len) => cut(header.slice(start, start + len).toString('utf8'))
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1) || '0'
    const prefix = field(345, 155)
    const name = longName !== null ? longName : prefix ? `${prefix}/${field(0, 100)}` : field(0, 100)
    longName = null
    const body = tar.slice(offset + 512, offset + 512 + size)
    if (type === 'L') longName = cut(body.toString('utf8'))
    else if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))
      if (m) longName = m[1]
    } else if (type === '0' && name.indexOf('package/') === 0) {
      const rel = path.posix.normalize(name.slice('package/'.length))
      if (!rel || rel === '.' || rel.indexOf('..') === 0 || path.posix.isAbsolute(rel)) throw new Error(`the package holds an entry outside itself (${name})`)
      out.set(rel, Buffer.from(body))
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

function mkdirp(dir) {
  if (fs.existsSync(dir)) return
  mkdirp(path.dirname(dir))
  try { fs.mkdirSync(dir) } catch (err) { if (err.code !== 'EEXIST') throw err }
}

function rmrf(p) {
  let st
  try { st = fs.lstatSync(p) } catch (err) { return }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) rmrf(path.join(p, e))
    fs.rmdirSync(p)
  } else {
    fs.unlinkSync(p)
  }
}

/** `<file> --version`, as a person runs it (never as bun). */
function versionOf(file) {
  const env = Object.assign({}, process.env)
  delete env.BUN_BE_BUN
  return childProcess.execFileSync(file, ['--version'], { env, encoding: 'utf8', timeout: VERSION_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * Fetch `@open-walnut/<target>@<version>` from `registry` into
 * `<packageRoot>/node_modules/@open-walnut/<target>`. Resolves to the file;
 * throws with a one-line reason, leaving nothing behind.
 */
async function fetchPlatformPackage(args) {
  const packageRoot = args.packageRoot
  const target = args.target
  const version = args.version
  const registry = args.registry || registryFor()
  const log = args.log || (() => {})
  const name = `${SCOPE}/${target}`
  const res = await get(`${registry}/${SCOPE}%2f${target}/${encodeURIComponent(version)}`, { accept: 'application/json' })
  if (res.status === 404) throw new Error(`${name}@${version} is not on ${registry}`)
  if (res.status < 200 || res.status >= 300) throw new Error(`${registry} answered HTTP ${res.status} for ${name}@${version}`)
  let doc = null
  try { doc = JSON.parse(res.body.toString('utf8')) } catch (err) { /* reported below */ }
  const dist = doc && doc.dist ? doc.dist : {}
  const tarball = dist.tarball
  const integrity = String(dist.integrity || '').split(/\s+/).filter((s) => /^sha512-[A-Za-z0-9+/=]+$/.test(s))[0]
  if (typeof tarball !== 'string' || !tarball) throw new Error(`${registry} names no tarball for ${name}@${version}`)
  if (!integrity) throw new Error(`${registry} gives no sha512 for ${name}@${version}`)
  log(`downloading ${name}@${version} from ${registry}...`)
  const got = await get(tarball, { timeoutMs: DOWNLOAD_TIMEOUT_MS })
  if (got.status < 200 || got.status >= 300) throw new Error(`GET ${tarball} answered HTTP ${got.status}`)
  if (`sha512-${crypto.createHash('sha512').update(got.body).digest('base64')}` !== integrity) {
    throw new Error(`the download of ${name}@${version} does not match its integrity (a broken or tampered download)`)
  }
  const files = packageFiles(zlib.gunzipSync(got.body))
  if (!files.has('walnut')) throw new Error(`${name}@${version} holds no walnut file`)
  const scope = path.join(packageRoot, 'node_modules', SCOPE)
  mkdirp(scope)
  const stage = fs.mkdtempSync(path.join(scope, `.${target}-`))
  try {
    for (const entry of files) {
      const rel = entry[0]
      const dest = path.join.apply(path, [stage].concat(rel.split('/')))
      mkdirp(path.dirname(dest))
      fs.writeFileSync(dest, entry[1], { mode: rel === 'walnut' ? 0o755 : 0o644 })
    }
    let printed
    try {
      printed = versionOf(path.join(stage, 'walnut'))
    } catch (err) {
      const said = String((err && err.stderr) || '').trim() || (err instanceof Error ? err.message : String(err))
      throw new Error(`the downloaded ${name} does not run here (${said.split('\n')[0].slice(0, 200)})`)
    }
    if (printed.split(/\s/)[0] !== version) throw new Error(`the downloaded ${name} does not run here (it printed: ${printed.slice(0, 200) || 'nothing'})`)
    const final = path.join(scope, target)
    // A directory without the file (a package manager's leftover) is replaced.
    if (fs.existsSync(final) && !fs.existsSync(path.join(final, 'walnut'))) rmrf(final)
    try {
      fs.renameSync(stage, final)
    } catch (err) {
      // Another start put it there first: theirs is as good as this one.
      if (!fs.existsSync(path.join(final, 'walnut'))) throw err
    }
    return path.join(final, 'walnut')
  } finally {
    rmrf(stage)
  }
}

module.exports = { SCOPE, DEFAULT_REGISTRY, registryFor, get, packageFiles, fetchPlatformPackage }
