// This machine's platform package (@open-walnut/<target>), fetched for when npm
// left it out: npm treats a failed optional dependency as no error, so an
// install still succeeds when the registry did not serve the package yet, or
// served an index of the package that did not name the version yet.
//
// npm fetches it when there is an npm to ask (the one running this install
// script, else the one beside this package, else the one on PATH): `npm pack
// <name>@<version>` uses every setting npm has (~/.npmrc, a scoped registry, a
// proxy, a CA, a login) and checks the download against the registry's
// integrity. When that fails, or there is no npm, the registry's document for
// that version is read directly: from the registry npm is set to use for the
// scope (npm 7 and later hand an install script only the settings given on the
// command line or in the environment, so this asks npm), else
// npm_config_registry, else the one the update check reads, else npm's own;
// the tarball is checked against its sha512. Either way the file must print
// the version before it is put beside the launcher (its own node_modules, where
// the launcher looks), readable by every user (an install as root).
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
const os = require('os')
const path = require('path')
const url = require('url')
const zlib = require('zlib')

const SCOPE = '@open-walnut'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DIST_TAGS_SUFFIX = '/-/package/open-walnut/dist-tags'
// Idle limits: a connection that sends nothing this long (connecting included) is given up.
const DOC_TIMEOUT_MS = 30000
const DOWNLOAD_TIMEOUT_MS = 60000
const VERSION_TIMEOUT_MS = 60000
const NPM_CONFIG_TIMEOUT_MS = 30000
const NPM_PACK_TIMEOUT_MS = 5 * 60000

/**
 * The registry to read when npm cannot say: npm_config_registry (given on
 * npm's command line or in the environment), else the one the update check
 * reads, else npm's own.
 */
function registryFor(env) {
  if (env === undefined) env = process.env
  const npm = (env.npm_config_registry || '').trim()
  if (npm) return npm.replace(/\/+$/, '')
  const tags = (env.WALNUT_UPDATE_REGISTRY_URL || '').trim()
  if (tags && tags.slice(-DIST_TAGS_SUFFIX.length) === DIST_TAGS_SUFFIX) return tags.slice(0, -DIST_TAGS_SUFFIX.length)
  return DEFAULT_REGISTRY
}

const isFile = (p) => { try { return fs.statSync(p).isFile() } catch (err) { return false } }

/**
 * The npm to ask, as [file, ...args], or null: the npm running this install
 * script (npm_execpath), the npm in the same node_modules as this package (an
 * npm global prefix, the archive's runtime), else `npm` on PATH.
 */
function npmCommand(packageRoot, env) {
  if (env === undefined) env = process.env
  const execpath = env.npm_execpath || ''
  if (/npm-cli\.js$/.test(execpath) && isFile(execpath)) return [process.execPath, execpath]
  const sibling = path.join(path.dirname(packageRoot), 'npm', 'bin', 'npm-cli.js')
  if (isFile(sibling)) return [process.execPath, sibling]
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (dir && isFile(path.join(dir, 'npm'))) return [path.join(dir, 'npm')]
  }
  return null
}

/** Run npm with `args`; resolves { code, out, err }. */
function runNpm(npm, args, opts) {
  return new Promise((resolve) => {
    childProcess.execFile(npm[0], npm.slice(1).concat(args), {
      cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err: String(stderr || '') })
    })
  })
}

/** The last line npm printed about a failure, for a one-line reason. */
function npmReason(r) {
  const lines = `${r.err}\n${r.out}`.split('\n').map((l) => l.trim()).filter((l) => l && !/^npm (error|ERR!) (A complete log|code)/.test(l))
  return (lines.filter((l) => /^npm (error|ERR!)/.test(l)).pop() || lines.pop() || `exit ${r.code}`).slice(0, 300)
}

/** The registry npm is set to use for @open-walnut packages, or null. */
async function npmRegistry(npm, env) {
  for (const key of [`${SCOPE}:registry`, 'registry']) {
    const r = await runNpm(npm, ['config', 'get', key], { env, timeoutMs: NPM_CONFIG_TIMEOUT_MS })
    const value = r.code === 0 ? r.out.trim().split('\n').pop().trim() : ''
    if (/^https?:\/\//.test(value)) return value.replace(/\/+$/, '')
  }
  return null
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
      // From before the connection: a request's own setTimeout starts only once it connects (Node 12).
      timeout: o.timeoutMs,
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
    req.on('timeout', () => {
      reject(new Error(`${parsed.host} sent nothing for ${Math.round(o.timeoutMs / 1000)}s`))
      req.abort()
    })
    req.on('error', reject)
  })
}

