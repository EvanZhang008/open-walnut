/**
 * A Gmail or Outlook account's row (the `mail_calendars` experiment): its calendar comes in by a
 * sign-in with its provider, since a mail password cannot read it.
 *
 * Not read yet: "Sign in with Google / Microsoft" (and, with no client yet, the steps to make one:
 * CalendarSignInClient). The provider's page opens in the browser and sends it back to Walnut on
 * this computer; the row waits, reading where the sign-in stands, and when the browser was on
 * another device the person pastes the address it ended on. Signed in, the row is the same
 * "Calendar here / Remove its calendar" row as a mail server's; a sign-in that expired or was
 * revoked says so there with "Sign in again", and its events stay as they were read. A sign-in
 * as another account than the row's is held (kept nowhere) until the person uses that account's
 * calendar or discards it.
 */
import { useEffect, useRef, useState } from 'react'
import { useLeanCallback } from '@/hooks/useLeanCallback'
import {
  addMailCalendar, cancelCalendarSignIn, completeCalendarSignIn, decideCalendarSignIn, getCalendarSignIn, startCalendarSignIn,
  type CalendarSignInStatus, type CalendarSourceStatus, type SignInProviderName,
} from '@/api/calendar'
import type { MailAccountDto } from '@/api/mail'
import { openInDefaultBrowser } from '@/plugins/link-handlers'
import { SettingsDisclosure, SettingsRow, SettingsTag } from '../SettingsSection'
import { SettingsButton } from '../inputs/SettingsButton'
import { saveErrorMessage } from '../settings-pane-context'
import { CalendarSignInClient } from './CalendarSignInClient'
import { MailServerCalendarRow } from './MailServerCalendarRow'
import { signInRowHelp } from './calendar-mail-accounts'

const POLL_MS = 1500

interface Props {
  account: MailAccountDto
  label: string
  provider: SignInProviderName
  /** What the row's tag says while its calendar is not read (the Mac match). */
  tag: string
  /** Its calendar's source, once Walnut reads it. */
  own?: CalendarSourceStatus
  calendarCount: number
  /** Bumped when any row changed something every row shares (a client was kept). */
  version: number
  /** This row holds the provider's client setup (the first row of that provider); else the address of the row that does. */
  clientSetup: true | string
  busy: string | null
  /** What the page's own last action on this row said (a failed remove). */
  said?: string
  onRemove: () => void
  /** Its calendar came in (or came back): read the accounts and calendars again. */
  onChanged: () => void
  /** A client was kept: the other rows of this provider read where they stand again. */
  onClientSaved: () => void
}

