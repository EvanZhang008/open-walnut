import { describe, expect, it } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { SetupBanner } from '../../web/src/components/common/SetupBanner'
import type { SystemHealth } from '../../web/src/hooks/useSystemHealth'
import type { LocalClaudeStatus } from '../../web/src/api/local-claude'
import { claudeBannerView, splitInlineCode } from '../../web/src/utils/local-claude-banner'

const render = (health: SystemHealth, loading = false) => renderToStaticMarkup(
  createElement(SetupBanner, { health, loading, onNavigateSettings: () => {} }),
)

describe('setup banner only asks for missing setup', () => {
  it.each([
    { mainProvider: 'claude_cli', claudeCliAuth: 'Bedrock (us-west-2)' },
    { mainProvider: 'claude_cli', claudeCliAuth: 'your Claude subscription' },
    { mainProvider: 'claude_cli' },
    { credentialDetail: 'claude-cli: default' },
    ...(['config', 'env', 'claude-settings', 'aws-files', 'none'] as const).map(credentialSource => ({
      mainProvider: 'bedrock', credentialSource, credentialDetail: 'profile: example',
    })),
    {},
  ])('does not advertise a ready provider: %j', health => {
    expect(render({ ...health, hasReadyProvider: true, claudeCliAvailable: true })).toBe('')
  })

  it('does not treat an omitted CLI status as missing', () => {
    expect(render({ hasReadyProvider: true })).toBe('')
  })

  it('renders nothing until health is known', () => {
    expect(render({})).toBe('')
    expect(render({ hasReadyProvider: false, claudeCliAvailable: false }, true)).toBe('')
  })

  it.each([
    { hasReadyProvider: false, claudeCliAvailable: false },
    { hasReadyProvider: false, claudeCliAvailable: true },
    { hasReadyProvider: true, claudeCliAvailable: false },
  ])('keeps actionable setup instructions: %j', health => {
    const html = render(health)
    expect(html).toContain('Get Walnut talking')
    // The native build: it needs no Node.js, and it is what the one-click install runs.
    expect(html).toContain('curl -fsSL https://claude.ai/install.sh | bash')
    expect(html).toContain('Open API settings')
    expect(html).toContain('Dismiss setup banner')
  })
})

// ── This machine's Claude Code: missing, too old, not signed in ──

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'
const local = (over: Partial<LocalClaudeStatus>): LocalClaudeStatus => ({
  checkedAt: 1, claude: { found: true, version: '2.1.280', kind: 'native', auth: 'ok', versionOk: true, installMethod: 'native' }, problems: [], ...over,
})
const MISSING = { kind: 'claude_missing', message: 'Claude Code is not installed on this computer.', commands: [INSTALL] }
const OUTDATED = { kind: 'claude_outdated', message: 'Claude Code on this computer is 2.1.258, but Opus 5.5 needs 2.1.280 or newer.', commands: ['claude update'] }
const SIGN_IN = { kind: 'claude_not_logged_in', message: 'Claude Code is not signed in. Run `claude` once in a terminal and sign in.', commands: ['claude'] }
const ready = { hasReadyProvider: true, claudeCliAvailable: true }
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'")

