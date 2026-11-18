/**
 * A machine on the host network (`transport: net`) has no SSH door: its hostname is a
 * placeholder (`clouddev.walnut-net.invalid`) and Walnut reaches it only through link(host).
 * 2026-11-16: plugin hosts.run ssh'd to that placeholder and failed every time; the same
 * assumption sat in a few more places, each checked here for a net host and, beside it, for
 * an SSH one (which keeps its ssh words):
 *   - readiness: the sign-in line names an `ssh -t <host> claude` the user cannot run; its
 *     dtach lines (its terminal rides the daemon link, 2026-11-18) name no ssh either;
 *   - connect hints: "run `ssh <host>` from a terminal", "SSH works but the daemon ...";
 *   - the session's "Open in VS Code" link: a Remote-SSH URI to the placeholder.
 * The plugin run and the copy route have their own tests (host-script.test.ts,
 * transfer/copy-pack-route.test.ts); new ssh spawns are held by link-ratchet.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-net-host-no-ssh'))
const HOSTS = {
  clouddev: { hostname: 'clouddev.walnut-net.invalid', transport: 'net', endpoint: 'ef'.repeat(32), label: 'Cloud dev' },
  devbox: { hostname: 'devbox.example.test', user: 'dev', label: 'Dev box' },
}
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: vi.fn(async () => ({ hosts: HOSTS })) }))

const { clearHostReadiness, refreshHostReadiness } = await import('../../../src/core/hosts/host-readiness.js')
const { nextFixAction } = await import('../../../src/core/hosts/host-autofix.js')
const { hintForKind } = await import('../../../src/core/sessions/host-connect-hint.js')
const { buildSessionVscodeUri } = await import('../../../src/core/session-vscode-uri.js')

/** Signed out, no compiler, no dtach: every line a host can get that names ssh or a terminal. */
const SIGNED_OUT = {
  ok: true, platform: 'linux',
  claude: { found: true, path: '/home/dev/.local/bin/claude', kind: 'native', needsNode: false, version: '9.9.9', auth: 'not-logged-in' },
  compiler: { found: false }, dtach: { found: false },
}
const conn = () => ({ hasCapability: (c: string) => c === 'preflight-v1', send: vi.fn(async () => SIGNED_OUT as { ok: boolean }) })

beforeEach(() => clearHostReadiness())

describe('a host on the host network is never told to use ssh', () => {
  it('readiness: sign in on the machine itself, and its dtach line (it has a terminal, over the link) names no ssh', async () => {
    const r = await refreshHostReadiness('clouddev', { getConnection: conn, autofix: false })
    expect(r?.problems.map((p) => p.kind)).toEqual(['claude_not_logged_in', 'compiler_missing'])
    expect(r?.problems[0]).toMatchObject({ message: expect.stringContaining('Run `claude` on Cloud dev'), commands: ['claude'] })
    expect(r?.problems[1]!.message).toContain('No C compiler on Cloud dev')
    expect(JSON.stringify(r?.problems)).not.toMatch(/ssh|walnut-net\.invalid/)
    expect(nextFixAction(r!, new Set(), { terminals: false })).toBeNull()

    const ssh = await refreshHostReadiness('devbox', { getConnection: conn, autofix: false })
    expect(ssh?.problems.map((p) => p.kind)).toEqual(['claude_not_logged_in', 'compiler_missing'])
    expect(ssh?.problems[0]!.commands).toEqual(['ssh -t dev@devbox.example.test claude'])
  })

  it('connect hints name no ssh command for a net host', () => {
    for (const kind of ['daemon', 'unknown'] as const) {
      expect(hintForKind(kind, 'clouddev.walnut-net.invalid', { label: 'Cloud dev', net: true })).not.toMatch(/`ssh |SSH works|walnut-net\.invalid/)
    }
    expect(hintForKind('unknown', 'dev@devbox.example.test', { label: 'Dev box' })).toContain('`ssh dev@devbox.example.test`')
  })

  it('the VS Code link refuses a net host instead of a Remote-SSH URI to its placeholder name', async () => {
    const connectRemote = vi.fn()
    const session = { host: 'clouddev', cwd: '/home/dev/repo' } as never
    await expect(buildSessionVscodeUri(session, { connectRemote })).rejects.toThrow(/Cloud dev through the host network, not SSH/)
    expect(connectRemote).not.toHaveBeenCalled()
  })
})