export function CalendarSignInRow({ account, label, provider, tag, own, calendarCount, version, clientSetup, busy, said, onRemove, onChanged, onClientSaved }: Props) {
  const id = account.accountId
  const [status, setStatus] = useState<CalendarSignInStatus | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [starting, setStarting] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [deciding, setDeciding] = useState<'use' | 'discard' | null>(null)
  const live = useRef(true)
  // Set on every mount: React's development double mount runs the cleanup once in between.
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])

  const refresh = useLeanCallback(async () => {
    const s = await getCalendarSignIn(id, account.address).catch(() => null)
    if (!live.current || !s) return s
    setStatus(s)
    return s
  }, [id, account.address])
  useEffect(() => {
    void refresh().then((s) => { if (s?.pending) setWaiting(true) })
  }, [refresh, version])

  // While the provider's page is open: read where the sign-in stands until it ended.
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => {
      void refresh().then((s) => {
        if (!s || s.pending) return
        setWaiting(false)
        const outcome = s.outcome
        // A sign-in held as another account shows its own question, not an error.
        if (outcome?.ok) { setError(null); onChanged() } else if (outcome && !outcome.cancelled && !outcome.held) setError(outcome.message)
      })
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [waiting, refresh, onChanged])

  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      const answer = await startCalendarSignIn(id, account.address)
      if (answer.ok) {
        setStatus((prev) => (prev ? { ...prev, pending: true, authUrl: answer.authUrl } : prev))
        setWaiting(true)
        // A browser that blocks the new window still has the link on the row.
        openInDefaultBrowser(answer.authUrl)
      } else {
        setError(answer.message)
        void refresh()
      }
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setStarting(false)
    }
  }

  const cancel = () => {
    setWaiting(false)
    void cancelCalendarSignIn(id).catch(() => {})
  }

  const finish = async () => {
    setFinishing(true)
    setError(null)
    try {
      const answer = await completeCalendarSignIn(id, pasted)
      setPasted('')
      setWaiting(false)
      if (answer.ok) onChanged()
      else if (!answer.held) setError(answer.message)
      void refresh()
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setFinishing(false)
    }
  }

  const decide = async (use: boolean) => {
    setDeciding(use ? 'use' : 'discard')
    setError(null)
    try {
      const answer = await decideCalendarSignIn(id, use)
      if (answer.ok) onChanged()
      else if (use) setError(answer.message)
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setDeciding(null)
      void refresh()
    }
  }

  // Signed in, but its calendar was not read (an API not enabled yet): try again without a new sign-in.
  const addAgain = async () => {
    setAdding(true)
    setError(null)
    try {
      const answer = await addMailCalendar(id, account.address)
      if (answer.ok) onChanged()
      else setError(answer.message)
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setAdding(false)
    }
  }

  const ready = !!status?.client?.ready
  const signInButton = (again: boolean) => waiting ? (
    <>
      <SettingsButton busy busyLabel={`Waiting for ${provider}...`} data-testid={`calendar-mail-sign-in-${id}`}>{`Sign in with ${provider}`}</SettingsButton>
      <SettingsButton onClick={cancel} data-testid={`calendar-mail-sign-in-cancel-${id}`}>Cancel</SettingsButton>
    </>
  ) : (
    <SettingsButton variant={again || !status?.signedIn ? 'primary' : undefined} onClick={() => void start()} busy={starting} busyLabel="Opening..."
      disabled={!ready || (busy !== null && busy !== id)} title={ready ? undefined : `Set up a ${provider} client first (the steps are below).`}
      data-testid={`calendar-mail-sign-in-${id}`}>
      {again ? 'Sign in again' : `Sign in with ${provider}`}
    </SettingsButton>
  )
  const waitingHelp = (
    <>{`Finish signing in on the ${provider} page that opened. This row updates by itself.`}{status?.authUrl
      ? <> No page? <a href={status.authUrl} target="_blank" rel="noreferrer" data-testid={`calendar-mail-sign-in-link-${id}`}>{`Open ${provider} sign-in`}</a>.</> /* empty-state-ok: a link hint, not a state */
      : null}</>
  )
  const pasteRow = waiting && (
    // Rare (the browser on another device): folded, so the usual sign-in shows one row.
    <SettingsDisclosure id={`calendar-sign-in-paste-${id}`} indent label="Signed in on another device?" data-testid={`calendar-mail-sign-in-paste-help-${id}`}>
      <SettingsRow indent wide label="Address it ended on" htmlFor={`calendar-sign-in-paste-${id}-input`}
        help="Paste the whole address the browser showed at the end (it starts with http://127.0.0.1)."
        control={
          <span className="settings-inline-pair">
            <input id={`calendar-sign-in-paste-${id}-input`} type="text" data-no-draft="autosave" className="settings-input"
              value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://127.0.0.1..." data-testid={`calendar-mail-sign-in-paste-${id}`} />
            <SettingsButton onClick={() => void finish()} busy={finishing} busyLabel="Finishing..." disabled={!pasted.trim()}
              title={pasted.trim() ? undefined : 'Paste the address it ended on first.'} data-testid={`calendar-mail-sign-in-finish-${id}`}>
              Finish
            </SettingsButton>
          </span>
        }
      />
    </SettingsDisclosure>
  )

  const outcome = status?.outcome
  const held = !waiting && outcome && !outcome.ok ? outcome.held?.email : undefined
  if (held) {
    return (
      <SettingsRow
        data-testid={`calendar-mail-account-${id}`}
        data-match="sign-in-held"
        label={label}
        help={`Signed in as ${held}. Use ${held}'s calendar for this account?`}
        error={error ?? undefined}
        state={error ? 'warning' : undefined}
        control={
          <span className="settings-addons-inline">
            <SettingsButton variant="primary" onClick={() => void decide(true)} busy={deciding === 'use'} busyLabel="Adding..." disabled={deciding !== null}
              data-testid={`calendar-mail-sign-in-use-${id}`}>
              Use this calendar
            </SettingsButton>
            <SettingsButton onClick={() => void decide(false)} busy={deciding === 'discard'} busyLabel="Discarding..." disabled={deciding !== null}
              data-testid={`calendar-mail-sign-in-discard-${id}`}>
              Discard sign-in
            </SettingsButton>
          </span>
        }
      />
    )
  }

  if (own) {
    const expired = own.reason === 'needs-sign-in'
    return (
      <>
        <MailServerCalendarRow accountId={id} label={label} own={own} calendarCount={calendarCount} provider={provider} keepsGrant={status?.keepsGrant} busy={busy} onRemove={onRemove}
          said={waiting ? undefined : error ?? said} extra={expired || waiting ? signInButton(true) : undefined} />
        {pasteRow}
      </>
    )
  }

  const help = waiting ? waitingHelp
    : status ? signInRowHelp(provider, { clientReady: ready, clientFrom: status.client?.from, signedIn: !!status.signedIn, email: status.email, ...(clientSetup === true ? {} : { clientSetupAt: clientSetup }) })
      : 'Checking...'
  return (
    <>
      <SettingsRow
        data-testid={`calendar-mail-account-${id}`}
        data-match="sign-in"
        label={label}
        help={help}
        error={error ?? undefined}
        state={error ? 'warning' : undefined}
        control={
          <span className="settings-addons-inline">
            <SettingsTag tone="neutral">{tag}</SettingsTag>
            {status?.signedIn && !waiting && (
              <SettingsButton variant="primary" onClick={() => void addAgain()} busy={adding} busyLabel="Looking..." data-testid={`calendar-mail-add-${id}`}>
                Add its calendar
              </SettingsButton>
            )}
            {signInButton(false)}
          </span>
        }
      />
      {pasteRow}
      {status && clientSetup === true && <CalendarSignInClient provider={provider} accountId={id} client={status.client} onSaved={onClientSaved} />}
    </>
  )
}
