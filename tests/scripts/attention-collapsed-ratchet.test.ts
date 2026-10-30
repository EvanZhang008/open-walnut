/**
 * Home's system attention section starts collapsed, so a host row in it is in the
 * DOM but hidden until the section is opened. 2026-10-30: browser specs written
 * before that waited for a row to be visible and failed on HEAD (host problems,
 * cloud companion, proxy login). Every spec that waits on a host row opens the
 * section (`expandSystemAttention`, host-problems-helpers.ts) or is listed here
 * with why it need not.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const BROWSER = path.resolve(import.meta.dirname, '..', 'e2e', 'browser')

const EXEMPT: Record<string, string> = {
  'banner-mount-behaviour.spec.ts': 'reads host rows in the notification panel, which never collapses; its Home card checks only how many rows there are',
}

describe('specs open the collapsed system attention section', () => {
  it('every spec that waits on a host row opens the section first', () => {
    const waiting = fs.readdirSync(BROWSER)
      .filter((n) => n.endsWith('.spec.ts'))
      .filter((n) => { const s = fs.readFileSync(path.join(BROWSER, n), 'utf-8'); return s.includes('hpb-row') && s.includes('toBeVisible') })
    expect(waiting.length).toBeGreaterThan(5)
    for (const n of waiting) {
      if (EXEMPT[n]) continue
      expect(fs.readFileSync(path.join(BROWSER, n), 'utf-8'), `${n} waits on a host row; call expandSystemAttention(page) first`).toMatch(/expandSystemAttention|system-attention-toggle/)
    }
    for (const n of Object.keys(EXEMPT)) expect(waiting, `${n} no longer waits on a host row; drop it from EXEMPT`).toContain(n)
  })
})
