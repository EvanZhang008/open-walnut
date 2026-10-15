import { describe, expect, it } from 'vitest'
import { modalityOf } from '../../web/src/utils/input-modality'

describe('modalityOf (N24: no keyboard ring for a finger)', () => {
  it('a press is touch', () => {
    expect(modalityOf({ type: 'pointerdown' })).toBe('touch')
    expect(modalityOf({ type: 'touchstart' })).toBe('touch')
    expect(modalityOf({ type: 'mousedown' })).toBe('touch')
  })
  it('a key that moves focus is keyboard, a lone modifier says nothing', () => {
    expect(modalityOf({ type: 'keydown', key: 'Tab' })).toBe('keyboard')
    expect(modalityOf({ type: 'keydown', key: 'Enter' })).toBe('keyboard')
    expect(modalityOf({ type: 'keydown', key: 'Shift' })).toBeNull()
    expect(modalityOf({ type: 'keydown' })).toBeNull()
  })
  it('anything else says nothing', () => {
    expect(modalityOf({ type: 'scroll' })).toBeNull()
  })
})
