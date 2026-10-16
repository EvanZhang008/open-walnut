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

  it('every write of a copied store needs the Mac', () => {
    for (const [m, p] of [['PUT', '/api/ui-prefs'], ['POST', '/api/favorites/projects/Acme'], ['PUT', '/api/config'], ['POST', '/api/routines'], ['PATCH', '/api/routines/rt-1'], ['POST', '/api/agents/general/conversations'], ['PATCH', '/api/agents/general/conversations/conv-1']] as const) {
      expect([m, p, classify(m, p).away]).toEqual([m, p, 'needs-leader'])
    }
  })
})
