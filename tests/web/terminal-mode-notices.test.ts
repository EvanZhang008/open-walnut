import { describe, expect, it } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import {
  TerminalPlainBadge,
  TerminalPlainNotice,
  TerminalSshFailedCard,
} from '../../web/src/components/sessions/TerminalModeNotices'
import type { TerminalOpenPlain, TerminalSshFailed } from '../../web/src/api/terminal'

/**
 * The plain-shell fallback is only acceptable because it is LOUD: a badge that
 * is always in the header, a notice naming the fix, and a Retry. An ssh failure
 * must never be dressed up as a compiler problem.
 */
const plain = (over: Partial<TerminalOpenPlain> = {}): TerminalOpenPlain => ({
  ok: true,
  terminalId: 'sess-1',
  cols: 80,
  rows: 24,
  persistent: false,
  reason: 'no_compiler',
  host: 'devbox',
  installHint: 'No C compiler on devbox, so Walnut cannot build dtach.',
  installCommand: 'sudo yum install -y gcc',
  ...over,
})

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

describe('terminal mode notices', () => {
  it('badge reads "Not persistent" and carries the hint as its tooltip', () => {
    const out = html(createElement(TerminalPlainBadge, { plain: plain() }))
    expect(out).toContain('>Not persistent</span>')
    expect(out).toContain('title="No C compiler on devbox, so Walnut cannot build dtach."')
    expect(out).toContain('session-terminal-status')
  })

  it('no_compiler notice names the host, the command and Retry', () => {
    const out = html(createElement(TerminalPlainNotice, { plain: plain(), retrying: false, onRetry: () => {} }))
    expect(out).toContain('This shell will not survive a disconnect. Install a C compiler on devbox (e.g. <code>sudo yum install -y gcc</code>) and click Retry to enable persistence.')
    expect(out).toContain('>Retry</button>')
    expect(out).toContain('>Copy</button>')
    expect(out).not.toContain('<details')
  })

  it('build_failed notice mentions development headers and folds the stderr into Details', () => {
    const out = html(createElement(TerminalPlainNotice, {
      plain: plain({ reason: 'build_failed', installCommand: 'sudo yum install -y gcc glibc-devel', detail: '/usr/bin/ld: cannot find -lutil' }),
      retrying: false,
      onRetry: () => {},
    }))
    expect(out).toContain('dtach failed to build on devbox.')
    expect(out).toContain('development headers')
    expect(out).toContain('<code>sudo yum install -y gcc glibc-devel</code>')
    expect(out).toContain('<summary>Details</summary><pre>/usr/bin/ld: cannot find -lutil</pre>')
  })

  it('Retry is disabled while a retry is in flight', () => {
    const out = html(createElement(TerminalPlainNotice, { plain: plain(), retrying: true, onRetry: () => {} }))
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Retrying…<\/button>/)
  })

  it('local notice says "this machine" when there is no host', () => {
    const out = html(createElement(TerminalPlainNotice, { plain: plain({ host: undefined }), retrying: false, onRetry: () => {} }))
    expect(out).toContain('Install a C compiler on this machine')
  })

  it('ssh failure card shows ssh stderr and never the compiler hint', () => {
    const failed: TerminalSshFailed = {
      ok: false,
      code: 'SSH_FAILED',
      host: 'devbox',
      detail: 'alice@devbox.example.com: Permission denied (publickey).',
      hint: 'Check that `ssh devbox` works from this machine without a prompt, then Retry.',
    }
    const out = html(createElement(TerminalSshFailedCard, { failed, onRetry: () => {} }))
    expect(out).toContain("Can&#x27;t start terminal: ssh to devbox failed")
    expect(out).toContain('Permission denied (publickey).')
    expect(out).not.toMatch(/gcc|compiler/i)
  })
})
