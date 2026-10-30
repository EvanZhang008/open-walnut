/**
 * tests/helpers/live-isolation.ts, without starting anything: the environment a live
 * e2e child gets is an allowlist, and the sandbox profile holds the walls it names.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LIVE_CONNECT_GUARD, liveEnv, liveProfile, parseLsofListen, parseProcNetListen, prodLockClash, realWalnutPorts, walled } from '../helpers/live-isolation.js'
import { daemonLockPort } from '../../src/providers/daemon-instance-lock.js'
import { EXEC_GUARD_BIN, EXEC_GUARD_VARS } from '../setup/exec-guard-core.js'
import { stripLiveOptIns } from '../setup/live-tier-only.js'

const made: string[] = []
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

describe('liveEnv', () => {
  it('keeps nothing of the runner but the exec guard and the runtime, and isolates home, temp, XDG and git', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-env-'))
    made.push(dir)
    const saved = { ...process.env }
    try {
      Object.assign(process.env, {
        OPEN_WALNUT_API_URL: 'http://127.0.0.1:3456', WALNUT_SERVER_URL: 'http://127.0.0.1:3456', SSH_AUTH_SOCK: '/tmp/agent.sock',
        AWS_PROFILE: 'p', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/x', NODE_OPTIONS: '--require /x.js', BUN_OPTIONS: '--preload /x.js', WALNUT_SESSION_ID: 's', VITEST: 'true',
      })
      const home = path.join(dir, 'home')
      const env = liveEnv({ home, tmp: path.join(dir, 'tmp'), bins: [path.join(home, 'bin')], guardLog: path.join(dir, 'guard.log') }, { OPEN_WALNUT_HOME: path.join(dir, 'data') })
      for (const k of ['WALNUT_SERVER_URL', 'SSH_AUTH_SOCK', 'AWS_PROFILE', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'WALNUT_SESSION_ID', 'VITEST']) {
        expect(env[k], k).toBeUndefined()
      }
      // The paths out stay shut where no walls stand: before listen an op client would fall back to :3456.
      expect(env).toMatchObject({ OPEN_WALNUT_API_URL: 'http://127.0.0.1:9', WALNUT_STT_AUTO_SETUP: '0', WALNUT_HOST_AUTOFIX: '0', WALNUT_NO_UPDATE_CHECK: '1' })
      expect(liveEnv({ home, tmp: path.join(dir, 'tmp'), bins: [], guardLog: path.join(dir, 'guard.log') }, { OPEN_WALNUT_API_URL: 'http://127.0.0.1:1234' }).OPEN_WALNUT_API_URL).toBe('http://127.0.0.1:1234')
      // The only NODE_OPTIONS and BUN_OPTIONS are the connect guard, with the real Walnut's ports.
      expect(env.NODE_OPTIONS).toBe(`--require ${JSON.stringify(LIVE_CONNECT_GUARD)}`)
      expect(env.BUN_OPTIONS).toBe(`--preload ${LIVE_CONNECT_GUARD}`)
      expect(env.WALNUT_TEST_DENY_PORTS!.split(',')).toContain('3456')
      expect(env.WALNUT_TEST_CONNECT_GUARD_LOG).toBe(path.join(dir, 'guard.log'))
      expect(env).toMatchObject({ HOME: home, USERPROFILE: home, TMPDIR: path.join(dir, 'tmp'), OPEN_WALNUT_HOME: path.join(dir, 'data'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), NODE_ENV: 'production' })
      for (const k of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH']) expect(env[k]!.startsWith(dir + '/'), k).toBe(true)
      // The test's own bin first, then the exec guard.
      expect(env.PATH!.split(path.delimiter).slice(0, 2)).toEqual([path.join(home, 'bin'), EXEC_GUARD_BIN])
      // git reads no credential helper from this config (an empty value clears the system's).
      expect(fs.readFileSync(env.GIT_CONFIG_GLOBAL!, 'utf8')).toMatch(/\[credential\]\n\thelper =\n/)
      const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'SHELL', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH', 'NODE_ENV', 'OPEN_WALNUT_HOME',
        ...Object.values(EXEC_GUARD_VARS), 'BUN_INSTALL', 'LANG', 'LC_ALL',
        'OPEN_WALNUT_API_URL', 'WALNUT_STT_AUTO_SETUP', 'WALNUT_SEARCH_V2_SEMANTIC', 'WALNUT_PRICE_REFRESH', 'WALNUT_NO_UPDATE_CHECK', 'WALNUT_HOST_WARMUP',
        'WALNUT_HOST_AUTOFIX', 'WALNUT_TEST_SERVER', 'WALNUT_STALL_RECORDER', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'NODE_OPTIONS', 'BUN_OPTIONS', 'WALNUT_TEST_DENY_PORTS', 'WALNUT_TEST_CONNECT_GUARD_LOG'])
      expect(Object.keys(env).filter((k) => !allowed.has(k))).toEqual([])
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })
})

describe('liveProfile', () => {
  const profile = liveProfile({
    base: '/private/tmp/wll-x', repo: '/Users/someone/src/walnut', realHome: '/Users/someone', prodDir: '/private/tmp/open-walnut', userTemp: '/private/var/folders/ab/xyz/T',
    runtimes: ['/opt/homebrew/Cellar/node/25.9.0', '/Users/someone/.bun', '/Users/someone/other/node_modules'],
    writable: ['/private/tmp/guard.log'],
    noExec: ['/opt/homebrew/bin/claude', '/opt/homebrew/Caskroom/claude-code/2.1.0/claude'],
    denyPorts: [3456, 8402],
  })

  it('allows outbound connections only to loopback, and unix sockets only under the base, and none to the denied ports', () => {
    expect(profile).toContain('(deny network-outbound (require-all (require-not (remote ip "localhost:*")) (require-not (remote unix-socket (subpath "/private/tmp/wll-x")))))')
    expect(profile).toContain('(deny network-outbound (remote ip "localhost:3456") (remote ip "localhost:8402"))')
    // An allow of loopback would outrank every port deny (measured): there is none.
    expect(profile).not.toMatch(/\(allow network-outbound/)
  })

  it('allows writes only under the base, the named files and /dev null devices', () => {
    expect(profile).toMatch(/\(deny file-write\* \(require-not \(require-any \(subpath "\/private\/tmp\/wll-x"\) \(literal "\/private\/tmp\/guard\.log"\) \(literal "\/dev\/null"\)/)
  })

  it('reads no file content under the real home except the repo and the runtimes there', () => {
    const rule = profile.split('\n').find((l) => l.startsWith('(deny file-read-data'))!
    expect(rule).toContain('(subpath "/Users/someone")')
    for (const p of ['/Users/someone/src/walnut', '/Users/someone/.bun', '/Users/someone/other/node_modules']) expect(rule).toContain(`(subpath "${p}")`)
    // A runtime outside the home needs no exception.
    expect(rule).not.toContain('/opt/homebrew')
  })

  it('runs nothing under the real home but the repo and the runtimes, and no claude outside it', () => {
    const rule = profile.split('\n').find((l) => l.startsWith('(deny process-exec (require-all'))!
    expect(rule).toContain('(subpath "/Users/someone")')
    expect(rule).toContain('(subpath "/Users/someone/.bun")')
    expect(profile).toContain('(deny process-exec (literal "/opt/homebrew/bin/claude") (literal "/opt/homebrew/Caskroom/claude-code/2.1.0/claude"))')
  })

  it('refuses an exception that holds the whole home, and an empty port list', () => {
    const input = { base: '/private/tmp/wll-x', repo: '/r', realHome: '/Users/someone', prodDir: '/private/tmp/open-walnut', userTemp: '/private/var/folders/ab/xyz/T', runtimes: [] as string[], writable: [], noExec: [], denyPorts: [3456] }
    expect(() => liveProfile({ ...input, runtimes: ['/Users/someone'] })).toThrow(/holds the real home/)
    expect(() => liveProfile({ ...input, runtimes: ['/Users'] })).toThrow(/holds the real home/)
    expect(() => liveProfile({ ...input, repo: '/Users/someone' })).toThrow(/holds the real home/)
    expect(() => liveProfile({ ...input, denyPorts: [] })).toThrow(/no ports/)
    expect(() => liveProfile(input)).not.toThrow()
  })

  it('reads nothing from the account\'s temp dir or an ephemeral server\'s dir in /tmp, except the base', () => {
    expect(profile).toContain('(deny file-read-data (require-all (require-any (subpath "/private/var/folders/ab/xyz/T") (regex #"^/private/tmp/open-walnut-(eph-|[0-9]+-)")) (require-not (subpath "/private/tmp/wll-x"))))')
  })

  it('reads nothing from the production daemon\'s dirs', () => {
    expect(profile).toContain('(deny file-read-data (subpath "/private/tmp/open-walnut") (subpath "/private/tmp/open-walnut-streams"))')
  })

  it('runs /bin/ps, and only it, outside the walls (no setuid binary runs in a sandbox)', () => {
    expect(profile).toContain('(allow process-exec (literal "/bin/ps") (with no-sandbox))')
    expect(profile.match(/with no-sandbox/g)).toHaveLength(1)
  })

  it('denies the keychain, signals out of the walls, and the tools that leave them', () => {
    expect(profile).toContain('(deny mach-lookup (global-name-regex #"^com\\.apple\\.secur") (global-name "com.apple.SecurityServer") (global-name "com.apple.tccd") (global-name "com.apple.tccd.system") (global-name "com.apple.pasteboard.1"))')
    expect(profile).toContain('(deny signal)\n(allow signal (target same-sandbox))')
    for (const t of ['/bin/launchctl', '/usr/bin/open', '/usr/bin/osascript', '/usr/bin/ssh', '/usr/bin/security', '/usr/bin/sudo', '/usr/bin/pkill', '/usr/bin/killall']) expect(profile).toContain(`(literal "${t}")`)
  })
})

describe('the walls on this machine', () => {
  // A child behind the walls with no connect guard: the kernel refuses the denied port, on both loopbacks.
  it.skipIf(process.platform !== 'darwin')('refuse a denied loopback port and pass another one', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-walls-net-')))
    made.push(base)
    const listen = (host: string) => new Promise<net.Server>((r) => { const s = net.createServer((c) => { c.on('error', () => {}); c.end() }); s.listen(0, host, () => r(s)) })
    const [allowed, denied, denied6] = [await listen('127.0.0.1'), await listen('127.0.0.1'), await listen('::1')]
    const port = (s: net.Server) => (s.address() as net.AddressInfo).port
    try {
      const profile = liveProfile({
        base, repo: process.cwd(), realHome: '/var/empty/no-home', prodDir: '/private/tmp/open-walnut', userTemp: '/private/var/folders/none',
        runtimes: [path.dirname(path.dirname(fs.realpathSync(process.execPath)))], writable: [], noExec: [], denyPorts: [port(denied), port(denied6)],
      })
      const code = `const net = require('net'); const c = (host, port) => new Promise((r) => { const s = net.connect({ host, port }); s.once('connect', () => { s.destroy(); r('connected') }); s.once('error', (e) => r(e.code)) });
(async () => console.log(JSON.stringify([await c('127.0.0.1', ${port(allowed)}), await c('127.0.0.1', ${port(denied)}), await c('localhost', ${port(denied)}), await c('::1', ${port(denied6)}), await c('192.0.2.1', 443)])))()`
      const p = spawn('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', code], { cwd: base, env: { PATH: process.env.PATH, HOME: base }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      p.stdout.on('data', (b: Buffer) => { out += b })
      p.stderr.on('data', (b: Buffer) => { err += b })
      const code2 = await new Promise<number | null>((r) => p.once('exit', r))
      expect(code2, err).toBe(0)
      // The kernel refuses with EPERM; bun 1.4.4 reports that refusal as ECONNREFUSED
      // (Node and Python say EPERM). Either is the wall: the denied ports have a
      // listener, and the allowed one on the same loopback connects.
      const [first, ...walled] = JSON.parse(out.trim()) as string[]
      expect(first).toBe('connected')
      expect(walled).toHaveLength(4)
      for (const got of walled) expect(['EPERM', 'ECONNREFUSED']).toContain(got)
    } finally { for (const s of [allowed, denied, denied6]) s.close() }
  })

  // The daemons read process identity with ps; without it a daemon refuses to stop its CLI.
  it.skipIf(process.platform !== 'darwin')('let a child read a start time with ps', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-walls-ps-')))
    made.push(base)
    const profile = liveProfile({
      base, repo: process.cwd(), realHome: '/var/empty/no-home', prodDir: '/private/tmp/open-walnut', userTemp: '/private/var/folders/none',
      runtimes: [], writable: [], noExec: [], denyPorts: [3456],
    })
    const r = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', 'ps -p $$ -o lstart='], { cwd: base, env: { PATH: process.env.PATH, LANG: 'C' }, encoding: 'utf8', timeout: 20_000 })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toMatch(/^\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}$/)
  })
})

describe('the ports listening at the start', () => {
  it('reads loopback and every-address listeners from lsof, never a remote-bound one', () => {
    expect(parseLsofListen('p100\nf5\nn127.0.0.1:3456\nf6\nn*:50410\np200\nf7\nn[::1]:8402\nn192.168.1.4:7000\nn[::]:9100\nnlocalhost:6000\n')).toEqual([3456, 6000, 8402, 9100, 50410])
  })

  it('reads LISTEN rows on loopback or every address from /proc/net', () => {
    const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
    const v4 = head
      + '   0: 0100007F:0D80 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1\n' // 127.0.0.1:3456
      + '   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2\n' // 0.0.0.0:8080
      + '   2: 0401A8C0:1B58 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3\n' // 192.168.1.4:7000
      + '   3: 0100007F:2328 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 4\n' // established, not LISTEN
    expect(parseProcNetListen(v4)).toEqual([3456, 8080])
    const v6 = head
      + '   0: 00000000000000000000000001000000:20C2 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 5\n' // ::1:8386
      + '   1: 0000000000000000FFFF00000100007F:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 6\n' // ::ffff:127.0.0.1:8081
      + '   2: 20010DB8000000000000000000000001:1F92 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 7\n' // 2001:db8::1, remote
    expect(parseProcNetListen(v6)).toEqual([8081, 8386])
  })
})

describe('walled', () => {
  it('wraps the command in sandbox-exec on macOS and keeps its argv, else runs it as is', () => {
    const [file, args] = walled('/bin/echo', ['a', 'b c'], { base: os.tmpdir(), repo: process.cwd() })
    if (process.platform === 'darwin') {
      expect(file).toBe('/usr/bin/sandbox-exec')
      expect(args[0]).toBe('-p')
      expect(args.slice(2)).toEqual(['/bin/echo', 'a', 'b c'])
    } else {
      expect([file, args]).toEqual(['/bin/echo', ['a', 'b c']])
    }
  })

  // Bun starts with an EMPTY environment behind the walls when its cwd is under a dir it may not
  // list (the repo under the real home): the live tests start it in a dir of their own base.
  const bun = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin', 'bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun'].find((p) => p && fs.existsSync(p))
  it.skipIf(process.platform !== 'darwin' || !bun)('a Bun child started in the base keeps its environment', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-walls-bun-')))
    made.push(base)
    fs.writeFileSync(path.join(base, 'env.ts'), 'console.log(process.env.LIVE_PROBE ?? "missing")\n')
    const [file, args] = walled(bun!, [path.join(base, 'env.ts')], { base, repo: process.cwd() })
    const r = spawnSync(file, args, {
      cwd: base, encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: base, LIVE_PROBE: 'kept', BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(base, 'bun-cache') },
    })
    expect(r.stdout.trim(), r.stderr).toBe('kept')
  })
})

describe('prodLockClash', () => {
  it('names exactly the dirs whose lock port is the production daemon\'s', () => {
    const uid = process.getuid?.() ?? 0
    const prodDir = path.join(fs.realpathSync('/tmp'), 'open-walnut')
    const prod = daemonLockPort(uid, prodDir)
    const base = fs.realpathSync(os.tmpdir())
    // Search a clashing name the slow way, then check the helper finds it and only it.
    let clash = ''
    for (let i = 0; i < 200_000 && !clash; i++) if (daemonLockPort(uid, path.join(base, `d${i}`)) === prod) clash = path.join(base, `d${i}`)
    expect(clash).not.toBe('')
    const other = path.join(base, 'no-clash-' + prod)
    const others = daemonLockPort(uid, other) === prod ? [] : [other]
    expect(prodLockClash([clash, ...others])).toEqual([clash])
  })
})

describe('realWalnutPorts', () => {
  it('names the default server port, the loopback URLs of the environment and the extras, never a remote one', () => {
    const ports = realWalnutPorts({
      OPEN_WALNUT_API_URL: 'http://127.0.0.1:3999', ANTHROPIC_BEDROCK_BASE_URL: 'http://localhost:8123', ANTHROPIC_BASE_URL: 'https://api.example.com:9443',
      WALNUT_TEST_DENY_PORTS_EXTRA: '7001, x,7002',
    })
    for (const p of [3456, 3999, 8123, 7001, 7002]) expect(ports).toContain(p)
    expect(ports).not.toContain(9443)
  })

  it('reads the extras under a name the mock tiers keep (they strip every WALNUT_LIVE_* variable)', () => {
    const env: NodeJS.ProcessEnv = { WALNUT_TEST_DENY_PORTS_EXTRA: '7003' }
    expect(stripLiveOptIns(env)).toEqual([])
    expect(realWalnutPorts(env)).toContain(7003)
  })
})
