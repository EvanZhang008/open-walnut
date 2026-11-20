/**
 * His reply on a thread card is drawn at once, never only after the next read of the list
 * (2026-11-20, the user, on a card that stayed in Needs you after his reply: "why this even keep
 * showing after I replied?"; on a copy of his data a read of the lead's Threads took 2 to 4 s and a
 * read started before the reply drew the card back). Every card path that sends his words must call
 * `state.heard` once the send went; a new path fails here until it does.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { heardOn } from '../../web/src/components/org/useOrgThreads'
import type { OrgThread } from '../../web/src/api/org-threads'

const base = { id: 'th-1', title: 'Store switch', messages: [], createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z' } as unknown as OrgThread

describe('heardOn', () => {
  it('moves a thread waiting on him to working with his words, its held ask answered', () => {
    const t = { ...base, state: 'needs', heldAsk: { id: 'ak-1', ask: 'Now or later?', was: 'working' } } as unknown as OrgThread
    const out = heardOn(t, undefined, 'Now please', '2026-11-20T01:00:00.000Z')
    expect(out.state).toBe('working')
    expect((out as { heldAsk?: unknown }).heldAsk).toBeUndefined()
    expect(out.messages.map((m) => m.text)).toEqual(['Now please'])
  })
  it('takes the record the server answered with, keeping what the list adds', () => {
    const t = { ...base, state: 'needs', owner: { task_id: 'tk-1', title: 'Owner' } } as unknown as OrgThread
    const saved = { ...base, state: 'working', messages: [{ id: 'tm-1', at: '2026-11-20T01:00:00.000Z', text: 'Now', via: 'follow-up' }] } as unknown as OrgThread
    const out = heardOn(t, saved) as OrgThread & { owner?: { task_id: string } }
    expect(out.state).toBe('working')
    expect(out.owner?.task_id).toBe('tk-1')
    expect(out.messages).toHaveLength(1)
  })
  it('leaves a closed thread closed', () => {
    const t = { ...base, state: 'answered', closed: { how: 'acked', at: '2026-11-20T00:00:00.000Z', by: 'human' } } as unknown as OrgThread
    expect(heardOn(t, undefined, 'x')).toBe(t)
  })
})

describe('every card path that sends his words draws it at once', () => {
  const dir = path.join(__dirname, '../../web/src/components/org')
  const files = fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && f !== 'useOrgThreads.ts')
  // A send from a card: his reply below (replyOnOrgThread) or the thread's own Follow up / choice (onFollowUp(t.id, ...)).
  const SEND = /\breplyOnOrgThread\(|\bonFollowUp\(t\.id\b/g
  it('found the send paths', () => {
    const total = files.reduce((n, f) => n + (fs.readFileSync(path.join(dir, f), 'utf8').match(SEND)?.length ?? 0), 0)
    expect(total).toBeGreaterThanOrEqual(3)
  })
  for (const f of files) {
    it(f, () => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8')
      const sends = src.match(SEND)?.length ?? 0
      const draws = src.match(/\bstate\.heard\(/g)?.length ?? 0
      // A pass-through (onSend={(text) => onFollowUp(t.id, text)}) on a card that is not waiting on him moves nothing.
      const passThrough = src.match(/onSend=\{\(text, images\) => onFollowUp\(t\.id, text, images\)\}/g)?.length ?? 0
      expect(draws, `${f}: ${sends} send(s), ${draws} state.heard call(s)`).toBeGreaterThanOrEqual(sends - passThrough)
    })
  }
})
