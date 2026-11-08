/**
 * A failed connect says why on the row itself (2026-11-10 review: Add host "demo-devbox-c" read
 * "Could not connect to demo-devbox-c" with no reason, while the server had sent "Nothing is
 * listening for SSH ..." and ssh's own "Connection refused"). Guard: every failure kind
 * hostFailureHeadline knows gets its reason line, so a new kind cannot come back bare.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import type { HostStatus } from '../../web/src/api/hosts'

const clock = 1_800_000_000_000
let current: HostStatus | undefined
vi.mock('@/hooks/useHostStatus', () => ({
  useHostStatus: () => current,
  useHostStatusHydration: () => 'done',
  serverNow: () => clock,
  seedHostStatus: () => {},
}))
vi.mock('@/api/hosts', () => ({ connectHost: async () => current, checkHostReadiness: async () => current }))
vi.mock('@/api/config', () => ({ fetchIsCloudReplica: async () => false }))

const { useLinkedHostRow, connectReasonLine } = await import('../../web/src/components/settings/sections/useLinkedHostRow')
const { RemoteHostDetail } = await import('../../web/src/components/settings/sections/RemoteHostStatus')

function Row() {
  const r = useLinkedHostRow({ alias: 'demo-devbox-c', name: 'demo-devbox-c', enabled: true, saved: true, now: clock })
  return createElement('div', { 'data-problem': r.problemKey ?? '' }, createElement('span', null, r.state), ...r.lines)
}
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
const failed = (extra: Partial<HostStatus>) => ({
  host: 'demo-devbox-c', label: 'demo-devbox-c', hostname: 'demo-devbox-c', connected: false, phase: 'failed',
  phaseLabel: 'Could not connect to demo-devbox-c', steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: clock, retryable: true, ...extra,
} as HostStatus)

describe('the reported case', () => {
  it('the row names the cause and ssh\'s words; Details leave the hint out', () => {
    current = failed({
      kind: 'refused', error: 'ssh: connect to host 127.0.0.1 port 3461: Connection refused',
      hint: 'Nothing is listening for SSH on demo-devbox-c. Check the port and that sshd is running on the host.',
    })
    const html = renderToStaticMarkup(createElement(Row))
    expect(text(html)).toContain('Could not connect to demo-devbox-c')
    expect(html).toContain('data-testid="rh-row-reason"')
    expect(text(html)).toContain('Nothing is listening for SSH on demo-devbox-c. Check the port and that sshd is running on the host. ssh: connect to host 127.0.0.1 port 3461: Connection refused')
    expect(html).toContain('data-problem="connect"')
    const detail = renderToStaticMarkup(createElement(RemoteHostDetail, { alias: 'demo-devbox-c', hintOnRow: true }))
    expect(text(detail)).not.toContain('Nothing is listening')
  })
})

describe('connectReasonLine', () => {
  it('hint then ssh, ssh alone, hint alone, nothing', () => {
    expect(connectReasonLine('Do X.', 'ssh: refused')).toBe('Do X. ssh: refused')
    expect(connectReasonLine('', 'Permission denied (publickey).')).toBe('ssh: Permission denied (publickey).')
    expect(connectReasonLine('Do X. refused', 'refused')).toBe('Do X. refused')
    expect(connectReasonLine(undefined, undefined)).toBeNull()
  })
})

describe('guard: every failure kind gets its reason line', () => {
  const src = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../src/core/hosts/host-problem.ts'), 'utf8')
  const body = src.slice(src.indexOf('export function hostFailureHeadline'))
  const kinds = [...body.slice(0, body.indexOf('\n}\n')).matchAll(/case '([a-z_]+)'/g)].map((m) => m[1])
  it('the kinds are read from the source', () => expect(kinds.length).toBeGreaterThan(5))
  for (const kind of [...kinds, 'refused', 'unknown']) {
    it(kind, () => {
      current = failed({ kind, error: `ssh: words for ${kind}`, hint: '' })
      const html = renderToStaticMarkup(createElement(Row))
      // A kind whose problem is no connect failure (listing, ephemeral) has no row reason to give.
      if (!html.includes('data-problem="connect"')) return
      expect(text(html)).toContain(`ssh: words for ${kind}`)
    })
  }
})
