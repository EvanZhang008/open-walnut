/**
 * Calendar Accounts' "Mail accounts" group: each mail account Walnut reads, and whether its
 * calendar comes in (calendar-mail-accounts.ts says how that is told). Nothing shows while
 * the mail plugin is off or has no account.
 *
 * With the `mail_calendars` experiment on, an account whose calendar is not here gets "Add its
 * calendar": Walnut looks for it on the account's mail server with the saved password and says
 * plainly when it cannot (a provider that needs its own sign-in, a server with no calendar, its
 * error). A calendar read that way has "Remove its calendar". A server Walnut found somewhere
 * the account does not point gets no password until the person picks it here ("Use <host>").
 */
import { useEffect, useState } from 'react'
import { listMailAccounts, type MailAccountDto } from '@/api/mail'
import { addMailCalendar, removeMailCalendar, type CalendarInfo, type CalendarSourceStatus } from '@/api/calendar'
import { calendarSourceOf } from '../../../../../src/integrations/calendar/event-rules'
import { signInNeededText, signInProvider } from '../../../../../src/integrations/calendar/sign-in-provider'
import { useExperimental } from '@/hooks/useExperimental'
import { ensureCalendarsLoaded } from '@/stores/calendar-events-store'
import { SettingsGroup, SettingsRow, SettingsTag } from '../SettingsSection'
import { SettingsButton } from '../inputs/SettingsButton'
import { saveErrorMessage } from '../settings-pane-context'
import {
  addMailCalendarHelp,
  mailCalendarHelp,
  mailCalendarMatch,
  mailServerCalendarHelp,
  type MailCalendarMatch,
} from './calendar-mail-accounts'

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'this server'
  }
}

const MATCH_TAG: Readonly<Record<MailCalendarMatch['kind'], string>> = {
  here: 'Calendar here',
  likely: 'Likely here',
  'kind-here': 'Not verified',
  missing: 'No match found',
}

interface Props {
  calendars: readonly CalendarInfo[]
  /** Every calendar source's status (`GET /sources`); a mail account's own carries `account`. */
  sources?: readonly CalendarSourceStatus[]
  /** After a calendar was added or removed: read the accounts again. */
  onChanged?: () => void
}

