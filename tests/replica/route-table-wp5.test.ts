/**
 * The WP5 rows of the host replica's route table (src/replica/route-table.ts): the
 * copied lists, routines, prefs, favorites and config read here while the Mac is
 * away (the default read row), conversation bodies (never copied) need the Mac,
 * and every write of those stores is a needs-leader row.
 */
import { describe, expect, it } from 'vitest'
import { classify } from '../../src/replica/route-table.js'

describe('WP5 copies on the route table', () => {
  it('the copied reads run here while away', () => {
    for (const p of ['/api/agents/general/conversations', '/api/routines', '/api/cron', '/api/routines/status', '/api/ui-prefs', '/api/favorites', '/api/config']) {
      expect([p, classify('GET', p)]).toMatchObject([p, { cls: 'leader', away: 'read' }])
    }
  })

  it('conversation bodies need the Mac while away', () => {
    // The phone's twins too: the copied list says a conversation exists, so a body read here answers an empty 200.
    for (const p of ['/api/chat/history', '/api/chat/stats', '/api/chat/triage', '/api/v1/conversations/conv-1/messages', '/api/v1/chat/stats']) {
      expect([p, classify('GET', p)]).toMatchObject([p, { cls: 'leader', away: 'needs-leader', why: 'conversation_bodies_need_mac' }])
    }
  })

  it('every write of a copied store needs the Mac, and says which store (the console shows its words)', () => {
    const rows: Array<[string, string, string]> = [
      ['PUT', '/api/config', 'config_writes_need_mac'],
      ['POST', '/api/routines', 'routine_writes_need_mac'],
      ['PATCH', '/api/routines/rt-1', 'routine_writes_need_mac'],
      ['DELETE', '/api/routines/rt-1', 'routine_writes_need_mac'],
      ['POST', '/api/routines/rt-1/toggle', 'routine_writes_need_mac'],
      ['POST', '/api/cron', 'routine_writes_need_mac'],
      ['PATCH', '/api/cron/rt-1', 'routine_writes_need_mac'],
      ['POST', '/api/v1/routines', 'routine_writes_need_mac'],
      ['PATCH', '/api/v1/routines/rt-1', 'routine_writes_need_mac'],
      ['POST', '/api/v1/routines/rt-1/toggle', 'routine_writes_need_mac'],
      ['PUT', '/api/ui-prefs', 'prefs_writes_need_mac'],
      ['POST', '/api/favorites/projects/Acme', 'prefs_writes_need_mac'],
      ['DELETE', '/api/favorites/projects/Acme', 'prefs_writes_need_mac'],
      ['POST', '/api/favorites/notes', 'prefs_writes_need_mac'],
      ['DELETE', '/api/favorites/notes', 'prefs_writes_need_mac'],
      ['POST', '/api/agents/general/conversations', 'conversation_writes_need_mac'],
      ['PUT', '/api/agents/general/conversations/active', 'conversation_writes_need_mac'],
      ['PATCH', '/api/agents/general/conversations/conv-1', 'conversation_writes_need_mac'],
      ['DELETE', '/api/agents/general/conversations/conv-1', 'conversation_writes_need_mac'],
      ['PUT', '/api/v1/conversations/active', 'conversation_writes_need_mac'],
      ['PATCH', '/api/v1/conversations/conv-1', 'conversation_writes_need_mac'],
      ['DELETE', '/api/v1/conversations/conv-1', 'conversation_writes_need_mac'],
    ]
    for (const [m, p, why] of rows) {
      expect([m, p, classify(m, p)]).toMatchObject([m, p, { cls: 'leader', away: 'needs-leader', why }])
    }
  })

  it('a routine route that changes no routine is not called a routine change', () => {
    // `:id` would take these: the exact methods keep them on the plain away answer.
    for (const p of ['/api/routines/draft', '/api/routines/check-test', '/api/routines/trigger', '/api/v1/routines/draft']) {
      const d = classify('POST', p)
      expect([p, d.away, d.why]).toEqual([p, 'needs-leader', undefined])
    }
    // Nor a settings test, which writes nothing.
    expect(classify('POST', '/api/config/test-connection').why).toBeUndefined()
  })
})
