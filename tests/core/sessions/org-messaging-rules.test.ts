/**
 * Two prompt rules from the 2026-10-29 org reflection (src/core/sessions/session-context.ts):
 *   - Main's and every lead's chat is read by the user whoever started the turn, so it is written
 *     in the user's reply language; messages to other tasks stay English (leads had answered
 *     Walnut notices in English there).
 *   - A task answering another task's request sends its result only to that task, and letters
 *     the user only when the user asked it for a letter or report (finished work reached the
 *     user twice, a worker's letter and Main's chat a minute apart).
 * Both ride the default instructions, so a running session hears them through the instruction notice.
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-org-messaging-rules'))

import { ORG_REPLY_LANGUAGE_LINE, defaultInstructions } from '../../../src/core/sessions/session-context.js'

describe('the org messaging rules ride the default instructions', () => {
  it('Main and a lead write their chat in the user\'s language; a worker is not told so', () => {
    expect(ORG_REPLY_LANGUAGE_LINE).toMatch(/whoever started the turn/)
    expect(ORG_REPLY_LANGUAGE_LINE).toMatch(/stays in English/)
    expect(defaultInstructions({ org_role: 'main', project: 'Main' })).toContain(ORG_REPLY_LANGUAGE_LINE.trim())
    expect(defaultInstructions({ org_role: 'lead', project: 'Walnut' })).toContain(ORG_REPLY_LANGUAGE_LINE.trim())
    expect(defaultInstructions({ project: 'Walnut' })).not.toContain(ORG_REPLY_LANGUAGE_LINE.trim())
  })

  it('every task answers a request to the asker alone', () => {
    for (const t of [{ project: 'Walnut' }, { org_role: 'lead', project: 'Walnut' }, { org_role: 'main', project: 'Main' }]) {
      const text = defaultInstructions(t)
      expect(text).toMatch(/Answering another task's request \(Main, a lead\): your result goes only to it, in your reply, and it tells the user/)
      expect(text).toMatch(/only if the user themself asked this task for a letter or report/)
    }
  })
})
