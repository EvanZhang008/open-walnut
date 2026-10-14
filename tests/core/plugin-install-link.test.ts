/**
 * The plugin install link (src/core/plugin-install-link.ts): what the store's
 * "Copy install link" makes must read back as the same source, everywhere the
 * link can land (the server's POST, the console's fragment), and nothing else
 * may pass for one.
 */
import { describe, it, expect } from 'vitest'
import {
  buildInstallLink, parseInstallLink, openLinkFragment, parseOpenLinkFragment,
} from '../../src/core/plugin-install-link.js'

describe('plugin install links', () => {
  it('round-trips git (with and without a branch) and npm sources', () => {
    for (const target of [
      { kind: 'git' as const, url: 'git@example.com:team/walnut-plugins.git' },
      { kind: 'git' as const, url: 'https://example.com/a/b.git', ref: 'release/2' },
      { kind: 'npm' as const, spec: '@scope/walnut-plugin@1.2.3' },
    ]) {
      const link = buildInstallLink(target)
      expect(link.startsWith('open-walnut://install-plugin?')).toBe(true)
      expect(parseInstallLink(link)).toEqual(target)
      expect(parseInstallLink(`  ${link}\n`)).toEqual(target)
    }
  })

  it('reads the slash-less and upper-case forms a chat app may produce', () => {
    expect(parseInstallLink('open-walnut:install-plugin?url=https%3A%2F%2Fx.test%2Fp.git')).toEqual({ kind: 'git', url: 'https://x.test/p.git' })
    expect(parseInstallLink('OPEN-WALNUT://Install-Plugin?spec=demo')).toEqual({ kind: 'npm', spec: 'demo' })
  })

  it('is null for everything that is not exactly one source', () => {
    for (const input of [
      'https://example.com/a.git',
      'open-walnut://pair?code=1',
      'open-walnut://install-plugin',
      'open-walnut://install-plugin?url=',
      'open-walnut://install-plugin?url=https://x.test/a.git&spec=demo',
      'open-walnut://install-plugin?url=' + 'a'.repeat(2_001),
      '{"walnut_plugin_source":"https://x.test/a.git"}',
    ]) expect(parseInstallLink(input)).toBeNull()
  })

  it('carries a link through the console fragment unchanged, and nothing else', () => {
    const link = buildInstallLink({ kind: 'git', url: 'https://example.com/p.git', ref: 'main' })
    const fragment = openLinkFragment(link)
    expect(fragment).toMatch(/^#open-link=[^&#]+$/)
    expect(parseOpenLinkFragment(fragment)).toBe(link)
    expect(parseOpenLinkFragment(fragment.slice(1))).toBe(link)
    expect(parseOpenLinkFragment('#plugin-store')).toBeNull()
    expect(parseOpenLinkFragment('#open-link=' + encodeURIComponent('javascript:alert(1)'))).toBeNull()
    expect(parseOpenLinkFragment('#open-link=%E0%A4%A')).toBeNull()
  })

  it('keeps Unicode in a path intact', () => {
    const target = { kind: 'git' as const, url: 'https://example.com/café/中.git' }
    expect(parseInstallLink(buildInstallLink(target))).toEqual(target)
  })
})
