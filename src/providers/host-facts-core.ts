/**
 * What a host is ('host-facts-v1', `host.facts`), shared by both daemon twins:
 * OS and distro, CPU and memory, free disk under HOME, the FQDN, which proxy
 * variables are SET (never their values: they can carry credentials), whether it
 * is a cloud VM (EC2 IMDSv2 over plain node http, no curl), whether github.com
 * answers, and the first line of each common toolchain's version.
 *
 * Read-only. Every probe runs in parallel and settles by its own deadline
 * (3 s; 1 s per IMDS request), even when the child it started leaves a
 * grandchild holding its pipes; a probe that fails or runs out of time is
 * null and never fails the call. The whole call answers within 12 s with
 * whatever finished. `{network:false}` skips the cloud and internet probes.
 *
 * On macOS, /usr/bin/{git,make,gcc,python3} are shims that open the "install
 * the command line tools" dialog when the tools are missing, and /usr/bin/java
 * does the same without a JDK: those are only run once `xcode-select -p` (or
 * `/usr/libexec/java_home`) says the real thing is there.
 *
 * How each twin gets it: daemon-standalone.ts imports createHostFacts;
 * daemon-source.ts inlines `createHostFacts.toString()` through
 * `__CREATE_HOST_FACTS__`. So the factory body references NOTHING at module
 * scope, every capability comes from `deps`, and it carries no backticks.
 */

import type fsType from 'node:fs'
import type osType from 'node:os'
import type httpType from 'node:http'

export interface HostFactsDeps {
  fs: typeof fsType
  os: Pick<typeof osType, 'release' | 'cpus' | 'totalmem' | 'hostname' | 'uptime'> & Partial<Pick<typeof osType, 'loadavg' | 'freemem'>>
  /** child_process.execFile */
  execFile: (file: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void) => { kill(sig?: string): boolean } | unknown
  http: Pick<typeof httpType, 'request'>
  https: Pick<typeof httpType, 'request'>
  /** The daemon's live environment (PATH is where tools are looked up). */
  env: Record<string, string | undefined>
  home: string
  platform: string
  arch: string
  now?: () => number
  timeouts?: { probeMs?: number; imdsMs?: number; totalMs?: number }
}

export interface HostFacts {
  os: { platform: string; release: string; distroId?: string; distroVersion?: string; prettyName?: string }
  arch: string
  cpus: number
  memBytes: number
  home: string
  shell?: string
  diskFreeBytes?: number | null
  fqdn?: string
  proxyEnv: { http?: boolean; https?: boolean; noProxy?: boolean }
  /** null when skipped ({network:false}) or out of time. */
  cloud: { imds: boolean; provider?: 'aws'; instanceType?: string; region?: string; hasPublicIpv4?: boolean } | null
  /** github: true when github.com answered over HTTPS, false when it did not. null when skipped. */
  internet: { github?: boolean } | null
  tools: Record<string, string | null>
  /**
   * What this host can do beyond its toolchain ('host-caps-v1'); absent from an older
   * daemon. iOS: macOS only, the full Xcode (not the command line tools) and its
   * simulator runtimes; null on any other system or without Xcode.
   */
  ios?: { xcode: string; runtimes: string[] } | null
  /** Chromium-family browsers with the Walnut browser extension's native host registered (it drives the user's own browser). */
  browsers?: Array<{ name: string; relay: boolean }>
  /**
   * The Claude Code MCP servers configured for this account, by NAME only: never a
   * command line, environment or header, which carry credentials. `plugin` names the
   * Claude Code plugin that brings it; user-scope servers have none.
   */
  mcp?: Array<{ name: string; plugin?: string }> | null
  uptimeSec: number
  probedAt: string
}

/**
 * How busy a host is right now ('host-load-v1', `host.load {path?}`), the numbers
 * placement weighs (src/core/hosts/placement.ts): the load average (it counts the
 * threads a Mac stalls on memory too, which CPU use alone misses), CPU busy share over
 * two samples 200 ms apart, memory available (MemAvailable on Linux, free + inactive +
 * speculative pages on macOS), and the disk that holds `path` (default HOME).
 * Every probe bounded; an unknown number is null.
 */
