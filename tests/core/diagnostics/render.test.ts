/**
 * renderDiagnosticsText + redactDiagnostics: the paste-ready doctor block.
 *
 * The golden texts below ARE the format: a support thread reads these lines,
 * so a change to them should be a deliberate edit here, not a side effect.
 */
import { describe, expect, it } from 'vitest'
import { formatUptime, redactDiagnostics, renderDiagnosticsText } from '../../../src/core/diagnostics/render.js'
import type { DiagnosticsReport } from '../../../src/core/diagnostics/types.js'
import type { HostReadiness } from '../../../src/core/hosts/host-readiness.js'

const READY: HostReadiness = {
  claude: { found: true, path: '/home/alice/.local/bin/claude', version: '2.1.280', kind: 'native', needsNode: false, auth: 'ok', versionOk: true, minVersion: '2.1.280' },
  compiler: { found: true, name: 'gcc' },
  dtach: { found: true, path: '/home/alice/.local/bin/walnut-dtach' },
  platform: 'linux', arch: 'x64', checkedAt: 1, problems: [], fixes: [],
}

function report(): DiagnosticsReport {
  return {
    generatedAt: '2026-09-24T12:00:00.000Z',
    collector: 'server',
    build: { version: '0.4.5', commit: 'f19a59b8', branch: 'main', builtAt: '2026-09-24T11:00:00.000Z', dirty: true },
    server: {
      node: 'v24.1.0', platform: 'darwin', arch: 'arm64', pid: 4242, nice: 0, port: 3456,
      dataDir: '/Users/alice/.open-walnut', uptimeMs: (3 * 3600 + 12 * 60) * 1000, mode: 'primary',
    },
    local: {
      node: { version: 'v24.1.0', path: '/Users/alice/.nvm/versions/node/v24.1.0/bin/node' },
      claude: { found: true, path: '/Users/alice/.local/bin/claude', version: '2.1.280', kind: 'native', auth: 'ok', authDetail: 'a Claude account', versionOk: true, minVersion: '2.1.280' },
      loginShellPath: { entries: ['/Users/alice/.local/bin', '/opt/homebrew/bin', '/usr/bin'], count: 14 },
      processPath: { entries: ['/usr/bin', '/bin'], count: 2 },
      shell: '/bin/zsh',
      preflightSource: 'in-process',
      compiler: { found: true, name: 'clang' },
      dtach: { found: true, path: '/Users/alice/.open-walnut/tmp/bin/walnut-dtach', source: 'prebuilt' },
      sqliteOk: true,
      sqliteVersion: '3.46.1',
      webAssetsOk: true,
    },
    hosts: [
      {
        alias: 'devbox', label: 'devbox', hostname: 'devbox.example.com', user: 'alice', connected: true, phase: 'connected',
        runtime: 'binary', daemonVersion: '0.4.5', readiness: READY, lastError: null,
        daemonDir: { display: '~/.cache/open-walnut', fallback: true },
        warnings: ['Using ~/.cache/open-walnut for the session daemon because /tmp is read-only.'],
      },
      {
        alias: 'lab', label: 'Lab', hostname: 'lab.example.com', connected: false, phase: 'failed',
        runtime: null, daemonVersion: null, readiness: null, lastError: 'ssh: connect to host lab.example.com port 22: Connection refused',
      },
      {
        alias: 'gpu', label: 'gpu', hostname: '10.0.0.7', connected: true, phase: 'connected', runtime: null, daemonVersion: '0.4.4',
        readiness: {
          ...READY,
          claude: { found: false, error: 'Claude Code is not installed on this host.' },
          problems: [{ kind: 'claude_missing', message: 'missing', commands: [] }, { kind: 'dtach_missing', message: 'missing', commands: [] }],
        },
        lastError: null,
      },
    ],
    config: {
      provider: 'bedrock', mainProvider: null, mainModel: 'claude-opus-5-5', fastModel: null,
      providers: ['bedrock (bedrock)'], engine: 'claude', hostsConfigured: 3, searchDisabled: false,
    },
    warnings: ['host lab: daemon hello: no answer within 5s'],
  }
}

const GOLDEN = `Open Walnut doctor (server, 2026-09-24T12:00:00.000Z)
build      0.4.5  commit f19a59b8+dirty  branch main  built 2026-09-24T11:00:00.000Z
server     pid 4242  port 3456  node v24.1.0  darwin/arm64  nice 0  up 3h 12m  primary
data dir   /Users/alice/.open-walnut
node       v24.1.0  /Users/alice/.nvm/versions/node/v24.1.0/bin/node
claude     2.1.280  native  signed-in (a Claude account)  /Users/alice/.local/bin/claude
shell      /bin/zsh
login PATH 14 entries  /Users/alice/.local/bin:/opt/homebrew/bin:/usr/bin (+11 more)
proc PATH  2 entries  /usr/bin:/bin
compiler   clang
dtach      /Users/alice/.open-walnut/tmp/bin/walnut-dtach (prebuilt)
sqlite     ok 3.46.1
web assets ok
config     provider bedrock  main model claude-opus-5-5  engine claude  search on  providers bedrock (bedrock)
hosts      3 configured
  devbox  alice@devbox.example.com  connected  daemon 0.4.5 binary  dir ~/.cache/open-walnut (fallback)  linux/x64  claude 2.1.280 native signed-in  ok; warning: Using ~/.cache/open-walnut for the session daemon because /tmp is read-only.
  lab     lab.example.com           failed     -                    -                                    -          -                                error: ssh: connect to host lab.example.com port 22: Connection refused
  gpu     10.0.0.7                  connected  daemon 0.4.4         -                                    linux/x64  no claude                        problems: claude_missing, dtach_missing
warnings   1
  - host lab: daemon hello: no answer within 5s`

