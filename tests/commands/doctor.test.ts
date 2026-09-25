/**
 * `open-walnut doctor`: asks the running server, falls back to this machine.
 *
 * Contract under test:
 *   - with a server up, stdout is exactly the server's text block, and the
 *     flags map to the query (--no-redact, --hosts, --json);
 *   - with no server (or an older one without the route), it collects the
 *     local half itself, says why on stderr, and still exits 0.
 * The server here is a stub http listener; the fallback collection is mocked,
 * so no probe process runs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-doctor-cli'))

const collectDiagnostics = vi.fn()
vi.mock('../../src/core/diagnostics/doctor.js', () => ({ collectDiagnostics }))
const killLeftoverProbes = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../src/core/diagnostics/local-probes.js', () => ({ killLeftoverProbes: () => { killLeftoverProbes.calls++; return 0 } }))

import { runDoctor } from '../../src/commands/doctor.js'
import type { DiagnosticsReport } from '../../src/core/diagnostics/types.js'

const LOCAL_REPORT: DiagnosticsReport = {
  generatedAt: '2026-09-24T12:00:00.000Z',
  collector: 'cli',
  build: { version: '0.4.5', commit: 'abc1234', branch: 'main', builtAt: null, dirty: false },
  server: null,
  local: {
    node: { version: 'v24.1.0', path: '/Users/alice/bin/node' },
    claude: { found: true, path: '/Users/alice/.local/bin/claude', version: '2.1.280', kind: 'native' },
    loginShellPath: null,
    processPath: { entries: ['/usr/bin'], count: 1 },
    shell: '/bin/zsh',
    preflightSource: 'in-process',
    compiler: { found: false, name: null },
    dtach: { found: false, path: null, source: null },
    sqliteOk: true,
    webAssetsOk: null,
  },
  hosts: [],
  config: null,
  warnings: ['server: not running, so remote hosts were not checked'],
}

let server: http.Server
let port: number
let lastUrl = ''
let status = 200
let out: string[]
let err: string[]

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastUrl = req.url ?? ''
    res.statusCode = status
    res.setHeader('content-type', 'text/plain')
    res.end(status === 200 ? 'Open Walnut doctor (server, 2026-09-24T12:00:00.000Z)\nbuild      0.4.5\n' : 'nope')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as net.AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => {
  out = []
  err = []
  status = 200
  process.exitCode = undefined
  collectDiagnostics.mockReset().mockResolvedValue(LOCAL_REPORT)
  killLeftoverProbes.calls = 0
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true })
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { err.push(args.map(String).join(' ')) })
  process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${port}`
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.OPEN_WALNUT_API_URL
})

async function closedPort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const p = (probe.address() as net.AddressInfo).port
  await new Promise<void>((r) => probe.close(() => r()))
  return p
}

describe('runDoctor', () => {
  it('prints the running server\'s text block, redacted by default', async () => {
    await runDoctor({}, { json: false })
    expect(lastUrl).toBe('/api/diagnostics?format=text&redact=1')
    expect(out.join('')).toBe('Open Walnut doctor (server, 2026-09-24T12:00:00.000Z)\nbuild      0.4.5\n')
    expect(err).toEqual([])
    expect(collectDiagnostics).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('maps --no-redact, --hosts and --json to the query', async () => {
    await runDoctor({ redact: false, hosts: true }, { json: true })
    expect(lastUrl).toBe('/api/diagnostics?format=json&redact=0&section=hosts')
  })

  it('collects this machine only when no server is running, and says so', async () => {
    process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${await closedPort()}`
    await runDoctor({}, { json: false })
    expect(collectDiagnostics).toHaveBeenCalledWith({ collector: 'cli' })
    expect(err.join('\n')).toMatch(/is not running; this report covers this machine only/)
    const text = out.join('')
    expect(text).toContain('Open Walnut doctor (cli, 2026-09-24T12:00:00.000Z)')
    expect(text).toContain('server     not running (collected by the CLI)')
    expect(text).toContain('/Users/\u2026/.local/bin/claude')
    expect(text).not.toContain('alice')
    expect(process.exitCode).toBeUndefined()
    // Review round 1, item 14: no probe child outlives the report.
    expect(killLeftoverProbes.calls).toBe(1)
  })

  // Review round 1, item 15: --hosts --json is the hosts section, not the whole report.
  it('prints only the hosts section for --hosts --json without a server', async () => {
    process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${await closedPort()}`
    collectDiagnostics.mockResolvedValue({
      ...LOCAL_REPORT,
      hosts: [{ alias: 'devbox', label: 'devbox', hostname: 'devbox.example.com', connected: false, phase: 'idle', runtime: null, daemonVersion: null, readiness: null, lastError: null }],
    })
    await runDoctor({ hosts: true }, { json: true })
    const json = JSON.parse(out.join('')) as Record<string, unknown>
    expect(Object.keys(json).sort()).toEqual(['build', 'collector', 'generatedAt', 'hosts', 'warnings'])
    expect(json.hosts).toEqual([expect.objectContaining({ alias: 'devbox', hostname: '[host:1]' })])
    expect(killLeftoverProbes.calls).toBe(1)
  })

  it('falls back when the server is an older build without the route', async () => {
    status = 404
    await runDoctor({ redact: false }, { json: true })
    expect(err.join('\n')).toContain('running an older build without /api/diagnostics')
    const json = JSON.parse(out.join('')) as DiagnosticsReport
    expect(json.collector).toBe('cli')
    expect(json.local.claude.path).toBe('/Users/alice/.local/bin/claude')
  })
})
