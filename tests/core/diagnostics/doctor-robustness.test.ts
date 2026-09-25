/**
 * collectDiagnostics under the conditions review round 1 named:
 *   4. secrets inside free text the report carries (fix logs, check errors,
 *      claude errors) never leave, even unredacted;
 *   6. a preflight that runs out of time concludes nothing: "unknown", with the
 *      compiler and dtach still answered by their own probes;
 *   7. the local daemon answers first; the login shell gets its 5s budget;
 *  13. a dtach check still running reads "checking", never "not found".
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-doctor-robust'))

import { collectDiagnostics } from '../../../src/core/diagnostics/doctor.js'
import { redactDiagnostics, renderDiagnosticsText } from '../../../src/core/diagnostics/render.js'
import { ENV, HOST, PREFLIGHT, fakeProbes, never } from './fakes.js'

describe('4. secrets in free text', () => {
  it('masks a proxy password and a token in fix logs, check errors and claude errors, in raw JSON and text', async () => {
    const r = await collectDiagnostics({
      probes: fakeProbes({
        preflight: async () => ({
          ...PREFLIGHT,
          claude: { ...PREFLIGHT.claude, error: 'fetch via http://proxyuser:hunter22secret@proxy.example.com:8080 failed' },
        }),
        hosts: async () => [{
          ...HOST,
          readiness: {
            claude: { found: true, version: '2.1.280' }, compiler: { found: true }, dtach: { found: false }, checkedAt: 1, problems: [],
            checkError: 'host.preflight: Authorization: Bearer FAKEBEARERVALUE0123456789abcdef',
            fixes: [{ action: 'build-dtach', ok: false, finishedAt: 1, ageMs: 5, text: 'Could not install dtach', detail: 'curl: token=FAKEFIXTOKEN0123456789 rejected' }],
          },
        }],
      }),
      env: ENV,
    })
    const dumps = [JSON.stringify(r), renderDiagnosticsText(r), JSON.stringify(redactDiagnostics(r))]
    for (const dump of dumps) {
      for (const secret of ['hunter22secret', 'FAKEBEARERVALUE0123456789abcdef', 'FAKEFIXTOKEN0123456789']) expect(dump).not.toContain(secret)
    }
    expect(r.local.claude.error).toContain('[REDACTED]')
    expect(r.hosts[0].readiness?.fixes[0].detail).toBe('curl: token=[REDACTED] rejected')
  })
})

describe('6. a preflight that runs out of time', () => {
  it('reports claude as unknown, keeps the compiler and dtach, and concludes nothing is missing', async () => {
    const compiler = vi.fn(() => ({ found: true, name: 'cc' }))
    const r = await collectDiagnostics({
      probes: fakeProbes({ preflight: never, claudePath: () => null, compiler }),
      env: ENV, localTimeoutMs: 40,
    })
    expect(r.local.claude).toEqual({ found: false, path: null, version: null, kind: null, unknown: 'preflight timed out' })
    expect(compiler).toHaveBeenCalledTimes(1)
    expect(r.local.compiler).toEqual({ found: true, name: 'cc' })
    expect(r.local.dtach).toEqual({ found: true, path: '/opt/homebrew/bin/dtach', source: 'system' })
    expect(r.local.preflightSource).toBeNull()
    expect(r.warnings).toEqual(['claude preflight: no answer within 0.08s'])
    const text = renderDiagnosticsText(r)
    expect(text).toContain('claude     unknown (preflight timed out)\n')
    expect(text).not.toContain('not found')
  })

  it('says "preflight failed" when the preflight throws, still without a not-found conclusion', async () => {
    const r = await collectDiagnostics({
      probes: fakeProbes({ preflight: async () => { throw new Error('spawn EAGAIN') }, claudePath: () => null }),
      env: ENV,
    })
    expect(r.local.claude.unknown).toBe('preflight failed')
    expect(r.warnings).toEqual(['claude preflight: spawn EAGAIN'])
  })
})

describe('7. who answers for this machine', () => {
  it('takes the local daemon\'s preflight when it is connected, and does not run one itself', async () => {
    const preflight = vi.fn(async () => PREFLIGHT)
    const daemonPreflight = vi.fn(async () => ({ ...PREFLIGHT, claude: { ...PREFLIGHT.claude, version: '2.1.281' } }))
    const r = await collectDiagnostics({
      probes: fakeProbes({ preflight, daemonPreflight, claudeFloor: async () => ({ minVersion: '2.1.280', model: 'Opus 5.5' }) }),
      env: ENV,
    })
    expect(daemonPreflight).toHaveBeenCalledWith('2.1.280', 4_000)
    expect(preflight).not.toHaveBeenCalled()
    expect(r.local.preflightSource).toBe('daemon')
    expect(r.local.claude).toMatchObject({ version: '2.1.281', versionOk: true, minVersion: '2.1.280' })
    expect(renderDiagnosticsText(r)).toContain('/Users/alice/.local/bin/claude  (checked by the local daemon)')
  })

  it('falls back to its own preflight when the daemon does not answer', async () => {
    const preflight = vi.fn(async () => PREFLIGHT)
    const r = await collectDiagnostics({ probes: fakeProbes({ preflight, daemonPreflight: never }), env: ENV, localTimeoutMs: 30 })
    expect(preflight).toHaveBeenCalledTimes(1)
    expect(r.local.preflightSource).toBe('in-process')
    expect(r.warnings).toEqual(['local daemon preflight: no answer within 0.06s'])
  })

  it('gives the login shell the daemon\'s own 5s budget by default', async () => {
    const loginShellPath = vi.fn(async () => '/usr/bin')
    await collectDiagnostics({ probes: fakeProbes({ loginShellPath }), env: ENV })
    expect(loginShellPath).toHaveBeenCalledWith(5_000)
  })
})

describe('13. a dtach check still running', () => {
  it('reads "checking", not missing', async () => {
    const r = await collectDiagnostics({ probes: fakeProbes({ dtach: never }), env: ENV, localTimeoutMs: 30 })
    expect(r.local.dtach).toEqual({ found: false, path: null, source: null, unknown: 'checking' })
    expect(r.warnings).toEqual(['dtach: no answer within 0.03s'])
    expect(renderDiagnosticsText(r)).toMatch(/\ndtach {6}checking\n/)
  })
})
