import { describe, expect, it } from 'vitest'
import { addMailCalendarHelp, mailCalendarHelp, mailCalendarMatch, mailServerCalendarHelp, signInRowHelp } from '../../web/src/components/settings/sections/calendar-mail-accounts.js'
import { canonicalAddress, sameAccount, signInProvider } from '../../src/integrations/calendar/sign-in-provider.js'

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

describe('a Gmail or Outlook calendar by sign-in (mail_calendars)', () => {
  it('walks to a client first, then offers the sign-in, naming a Drive client it reuses', () => {
    expect(signInRowHelp('Google', { clientReady: false, signedIn: false })).toMatch(/need a Google sign-in.*First set up a Google client below/)
    expect(signInRowHelp('Google', { clientReady: true, clientFrom: 'drive', signedIn: false })).toContain('with the Google client your Drive backups use')
    expect(signInRowHelp('Microsoft', { clientReady: true, clientFrom: 'calendar', signedIn: false })).toMatch(/Microsoft sign-in.*Sign in with Microsoft to read it here\.$/)
    // Two Outlook rows and no client yet: the steps show once, on the first row; the others point there.
    expect(signInRowHelp('Microsoft', { clientReady: false, signedIn: false, clientSetupAt: 'pat@outlook.com' })).toMatch(/First set up a Microsoft client on the row of pat@outlook\.com above \(once, for every Microsoft account\)\.$/)
  })
  it('says a sign-in that worked but whose calendar is not read yet, and who signed in', () => {
    expect(signInRowHelp('Google', { clientReady: true, signedIn: true, email: 'pat@gmail.com' })).toBe('Signed in to Google as pat@gmail.com, but its calendar is not read yet. Add its calendar to try again.')
  })
  it('a signed-in calendar says where it comes from, and that an ended sign-in keeps its events', () => {
    expect(mailServerCalendarHelp({ available: true }, 1, 'Google')).toBe('Its calendar comes from Google: one calendar, listed above under its address. Remove its calendar also signs Walnut out of it on this computer.')
    // Signed in with Drive backups' client (or a grant another sign-in holds): Remove leaves the grant, and says so.
    expect(mailServerCalendarHelp({ available: true }, 1, 'Google', true)).toBe("Its calendar comes from Google: one calendar, listed above under its address. Remove its calendar also signs Walnut out of it on this computer (Walnut stays in your Google account's app list until you remove it there).")
    expect(mailServerCalendarHelp({ available: true }, 2, 'Microsoft')).toMatch(/2 calendars.*signs Walnut out of it on this computer \(Walnut stays in your Microsoft account's app list until you remove it there\)\.$/)
    expect(mailServerCalendarHelp({ available: false, reason: 'needs-sign-in', message: 'The Google sign-in for this calendar was revoked or has expired. Sign in again.' }, 1, 'Google'))
      .toBe('The Google sign-in for this calendar was revoked or has expired. Sign in again. Its events stay as they were read until then.')
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

describe('sameAccount: a sign-in that is the row\'s own account', () => {
  it('reads Gmail as Google does: dots, a +tag and googlemail.com do not matter', () => {
    expect(canonicalAddress(' Pat.Smith+mail@GoogleMail.com ')).toBe('patsmith@gmail.com')
    expect(sameAccount('pat.smith@gmail.com', 'patsmith@gmail.com')).toBe(true)
    expect(sameAccount('patsmith@googlemail.com', 'pat.smith+news@gmail.com')).toBe(true)
    expect(sameAccount('lee@gmail.com', 'pat@gmail.com')).toBe(false)
    // Dots matter everywhere else.
    expect(canonicalAddress('pat.smith@outlook.com')).toBe('pat.smith@outlook.com')
  })

  it('takes a work sign-in name on the row\'s own domain (a UPN), never another person on a personal domain', () => {
    expect(sameAccount('rlee@corp.example', 'robin.lee@corp.example')).toBe(true)
    expect(sameAccount('RLee@Corp.Example', 'robin.lee@corp.example')).toBe(true)
    expect(sameAccount('sam@contoso.example', 'robin.lee@corp.example')).toBe(false)
    expect(sameAccount('sam@outlook.com', 'pat@outlook.com')).toBe(false)
    expect(sameAccount('sam@hotmail.co.uk', 'pat@hotmail.co.uk')).toBe(false)
    expect(sameAccount('lee@gmail.com', 'pat@acme.example')).toBe(false)
  })
})
