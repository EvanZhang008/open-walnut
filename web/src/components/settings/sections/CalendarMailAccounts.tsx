/**
 * Calendar Accounts' "Mail accounts" group: each mail account Walnut reads, and whether its
 * calendar comes in (calendar-mail-accounts.ts says how that is told). Nothing shows while
 * the mail plugin is off or has no account.
 */
import { useEffect, useState } from 'react'
import { listMailAccounts, type MailAccountDto } from '@/api/mail'
import type { CalendarInfo } from '@/api/calendar'
import { SettingsGroup, SettingsRow, SettingsTag } from '../SettingsSection'
import { mailCalendarHelp, mailCalendarMatch, type MailCalendarMatch } from './calendar-mail-accounts'

const MATCH_TAG: Readonly<Record<MailCalendarMatch['kind'], string>> = {
  here: 'Calendar here',
  likely: 'Likely here',
  'kind-here': 'Not verified',
  missing: 'No match found',
}

export function CalendarMailAccounts({ calendars }: { calendars: readonly CalendarInfo[] }) {
  const [accounts, setAccounts] = useState<MailAccountDto[] | null>(null)
  useEffect(() => {
    let live = true
    listMailAccounts().then((answer) => { if (live) setAccounts(answer.accounts ?? []) }, () => { if (live) setAccounts([]) })
    return () => { live = false }
  }, [])
  if (!accounts || accounts.length === 0) return null
  return (
    <SettingsGroup
      heading="Mail accounts"
      description="Walnut reads calendars through this Mac, so a mail account's calendar comes in once the Mac has that account too. Mail set up only in Walnut (IMAP) carries no calendar."
      data-testid="calendar-mail-accounts"
    >
      {accounts.map((account) => {
        const match = mailCalendarMatch(account.address, calendars)
        return (
          <SettingsRow
            key={account.accountId}
            data-testid={`calendar-mail-account-${account.accountId}`}
            data-match={match.kind}
            label={account.displayName && account.displayName !== account.address ? `${account.displayName} (${account.address})` : account.address}
            help={mailCalendarHelp(match)}
            control={<SettingsTag tone={match.kind === 'here' ? 'success' : 'neutral'}>{MATCH_TAG[match.kind]}</SettingsTag>}
          />
        )
      })}
    </SettingsGroup>
  )
}
