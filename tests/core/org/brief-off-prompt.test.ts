/**
 * The org prompt with the experiment brief_off off is byte for byte what it was before the
 * experiment (src/core/sessions/session-context.ts ORG_MANUALS): the away rule, the Brief rules,
 * the Threads rules and the walnut-about rule, in that order and nothing else. On, the Brief and
 * Threads rules give way to their shorter off lines, and switching back gives the same bytes again.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  AWAY_INBOX_LINE, BRIEF_LINE, BRIEF_OFF_LINE, MESSAGE_ABOUT_LINE, THREADS_LINE, THREADS_OFF_LINE, orgRoleParts,
} from '../../../src/core/sessions/session-context.js'
import { setBriefOff } from '../../../src/core/org/brief-off.js'

const OLD_MANUALS = AWAY_INBOX_LINE + BRIEF_LINE + THREADS_LINE + MESSAGE_ABOUT_LINE
const roles = [{ org_role: 'main' }, { org_role: 'lead', project: 'Garden', org_name: 'Garden lead' }]
const role = (task: (typeof roles)[number]) => orgRoleParts(task)[0]![1]

afterEach(() => setBriefOff(false))

describe('the org prompt and brief_off', () => {
  it('off: the manuals are the old string exactly; on: the off lines, shorter; off again: the same bytes', () => {
    for (const task of roles) {
      setBriefOff(false)
      const off = role(task)
      expect(off).toContain(OLD_MANUALS)
      expect(off).not.toContain(BRIEF_OFF_LINE)
      expect(off).not.toContain(THREADS_OFF_LINE)
      setBriefOff(true)
      const on = role(task)
      expect(on).toContain(AWAY_INBOX_LINE + BRIEF_OFF_LINE + THREADS_OFF_LINE + MESSAGE_ABOUT_LINE)
      expect(on).not.toContain(BRIEF_LINE)
      expect(on.length).toBeLessThan(off.length)
      expect(on.replace(BRIEF_OFF_LINE + THREADS_OFF_LINE, BRIEF_LINE + THREADS_LINE)).toBe(off)
      setBriefOff(false)
      expect(role(task)).toBe(off)
    }
  })
})