export function CalendarMailAccounts({ calendars, sources = [], onChanged }: Props) {
  const [accounts, setAccounts] = useState<MailAccountDto[] | null>(null)
  const serverCalendars = useExperimental('mail_calendars')
  // Per account: a try in flight, and what the last try said when it found nothing.
  const [busy, setBusy] = useState<string | null>(null)
  const [said, setSaid] = useState<Record<string, string>>({})
  // Per account: a calendar server found where the account does not point, for the person to pick.
  const [found, setFound] = useState<Record<string, string>>({})
  useEffect(() => {
    let live = true
    listMailAccounts().then((answer) => { if (live) setAccounts(answer.accounts ?? []) }, () => { if (live) setAccounts([]) })
    return () => { live = false }
  }, [])
  if (!accounts || accounts.length === 0) return null

  const changed = () => {
    void ensureCalendarsLoaded(true)
    onChanged?.()
  }
  const without = (map: Record<string, string>, id: string) => { const next = { ...map }; delete next[id]; return next }
  const add = async (account: MailAccountDto, server?: string) => {
    setBusy(account.accountId)
    setSaid((prev) => without(prev, account.accountId))
    setFound((prev) => without(prev, account.accountId))
    try {
      const answer = await addMailCalendar(account.accountId, account.address, server)
      if (answer.ok) changed()
      else {
        setSaid((prev) => ({ ...prev, [account.accountId]: answer.message }))
        if (answer.reason === 'found-server' && answer.server) setFound((prev) => ({ ...prev, [account.accountId]: answer.server! }))
      }
    } catch (err) {
      setSaid((prev) => ({ ...prev, [account.accountId]: saveErrorMessage(err) }))
    } finally {
      setBusy(null)
    }
  }
  const remove = async (account: MailAccountDto) => {
    setBusy(account.accountId)
    try {
      await removeMailCalendar(account.accountId)
      changed()
    } catch (err) {
      setSaid((prev) => ({ ...prev, [account.accountId]: saveErrorMessage(err) }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsGroup
      heading="Mail accounts"
      description={serverCalendars
        ? "A mail account's calendar comes in through this Mac when the Mac has that account too, or straight from its mail server: Add its calendar uses the password saved for its mail."
        : 'Walnut reads calendars through this Mac, so a mail account\'s calendar comes in once the Mac has that account too. Mail set up only in Walnut (IMAP) carries no calendar.'}
      data-testid="calendar-mail-accounts"
    >
      {accounts.map((account) => {
        const label = account.displayName && account.displayName !== account.address ? `${account.displayName} (${account.address})` : account.address
        const own = serverCalendars ? sources.find((s) => s.kind === 'caldav' && s.account === account.accountId) : undefined
        if (own) {
          const count = calendars.filter((c) => calendarSourceOf(c.id) === own.id).length
          return (
            <SettingsRow
              key={account.accountId}
              data-testid={`calendar-mail-account-${account.accountId}`}
              data-match="server"
              label={label}
              help={said[account.accountId] ?? mailServerCalendarHelp(own, count)}
              state={own.available || own.reason === 'disabled' ? undefined : 'warning'}
              control={
                <span className="settings-addons-inline">
                  <SettingsTag tone={own.available ? 'success' : 'neutral'}>{own.available ? 'Calendar here' : 'Not read'}</SettingsTag>
                  <SettingsButton
                    variant="danger"
                    busy={busy === account.accountId}
                    busyLabel="Removing..."
                    disabled={busy !== null && busy !== account.accountId}
                    onClick={() => void remove(account)}
                    data-testid={`calendar-mail-remove-${account.accountId}`}
                  >
                    Remove its calendar
                  </SettingsButton>
                </span>
              }
            />
          )
        }
        const match = mailCalendarMatch(account.address, calendars)
        // Only an IMAP account's saved password can read a calendar server, and never Google's or Microsoft's.
        const signIn = match.kind === 'here' ? null : signInProvider({ address: account.address })
        const canAdd = serverCalendars && match.kind !== 'here' && account.providerId === 'imap' && !signIn
        const failure = said[account.accountId] ?? (serverCalendars && signIn && match.kind === 'missing' ? signInNeededText(signIn) : undefined)
        return (
          <SettingsRow
            key={account.accountId}
            data-testid={`calendar-mail-account-${account.accountId}`}
            data-match={match.kind}
            label={label}
            help={failure ?? (canAdd ? addMailCalendarHelp(match) : mailCalendarHelp(match))}
            state={failure ? 'warning' : undefined}
            control={
              canAdd ? (
                <span className="settings-addons-inline">
                  <SettingsTag tone="neutral">{MATCH_TAG[match.kind]}</SettingsTag>
                  {found[account.accountId] ? (
                    <SettingsButton
                      busy={busy === account.accountId}
                      busyLabel="Connecting..."
                      disabled={busy !== null && busy !== account.accountId}
                      onClick={() => void add(account, found[account.accountId])}
                      data-testid={`calendar-mail-use-server-${account.accountId}`}
                    >
                      {`Use ${hostOf(found[account.accountId])}`}
                    </SettingsButton>
                  ) : (
                    <SettingsButton
                      busy={busy === account.accountId}
                      busyLabel="Looking..."
                      disabled={busy !== null && busy !== account.accountId}
                      onClick={() => void add(account)}
                      data-testid={`calendar-mail-add-${account.accountId}`}
                    >
                      Add its calendar
                    </SettingsButton>
                  )}
                </span>
              ) : (
                <SettingsTag tone={match.kind === 'here' ? 'success' : 'neutral'}>{MATCH_TAG[match.kind]}</SettingsTag>
              )
            }
          />
        )
      })}
    </SettingsGroup>
  )
}
