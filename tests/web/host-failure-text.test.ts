/**
 * HostFailureText, rendered: the one failure block the banner, the picker,
 * Settings and the error bar share. Headline (with a full-text title), the
 * server hint with `code`, a details toggle named for what it hides, and a
 * countdown only for a real schedule.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'

let now = 1_900_000_000_000
vi.mock('@/hooks/useHostStatus', () => ({ serverNow: () => now }))

const { HostFailureText, detailsToggleLabel } = await import('../../web/src/components/hosts/HostFailureText')
const { HostCommands } = await import('../../web/src/components/hosts/HostCommands')

type Props = Parameters<typeof HostFailureText>[0]
const render = (p: Props) => renderToStaticMarkup(createElement(HostFailureText, p))
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")

beforeEach(() => { now = 1_900_000_000_000 })

describe('HostFailureText', () => {
  it('headline with a title, hint with code, SSH output toggle for an ssh kind', () => {
    const html = render({
      headline: 'Could not connect to Dev box', kind: 'auth',
      hint: 'Walnut runs `ssh alice@devbox.example.com` without a password prompt.', summary: 'Permission denied (publickey).',
      testId: 'hft-devbox',
    })
    expect(html).toContain('class="hft"')
    expect(html).toContain('data-testid="hft-devbox"')
    expect(html).toContain('title="Could not connect to Dev box"')
    expect(html).toContain('<code>ssh alice@devbox.example.com</code>')
    expect(html).toContain('aria-expanded="false"')
    expect(text(html)).toContain('Show SSH output')
    // The raw output stays behind the toggle.
    expect(html).not.toContain('hft-summary')
    expect(text(html)).not.toContain('Permission denied')
  })

  it.each(['listing', 'daemon', 'runtime'])('C86: %s hides details, not SSH output', (kind) => {
    const html = render({ headline: 'x', kind, summary: 'EACCES: permission denied' })
    expect(text(html)).toContain('Show details')
    expect(text(html)).not.toContain('SSH output')
  })

  it('no summary, no toggle; no retryAt, no countdown and no "retries by itself"', () => {
    const html = render({ headline: 'Connecting to Dev box timed out', kind: 'timeout', hint: 'Retry in a moment.' })
    expect(html).not.toContain('hft-details')
    expect(html).not.toContain('hft-when')
    expect(text(html)).not.toMatch(/retries by itself/)
  })

  it('C60: a real schedule counts down; 31s past it with no newer frame there is no line at all', () => {
    const retryAt = now + 192_000
    const soon = render({ headline: 'h', kind: 'cert_expired', retryAt })
    expect(soon).toContain('aria-hidden="true"')
    expect(text(soon)).toContain('Walnut tries again in 3m 12s')
    now = retryAt + 5_000
    expect(text(render({ headline: 'h', kind: 'cert_expired', retryAt }))).toContain('Trying again...')
    now = retryAt + 31_000
    expect(render({ headline: 'h', kind: 'cert_expired', retryAt })).not.toContain('hft-when')
  })

  it('collapsed: headline only, hint and output behind Show details', () => {
    const html = render({ headline: 'Could not connect to Dev box', kind: 'auth', hint: 'Do the thing.', summary: 'raw', collapsed: true })
    expect(text(html)).toContain('Could not connect to Dev box')
    expect(text(html)).not.toContain('Do the thing.')
    expect(text(html)).toContain('Show details')
  })

  it('an empty headline draws no headline line (the System host row says it on its own line)', () => {
    const html = render({ headline: '', kind: 'auth', hint: 'Check the key, then Retry.', summary: 'Permission denied (publickey).' })
    expect(html).not.toContain('hft-headline')
    expect(text(html)).toContain('Check the key, then Retry.')
    expect(text(html)).toContain('Show SSH output')
  })

  it('toggle words', () => {
    expect(detailsToggleLabel('auth', false)).toBe('Show SSH output')
    expect(detailsToggleLabel('auth', true)).toBe('Hide SSH output')
    expect(detailsToggleLabel('listing', true)).toBe('Hide details')
    expect(detailsToggleLabel('auth', false, true)).toBe('Show details')
  })
})

describe('HostCommands', () => {
  it('first command as a chip with Copy; the rest behind Other ways; nothing without commands', () => {
    const html = renderToStaticMarkup(createElement(HostCommands, { commands: ['claude update', 'brew upgrade claude-code'] }))
    expect(html).toContain('claude update')
    expect(text(html)).toContain('Copy')
    expect(text(html)).toContain('Other ways')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('brew upgrade claude-code')
    expect(renderToStaticMarkup(createElement(HostCommands, { commands: [] }))).toBe('')
    expect(text(renderToStaticMarkup(createElement(HostCommands, { commands: ['claude'] })))).not.toContain('Other ways')
  })
})

describe('C83: the dot shapes (color is never the only signal)', () => {
  it('warn is a square, off a still hollow ring, unknown pulses slowly, failed a solid circle', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(new URL('../../web/src/styles/host-status.css', import.meta.url), 'utf8')
    const rule = (kind: string) => {
      const m = css.match(new RegExp(`\\.sps-host-dot\\.hsd\\[data-kind="${kind}"\\][^{]*\\{([^}]*)\\}`))
      return m ? m[1] : ''
    }
    expect(rule('warn')).toMatch(/border-radius:\s*1px/)
    expect(rule('warn')).toMatch(/var\(--warning\)/)
    expect(rule('off')).toMatch(/background:\s*transparent/)
    expect(rule('off')).toMatch(/border-color:\s*var\(--fg-muted\)/)
    expect(rule('off')).not.toMatch(/animation/)
    expect(rule('unknown')).toMatch(/animation:\s*status-pulse/)
    expect(rule('failed')).toMatch(/var\(--error\)/)
    // The base rule gives every dot a 1px border box and a round shape.
    expect(css).toMatch(/\.sps-host-dot\.hsd \{[^}]*border: 1px solid transparent;[^}]*border-radius: 50%;[^}]*animation: none;/)
    // No new colors: only variables; the active tab's dot takes the tab's own text color.
    expect(css.match(/#[0-9a-fA-F]{3,6}\b/g) ?? []).toEqual([])
    expect(css).toMatch(/\.sps-host-tab\.active [^{]*\{ background: currentColor; \}/)
  })

  it('renders data-kind and an aria-label, never a title of its own', async () => {
    const { HostStatusDot } = await import('../../web/src/components/sessions/path-selector/HostStatusDot')
    const html = renderToStaticMarkup(createElement(HostStatusDot, { dot: { kind: 'warn', title: 'Build box: Claude Code on Build box is 2.1.220.' } }))
    expect(html).toContain('data-kind="warn"')
    expect(html).toContain('aria-label="Build box: Claude Code on Build box is 2.1.220."')
    expect(html).toContain('class="sps-host-dot sps-host-dot-warn hsd"')
    expect(html).not.toMatch(/\stitle=/)
  })
})
