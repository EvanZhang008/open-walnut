/**
 * The OAuth client a Gmail or Outlook calendar sign-in needs, set up in place (Walnut has no
 * published client of its own yet): the exact steps in the provider's console, the fields to paste
 * what it gives, and "Check and save", which asks the provider whether it knows that client before
 * Walnut keeps it (in the calendar's secret store on this computer). One client serves every
 * account of that provider; a Google client Drive backups already use serves calendars too.
 */
import { useState } from 'react'
import { saveSignInClient, type SignInClientView, type SignInProviderName } from '@/api/calendar'
import { SettingsDisclosure, SettingsRow } from '../SettingsSection'
import { SettingsButton } from '../inputs/SettingsButton'
import { SecretInput } from '../inputs/SecretInput'
import { saveErrorMessage } from '../settings-pane-context'

function GoogleSteps() {
  return (
    <ol className="settings-steps" data-testid="calendar-sign-in-steps-google">
      <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud: new project</a>, name it <code>Walnut Calendar</code>, choose <b>Create</b> (a project you already use for Walnut works too).</li>
      <li>Open <a href="https://console.cloud.google.com/apis/library/caldav.googleapis.com" target="_blank" rel="noreferrer">CalDAV API</a> and choose <b>Enable</b>.</li>
      <li>Open <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">Google Auth Platform</a>, choose <b>Get started</b>: any app name, your email, Audience <b>External</b>.</li>
      <li>Under <b>Audience</b> choose <b>Publish app</b> (otherwise Google signs Walnut out every 7 days). Google then calls the app unverified on its sign-in page: choose <b>Advanced</b>, then <b>Go to</b> your app.</li>
      <li>Under <b>Clients</b> choose <b>Create client</b>, type <b>Desktop app</b>, then copy its Client ID and Client secret into the rows below. Google allows its sign-in back to <code>http://127.0.0.1</code> for a desktop app by itself.</li>
    </ol>
  )
}

function MicrosoftSteps() {
  return (
    <ol className="settings-steps" data-testid="calendar-sign-in-steps-microsoft">
      <li>Open <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer">Microsoft Entra: App registrations</a> and choose <b>New registration</b>. A work or school account can register apps there; with only a personal Microsoft account, Microsoft may first ask you to make a free Azure account (it gives you a directory to register in).</li>
      <li>Name it <code>Walnut Calendar</code>. Supported account types: <b>Accounts in any organizational directory and personal Microsoft accounts</b>. Redirect URI: platform <b>Public client/native (mobile &amp; desktop)</b>, address <code>http://127.0.0.1</code>. Choose <b>Register</b>.</li>
      <li>Under <b>Authentication</b>, set <b>Allow public client flows</b> to <b>Yes</b> and choose <b>Save</b>.</li>
      <li>Under <b>API permissions</b>, choose <b>Add a permission</b>, <b>Microsoft Graph</b>, <b>Delegated permissions</b>, tick <b>Calendars.ReadWrite</b>.</li>
      <li>On <b>Overview</b>, copy the <b>Application (client) ID</b> into the row below. Microsoft needs no secret for it.</li>
    </ol>
  )
}

interface Props {
  provider: SignInProviderName
  accountId: string
  client: SignInClientView | undefined
  /** After a client was kept: every row of this provider can sign in now. */
  onSaved: () => void
}

export function CalendarSignInClient({ provider, accountId, client, onSaved }: Props) {
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null)
  const google = provider === 'Google'
  const ready = !!client?.ready
  const complete = !!clientId.trim() && (!google || !!secret.trim())
  const key = `${provider.toLowerCase()}-${accountId}`

  const save = async () => {
    setSaving(true)
    setSaid(null)
    try {
      const answer = await saveSignInClient(provider, clientId.trim(), google ? secret.trim() : undefined)
      if (answer.ok) {
        setSaid({ ok: true, text: `${provider} knows this client, and Walnut keeps it on this computer. Now sign in above.` })
        setClientId('')
        setSecret('')
        onSaved()
      } else {
        setSaid({ ok: false, text: answer.message })
      }
    } catch (err) {
      setSaid({ ok: false, text: saveErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsDisclosure
      id={`calendar-sign-in-client-${key}`}
      indent
      label={!ready ? `Set up a ${provider} client for Walnut (once, about 5 minutes)`
        : client?.from === 'calendar' ? `Change the ${provider} client` : `Use your own ${provider} client (optional)`}
      defaultOpen={!ready}
      data-testid={`calendar-sign-in-client-${accountId}`}
    >
      {google ? <GoogleSteps /> : <MicrosoftSteps />}
      <SettingsRow indent label={google ? 'Client ID' : 'Application (client) ID'} htmlFor={`calendar-client-id-${key}`} control={
        <input id={`calendar-client-id-${key}`} type="text" data-no-draft="autosave" autoComplete="off" spellCheck={false}
          className="settings-input settings-input--short" placeholder={google ? '....apps.googleusercontent.com' : '00000000-0000-0000-0000-000000000000'}
          value={clientId} onChange={(e) => setClientId(e.target.value)} data-testid={`calendar-client-id-${accountId}`} />
      } />
      {google && (
        <SettingsRow indent label="Client secret" htmlFor={`calendar-client-secret-${key}`} control={
          <SecretInput id={`calendar-client-secret-${key}`} value={secret} onChange={setSecret} data-testid={`calendar-client-secret-${accountId}`} />
        } />
      )}
      <SettingsRow
        indent
        label="Check and keep it"
        help={said?.ok ? said.text : `Walnut asks ${provider} whether it knows this client first.`}
        error={said && !said.ok ? said.text : undefined}
        control={
          <SettingsButton onClick={() => void save()} busy={saving} busyLabel="Checking..." disabled={!complete}
            title={complete ? undefined : google ? 'Fill in the client ID and the client secret.' : 'Fill in the application (client) ID.'}
            data-testid={`calendar-client-save-${accountId}`}>
            Check and save
          </SettingsButton>
        }
      />
    </SettingsDisclosure>
  )
}