describe('renderDiagnosticsText', () => {
  it('renders the golden block', () => {
    expect(renderDiagnosticsText(report())).toBe(GOLDEN)
  })

  it('renders the hosts section alone for Settings > Remote Hosts', () => {
    const text = renderDiagnosticsText({ ...report(), warnings: ['claude: not found on this machine', 'host lab: x'] }, { section: 'hosts' })
    expect(text.split('\n')).toEqual([
      'Open Walnut host diagnostics (2026-09-24T12:00:00.000Z)',
      'build      0.4.5  commit f19a59b8+dirty  branch main  built 2026-09-24T11:00:00.000Z',
      ...GOLDEN.split('\n').slice(14, 18),
      'warnings   1',
      '  - host lab: x',
    ])
  })

  it('says so when the CLI collected it without a server', () => {
    const text = renderDiagnosticsText({ ...report(), collector: 'cli', server: null, hosts: [], warnings: [] })
    expect(text).toContain('Open Walnut doctor (cli, ')
    expect(text).toContain('server     not running (collected by the CLI)')
    expect(text).toContain('hosts      not checked (server not running)')
    expect(text).not.toContain('data dir')
  })

  it('reads a from-source build, an unknown PATH and a missing claude plainly', () => {
    const r = report()
    r.build = { version: '0.4.5', commit: null, branch: null, builtAt: null, dirty: false }
    r.local.loginShellPath = null
    r.local.claude = { found: false, path: null, version: null, kind: null }
    r.local.sqliteOk = null
    r.local.webAssetsOk = null
    const text = renderDiagnosticsText(r)
    expect(text).toContain('build      0.4.5  from source')
    expect(text).toContain('login PATH not captured')
    expect(text).toContain('claude     not found')
    expect(text).toContain('sqlite     not checked')
    expect(text).toContain('web assets not served by this process')
  })

  it('shows the node an npm-built claude needs', () => {
    const r = report()
    r.local.claude = { found: true, path: '/usr/local/bin/claude', version: '2.1.200', kind: 'npm', node: { found: false, version: null } }
    expect(renderDiagnosticsText(r)).toContain('claude     2.1.200  npm (node missing)  /usr/local/bin/claude')
  })

  it('names sign-in and the version floor on the local line and each host line', () => {
    const r = report()
    r.local.claude = { ...r.local.claude, auth: 'unknown', authDetail: undefined, versionOk: false, version: '2.1.200' }
    r.hosts = [{ ...r.hosts[0], readiness: { ...READY, claude: { ...READY.claude, version: '2.1.200', auth: 'not-logged-in', versionOk: false } } }]
    const text = renderDiagnosticsText(r)
    expect(text).toContain('claude     2.1.200  native  sign-in unknown  needs 2.1.280  /Users/alice/.local/bin/claude')
    expect(text).toContain('linux/x64  claude 2.1.200 native not signed in needs 2.1.280  ok')
  })

  it('formats uptime at every scale', () => {
    expect(formatUptime(42_000)).toBe('42s')
    expect(formatUptime(125_000)).toBe('2m 5s')
    expect(formatUptime((2 * 86400 + 3 * 3600) * 1000)).toBe('2d 3h')
  })
})

describe('redactDiagnostics', () => {
  it('masks home-directory usernames, hostnames and ssh users with ordinal markers, and keeps plain aliases', () => {
    const red = redactDiagnostics(report(), { local: { home: '/Users/alice', users: ['alice'] } })
    const text = renderDiagnosticsText(red)
    expect(text).not.toMatch(/alice/)
    expect(text).not.toContain('devbox.example.com')
    expect(text).not.toContain('lab.example.com')
    expect(text).not.toContain('10.0.0.7')
    expect(text).toContain('data dir   ~/.open-walnut')
    expect(text).toContain('claude     2.1.280  native  signed-in (a Claude account)  ~/.local/bin/claude')
    expect(text).toContain('  devbox  [user:1]@[host:1]  connected  daemon 0.4.5 binary  dir ~/.cache/open-walnut (fallback)')
    expect(text).toContain('error: ssh: connect to host [host:2] port 22: Connection refused')
    expect(red.hosts[0].readiness?.claude.path).toBe('/home/\u2026/.local/bin/claude')
    expect(red.hosts.map((h) => h.alias)).toEqual(['devbox', 'lab', 'gpu'])
    expect(red.hosts.map((h) => h.hostname)).toEqual(['[host:1]', '[host:2]', '[host:3]'])
  })

  it('masks a home username wherever else it appears, but only as a whole word', () => {
    const r = report()
    r.hosts = []
    r.warnings = ['login shell PATH: alice has no rc file', 'aliceberg and malice stay']
    const red = redactDiagnostics(r)
    expect(red.warnings).toEqual(['login shell PATH: \u2026 has no rc file', 'aliceberg and malice stay'])
  })

  it('does not treat a shared home directory as a person, and leaves the input untouched', () => {
    const r = report()
    r.local.node.path = '/Users/Shared/node/bin/node'
    const red = redactDiagnostics(r)
    expect(red.local.node.path).toBe('/Users/Shared/node/bin/node')
    expect(r.server?.dataDir).toBe('/Users/alice/.open-walnut')
  })

  it('masks Windows and /home paths', () => {
    const r = report()
    r.hosts = []
    r.local.node.path = 'C:\\Users\\bob\\node\\node.exe'
    r.local.shell = '/home/carol/bin/zsh'
    const red = redactDiagnostics(r)
    expect(red.local.node.path).toBe('C:\\Users\\\u2026\\node\\node.exe')
    expect(red.local.shell).toBe('/home/\u2026/bin/zsh')
  })
})
