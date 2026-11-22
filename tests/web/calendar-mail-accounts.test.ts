import { describe, expect, it } from 'vitest'
import { addMailCalendarHelp, mailCalendarHelp, mailCalendarMatch, mailServerCalendarHelp } from '../../web/src/components/settings/sections/calendar-mail-accounts.js'
import { signInProvider } from '../../src/integrations/calendar/sign-in-provider.js'

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

describe("a mail account's calendar from its own server (mail_calendars)", () => {
  it('offers to add it, saying where it would come from', () => {
    expect(addMailCalendarHelp({ kind: 'missing' })).toContain('straight from its mail server')
    expect(addMailCalendarHelp({ kind: 'kind-here', account: 'Google' })).toContain('Or add its calendar from its mail server')
  })
  it('says how many calendars came, or why none is read', () => {
    expect(mailServerCalendarHelp({ available: true }, 1)).toContain('one calendar')
    expect(mailServerCalendarHelp({ available: true }, 3)).toContain('3 calendars')
    expect(mailServerCalendarHelp({ available: false, reason: 'auth-failed', message: 'refused the saved mail password' }, 0)).toContain('refused the saved mail password')
    expect(mailServerCalendarHelp({ available: false, reason: 'disabled' }, 2)).toContain('external calendars are off')
  })
})


describe('signInProvider: the accounts a mail password cannot read a calendar of', () => {
  it('names Google and Microsoft by address or by mail server, and nothing else', () => {
    expect(signInProvider({ address: 'pat@gmail.com' })).toBe('Google')
    expect(signInProvider({ address: 'pat@acme.example', hosts: { imap: 'imap.gmail.com' } })).toBe('Google')
    expect(signInProvider({ address: 'pat@outlook.com' })).toBe('Microsoft')
    expect(signInProvider({ address: 'pat@acme.example', hosts: { smtp: 'smtp.office365.com' } })).toBe('Microsoft')
    expect(signInProvider({ address: 'pat@icloud.com' })).toBeNull()
    expect(signInProvider({ address: 'pat@fastmail.com', hosts: { imap: 'imap.fastmail.com' } })).toBeNull()
  })
})