describe('setup banner for this machine\'s Claude Code', () => {
  it('missing: one-click install, the command to run by hand, and the API-settings way out', () => {
    const html = render({ hasReadyProvider: true, claudeCliAvailable: false, localClaude: local({ claude: { found: false }, problems: [MISSING] }) })
    expect(html).toContain('data-testid="setup-banner-install"')
    expect(html).toContain('data-testid="setup-banner-fix"')
    expect(text(html)).toContain('Ask Walnut runs on Claude Code. It is not installed on this computer yet.')
    expect(text(html)).toContain('Install Claude Code')
    expect(text(html)).toContain(`Or install it yourself:${INSTALL}`)
    expect(html).toContain('Open API settings')
  })

  it('missing, while the install runs, then after it failed', () => {
    const running = render({ ...ready, claudeCliAvailable: false, localClaude: local({
      claude: { found: false }, problems: [{ ...MISSING, fix: { action: 'install-claude-native', state: 'running', text: 'Installing Claude Code' } }],
    }) })
    expect(text(running)).toContain('Installing Claude Code...')
    expect(running).not.toContain('data-testid="setup-banner-fix"')
    const failed = render({ ...ready, claudeCliAvailable: false, localClaude: local({
      claude: { found: false },
      problems: [{ ...MISSING, fix: { action: 'install-claude-native', state: 'failed', text: 'Could not install Claude Code automatically (the installer failed)' } }],
    }) })
    expect(text(failed)).toContain('Could not install Claude Code automatically (the installer failed): run it yourself')
    expect(text(failed)).toContain('Try again')
    // The failed command is the one line to copy: not shown twice.
    expect(failed.split(INSTALL.replace(/\|/g, '|')).length - 1).toBe(1)
  })

  it('too old: names both versions and offers the one-click update; an install Walnut must not touch only gets its command', () => {
    const html = render({ ...ready, localClaude: local({ claude: { ...local({}).claude, version: '2.1.258', versionOk: false, minVersion: '2.1.280' }, problems: [OUTDATED] }) })
    expect(html).toContain('data-testid="setup-banner-outdated"')
    expect(text(html)).toContain('Update Claude Code')
    expect(text(html)).toContain('Claude Code on this computer is 2.1.258, but Opus 5.5 needs 2.1.280 or newer.')
    expect(html).toContain('data-testid="setup-banner-fix"')
    const brew = render({ ...ready, localClaude: local({
      claude: { found: true, version: '2.1.258', versionOk: false, minVersion: '2.1.280', installMethod: 'homebrew' },
      problems: [{ ...OUTDATED, commands: ['brew upgrade claude-code'] }],
    }) })
    expect(brew).not.toContain('data-testid="setup-banner-fix"')
    expect(text(brew)).toContain('brew upgrade claude-code')
  })

  it('not signed in: the `claude` instruction as code, Check now, and the 15s promise', () => {
    const html = render({ ...ready, localClaude: local({ claude: { ...local({}).claude, auth: 'not-logged-in' }, problems: [SIGN_IN] }) })
    expect(html).toContain('data-testid="setup-banner-sign-in"')
    expect(html).toContain('Run <code>claude</code> once in a terminal and sign in.')
    expect(text(html)).toContain('Walnut checks again every 15 seconds and hides this once you are signed in.')
    expect(html).toContain('data-testid="setup-banner-check"')
  })

  it('signed in, up to date: nothing at all (the banner removed itself)', () => {
    expect(render({ ...ready, localClaude: local({}) })).toBe('')
  })

  it('the state rules: install before outdated before sign-in; a fix only when the server can run it', () => {
    expect(claudeBannerView({ ...ready, localClaude: local({ problems: [OUTDATED, SIGN_IN] }) })).toMatchObject({ kind: 'outdated', fixable: true, dismissKey: 'outdated:' })
    expect(claudeBannerView({ ...ready, claudeCliAvailable: false })).toMatchObject({ kind: 'install', fixable: false })
    expect(claudeBannerView({ ...ready, localClaude: local({ problems: [{ ...MISSING, kind: 'claude_error', message: 'Claude Code did not start: x' }] }) }))
      .toMatchObject({ kind: 'install', fixable: false })
    expect(claudeBannerView({ ...ready, localClaude: local({ claude: { found: true, kind: 'npm' }, problems: [OUTDATED] }) })).toMatchObject({ fixable: true })
    expect(claudeBannerView({ ...ready, localClaude: local({ claude: { found: true, installMethod: 'other' }, problems: [OUTDATED] }) })).toMatchObject({ fixable: false })
    expect(claudeBannerView({ ...ready, localClaude: local({ problems: [SIGN_IN] }) })).toMatchObject({ kind: 'sign-in', fixable: false })
    expect(claudeBannerView(ready)).toBeNull()
  })

  it('splitInlineCode: backticks become code, an unclosed one stays text', () => {
    expect(splitInlineCode('Run `claude` once')).toEqual([{ code: false, text: 'Run ' }, { code: true, text: 'claude' }, { code: false, text: ' once' }])
    expect(splitInlineCode('a `b')).toEqual([{ code: false, text: 'a ' }, { code: false, text: '`b' }])
    expect(splitInlineCode('plain')).toEqual([{ code: false, text: 'plain' }])
  })
})
