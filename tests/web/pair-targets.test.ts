/**
 * Phones & Cloud pairing choices: which address the picker offers first, which
 * one a re-pair QR carries, and when the Tailscale line shows.
 */
import { describe, expect, it } from 'vitest'
import { bestOfferedKind, preferredKind } from '../../web/src/components/settings/sections/cloud/pair-targets.js'

describe('bestOfferedKind', () => {
  it('prefers cloud, then the tailnet, then this network, whatever the server order', () => {
    expect(bestOfferedKind(['lan', 'tailnet', 'cloud'])).toBe('cloud')
    expect(bestOfferedKind(['cloud', 'lan'])).toBe('cloud')
    expect(bestOfferedKind(['tailnet', 'lan'])).toBe('tailnet')
    expect(bestOfferedKind(['lan', 'tailnet'])).toBe('tailnet')
    expect(bestOfferedKind(['lan'])).toBe('lan')
  })
  it('falls back to this network when nothing is offered', () => {
    expect(bestOfferedKind([])).toBe('lan')
  })
})

describe('preferredKind (re-pair)', () => {
  it('keeps a phone with a cloud credential on the cloud', () => {
    expect(preferredKind(['lan', 'cloud'], ['lan', 'tailnet', 'cloud'])).toBe('cloud')
    expect(preferredKind(['cloud'], ['lan', 'tailnet'])).toBe('cloud')
  })
  it('uses the tailnet for a local phone when this machine offers one', () => {
    expect(preferredKind(['lan'], ['lan', 'tailnet', 'cloud'])).toBe('tailnet')
    expect(preferredKind(['lan'], ['tailnet'])).toBe('tailnet')
  })
  it('stays on this network otherwise', () => {
    expect(preferredKind(['lan'], ['lan', 'cloud'])).toBe('lan')
    expect(preferredKind(['lan'], [])).toBe('lan')
  })
})

