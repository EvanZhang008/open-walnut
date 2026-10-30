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

import { LEAD_NEWS_ONCE_LINE, MAIN_NEWS_ONCE_LINE, ORG_REPLY_LANGUAGE_LINE, WALNUT_PROMPT_MARK, defaultInstructions } from '../../../src/core/sessions/session-context.js'
import { instructionNoticeFor } from '../../../src/core/sessions/instruction-notice.js'

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

  // 2026-10-30 org review: a lead passed a result to Main, wrote the whole summary in its own chat,
  // and Main posted it again; the user read the same news twice.
  it('news reaches the user once: a lead that passed a result up says one line, Main tells the user', () => {
    expect(LEAD_NEWS_ONCE_LINE).toMatch(/end your own turn with one line saying what you passed and to whom/)
    expect(LEAD_NEWS_ONCE_LINE).toMatch(/Tell the user directly only what only you know and they must act on/)
    expect(MAIN_NEWS_ONCE_LINE).toMatch(/a result a lead passes up to you is yours to tell/)
    const lead = defaultInstructions({ org_role: 'lead', project: 'Walnut' })
    const main = defaultInstructions({ org_role: 'main', project: 'Main' })
    expect(lead).toContain(LEAD_NEWS_ONCE_LINE.trim())
    expect(lead).not.toContain(MAIN_NEWS_ONCE_LINE.trim())
    expect(main).toContain(MAIN_NEWS_ONCE_LINE.trim())
    expect(main).not.toContain(LEAD_NEWS_ONCE_LINE.trim())
    expect(defaultInstructions({ project: 'Walnut' })).not.toMatch(/News reaches the user once/)
  })

  it('a running lead and Main spawned before the rule hear it through the instruction notice', () => {
    for (const [task, line] of [
      [{ org_role: 'lead', project: 'Walnut' }, LEAD_NEWS_ONCE_LINE],
      [{ org_role: 'main', project: 'Main' }, MAIN_NEWS_ONCE_LINE],
    ] as const) {
      const old = `${WALNUT_PROMPT_MARK}\n` + defaultInstructions(task).split('\n').filter((l) => l.trim() !== line.trim()).join('\n')
      const notice = instructionNoticeFor({ appliedAppendSystemPrompt: old } as never, task)
      expect(notice).toContain(line.trim())
      const current = `${WALNUT_PROMPT_MARK}\n` + defaultInstructions(task)
      expect(instructionNoticeFor({ appliedAppendSystemPrompt: current } as never, task)).toBeNull()
    }
  })
})

