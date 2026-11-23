import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SLOW_READ_MS } from '../../../src/core/usage-watch/record.js'
import { SUPERVISION_READ_DEADLINE_MS } from '../../../src/core/sessions/session-supervision.js'
import { GLANCE_COLD_WAIT_MS, GLANCE_REFRESH_WAIT_MS } from '../../../src/core/session-git-status.js'

// 2026-11-23: two polled reads waited on a host longer than the usage watch's slow read: the
// git glance's refresh held its request 8 s for a recompute that also arrives as an event, and the
// supervision read went past the page's own 8 s timeout. A wait a read route holds for a host
// stays under SLOW_READ_MS; a later answer reaches the page another way (an event, the next poll).
const ROOT = path.resolve(__dirname, '../../..')

describe('read routes answer before the slow-read line', () => {
  it('the git glance and supervision waits stay under SLOW_READ_MS', () => {
    for (const ms of [GLANCE_COLD_WAIT_MS, GLANCE_REFRESH_WAIT_MS, SUPERVISION_READ_DEADLINE_MS]) expect(ms).toBeLessThan(SLOW_READ_MS)
  })

  it('the supervision read deadline is under the page\'s own timeout for it', () => {
    const api = fs.readFileSync(path.join(ROOT, 'web/src/api/sessions.ts'), 'utf8')
    const line = api.split('\n').find((l) => l.includes('/supervision`') && l.includes('apiGet'))
    const timeout = Number(/timeoutMs:\s*([\d_]+)/.exec(line ?? '')?.[1]?.replace(/_/g, ''))
    expect(timeout).toBeGreaterThan(0)
    expect(SUPERVISION_READ_DEADLINE_MS).toBeLessThan(timeout)
  })

  it('no route passes a literal host wait at or past SLOW_READ_MS', () => {
    const dir = path.join(ROOT, 'src/web/routes')
    const hits: string[] = []
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      fs.readFileSync(path.join(dir, file), 'utf8').split('\n').forEach((text, i) => {
        for (const m of text.matchAll(/waitMs:[^,}]*?\b(\d[\d_]{3,})\b/g)) {
          if (Number(m[1].replace(/_/g, '')) >= SLOW_READ_MS) hits.push(`${file}:${i + 1}: ${text.trim()}`)
        }
      })
    }
    expect(hits).toEqual([])
  })
})
