/**
 * The capability manifests (src/core/capabilities/) are the whole surface of each
 * capability, and these checks hold them to the code (2026-11-14, the user: an
 * internal capability platform that is easy to add to, "but please still keep the
 * security to the best"):
 *
 * - the registry is closed: every manifest file is registered, nothing else is;
 * - the wire names older phones and browsers read are never renamed, and a companion
 *   that sets nothing gets exactly the four it always ran (a new one is off by default);
 * - every job a manifest turns on is a boot row, owned by one capability only;
 * - every way in (socket door, HTTP route outside the /api token check) is declared once,
 *   says who may come in, and its credential check is in the code of the file it names;
 * - the upgrade handler opens no path a manifest does not declare, a door is shut on every
 *   server that lacks its capability, and every HTTP path a capability job mounts or the
 *   auth middleware exempts is declared;
 * - every file that asks for a capability is listed in its manifest.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BOOT_POLICY } from '../../src/core/boot-policy.js'
import {
  CAPABILITIES, MANIFESTS, capabilityOfJob, defaultCapabilities, openSocketDoor, type Capability,
} from '../../src/core/capabilities.js'
import { DAEMON_TUNNEL_PATH } from '../../src/core/hosts/cloud-box-host.js'
import { BRIDGE_SESSION_STREAM_PATH } from '../../src/web/ws/bridge-session-stream.js'
import { listTsFiles } from '../helpers/cloud-mode-scan.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const FOLDER = 'src/core/capabilities'

/** The names phones (ServerFacts.swift) and browsers (web/src/api/config.ts) already read. */
const WIRE_NAMES = ['public-door', 'bridge-door', 'cloud-exec', 'backup-leader']

/**
 * Paths the /api auth middleware lets in without a device token on the companion that are
 * no capability's: they are mounted on every server.
 */
const EXEMPT_NOT_A_CAPABILITY: Record<string, string> = {
  '/api/v1/setup/': 'the first-boot claim, before any token exists (routes/setup.ts), mounted on every server',
  '/api/system/health': 'the health check, mounted on every server',
  '/api/v1/instance': 'which box this is ({ instance, mode }), so a client checks an address before it sends a token; every server',
  '/api/v1/browser-pair': 'a browser trades a one-time sign-in code for its token, on the primary only (never a replica)',
  '/api/auth/browser/refresh': 'a browser renews its sign-in with its refresh cookie, on the primary only',
}

/**
 * Everything server.ts mounts outside /api that is no capability's, by the mount's first
 * argument (a path, or the middleware itself when it takes none), with why.
 */
const MOUNTED_NOT_A_CAPABILITY: Record<string, string> = {
  "'/plugin-apps'": "the Mac's plugin apps (the leader-only plugin-apps row)",
  'options.beforeRoutes': 'a test hook given to startServer',
  replicaPublicRefusal: "a host replica's refusal of the public routes",
  '(req, res, next) => front.middleware(req, res, next)': "a host replica's front, which forwards to the Mac",
  'cors({ origin: corsOriginAllowed })': 'CORS for every route',
  "(await import('./middleware/op-id.js')).stampArrival()": 'stamps the arrival time of each request',
  'compression({ threshold: 1024 })': 'gzip of responses',
  "express.json({ limit: '15mb' })": 'the JSON body parser',
  "(await import('../core/companion-forward.js')).companionUnkeptKindReads": "the companion's reads of a copy it does not keep, forwarded to the Mac",
  'staticFrom(staticDir)': 'the web app bundle',
  'staticFrom(root)': 'the mirrored older bundles',
  fileRawRefererRedirect: 'a redirect for files a page links to',
  '(req, res, next) => {': 'the web app fallback: index.html for a GET outside /api',
  errorHandler: 'the error handler',
}

/** Every listener that takes WebSocket upgrades, by file, with why. */
const UPGRADE_LISTENERS: Record<string, string> = {
  'src/web/ws/handler.ts': 'the one door handler of the Walnut server',
  'src/web/expose-runtime.ts': "the tunnel port: hands every upgrade to the main server's handler",
  'src/web/v1-forward/stream-door.ts': 'refuses every upgrade the companion forwards',
  'src/host-server/main.ts': "the host server's own loopback port (not the Walnut server)",
  'src/host-server/proxy.ts': 'the answer to an upgrade it sent on (a client event)',
  'src/providers/daemon-source.ts': "the daemon's own socket server and its client",
  'src/commands/demo-server.ts': 'the local demo server',
}

/** Code lines only: a comment that names a call is not a use. */
function codeLines(text: string): string[] {
  return text.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
}
const code = (rel: string) => codeLines(read(rel)).join('\n')

