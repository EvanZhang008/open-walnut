/**
 * Where the sidebar Voice panel's Insert goes (voice-status.ts): the composer
 * that registered last, unless the user focused a box whose mic named it. A box
 * mic that merely mounts (an inbox reply, a Board card) never takes the target.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

class FakeNode {
  constructor(private readonly kids: FakeNode[] = [], readonly tagName?: string) {}
  contains(n: unknown): boolean { return n === this || this.kids.some((k) => k.contains(n)) }
}
let focusIn: ((e: { target: unknown }) => void) | null = null

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).Node = FakeNode
  ;(globalThis as Record<string, unknown>).document = {
    addEventListener: (type: string, fn: (e: { target: unknown }) => void) => { if (type === 'focusin') focusIn = fn },
  }
})

const unregister: Array<() => void> = []
afterEach(() => { for (const u of unregister.splice(0)) u() })

async function load() {
  return import('../../web/src/utils/voice-status')
}

describe('voice insert target', () => {
  it('a composer that registers last takes Insert; a mounting box mic does not', async () => {
    const { registerVoiceInsertTarget, insertVoiceText } = await load()
    const got: string[] = []
    unregister.push(registerVoiceInsertTarget((t) => got.push(`composer:${t}`)))
    const box = new FakeNode()
    unregister.push(registerVoiceInsertTarget((t) => got.push(`box:${t}`), () => box as unknown as Element))
    expect(insertVoiceText('a')).toBe(true)
    expect(got).toEqual(['composer:a'])
  })

  it('focusing a box (or something inside it) moves Insert there, and its unmount hands it back', async () => {
    const { registerVoiceInsertTarget, insertVoiceText } = await load()
    const got: string[] = []
    unregister.push(registerVoiceInsertTarget((t) => got.push(`composer:${t}`)))
    const inner = new FakeNode()
    const box = new FakeNode([inner])
    const off = registerVoiceInsertTarget((t) => got.push(`box:${t}`), () => box as unknown as Element)
    focusIn?.({ target: inner })
    insertVoiceText('b')
    off()
    insertVoiceText('c')
    expect(got).toEqual(['box:b', 'composer:c'])
  })

  it('focus outside every named box changes nothing; a box gone from the page is skipped', async () => {
    const { registerVoiceInsertTarget, insertVoiceText } = await load()
    const got: string[] = []
    unregister.push(registerVoiceInsertTarget((t) => got.push(`composer:${t}`)))
    const box = new FakeNode()
    let mounted = true
    unregister.push(registerVoiceInsertTarget((t) => got.push(`box:${t}`), () => (mounted ? box as unknown as Element : null)))
    focusIn?.({ target: new FakeNode() })
    insertVoiceText('d')
    mounted = false
    focusIn?.({ target: box })
    insertVoiceText('e')
    expect(got).toEqual(['composer:d', 'composer:e'])
  })

  it('typing in the composer after a box gives Insert back to the composer', async () => {
    const { registerVoiceInsertTarget, insertVoiceText } = await load()
    const got: string[] = []
    unregister.push(registerVoiceInsertTarget((t) => got.push(`composer:${t}`)))
    const box = new FakeNode()
    unregister.push(registerVoiceInsertTarget((t) => got.push(`box:${t}`), () => box as unknown as Element))
    focusIn?.({ target: box })
    insertVoiceText('g')
    focusIn?.({ target: new FakeNode([], 'TEXTAREA') })
    insertVoiceText('h')
    // A press on a button (no text box) changes nothing.
    focusIn?.({ target: box })
    focusIn?.({ target: new FakeNode([], 'BUTTON') })
    insertVoiceText('i')
    expect(got).toEqual(['box:g', 'composer:h', 'box:i'])
  })

  it('no target at all reports false (the panel falls back to the clipboard)', async () => {
    const { insertVoiceText } = await load()
    expect(insertVoiceText('f')).toBe(false)
  })
})
