/**
 * host.facts (host-facts-core.ts): the shape, the bounded probes, and what it
 * must never record. Tools are stub scripts on a temp PATH (one hangs, one
 * leaves a grandchild holding its pipes); HTTP is a fake, so the test makes no
 * network call.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHostFacts, type HostFactsDeps } from '../../src/providers/host-facts-core.js'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-facts-')))
afterAll(() => { if (tmp.includes('walnut-host-facts-')) fs.rmSync(tmp, { recursive: true, force: true }) })
const bin = path.join(tmp, 'bin')
fs.mkdirSync(bin)
const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 })
stub('git', 'echo "git version 9.9.9"')
stub('go', '[ "$1" = version ] && echo "go version go1.99 linux/amd64"')
stub('java', 'echo \'openjdk version "99"\' >&2; echo "OpenJDK Runtime" >&2')
stub('node', '/bin/sleep 5') // hangs past its probe window
stub('npm', '/bin/sleep 5 & wait') // its grandchild keeps the pipes open after the kill
stub('cargo', 'echo broken >&2; exit 3')
stub('hostname', '[ "$1" = -f ] && echo "box.example.internal"')
stub('df', 'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/disk1 100 40 2048 2% /"')
fs.writeFileSync(path.join(bin, 'not-exec'), 'x')

type Handler = (opts: Record<string, unknown>) => { status: number; body: string } | 'hang' | 'error'
const calls: string[] = []
function fakeHttp(handler: Handler): HostFactsDeps['http'] {
  return {
    request: ((opts: Record<string, unknown>, cb: (res: unknown) => void) => {
      calls.push(String(opts.method) + ' ' + String(opts.host) + String(opts.path))
      const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void }
      req.destroy = () => {}
      req.end = () => {
        const out = handler(opts)
        if (out === 'hang') return
        setImmediate(() => {
          if (out === 'error') { req.emit('error', new Error('EHOSTUNREACH')); return }
          const res = new EventEmitter() as EventEmitter & { statusCode: number; setEncoding(): void }
          res.statusCode = out.status
          res.setEncoding = () => {}
          cb(res)
          res.emit('data', out.body)
          res.emit('end')
        })
      }
      return req
    }) as unknown as HostFactsDeps['http']['request'],
  }
}

const imds = fakeHttp((o) => {
  const headers = (o.headers ?? {}) as Record<string, string>
  if (o.method === 'PUT' && o.path === '/latest/api/token') return { status: 200, body: 'tok-123' }
  if (headers['X-aws-ec2-metadata-token'] !== 'tok-123') return { status: 401, body: '' }
  if (o.path === '/latest/meta-data/instance-type') return { status: 200, body: 't4g.large' }
  if (o.path === '/latest/meta-data/placement/region') return { status: 200, body: 'us-west-2' }
  return { status: 404, body: 'Not Found' }
})

function make(over: Partial<HostFactsDeps> = {}) {
  return createHostFacts({
    fs, os, execFile: execFile as unknown as HostFactsDeps['execFile'],
    http: imds, https: fakeHttp(() => ({ status: 301, body: '' })),
    env: { PATH: bin, SHELL: '/bin/zsh', HTTPS_PROXY: 'http://user:s3cret-value@proxy.example:3128', no_proxy: 'localhost' },
    home: tmp, platform: 'linux', arch: 'arm64',
    now: () => Date.UTC(2026, 9, 21), timeouts: { probeMs: 400, imdsMs: 200, totalMs: 3000 },
    ...over,
  })
}

describe('host.facts', () => {
  it('answers the full shape; a hung or failing tool is null; the call stays in budget', async () => {
    const started = Date.now()
    // Windows wide enough for a loaded machine to run the quick stubs; the hung ones still get cut.
    const r = await make({ timeouts: { probeMs: 1500, imdsMs: 500, totalMs: 5000 } }).facts({})
    const ms = Date.now() - started
    expect(ms).toBeLessThan(5500)
    expect(r).toMatchObject({
      os: { platform: 'linux', release: os.release() },
      arch: 'arm64', cpus: os.cpus().length, memBytes: os.totalmem(), home: tmp, shell: '/bin/zsh',
      diskFreeBytes: 2048 * 1024, fqdn: 'box.example.internal',
      proxyEnv: { http: false, https: true, noProxy: true },
      cloud: { imds: true, provider: 'aws', instanceType: 't4g.large', region: 'us-west-2', hasPublicIpv4: false },
      internet: { github: true },
      probedAt: '2026-10-21T00:00:00.000Z',
    })
    expect(r.tools).toMatchObject({
      git: 'git version 9.9.9', go: 'go version go1.99 linux/amd64', java: 'openjdk version "99"',
      node: null, npm: null, cargo: null, docker: null, rustc: null, uv: null,
    })
    expect(Object.keys(r.tools).sort()).toEqual(['bun', 'cargo', 'docker', 'gcc', 'gh', 'git', 'go', 'java', 'make', 'node', 'npm', 'pnpm', 'python3', 'rustc', 'uv', 'yarn'])
    expect(typeof r.uptimeSec).toBe('number')
  })

  it('never records a proxy value', async () => {
    const text = JSON.stringify(await make().facts({ network: false }))
    expect(text).not.toContain('s3cret')
    expect(text).not.toContain('proxy.example')
  })

  it('network:false skips IMDS and github', async () => {
    calls.length = 0
    const r = await make().facts({ network: false })
    expect(r.cloud).toBeNull()
    expect(r.internet).toBeNull()
    expect(calls).toEqual([])
  })

  it('no IMDS (it hangs or refuses) is imds:false; github down is false', async () => {
    const hang = await make({ http: fakeHttp(() => 'hang'), https: fakeHttp(() => 'error') }).facts({})
    expect(hang.cloud).toEqual({ imds: false })
    expect(hang.internet).toEqual({ github: false })
    const refused = await make({ http: fakeHttp(() => 'error') }).facts({})
    expect(refused.cloud).toEqual({ imds: false })
  })

  it('a probe that throws, and a whole budget that runs out, still answer', async () => {
    const r = await make({
      execFile: (() => { throw new Error('spawn EAGAIN') }) as unknown as HostFactsDeps['execFile'],
      os: { ...os, hostname: () => 'fallback-name' } as unknown as HostFactsDeps['os'],
    }).facts({ network: false })
    expect(r.fqdn).toBe('fallback-name')
    expect(r.diskFreeBytes).toBeNull()
    expect(r.tools.git).toBeNull()

    const started = Date.now()
    const tight = await make({ timeouts: { probeMs: 2000, totalMs: 300 } }).facts({ network: false })
    expect(Date.now() - started).toBeLessThan(2500)
    expect(tight.tools.node).toBeNull()
    expect(tight.probedAt).toBe('2026-10-21T00:00:00.000Z')
  })
})

// 'host-caps-v1': what a host can do. The Mac probes run absolute paths
// (/usr/bin/xcode-select, xcodebuild, xcrun), so the darwin case answers them
// from a fake execFile; files come from a temp HOME. Each case also runs the
// factory from its TEXT, as daemon-source.ts inlines it.
describe('host.facts capabilities (host-caps-v1)', () => {
  const strict = <T>(fn: T): T => new Function('"use strict"; return (' + String(fn) + ')')() as T
  const SECRET = 'tok-must-never-leave-the-host'

  function home(name: string): string {
    const h = path.join(tmp, name)
    fs.mkdirSync(path.join(h, '.claude', 'plugins'), { recursive: true })
    fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({
      mcpServers: { 'mail-mcp': { command: 'mail', env: { TOKEN: SECRET } }, "notes-mcp": { type: 'http', headers: { Authorization: 'Bearer ' + SECRET } } },
      projects: { '/x': { mcpServers: { 'project-only': { command: 'p' } } } },
    }))
    const plugin = path.join(h, 'plugin-a')
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true })
    fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { 'docs-mcp': { command: 'b', env: { K: SECRET } } } }))
    fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'a', mcpServers: { 'second-mcp': { command: 's' } } }))
    const off = path.join(h, 'plugin-off')
    fs.mkdirSync(off)
    fs.writeFileSync(path.join(off, '.mcp.json'), JSON.stringify({ mcpServers: { 'disabled-mcp': { command: 'd' } } }))
    fs.writeFileSync(path.join(h, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'PluginA@market': true, 'PluginOff@market': false } }))
    fs.writeFileSync(path.join(h, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      'PluginA@market': [{ scope: 'user', installPath: plugin }], 'PluginOff@market': [{ scope: 'user', installPath: off }],
    } }))
    return h
  }

  const macExec = ((file: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    const reply = (out: string, code = 0) => setImmediate(() => cb(code ? Object.assign(new Error('exit'), { code }) : null, out, ''))
    if (file === '/usr/bin/xcode-select') return reply('/Applications/Xcode.app/Contents/Developer\n')
    if (file === '/usr/bin/xcodebuild') return reply('Xcode 26.1\nBuild version 17B55\n')
    if (file === '/usr/bin/xcrun' && args[0] === 'simctl') {
      return reply([
        '== Runtimes ==',
        'iOS 26.1 (26.1 - 23B80) - com.apple.CoreSimulator.SimRuntime.iOS-26-1',
        'watchOS 26.0 (26.0 - 23R353) - com.apple.CoreSimulator.SimRuntime.watchOS-26-0',
        'iOS 17.5 (17.5 - 21F79) - com.apple.CoreSimulator.SimRuntime.iOS-17-5 (unavailable, runtime path not found)',
      ].join('\n') + '\n')
    }
    if (file === 'sw_vers') return reply('26.1\n')
    return reply('', 1)
  }) as unknown as HostFactsDeps['execFile']

  for (const [label, factory] of [['imported', createHostFacts], ['inlined', strict(createHostFacts)]] as const) {
    it(`${label}: a Mac with Xcode and the browser extension reports iOS, the browser and MCP names only`, async () => {
      const h = home(`mac-${label}`)
      fs.mkdirSync(path.join(h, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'), { recursive: true })
      fs.writeFileSync(path.join(h, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', 'com.walnut.browser.json'), '{}')
      const r = await factory({
        fs, os, execFile: macExec, http: imds, https: fakeHttp(() => ({ status: 301, body: '' })),
        env: { PATH: bin }, home: h, platform: 'darwin', arch: 'arm64', timeouts: { probeMs: 1500, totalMs: 5000 },
      }).facts({ network: false })
      expect(r.ios).toEqual({ xcode: 'Xcode 26.1', runtimes: ['iOS 26.1'] })
      expect(r.browsers).toContainEqual({ name: 'chrome', relay: true })
      expect(r.mcp).toEqual([
        { name: 'mail-mcp' }, { name: 'notes-mcp' },
        { name: 'docs-mcp', plugin: 'PluginA' }, { name: 'second-mcp', plugin: 'PluginA' },
      ])
      // Names only: no command, environment, header or token rides the answer.
      const text = JSON.stringify(r)
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('disabled-mcp')
      expect(text).not.toContain('project-only')
    })
  }

  it('the command line tools alone are no iOS; Linux has none and never runs the Mac probes', async () => {
    const seen: string[] = []
    const clt = ((file: string, args: string[], o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      seen.push(file)
      if (file === '/usr/bin/xcode-select') { setImmediate(() => cb(null, '/Library/Developer/CommandLineTools\n', '')); return }
      return (macExec as unknown as (...a: unknown[]) => void)(file, args, o, cb)
    }) as unknown as HostFactsDeps['execFile']
    const mac = await make({ execFile: clt, platform: 'darwin', home: home('clt') }).facts({ network: false })
    expect(mac.ios).toBeNull()
    expect(seen).not.toContain('/usr/bin/xcodebuild')

    const linuxSeen: string[] = []
    const linuxExec = ((file: string, args: string[], o: Record<string, unknown>, cb: (...a: unknown[]) => void) => {
      linuxSeen.push(file)
      return (execFile as unknown as (...a: unknown[]) => void)(file, args, o, cb)
    }) as unknown as HostFactsDeps['execFile']
    const h = home('linux')
    fs.mkdirSync(path.join(h, '.config', 'google-chrome', 'NativeMessagingHosts'), { recursive: true })
    fs.writeFileSync(path.join(h, '.config', 'google-chrome', 'NativeMessagingHosts', 'com.walnut.browser.json'), '{}')
    const linux = await make({ execFile: linuxExec, home: h }).facts({ network: false })
    expect(linux.ios).toBeNull()
    expect(linuxSeen.some((f) => f.startsWith('/usr/bin/xc'))).toBe(false)
    expect(linux.browsers).toEqual([{ name: 'chrome', relay: true }])
    expect(linux.mcp?.map((m) => m.name)).toContain('docs-mcp')
  })

  it('no Claude config is mcp:null; a broken or huge file is skipped, never thrown', async () => {
    const empty = path.join(tmp, 'no-claude')
    fs.mkdirSync(empty, { recursive: true })
    expect((await make({ home: empty }).facts({ network: false })).mcp).toBeNull()
    const broken = path.join(tmp, 'broken-claude')
    fs.mkdirSync(path.join(broken, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(broken, '.claude.json'), '{not json')
    fs.writeFileSync(path.join(broken, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'Gone@m': true } }))
    const r = await make({ home: broken }).facts({ network: false })
    expect(r.mcp).toEqual([])
    expect(r.browsers).toEqual([])
  })

  it('CLAUDE_CONFIG_DIR moves where the names are read', async () => {
    const h = home('cfgdir-home')
    const cfg = path.join(tmp, 'cfgdir')
    fs.mkdirSync(cfg, { recursive: true })
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: { 'from-config-dir': {} } }))
    const r = await make({ home: h, env: { PATH: bin, CLAUDE_CONFIG_DIR: cfg } }).facts({ network: false })
    expect(r.mcp).toEqual([{ name: 'from-config-dir' }])
  })
})