/** `<file>` for every literal capability ask in the given files, by capability name. */
export function capabilityReads(files: ReadonlyArray<{ file: string; text: string }>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const ASK = /(?<![.\w])(?:hasCapability|useServerCapability|hasServerCapability)\(\s*['"`]([a-z0-9][a-z0-9-]*)['"`]/g
  for (const { file, text } of files) {
    if (!text.includes('Capability(')) continue
    for (const line of codeLines(text)) {
      for (const m of line.matchAll(ASK)) {
        if (!out.has(m[1]!)) out.set(m[1]!, new Set())
        out.get(m[1]!)!.add(file)
      }
    }
  }
  return out
}

/** The text of the block `if (<head>) { ... }` starting at `at`, braces balanced. */
function blockAt(text: string, at: number): string {
  const open = text.indexOf('{', at)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1)
  }
  return text.slice(open)
}

/** `export const NAME = '<path>'` anywhere in src/ (read once), for a mount that names its path by constant. */
let constants: Map<string, string> | null = null
function constantPath(name: string): string | undefined {
  if (!constants) {
    constants = new Map()
    for (const f of listTsFiles(ROOT, 'src')) {
      for (const m of read(f).matchAll(/export const ([A-Z_][A-Z0-9_]*) = '([^']+)'/g)) constants.set(m[1]!, m[2]!)
    }
  }
  return constants.get(name)
}

/** The first argument of each `app.<verb>(` call, read with brackets and strings balanced. */
function mountArgs(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\bapp\.(?:use|get|post|put|patch|delete|all)\(/g)) {
    let i = m.index! + m[0].length
    let depth = 0
    let quote = ''
    let arg = ''
    for (; i < text.length; i++) {
      const c = text[i]!
      if (quote) { arg += c; if (c === quote && text[i - 1] !== '\\') quote = ''; continue }
      if (c === "'" || c === '"' || c === '`') { quote = c; arg += c; continue }
      if ('([{'.includes(c)) depth++
      if (')]}'.includes(c)) { if (depth === 0) break; depth-- }
      if (c === ',' && depth === 0) break
      if (c === '{' && depth === 1 && /=>\s*\{$/.test(arg + c)) { arg += c; break }
      arg += c
    }
    out.push(arg.replace(/\s+/g, ' ').trim())
  }
  return out
}

