/** The cached-history line is one clean sentence (N2-22). */
import { describe, it, expect } from 'vitest'
import { staleBannerText } from '../../web/src/components/sessions/stale-banner-text'

describe('staleBannerText', () => {
  it('does not say Reconnecting twice', () => {
    expect(staleBannerText('Reconnecting to Garden box')).toBe('Showing cached history. Reconnecting to Garden box...')
  })
  it('keeps one period after a reason that ends a sentence', () => {
    expect(staleBannerText("Can't reach Garden box right now.")).toBe("Showing cached history. Can't reach Garden box right now. Reconnecting...")
    expect(staleBannerText('Daemon unreachable\u2026 ')).toBe('Showing cached history. Daemon unreachable. Reconnecting...')
  })
  it('has no brackets and no doubled punctuation', () => {
    for (const r of ['Reconnecting to X.', 'Timed out.', '']) {
      const t = staleBannerText(r)
      expect(t).not.toMatch(/[()]/)
      expect(t).not.toMatch(/\.\s+\./)
      expect(t.replace(/\.\.\./g, '')).not.toMatch(/\.\./)
    }
  })
})
