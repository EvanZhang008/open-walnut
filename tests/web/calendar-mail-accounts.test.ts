import { describe, expect, it } from 'vitest'
import { mailCalendarHelp, mailCalendarMatch } from '../../web/src/components/settings/sections/calendar-mail-accounts.js'

const calendars = [
  { account: 'iCloud', title: 'Home' },
  { account: 'Google', title: 'Family' },
  { account: 'Google', title: 'pat@gmail.com' },
  { account: 'pat@corp.example', title: 'Calendar' },
  { account: 'Exchange', title: 'Holidays' },
]

describe("a mail account's calendar through the Mac", () => {
  it('matches an account macOS names by the address, in any case', () => {
    expect(mailCalendarMatch('Pat@Corp.Example', calendars)).toEqual({ kind: 'here', account: 'pat@corp.example' })
  })
  it("says likely for a Google account's main calendar titled by the address, never sure", () => {
    expect(mailCalendarMatch('pat@gmail.com', calendars)).toEqual({ kind: 'likely', account: 'Google' })
  })
  it('says only "a Google account is here" when the address names none of it', () => {
    expect(mailCalendarMatch('sam@gmail.com', calendars)).toEqual({ kind: 'kind-here', account: 'Google' })
    expect(mailCalendarMatch('sam@icloud.com', calendars)).toEqual({ kind: 'kind-here', account: 'iCloud' })
  })
  it('says missing for an address the Mac has no account of, and for an empty one', () => {
    expect(mailCalendarMatch('sam@fastmail.com', calendars)).toEqual({ kind: 'missing' })
    expect(mailCalendarMatch('sam@gmail.com', calendars.filter((c) => c.account !== 'Google'))).toEqual({ kind: 'missing' })
    expect(mailCalendarMatch('  ', calendars)).toEqual({ kind: 'missing' })
  })
  it('has a line for every answer', () => {
    for (const match of [mailCalendarMatch('pat@gmail.com', calendars), mailCalendarMatch('sam@gmail.com', calendars), mailCalendarMatch('x@y.z', calendars)]) {
      expect(mailCalendarHelp(match).length).toBeGreaterThan(10)
    }
  })
})
