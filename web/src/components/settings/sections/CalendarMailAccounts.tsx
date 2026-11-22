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
 * A Gmail or Outlook account signs in with its provider instead (CalendarSignInRow.tsx).
 */
import { useEffect, useState } from 'react'
import { useLeanCallback } from '@/hooks/useLeanCallback'
import { listMailAccounts, type MailAccountDto } from '@/api/mail'
import { addMailCalendar, getSignInProviders, removeMailCalendar, type CalendarInfo, type CalendarSourceStatus, type SignInProviderName } from '@/api/calendar'
import { calendarSourceOf } from '../../../../../src/integrations/calendar/event-rules'
import { signInProvider } from '../../../../../src/integrations/calendar/sign-in-provider'
import { useExperimental } from '@/hooks/useExperimental'
import { ensureCalendarsLoaded } from '@/stores/calendar-events-store'
import { SettingsGroup, SettingsRow, SettingsTag } from '../SettingsSection'
import { SettingsButton } from '../inputs/SettingsButton'
import { saveErrorMessage } from '../settings-pane-context'
import {
  addMailCalendarHelp,
  mailCalendarHelp,
  mailCalendarMatch,
  type MailCalendarMatch,
} from './calendar-mail-accounts'
import { CalendarSignInRow } from './CalendarSignInRow'
import { MailServerCalendarRow } from './MailServerCalendarRow'

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
  missing: 'No match found', // empty-state-ok: a match tag's label
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
  // Bumped when a sign-in client was kept: every sign-in row reads where it stands again.
  const [signInVersion, setSignInVersion] = useState(0)
  const changed = useLeanCallback(() => {
    void ensureCalendarsLoaded(true)
    onChanged?.()
  }, [onChanged])
  // Per account: the provider it signs in with, as the server tells it from its mail servers too.
  const [providers, setProviders] = useState<Record<string, SignInProviderName>>({})
  useEffect(() => {
    let live = true
    listMailAccounts().then((answer) => { if (live) setAccounts(answer.accounts ?? []) }, () => { if (live) setAccounts([]) })
    return () => { live = false }
  }, [])
  useEffect(() => {
    if (!serverCalendars || !accounts?.length) return
    let live = true
    getSignInProviders(accounts.map((a) => a.accountId)).then((answer) => { if (live) setProviders(answer.providers ?? {}) }, () => {})
    return () => { live = false }
  }, [serverCalendars, accounts])
  if (!accounts || accounts.length === 0) return null
  // A provider's client is set up on its first row only; the others point there.
  const providerOf = (account: MailAccountDto) => providers[account.accountId] ?? signInProvider({ address: account.address })
  const ownOf = (account: MailAccountDto) => (serverCalendars ? sources.find((s) => (s.kind === 'caldav' || s.kind === 'graph') && s.account === account.accountId) : undefined)
  /** A row of a sign-in account (its calendar read, or not here through the Mac). */
  const signsIn = (account: MailAccountDto) => serverCalendars && !!providerOf(account) && (!!ownOf(account) || mailCalendarMatch(account.address, calendars).kind !== 'here')
  const setupRow: Partial<Record<SignInProviderName, MailAccountDto>> = {}
  for (const account of accounts) {
    const p = providerOf(account)
    if (p && signsIn(account) && !setupRow[p]) setupRow[p] = account
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
        ? "A mail account's calendar comes in through this Mac when the Mac has that account too, or straight from its mail server: Add its calendar uses the password saved for its mail. A Gmail or Outlook account signs in with Google or Microsoft instead."
        : 'Walnut reads calendars through this Mac, so a mail account\'s calendar comes in once the Mac has that account too. Mail set up only in Walnut (IMAP) carries no calendar.'}
      data-testid="calendar-mail-accounts"
    >
      {accounts.map((account) => {
        const label = account.displayName && account.displayName !== account.address ? `${account.displayName} (${account.address})` : account.address
        const own = ownOf(account)
        const count = own ? calendars.filter((c) => calendarSourceOf(c.id) === own.id).length : 0
        const match = mailCalendarMatch(account.address, calendars)
        // A Google or Microsoft account signs in for its calendar; a mail password never reads it.
        const signIn = providerOf(account)
        if (signIn && signsIn(account)) {
          return (
            <CalendarSignInRow
              key={account.accountId}
              account={account}
              label={label}
              provider={signIn}
              tag={MATCH_TAG[match.kind]}
              own={own}
              calendarCount={count}
              version={signInVersion}
              clientSetup={setupRow[signIn] === account ? true : setupRow[signIn]!.address}
              busy={busy}
              said={said[account.accountId]}
              onRemove={() => void remove(account)}
              onChanged={changed}
              onClientSaved={() => setSignInVersion((v) => v + 1)}
            />
          )
        }
        if (own) {
          return (
            <MailServerCalendarRow
              key={account.accountId}
              accountId={account.accountId}
              label={label}
              own={own}
              calendarCount={count}
              said={said[account.accountId]}
              busy={busy}
              onRemove={() => void remove(account)}
            />
          )
        }
        // Only an IMAP account's saved password can read a calendar server, and never Google's or Microsoft's.
        const canAdd = serverCalendars && match.kind !== 'here' && account.providerId === 'imap' && !signIn
        const failure = said[account.accountId]
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