/**
 * The regular files under `package/` in a tar (ustar, pax and GNU long names),
 * by their path inside the package: { data, mode }, the mode as npm installs it
 * (executable when the entry is). Anything that would land outside is refused.
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
    const entryMode = parseInt(field(100, 8).trim() || '644', 8)
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
      out.set(rel, { data: Buffer.from(body), mode: (entryMode & 0o111) ? 0o755 : 0o644 })
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

/** mkdir -p, every new directory 0755 whatever the umask (an install as root is read by every user). */
function mkdirp(dir) {
  if (fs.existsSync(dir)) return
  mkdirp(path.dirname(dir))
  try { fs.mkdirSync(dir) } catch (err) { if (err.code !== 'EEXIST') throw err }
  fs.chmodSync(dir, 0o755)
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

const sha512Of = (bytes) => `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`

/**
 * The tarball through `npm pack`, with npm's own settings; npm checks it against
 * the registry's integrity, and so does this, by what `npm view` says (when it
 * answers). Throws npm's reason.
 */
async function packWithNpm(npm, spec, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-walnut-pack-'))
  let bytes
  try {
    // npm 6 has no --pack-destination: it packs into the directory it runs in.
    const r = await runNpm(npm, ['pack', spec], { cwd: dir, env, timeoutMs: NPM_PACK_TIMEOUT_MS })
    const tgz = fs.readdirSync(dir).filter((f) => /\.tgz$/.test(f))[0]
    if (r.code !== 0 || !tgz) throw new Error(`npm pack ${spec}: ${npmReason(r)}`)
    bytes = fs.readFileSync(path.join(dir, tgz))
  } finally {
    rmrf(dir)
  }
  const view = await runNpm(npm, ['view', spec, 'dist.integrity'], { env, timeoutMs: NPM_CONFIG_TIMEOUT_MS })
  const integrity = view.code === 0 ? view.out.split(/\s+/).filter((t) => /^sha512-[A-Za-z0-9+/=]+$/.test(t))[0] : null
  if (integrity && integrity !== sha512Of(bytes)) throw new Error(`the download of ${spec} does not match its integrity (a broken or tampered download)`)
  return bytes
}

/** The tarball from the registry's document for that version, checked against its sha512. */
async function packFromRegistry(name, version, registry, log) {
  const res = await get(`${registry}/${SCOPE}%2f${name.slice(SCOPE.length + 1)}/${encodeURIComponent(version)}`, { accept: 'application/json' })
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
  if (sha512Of(got.body) !== integrity) {
    throw new Error(`the download of ${name}@${version} does not match its integrity (a broken or tampered download)`)
  }
  return got.body
}

/**
 * Fetch `@open-walnut/<target>@<version>` into
 * `<packageRoot>/node_modules/@open-walnut/<target>`. Resolves to the file;
 * throws with a one-line reason, leaving nothing behind. `registry` skips npm
 * and reads that registry; `npm` names the npm to ask (null: none).
 */
async function fetchPlatformPackage(args) {
  const packageRoot = args.packageRoot
  const target = args.target
  const version = args.version
  const env = args.env || process.env
  const log = args.log || (() => {})
  const name = `${SCOPE}/${target}`
  const npm = args.registry ? null : args.npm !== undefined ? args.npm : npmCommand(packageRoot, env)
  let tgz = null
  const tried = []
  if (npm) {
    log(`asking npm for ${name}@${version}...`)
    try {
      tgz = await packWithNpm(npm, `${name}@${version}`, env)
    } catch (err) {
      tried.push(err.message)
    }
  }
  if (!tgz) {
    const registry = args.registry || (npm && await npmRegistry(npm, env)) || registryFor(env)
    try {
      tgz = await packFromRegistry(name, version, registry, log)
    } catch (err) {
      tried.push(err.message)
      throw new Error(tried.join('; '))
    }
  }
  const files = packageFiles(zlib.gunzipSync(tgz))
  if (!files.has('walnut')) throw new Error(`${name}@${version} holds no walnut file`)
  const scope = path.join(packageRoot, 'node_modules', SCOPE)
  mkdirp(scope)
  const stage = fs.mkdtempSync(path.join(scope, `.${target}-`))
  try {
    for (const entry of files) {
      const dest = path.join.apply(path, [stage].concat(entry[0].split('/')))
      mkdirp(path.dirname(dest))
      fs.writeFileSync(dest, entry[1].data)
      fs.chmodSync(dest, entry[0] === 'walnut' ? 0o755 : entry[1].mode)
    }
    let printed
    try {
      printed = versionOf(path.join(stage, 'walnut'))
    } catch (err) {
      const said = String((err && err.stderr) || '').trim() || (err instanceof Error ? err.message : String(err))
      throw new Error(`the downloaded ${name} does not run here (${said.split('\n')[0].slice(0, 200)})`)
    }
    if (printed.split(/\s/)[0] !== version) throw new Error(`the downloaded ${name} does not run here (it printed: ${printed.slice(0, 200) || 'nothing'})`)
    // mkdtemp makes it 0700: under a root install no other user could read it.
    fs.chmodSync(stage, 0o755)
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

module.exports = { SCOPE, DEFAULT_REGISTRY, registryFor, npmCommand, npmRegistry, get, packageFiles, fetchPlatformPackage }
