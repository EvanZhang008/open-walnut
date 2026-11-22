/**
 * Whether a mail account's calendar reaches Walnut. Walnut reads calendars through macOS
 * (EventKit), and a mail account is set up in Walnut on its own (IMAP has no calendar at
 * all; an Outlook provider reads mail only), so an account's calendar is here exactly when
 * the Mac has that account too. The address tells: macOS names an Exchange account by its
 * address (a sure match); a Google account's main calendar carries its address as its title
 * (likely, since a shared calendar can too). A Mac account of the same
 * kind whose name says nothing (Google, iCloud) is reported as that, never as a match.
 */
export type MailCalendarMatch =
  | { kind: 'here'; account: string }
  | { kind: 'likely'; account: string }
  | { kind: 'kind-here'; account: string }
  | { kind: 'missing' }

const KIND_BY_DOMAIN: Readonly<Record<string, string>> = {
  'gmail.com': 'Google',
  'googlemail.com': 'Google',
  'icloud.com': 'iCloud',
  'me.com': 'iCloud',
  'mac.com': 'iCloud',
}

export function mailCalendarMatch(address: string, calendars: readonly { account: string; title: string }[]): MailCalendarMatch {
  const wanted = address.trim().toLowerCase()
  if (!wanted) return { kind: 'missing' }
  const byAccount = calendars.find((calendar) => calendar.account.trim().toLowerCase() === wanted)
  if (byAccount) return { kind: 'here', account: byAccount.account }
  const byTitle = calendars.find((calendar) => calendar.title.trim().toLowerCase() === wanted)
  // A calendar titled by the address (a Google account's main one) is strong but not proof: a
  // calendar someone shared can carry their address too.
  if (byTitle) return { kind: 'likely', account: byTitle.account }
  const kind = KIND_BY_DOMAIN[wanted.split('@').pop() ?? '']
  if (kind && calendars.some((calendar) => calendar.account === kind)) return { kind: 'kind-here', account: kind }
  return { kind: 'missing' }
}

/** The one line a mail account's row says about its calendar. */
export function mailCalendarHelp(match: MailCalendarMatch): string {
  switch (match.kind) {
    case 'here': return `Its calendar is here, under ${match.account}.`
    case 'likely': return `A calendar named by this address is here, under ${match.account}.`
    case 'kind-here': return `This Mac has a ${match.account} account, listed above; its address does not say whether it is this one.`
    // An address can name none of its calendars (a work domain on a Google account): a check, not a verdict.
    case 'missing': return 'No calendar here matches this address. If it should be here, check that this account is in macOS System Settings, Internet Accounts, with Calendars on.'
  }
}

/**
 * A mail account's calendar read from its own server (the `mail_calendars` experiment): the
 * line its row says. `status` is that calendar's source status from `GET /sources`.
 */
export function mailServerCalendarHelp(status: { available: boolean; reason?: string; message?: string }, calendarCount: number): string {
  if (!status.available) {
    if (status.reason === 'disabled') return 'Its calendar comes from its mail server; external calendars are off above.'
    return `Its calendar is not read right now: ${status.message ?? 'its server did not answer.'}`
  }
  if (calendarCount === 0) return 'Its calendar comes from its mail server.'
  return `Its calendar comes from its mail server: ${calendarCount === 1 ? 'one calendar' : `${calendarCount} calendars`}, listed above under its address.`
}

/** The line of a row that can still get its calendar from the mail server. */
export function addMailCalendarHelp(match: MailCalendarMatch): string {
  switch (match.kind) {
    case 'missing': return 'No calendar here matches this address. Add its calendar to read it straight from its mail server with the password saved for its mail.'
    default: return `${mailCalendarHelp(match)} Or add its calendar from its mail server.`
  }
}
