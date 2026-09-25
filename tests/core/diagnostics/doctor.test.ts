/**
 * collectDiagnostics: the `open-walnut doctor` report.
 *
 * Contract under test:
 *   - every probe's answer lands in its field (fake probes, no processes);
 *   - a probe that hangs or throws becomes ONE warnings line, never a throw,
 *     and the rest of the report still fills in;
 *   - the CLI collector (no server) reports the local half only;
 *   - no secret reaches the report: a token in the env, in config.yaml or in a
 *     host's connect error never appears in the JSON or the text.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-doctor'))

import { collectDiagnostics } from '../../../src/core/diagnostics/doctor.js'
import { redactDiagnostics, renderDiagnosticsText } from '../../../src/core/diagnostics/render.js'
import { summarizeConfig } from '../../../src/core/diagnostics/local-probes.js'
import type { Config } from '../../../src/core/types.js'
import { ENV, HOST, fakeProbes, never } from './fakes.js'

describe('collectDiagnostics', () => {
  it('fills every field from its probe', async () => {
    const r = await collectDiagnostics({ probes: fakeProbes(), env: ENV, now: () => new Date('2026-09-24T12:00:00.000Z') })
    expect(r.generatedAt).toBe('2026-09-24T12:00:00.000Z')
    expect(r.collector).toBe('server')
    expect(r.server?.port).toBe(3456)
    expect(r.local.claude).toEqual({ found: true, path: '/Users/alice/.local/bin/claude', version: '2.1.280', kind: 'native' })
    expect(r.local.loginShellPath).toEqual({ entries: ['/Users/alice/.local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'], count: 4 })
    expect(r.local.processPath).toEqual({ entries: ['/usr/bin', '/bin'], count: 2 })
    expect(r.local.shell).toBe('/bin/zsh')
    expect(r.local.compiler).toEqual({ found: true, name: 'clang' })
    expect(r.local.dtach).toEqual({ found: true, path: '/opt/homebrew/bin/dtach', source: 'system' })
    expect(r.local.preflightSource).toBe('in-process')
    expect(r.local.sqliteOk).toBe(true)
    expect(r.local.webAssetsOk).toBe(true)
    expect(r.config).toMatchObject({ provider: 'bedrock', mainModel: 'claude-opus-5-5', engine: 'claude' })
    expect(r.hosts).toEqual([{ ...HOST, daemonVersion: '0.4.5', runtime: 'binary' }])
    expect(r.warnings).toEqual([])
  })

  it('passes the session PATH (login shell first) to the preflight', async () => {
    const preflight = vi.fn(fakeProbes().preflight!)
    await collectDiagnostics({ probes: fakeProbes({ preflight }), env: ENV })
    const pathStr = preflight.mock.calls[0][0]
    expect(pathStr.split(':').slice(0, 2)).toEqual(['/Users/alice/.local/bin', '/opt/homebrew/bin'])
    expect(pathStr.split(':')).toContain('/Users/alice/.toolbox/bin')
  })

  it('turns hung probes into warnings and still fills the rest', async () => {
    const r = await collectDiagnostics({
      probes: fakeProbes({ preflight: never, sqlite: never, daemonHello: never }),
      env: ENV, localTimeoutMs: 40, hostTimeoutMs: 40,
    })
    // The preflight ran out of time: the path still comes from the resolver, the rest is unknown.
    expect(r.local.claude).toEqual({ found: true, path: '/Users/alice/.local/bin/claude', version: null, kind: null, unknown: 'preflight timed out' })
    expect(r.local.sqliteOk).toBeNull()
    expect(r.hosts[0].daemonVersion).toBeNull()
    expect(r.warnings).toEqual([
      'sqlite: no answer within 0.04s',
      // Two budgets: the preflight runs `claude --version` and `claude auth status`.
      'claude preflight: no answer within 0.08s',
      'host devbox: daemon hello: no answer within 0.04s',
    ])
  })

  it('turns thrown probes into warnings', async () => {
    const r = await collectDiagnostics({
      probes: fakeProbes({
        config: async () => { throw new Error('config.yaml unreadable') },
        hosts: async () => { throw new Error('boom\nstack line') },
      }),
      env: ENV,
    })
    expect(r.config).toBeNull()
    expect(r.hosts).toEqual([])
    expect(r.warnings).toEqual(['config: config.yaml unreadable', 'hosts: boom'])
  })

  it('skips the hello for a host that is not connected', async () => {
    const daemonHello = vi.fn(fakeProbes().daemonHello!)
    const r = await collectDiagnostics({
      probes: fakeProbes({ daemonHello, hosts: async () => [{ ...HOST, connected: false, phase: 'failed', lastError: 'ssh: connect timed out' }] }),
      env: ENV,
    })
    expect(daemonHello).not.toHaveBeenCalled()
    expect(r.hosts[0]).toMatchObject({ connected: false, daemonVersion: null, lastError: 'ssh: connect timed out' })
  })

  it('keeps the connection\'s runtime over the hello\'s guess, and redacts host warnings', async () => {
    const r = await collectDiagnostics({
      probes: fakeProbes({
        hosts: async () => [{ ...HOST, runtime: 'bun', warnings: ['disk low; token=sk-ant-WARNKEYWARNKEYWARNKEYWARN'] }],
        daemonHello: async () => ({ version: '0.4.5', runtime: 'binary' }),
      }),
      env: ENV,
    })
    expect(r.hosts[0].runtime).toBe('bun')
    expect(r.hosts[0].daemonVersion).toBe('0.4.5')
    expect(r.hosts[0].warnings?.[0]).toContain('disk low')
    expect(JSON.stringify(r)).not.toContain('sk-ant-WARNKEYWARNKEYWARNKEYWARN')
  })

  it('reports the local half only when collected by the CLI', async () => {
    const hosts = vi.fn(fakeProbes().hosts!)
    const r = await collectDiagnostics({ collector: 'cli', probes: fakeProbes({ hosts }), env: ENV })
    expect(hosts).not.toHaveBeenCalled()
    expect(r.server).toBeNull()
    expect(r.hosts).toEqual([])
    expect(r.local.claude.found).toBe(true)
    expect(r.warnings[0]).toBe('server: not running, so remote hosts were not checked')
  })

  it('checks claude against the configured model\'s floor and reports sign-in', async () => {
    const preflight = vi.fn(async (_pathStr: string, _minVersion?: string) => ({
      claude: { found: true, path: '/Users/alice/.local/bin/claude', version: '2.1.200', kind: 'native' as const, auth: 'not-logged-in' as const },
      compiler: { found: false }, dtach: { found: false },
    }))
    const r = await collectDiagnostics({
      probes: fakeProbes({ preflight, claudeFloor: async () => ({ minVersion: '2.1.280', model: 'Opus 5.5' }) }),
      env: ENV,
    })
    expect(preflight.mock.calls[0][1]).toBe('2.1.280')
    // The fake daemon did not compare: the floor is applied here, as host-readiness does.
    expect(r.local.claude).toMatchObject({ version: '2.1.200', auth: 'not-logged-in', versionOk: false, minVersion: '2.1.280' })
    expect(r.warnings).toContain('claude: not signed in (run `claude` once in a terminal and sign in)')
    expect(r.warnings).toContain('claude: 2.1.200 is older than 2.1.280, the oldest the configured model runs on')
    expect(renderDiagnosticsText(r)).toContain('claude     2.1.200  native  not signed in  needs 2.1.280  /Users/alice/.local/bin/claude')
  })

  it('keeps how claude signs in, never an address', async () => {
    const withDetail = (authDetail: string) => fakeProbes({
      preflight: async () => ({
        claude: { found: true, path: '/Users/alice/.local/bin/claude', version: '2.1.280', kind: 'native', auth: 'ok', authDetail },
        compiler: { found: false }, dtach: { found: false },
      }),
      hosts: async () => [{ ...HOST, readiness: {
        claude: { found: true, version: '2.1.280', kind: 'native', auth: 'ok', authDetail },
        compiler: { found: true }, dtach: { found: true }, checkedAt: 1, problems: [], fixes: [],
      } }],
    })
    const ok = await collectDiagnostics({ probes: withDetail('Bedrock'), env: ENV })
    expect(ok.local.claude).toMatchObject({ auth: 'ok', authDetail: 'Bedrock' })
    expect(ok.hosts[0].readiness?.claude.authDetail).toBe('Bedrock')
    const leaky = await collectDiagnostics({ probes: withDetail('a Claude account (alice@example.com, Acme Org)'), env: ENV })
    expect(leaky.local.claude.auth).toBe('ok')
    expect(leaky.local.claude.authDetail).toBeUndefined()
    expect(leaky.hosts[0].readiness?.claude.authDetail).toBeUndefined()
    expect(JSON.stringify(leaky)).not.toContain('alice@example.com')
  })

  it('names a missing claude and a niced server as findings', async () => {
    const base = fakeProbes()
    const r = await collectDiagnostics({
      probes: {
        ...base,
        preflight: async () => ({ claude: { found: false, error: 'not installed' }, compiler: { found: false }, dtach: { found: false } }),
        server: () => ({ ...base.server!(), nice: 10 }),
      },
      env: ENV,
    })
    expect(r.local.claude).toEqual({ found: false, path: null, version: null, kind: null })
    expect(r.warnings.some((w) => w.startsWith('claude: not found on this machine'))).toBe(true)
    expect(r.warnings.some((w) => w.startsWith('server: running at nice 10'))).toBe(true)
  })

  it('never carries a secret from the env, the config or a connect error', async () => {
    const config = {
      provider: { type: 'bedrock', bedrock_bearer_token: 'FAKE-CONFIG-BEARER-9876543210' },
      providers: {
        anthropic: { api: 'anthropic', api_key: 'sk-ant-CONFIGKEYCONFIGKEYCONFIGKEY', headers: { 'x-secret': 'FAKE-HEADER-SECRET' } },
      },
      agent: { main_model: 'claude-opus-5-5' },
    } as unknown as Config
    const r = await collectDiagnostics({
      probes: fakeProbes({
        config: async () => summarizeConfig(config, ENV),
        hosts: async () => [{ ...HOST, connected: false, phase: 'failed', lastError: 'auth failed for token=sk-ant-HOSTERRKEYHOSTERRKEYHOSTERR' }],
      }),
      env: ENV,
    })
    const dumps = [JSON.stringify(r), renderDiagnosticsText(r), renderDiagnosticsText(redactDiagnostics(r))]
    for (const secret of [
      ENV.AWS_BEARER_TOKEN_BEDROCK, ENV.ANTHROPIC_API_KEY, 'FAKE-CONFIG-BEARER-9876543210',
      'sk-ant-CONFIGKEYCONFIGKEYCONFIGKEY', 'FAKE-HEADER-SECRET', 'sk-ant-HOSTERRKEYHOSTERRKEYHOSTERR',
    ]) {
      for (const dump of dumps) expect(dump).not.toContain(secret)
    }
    expect(r.config?.providers).toEqual(['anthropic (anthropic)'])
  })
})