/** The paths a mount argument names: a literal, an array of literals, or a constant. */
function argPaths(arg: string): string[] | null {
  if (/^'[^']*'$/.test(arg)) return [arg.slice(1, -1)]
  if (/^\[('[^']*'(, )?)+\]$/.test(arg)) return [...arg.matchAll(/'([^']*)'/g)].map((m) => m[1]!)
  if (/^[A-Z_][A-Z0-9_]*$/.test(arg)) return [constantPath(arg) ?? `unresolved ${arg}`]
  return null
}

/** Routers mounted with no path: where their own paths are declared. */
const ROUTER_FILES: Record<string, { file: string; router: string }> = {
  'net.netJoinPageRouter': { file: 'src/web/routes/net-v1.ts', router: 'netJoinPageRouter' },
}

describe('capability manifests', () => {
  it('the registry lists exactly the manifest files in its folder', () => {
    const files = fs.readdirSync(path.join(ROOT, FOLDER)).filter((f) => f.endsWith('.ts') && f !== 'manifest.ts').sort()
    expect(files).toEqual(MANIFESTS.map((m) => `${m.name}.ts`).sort())
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length)
    for (const m of MANIFESTS) {
      expect(m.name, m.name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
      expect(m.summary.length, m.name).toBeGreaterThan(20)
    }
  })

  it('never renames a name an older phone or browser reads, and a new one is off by default', () => {
    for (const name of WIRE_NAMES) expect(CAPABILITIES, name).toContain(name)
    // A companion that sets nothing runs what it always ran: an update never opens a new door.
    expect([...defaultCapabilities('cloud')].sort()).toEqual([...WIRE_NAMES].sort())
    expect(MANIFESTS.filter((m) => m.companionDefault).map((m) => m.name).sort()).toEqual([...WIRE_NAMES].sort())
    expect(defaultCapabilities('mac').size + defaultCapabilities('host').size).toBe(0)
  })

  it('the web knows every capability, and an older companion still reads as the four it had', () => {
    const config = read('web/src/api/config.ts')
    const union = /export type ServerCapability = ([^;]+);/.exec(config)?.[1] ?? ''
    expect([...union.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]).sort()).toEqual([...CAPABILITIES].sort())
    const older = /const COMPANION_CAPABILITIES[^=]*=\s*\[([^\]]+)\]/.exec(config)?.[1] ?? ''
    expect([...older.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1])).toEqual(WIRE_NAMES)
  })

  it('every job a manifest turns on is a boot row, owned by one capability', () => {
    const jobs = new Set(BOOT_POLICY.map((r) => r.job))
    const owners = new Map<string, string[]>()
    for (const m of MANIFESTS) {
      for (const job of m.jobs) {
        expect(jobs.has(job), `${m.name}: ${job}`).toBe(true)
        owners.set(job, [...(owners.get(job) ?? []), m.name])
      }
      // In the table's order, so the manifest reads as the boot policy line does.
      const order = BOOT_POLICY.map((r) => r.job).filter((j) => (m.jobs as readonly string[]).includes(j))
      expect([...m.jobs], m.name).toEqual(order)
    }
    for (const [job, names] of owners) expect(names, job).toHaveLength(1)
    for (const r of BOOT_POLICY) if (capabilityOfJob(r.job)) expect(r.replica, r.job).toBe(false)
  })

  it('every way in is declared once, says who may come in, and its check is in the code of the file it names', () => {
    const all = MANIFESTS.flatMap((m) => [...m.doors, ...m.routes].map((e) => ({ m: m.name, e })))
    const paths = all.map(({ e }) => e.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const { m, e } of all) {
      expect(e.path, m).toMatch(/^\/[a-z0-9_/:-]+$/)
      expect(e.opensWith.length, e.path).toBeGreaterThan(30)
      expect(code(e.verifiedIn), `${e.path}: "${e.check}" in the code of ${e.verifiedIn}`).toContain(e.check)
      expect(e.check.length, e.path).toBeGreaterThan(12)
    }
  })

  it('the upgrade handler opens only /ws and the doors the manifests declare, each behind its credential check', () => {
    // The upgrade path: ownUpgrade, every upgrade the server takes (the listener above it only lets
    // an interceptor, the host replica's front, take one first).
    const file = code('src/web/ws/handler.ts')
    const at = file.indexOf('function ownUpgrade(')
    expect(at, 'ownUpgrade').toBeGreaterThan(0)
    const handler = blockAt(file, at)
    // The path is read in exactly two places: the door lookup and the /ws test, under no other name.
    expect(handler.match(/url\.pathname/g)?.length).toBe(2)
    expect(handler.match(/\bpathname\b/g)?.length).toBe(2)
    expect(handler).toContain("const door = openSocketDoor(url.pathname)?.path ?? null")
    expect(handler).toContain("if (url.pathname !== '/ws') {")
    expect(handler.match(/\bdoor\s*=(?!=)/g)?.length, 'door is assigned once').toBe(1)
    // No other source of the path (the URL is built from request.url once).
    expect(handler.match(/request\??\.url\b/g)?.length).toBe(1)
    // Door branches: each names a declared door, every declared door has its branch, and
    // each branch checks a credential before it hands the socket on.
    const consts: Record<string, string> = { DAEMON_TUNNEL_PATH, BRIDGE_SESSION_STREAM_PATH }
    const branches = [...handler.matchAll(/if \(door === [^{]+\{/g)]
    const named = new Set<string>()
    for (const b of branches) {
      for (const t of b[0].matchAll(/door === ('([^']+)'|[A-Z_]+)/g)) named.add(t[2] ?? consts[t[1]!] ?? `unknown ${t[1]}`)
      const block = blockAt(handler, b.index!)
      expect(block, b[0]).toContain('verifyCloudUpgrade(url, request)')
      // A socket is handed on only after a credential call earlier in the branch, or to a
      // module that is given the check to run first.
      const firstCheck = block.search(/verifyCloudUpgrade\(|authenticateFeatureNode\(/)
      for (const h of block.matchAll(/(?:wss!?\.handleUpgrade|upgradeFeatureNode)\(/g)) expect(h.index!, `${b[0]}: ${h[0]} before any check`).toBeGreaterThan(firstCheck)
      for (const h of block.matchAll(/handle\w+Upgrade\(request, socket, head, \{([^}]*)\}/g)) expect(h[1], h[0]).toContain('verify: () => verifyCloudUpgrade(url, request)')
    }
    expect(named).toEqual(new Set(MANIFESTS.flatMap((m) => m.doors.map((d) => d.path))))
  })

  it('a door is shut on every server that lacks its capability, and an unknown path is never a door', () => {
    for (const m of MANIFESTS) {
      for (const d of m.doors) {
        const without = new Set(CAPABILITIES.filter((c) => c !== m.name)) as ReadonlySet<Capability>
        expect(openSocketDoor(d.path, without), d.path).toBeNull()
        expect(openSocketDoor(d.path, new Set([m.name]) as ReadonlySet<Capability>)?.path, d.path).toBe(d.path)
      }
    }
    const all = new Set(CAPABILITIES) as ReadonlySet<Capability>
    for (const p of ['/ws', '/', '/bridge/', '/BRIDGE', '/bridge?x', '/daemon-tunnel/x', '']) expect(openSocketDoor(p, all), p).toBeNull()
    // The Mac and a host replica have no capability, so no door at all.
    for (const p of MANIFESTS.flatMap((m) => m.doors.map((d) => d.path))) expect(openSocketDoor(p, new Set()), p).toBeNull()
  })

  it('everything server.ts mounts outside /api is a declared route or named here as no capability\'s', () => {
    const declared = new Set(MANIFESTS.flatMap((m) => m.routes.map((r) => r.path)))
    const seen = new Set<string>()
    const unknown: string[] = []
    for (const arg of mountArgs(codeLines(read('src/web/server.ts')).join('\n'))) {
      const paths = argPaths(arg)
      if (paths && paths.every((p) => p.startsWith('/api'))) continue // the /api auth and the exempt test cover these
      if (arg in MOUNTED_NOT_A_CAPABILITY) { seen.add(arg); continue }
      if (ROUTER_FILES[arg]) {
        const { file, router } = ROUTER_FILES[arg]
        for (const r of read(file).matchAll(new RegExp(`${router}\\.(?:get|post|put|patch|delete|all|use)\\('([^']+)'`, 'g'))) {
          if (!declared.has(r[1]!)) unknown.push(`${arg}: ${r[1]}`)
        }
        continue
      }
      for (const p of paths ?? [`a mount of ${arg}`]) if (!declared.has(p)) unknown.push(p)
    }
    expect(unknown, 'declare it as a route of its capability, or name it in MOUNTED_NOT_A_CAPABILITY with why').toEqual([])
    expect(Object.keys(MOUNTED_NOT_A_CAPABILITY).filter((k) => !seen.has(k)), 'stale entries').toEqual([])
  }, 60_000)

  it('only the known listeners take WebSocket upgrades, and every socket server takes none on its own', () => {
    const files = listTsFiles(ROOT, 'src')
    const listening = files.filter((f) => /\.on\(\s*['"]upgrade['"]/.test(code(f))).sort()
    expect(listening).toEqual(Object.keys(UPGRADE_LISTENERS).sort())
    // A WebSocketServer given an http server attaches its own upgrade listener: only the
    // daemon and the separate session server may, never the Walnut server.
    const own = files.filter((f) => /new WebSocketServer\(\{\s*server:/.test(code(f))).sort()
    expect(own).toEqual(['src/providers/daemon-source.ts', 'src/session-server/server.ts'])
  })

  it('every path the auth middleware lets in without a token is a declared route or named here', () => {
    const auth = read('src/web/middleware/auth.ts')
    const list = (name: string) => [...(new RegExp(`const ${name} = (?:new Set\\()?\\[([^\\]]*)\\]`).exec(auth)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => `/api${m[1]}`)
    const exempt = [...list('CLOUD_EXEMPT_PREFIXES'), ...list('CLOUD_EXEMPT_PATHS'), ...list('PUBLIC_GET_PATHS'), ...list('PUBLIC_POST_PATHS')]
    expect(exempt.length).toBeGreaterThan(0)
    const routes = new Set(MANIFESTS.flatMap((m) => m.routes.map((r) => r.path)))
    for (const p of exempt) expect(routes.has(p) || p in EXEMPT_NOT_A_CAPABILITY, p).toBe(true)
  })

  it('every file that asks for a capability is listed in its manifest, and nothing else is', () => {
    const files = [...listTsFiles(ROOT, 'src'), ...listTsFiles(ROOT, 'web/src')]
      .filter((f) => f !== 'src/core/capabilities.ts' && !f.startsWith(`${FOLDER}/`))
      .map((file) => ({ file, text: read(file) }))
    const asks = capabilityReads(files)
    for (const name of asks.keys()) expect(CAPABILITIES, `asked for "${name}", which no manifest has`).toContain(name)
    for (const m of MANIFESTS) expect([...m.reads].sort(), m.name).toEqual([...(asks.get(m.name) ?? [])].sort())
  }, 60_000)

  it('the scans find what they claim to', () => {
    const asks = capabilityReads([
      { file: 'a.ts', text: "if (hasCapability('public-door')) x()\n * hasCapability('cloud-exec') in a comment\nconn.hasCapability('acp-host-v1')" },
      { file: 'b.tsx', text: 'const p = useServerCapability("door-v2")' },
    ])
    expect([...asks.keys()].sort()).toEqual(['door-v2', 'public-door'])
    const args = mountArgs("app.use('/git/data', r)\napp.use(['/api/a', '/api/b'], x)\napp.use(BRIDGE_SEND_PATH, y)\napp.use(cors({ origin: f(a, b) }))\napp.use((req, res, next) => {\n  next()\n})")
    expect(args).toEqual(["'/git/data'", "['/api/a', '/api/b']", 'BRIDGE_SEND_PATH', 'cors({ origin: f(a, b) })', '(req, res, next) => {'])
    expect(args.map(argPaths)).toEqual([['/git/data'], ['/api/a', '/api/b'], ['/bridge/send'], null, null])
  })
})
