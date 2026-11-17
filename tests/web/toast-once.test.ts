/**
 * Once per problem until it heals (web/src/contexts/notifications/toast-once.ts, read by
 * notify() for the server's errors). 2026-11-17, the user: "if it show once don't show it so
 * many times". The same problem reported N times toasts once; healed and broken again, once more.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
}

const once = await import('../../web/src/contexts/notifications/toast-once')

beforeEach(() => { (globalThis as { localStorage?: unknown }).localStorage = new MemStorage() })

describe('a problem toasts once until it heals', () => {
  it('the same problem reported 12 times toasts once', () => {
    let toasts = 0
    for (let i = 0; i < 12; i++) if (once.firstToastUntilHealed('error:plugin:mail:sign-in')) toasts++
    expect(toasts).toBe(1)
  })

  it('healed, then broken again: one more toast', () => {
    expect(once.firstToastUntilHealed('k')).toBe(true)
    expect(once.firstToastUntilHealed('k')).toBe(false)
    once.healedOnce('k')
    expect(once.firstToastUntilHealed('k')).toBe(true)
  })

  it('notify() asks it for every server error it would toast, and a recovery releases it', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src/contexts/notifications/NotificationProvider.tsx'), 'utf8')
    expect(src).toMatch(/input\.fromServer && !firstToastUntilHealed\(input\.dedupKey\)/)
    expect(src).toMatch(/r\.resolved === 'recovered'\) healedOnce\(r\.dedupKey\)/)
  })
})