export interface HostLoad {
  cpus: number
  /** os.loadavg(): 1, 5 and 15 minutes. */
  load: number[]
  /** Share of CPU time not idle between two samples, 0..1. */
  cpuBusy: number | null
  memTotalBytes: number
  memAvailBytes: number | null
  diskPath: string
  diskFreeBytes: number | null
  diskTotalBytes: number | null
  at: string
}

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createHostFacts(deps: HostFactsDeps) {
  var t = deps.timeouts || {}
  var PROBE_MS = t.probeMs || 3000
  var IMDS_MS = t.imdsMs || 1000
  var TOTAL_MS = t.totalMs || 12000
  var IMDS_HOST = '169.254.169.254'
  var TOOLS: Array<[string, string[]]> = [
    ['git', ['--version']], ['node', ['--version']], ['npm', ['--version']], ['bun', ['--version']],
    ['python3', ['--version']], ['go', ['version']], ['java', ['-version']], ['docker', ['--version']],
    ['gh', ['--version']], ['cargo', ['--version']], ['rustc', ['--version']], ['pnpm', ['--version']],
    ['yarn', ['--version']], ['uv', ['--version']], ['make', ['--version']], ['gcc', ['--version']],
  ]
  var MAC_CLT_SHIMS: Record<string, boolean> = { git: true, make: true, gcc: true, python3: true }
  var now = deps.now || function () { return Date.now() }

  /** `p`, or `fallback` once `ms` passes; never rejects. */
  function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise(function (resolve) {
      var done = false
      var timer = setTimeout(function () { if (!done) { done = true; resolve(fallback) } }, ms)
      p.then(function (v) { if (!done) { done = true; clearTimeout(timer); resolve(v) } },
        function () { if (!done) { done = true; clearTimeout(timer); resolve(fallback) } })
    })
  }

  interface ExecOut { code: number; stdout: string; stderr: string }

  function exec(file: string, args: string[], ms: number): Promise<ExecOut | null> {
    return within(new Promise<ExecOut | null>(function (resolve) {
      try {
        deps.execFile(file, args, { env: deps.env, timeout: ms, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, encoding: 'utf8', windowsHide: true },
          function (err, stdout, stderr) {
            var code = err ? (typeof (err as Error & { code?: unknown }).code === 'number' ? (err as Error & { code: number }).code : -1) : 0
            resolve({ code: code, stdout: String(stdout || ''), stderr: String(stderr || '') })
          })
      } catch (_e) { resolve(null) }
    }), ms + 100, null)
  }

  function firstLine(s: string): string {
    var lines = String(s || '').split('\n').map(function (l) { return l.trim() }).filter(Boolean)
    return lines.length ? lines[0].slice(0, 200) : ''
  }

  async function which(name: string): Promise<string | null> {
    var dirs = String(deps.env.PATH || '').split(':')
    for (var i = 0; i < dirs.length; i++) {
      if (!dirs[i]) continue
      var p = dirs[i].replace(/\/+$/, '') + '/' + name
      try {
        await deps.fs.promises.access(p, 1)
        if ((await deps.fs.promises.stat(p)).isFile()) return p
      } catch (_e) { /* not here */ }
    }
    return null
  }

  var cltCheck: Promise<boolean> | null = null
  var jdkCheck: Promise<boolean> | null = null
  function macHas(kind: 'clt' | 'jdk'): Promise<boolean> {
    var probe = function (file: string, args: string[]) {
      return exec(file, args, PROBE_MS).then(function (r) { return !!r && r.code === 0 })
    }
    if (kind === 'clt') return cltCheck || (cltCheck = probe('/usr/bin/xcode-select', ['-p']))
    return jdkCheck || (jdkCheck = probe('/usr/libexec/java_home', []))
  }

  async function toolVersion(name: string, args: string[]): Promise<string | null> {
    var p = await which(name)
    if (!p) return null
    if (deps.platform === 'darwin' && p.indexOf('/usr/bin/') === 0) {
      if (MAC_CLT_SHIMS[name] && !(await macHas('clt'))) return null
      if (name === 'java' && !(await macHas('jdk'))) return null
    }
    var r = await exec(p, args, PROBE_MS)
    if (!r || r.code !== 0) return null
    return firstLine(r.stdout) || firstLine(r.stderr) || null
  }

  async function osFacts(): Promise<Partial<HostFacts['os']>> {
    if (deps.platform === 'darwin') {
      var r = await exec('sw_vers', ['-productVersion'], PROBE_MS)
      var v = r && r.code === 0 ? firstLine(r.stdout) : ''
      return v ? { distroId: 'macos', distroVersion: v, prettyName: 'macOS ' + v } : {}
    }
    if (deps.platform !== 'linux') return {}
    var text = await deps.fs.promises.readFile('/etc/os-release', 'utf8')
    var kv: Record<string, string> = {}
    text.split('\n').forEach(function (line) {
      var m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (m) kv[m[1]] = m[2].replace(/^["']|["']$/g, '')
    })
    var out: Partial<HostFacts['os']> = {}
    if (kv.ID) out.distroId = kv.ID
    if (kv.VERSION_ID) out.distroVersion = kv.VERSION_ID
    if (kv.PRETTY_NAME) out.prettyName = kv.PRETTY_NAME
    return out
  }

  async function diskOf(dir: string): Promise<{ free: number; total: number } | null> {
    var r = await exec('df', ['-Pk', dir], PROBE_MS)
    if (!r || r.code !== 0) return null
    var lines = r.stdout.trim().split('\n')
    var cols = lines[lines.length - 1].trim().split(/\s+/)
    var kb = Number(cols[3])
    var totalKb = Number(cols[1])
    return isFinite(kb) && cols.length >= 4 ? { free: kb * 1024, total: isFinite(totalKb) ? totalKb * 1024 : 0 } : null
  }

  async function diskFree(): Promise<number | null> {
    var d = await diskOf(deps.home)
    return d ? d.free : null
  }

  function cpuTimes(): { idle: number; total: number } | null {
    try {
      var list = deps.os.cpus()
      var idle = 0
      var total = 0
      for (var i = 0; i < list.length; i++) {
        var t = list[i].times
        idle += t.idle
        total += t.user + t.nice + t.sys + t.idle + t.irq
      }
      return list.length ? { idle: idle, total: total } : null
    } catch (_e) { return null }
  }

  async function cpuBusy(): Promise<number | null> {
    var a = cpuTimes()
    await new Promise(function (r) { setTimeout(r, 200) })
    var b = cpuTimes()
    if (!a || !b || b.total <= a.total) return null
    var share = 1 - (b.idle - a.idle) / (b.total - a.total)
    return Math.max(0, Math.min(1, Math.round(share * 1000) / 1000))
  }

  async function memAvailable(): Promise<number | null> {
    if (deps.platform === 'linux') {
      var text = await deps.fs.promises.readFile('/proc/meminfo', 'utf8')
      var m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text)
      return m ? Number(m[1]) * 1024 : null
    }
    if (deps.platform === 'darwin') {
      var r = await exec('vm_stat', [], PROBE_MS)
      if (!r || r.code !== 0) return null
      var size = /page size of (\d+) bytes/.exec(r.stdout)
      var page = size ? Number(size[1]) : 4096
      var pages = 0
      var names = ['Pages free', 'Pages inactive', 'Pages speculative']
      names.forEach(function (n) {
        var mm = new RegExp('^' + n + ':\\s+(\\d+)', 'm').exec(r!.stdout)
        if (mm) pages += Number(mm[1])
      })
      return pages * page
    }
    return deps.os.freemem ? deps.os.freemem() : null
  }

  async function load(cmd?: Record<string, unknown>): Promise<HostLoad> {
    var dir = cmd && typeof cmd.path === 'string' && cmd.path ? cmd.path : deps.home
    if (dir === '~' || dir.indexOf('~/') === 0) dir = deps.home + dir.slice(1)
    var cpus = 0
    try { cpus = deps.os.cpus().length } catch (_e) { /* unknown */ }
    var avg: number[] = []
    try { avg = deps.os.loadavg ? deps.os.loadavg().map(function (n) { return Math.round(n * 100) / 100 }) : [] } catch (_e) { /* unknown */ }
    var got = await Promise.all([
      within(cpuBusy(), PROBE_MS, null),
      within(memAvailable(), PROBE_MS, null),
      within(diskOf(dir), PROBE_MS, null),
    ])
    return {
      cpus: cpus, load: avg, cpuBusy: got[0], memTotalBytes: deps.os.totalmem(), memAvailBytes: got[1],
      diskPath: dir, diskFreeBytes: got[2] ? got[2].free : null, diskTotalBytes: got[2] ? got[2].total || null : null,
      at: new Date(now()).toISOString(),
    }
  }

  // 'host-caps-v1': what this host can do (ios, browsers, mcp in HostFacts).
  async function iosFacts(): Promise<HostFacts['ios']> {
    if (deps.platform !== 'darwin') return null
    var sel = await exec('/usr/bin/xcode-select', ['-p'], PROBE_MS)
    // The command line tools alone answer /Library/Developer/CommandLineTools: no simulators.
    if (!sel || sel.code !== 0 || firstLine(sel.stdout).indexOf('.app/') < 0) return null
    // The text listing, not --json: the JSON carries every device type per runtime and
    // outgrows the probe's output cap on a Mac with many runtimes.
    var got = await Promise.all([
      exec('/usr/bin/xcodebuild', ['-version'], PROBE_MS),
      exec('/usr/bin/xcrun', ['simctl', 'list', 'runtimes'], PROBE_MS * 2),
    ])
    var xcode = got[0] && got[0].code === 0 ? firstLine(got[0].stdout) : ''
    if (!xcode) return null
    var runtimes: string[] = []
    String(got[1] && got[1].code === 0 ? got[1].stdout : '').split('\n').forEach(function (line) {
      var m = /^iOS\s+(\d+(?:\.\d+)*)\b/.exec(line.trim())
      if (m && line.indexOf('unavailable') < 0 && runtimes.indexOf('iOS ' + m[1]) < 0) runtimes.push('iOS ' + m[1])
    })
    return { xcode: xcode, runtimes: runtimes.slice(0, 12) }
  }

  async function exists(p: string): Promise<boolean> {
    try { await deps.fs.promises.access(p, 0); return true } catch (_e) { return false }
  }

  async function browserFacts(): Promise<NonNullable<HostFacts['browsers']>> {
    var mac = deps.platform === 'darwin'
    var support = deps.home + '/Library/Application Support/'
    var conf = (deps.env.XDG_CONFIG_HOME || deps.home + '/.config') + '/'
    // [name, app or binary that says it is installed, its profile dir for native hosts]
    var known: Array<[string, string, string]> = mac
      ? [['chrome', '/Applications/Google Chrome.app', support + 'Google/Chrome'],
        ['brave', '/Applications/Brave Browser.app', support + 'BraveSoftware/Brave-Browser'],
        ['edge', '/Applications/Microsoft Edge.app', support + 'Microsoft Edge'],
        ['chromium', '/Applications/Chromium.app', support + 'Chromium']]
      : deps.platform === 'linux'
        ? [['chrome', 'google-chrome', conf + 'google-chrome'], ['brave', 'brave-browser', conf + 'BraveSoftware/Brave-Browser'],
          ['edge', 'microsoft-edge', conf + 'microsoft-edge'], ['chromium', 'chromium', conf + 'chromium']]
        : []
    var out: NonNullable<HostFacts['browsers']> = []
    for (var i = 0; i < known.length; i++) {
      var k = known[i]
      var installed = mac ? await exists(k[1]) : !!(await which(k[1]))
      var relay = await exists(k[2] + '/NativeMessagingHosts/com.walnut.browser.json')
      if (installed || relay) out.push({ name: k[0], relay: relay })
    }
    return out
  }

  async function readJson(p: string, maxBytes: number): Promise<Record<string, unknown> | null> {
    try {
      var st = await deps.fs.promises.stat(p)
      if (!st.isFile() || st.size > maxBytes) return null
      var v = JSON.parse(await deps.fs.promises.readFile(p, 'utf8'))
      return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
    } catch (_e) { return null }
  }

  function keysOf(v: unknown): string[] {
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as Record<string, unknown>) : []
  }

  /** MCP server names only, from the files Claude Code itself reads; values never leave this function. */
  async function mcpFacts(): Promise<HostFacts['mcp']> {
    var dir = deps.env.CLAUDE_CONFIG_DIR || deps.home + '/.claude'
    var mainFile = deps.env.CLAUDE_CONFIG_DIR ? dir + '/.claude.json' : deps.home + '/.claude.json'
    var LIMIT = 32 * 1024 * 1024
    var got = await Promise.all([readJson(mainFile, LIMIT), readJson(dir + '/settings.json', LIMIT), readJson(dir + '/plugins/installed_plugins.json', LIMIT)])
    if (!got[0] && !got[1]) return null
    var out: NonNullable<HostFacts['mcp']> = []
    var seen: Record<string, boolean> = {}
    var add = function (name: string, plugin?: string) {
      var key = (plugin || '') + '\u0000' + name
      if (seen[key] || out.length >= 64) return
      seen[key] = true
      out.push(plugin ? { name: name.slice(0, 80), plugin: plugin.slice(0, 80) } : { name: name.slice(0, 80) })
    }
    keysOf(got[0] && got[0].mcpServers).forEach(function (n) { add(n) })
    var enabled = (got[1] && got[1].enabledPlugins) as Record<string, unknown> | undefined
    var installed = ((got[2] && got[2].plugins) || {}) as Record<string, Array<{ installPath?: unknown }>>
    var ids = keysOf(enabled).filter(function (id) { return enabled![id] === true })
    for (var i = 0; i < ids.length && i < 64; i++) {
      var entry = Array.isArray(installed[ids[i]]) ? installed[ids[i]][0] : null
      var root = entry && typeof entry.installPath === 'string' ? entry.installPath : ''
      if (!root) continue
      var plugin = ids[i].split('@')[0]
      var files = await Promise.all([readJson(root + '/.mcp.json', 1024 * 1024), readJson(root + '/.claude-plugin/plugin.json', 1024 * 1024)])
      var fromMcp = files[0] ? (files[0].mcpServers !== undefined ? files[0].mcpServers : files[0]) : null
      keysOf(fromMcp).forEach(function (n) { add(n, plugin) })
      keysOf(files[1] && files[1].mcpServers).forEach(function (n) { add(n, plugin) })
    }
    return out
  }

  async function fqdn(): Promise<string> {
    var r = await exec('hostname', ['-f'], PROBE_MS)
    var name = r && r.code === 0 ? firstLine(r.stdout) : ''
    return name || deps.os.hostname()
  }

  /** One HTTP exchange, settled by `ms`: {status, body} or null. */
  function request(mod: HostFactsDeps['http'], opts: Record<string, unknown>, ms: number): Promise<{ status: number; body: string } | null> {
    return within(new Promise<{ status: number; body: string } | null>(function (resolve) {
      var req: ReturnType<HostFactsDeps['http']['request']>
      try {
        req = mod.request(Object.assign({ timeout: ms, agent: false }, opts) as never, function (res) {
          var body = ''
          res.setEncoding('utf8')
          res.on('data', function (c: string) { if (body.length < 4096) body += c })
          res.on('end', function () { resolve({ status: res.statusCode || 0, body: body.trim() }) })
          res.on('error', function () { resolve(null) })
        })
      } catch (_e) { resolve(null); return }
      req.on('timeout', function () { req.destroy(); resolve(null) })
      req.on('error', function () { resolve(null) })
      req.end()
    }), ms + 50, null)
  }

  async function cloud(): Promise<NonNullable<HostFacts['cloud']>> {
    var tok = await request(deps.http, { method: 'PUT', host: IMDS_HOST, path: '/latest/api/token', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' } }, IMDS_MS)
    if (!tok || tok.status !== 200 || !tok.body) return { imds: false }
    var get = function (p: string) {
      return request(deps.http, { method: 'GET', host: IMDS_HOST, path: '/latest/meta-data/' + p, headers: { 'X-aws-ec2-metadata-token': tok!.body } }, IMDS_MS)
    }
    var got = await Promise.all([get('instance-type'), get('placement/region'), get('public-ipv4')])
    var out: NonNullable<HostFacts['cloud']> = { imds: true, provider: 'aws' }
    if (got[0] && got[0].status === 200 && got[0].body) out.instanceType = got[0].body
    if (got[1] && got[1].status === 200 && got[1].body) out.region = got[1].body
    if (got[2]) out.hasPublicIpv4 = got[2].status === 200 && !!got[2].body
    return out
  }

  async function github(): Promise<boolean> {
    var r = await request(deps.https, { method: 'HEAD', host: 'github.com', path: '/' }, PROBE_MS)
    return !!r && r.status > 0
  }

  async function facts(cmd?: Record<string, unknown>): Promise<HostFacts> {
    var env = deps.env
    var network = !(cmd && cmd.network === false)
    var cpus = 0
    try { cpus = deps.os.cpus().length } catch (_e) { /* unknown */ }
    var out: HostFacts = {
      os: { platform: deps.platform, release: deps.os.release() },
      arch: deps.arch,
      cpus: cpus,
      memBytes: deps.os.totalmem(),
      home: deps.home,
      proxyEnv: {
        http: !!(env.http_proxy || env.HTTP_PROXY),
        https: !!(env.https_proxy || env.HTTPS_PROXY),
        noProxy: !!(env.no_proxy || env.NO_PROXY),
      },
      diskFreeBytes: null,
      cloud: null,
      internet: null,
      tools: {},
      uptimeSec: Math.round(deps.os.uptime()),
      probedAt: '',
    }
    if (env.SHELL) out.shell = env.SHELL
    out.fqdn = deps.os.hostname()
    TOOLS.forEach(function (tool) { out.tools[tool[0]] = null })
    var probe = function <T>(work: () => Promise<T>, ms: number, apply: (v: T) => void): Promise<void> {
      var p: Promise<T>
      try { p = work() } catch (e) { p = Promise.reject(e) }
      return within(p.then(function (v) { return { v: v } }), ms, null).then(function (r) { if (r) apply(r.v) })
    }
    var tasks: Array<Promise<void>> = [
      probe(osFacts, PROBE_MS, function (v) { Object.assign(out.os, v) }),
      probe(diskFree, PROBE_MS, function (v) { out.diskFreeBytes = v }),
      probe(fqdn, PROBE_MS, function (v) { out.fqdn = v }),
      probe(iosFacts, PROBE_MS * 4 + 400, function (v) { out.ios = v }),
      probe(browserFacts, PROBE_MS, function (v) { out.browsers = v }),
      probe(mcpFacts, PROBE_MS, function (v) { out.mcp = v }),
    ]
    TOOLS.forEach(function (tool) {
      // A macOS shim waits for its tools check first, so it gets two probe windows.
      tasks.push(probe(function () { return toolVersion(tool[0], tool[1]) }, PROBE_MS * 2 + 200, function (v) { out.tools[tool[0]] = v }))
    })
    if (network) {
      tasks.push(probe(cloud, IMDS_MS * 2 + 300, function (v) { out.cloud = v }))
      tasks.push(probe(github, PROBE_MS, function (v) { out.internet = { github: v } }))
    }
    await within(Promise.all(tasks), TOTAL_MS, undefined)
    out.probedAt = new Date(now()).toISOString()
    // A probe still running past the budget must not change the answer already sent.
    return JSON.parse(JSON.stringify(out)) as HostFacts
  }

  return { facts: facts, load: load }
}
