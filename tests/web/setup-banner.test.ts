import { describe, expect, it } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { SetupBanner } from '../../web/src/components/common/SetupBanner'
import type { SystemHealth } from '../../web/src/hooks/useSystemHealth'

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
    expect(html).toContain('npm install -g @anthropic-ai/claude-code')
    expect(html).toContain('Settings')
    expect(html).toContain('Dismiss setup banner')
  })
})
