/**
 * Google Drive as the destination: one "Connect Google Drive" sign-in.
 *
 * Walnut asks Google only for `drive.file` (the files it makes itself). With
 * Walnut's own Google client in the build, Connect is all there is; the user's
 * own client is an optional choice tucked away. Without one, the user makes a
 * client (steps in place, about five minutes, once) and pastes its ID and secret.
 * The sign-in opens in the browser; Google sends it back to this computer,
 * and when the browser is on another device the user pastes the address it
 * ended on instead.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { SettingsDisclosure, SettingsRow } from '../../SettingsSection'
import { SettingsButton } from '../../inputs/SettingsButton'
import { KeyInput } from './KeyInput'
import { saveErrorMessage } from '../../settings-pane-context'
import { apiGet, apiPost } from '@/api/client'
import { useEvent } from '@/hooks/useWebSocket'
import { openInDefaultBrowser } from '@/plugins/link-handlers'
import type { BackupDestinationConfig } from './backup-model'

interface DriveStatus {
  builtinClient: boolean
  client: 'builtin' | 'custom' | null
  connected: boolean
  email: string | null
  folderName: string | null
  pending: boolean
}

interface Props {
  dest: BackupDestinationConfig
  onChange: (next: BackupDestinationConfig) => void
  /** Backups go to Google Drive now. */
  inUse: boolean
  /** The service backups go to instead, while Drive is only being looked at. */
  otherInUse: string | null
  /** Told when the sign-in finished: the pane makes Drive the destination. */
  onConnected: () => void
  /** "Use Google Drive": connected earlier, chosen now. */
  onUse: () => void
  /** Told whenever the connection state is read. */
  onConnectedChange?: (connected: boolean) => void
}

export function DriveConnect({ dest, onChange, inUse, otherInUse, onConnected, onUse, onConnectedChange }: Props) {
  const [status, setStatus] = useState<DriveStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  // The sign-in can finish by the event, the poll or a paste: tell the pane once.
  const toldConnected = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const s = await apiGet<DriveStatus>('/api/backup/gdrive/status')
      setStatus(s)
      onConnectedChange?.(s.connected)
    } catch {
      /* keeps the last status */
    }
  }, [onConnectedChange])
  useEffect(() => { void refresh() }, [refresh])

  const signedIn = useCallback(() => {
    setWaiting(false)
    if (toldConnected.current) return
    toldConnected.current = true
    onConnected()
  }, [onConnected])

  useEvent('backup:gdrive', useCallback((data: unknown) => {
    const d = data as { connected: boolean; error: string | null }
    setWaiting(false)
    setError(d.connected ? null : d.error)
    void refresh()
    if (d.connected) signedIn()
  }, [refresh, signedIn]))

  // A missed event (a reconnecting socket) must not leave the row waiting forever.
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => {
      void apiGet<DriveStatus>('/api/backup/gdrive/status').then((s) => {
        if (!s.connected) return
        setStatus(s)
        onConnectedChange?.(true)
        signedIn()
      }).catch(() => {})
    }, 3000)
    return () => clearInterval(t)
  }, [waiting, signedIn, onConnectedChange])

  const connect = async () => {
    setBusy(true)
    setError(null)
    toldConnected.current = false
    try {
      const r = await apiPost<{ authUrl: string }>('/api/backup/gdrive/connect', {
        client_id: dest.client_id, client_secret: dest.client_secret, destination: dest,
      })
      setAuthUrl(r.authUrl)
      setWaiting(true)
      // The Mac app sends a new window to the default browser. A browser that
      // blocks the pop-up still has the link in the row below.
      openInDefaultBrowser(r.authUrl)
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const finish = async () => {
    setFinishing(true)
    setError(null)
    try {
      await apiPost('/api/backup/gdrive/complete', { url: pasted }, { timeoutMs: 45000 })
      setPasted('')
      await refresh()
      signedIn()
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setFinishing(false)
    }
  }

  const disconnect = async () => {
    setConfirmingDisconnect(false)
    await apiPost('/api/backup/gdrive/disconnect', {}).catch((err) => setError(saveErrorMessage(err)))
    await refresh()
  }

  if (!status) return <SettingsRow label="Google account" help="Checking..." />

  if (status.connected) {
    const who = `${status.email ? ` as ${status.email}` : ''}`
    if (confirmingDisconnect) {
      return (
        <SettingsRow
          label="Disconnect Google Drive?"
          state="warning"
          help={inUse
            ? 'Backups pause until you connect again. The backups already in your Drive stay there; connect again to restore them.'
            : 'The backups already in your Drive stay there; connect again to restore them.'}
          error={error ?? undefined}
          data-testid="backup-gdrive-disconnect-warning"
          control={
            <span className="settings-inline-pair" data-testid="backup-gdrive-disconnect-confirm">
              <SettingsButton onClick={() => setConfirmingDisconnect(false)} data-testid="backup-gdrive-disconnect-cancel">Keep</SettingsButton>
              <SettingsButton variant="danger" onClick={disconnect} data-testid="backup-gdrive-disconnect-yes">Disconnect</SettingsButton>
            </span>
          }
        />
      )
    }
    return (
      <SettingsRow
        label="Google account"
        help={inUse
          ? `Connected${who}. Backups go to the "${status.folderName ?? 'Walnut Backup'}" folder in your Drive.${status.client === 'custom' ? ' Uses your own Google client: a new computer needs the same ID and secret.' : ''}`
          : `Connected${who}. Backups still go to ${otherInUse ?? 'the service picked before'} until you choose Google Drive.`}
        error={error ?? undefined}
        data-testid="backup-gdrive-connected"
        control={
          <span className="settings-inline-pair">
            {!inUse && <SettingsButton variant="primary" onClick={onUse} data-testid="backup-gdrive-use">Use Google Drive</SettingsButton>}
            <SettingsButton onClick={() => setConfirmingDisconnect(true)} data-testid="backup-gdrive-disconnect">Disconnect</SettingsButton>
          </span>
        }
      />
    )
  }

  const needsOwnClient = !status.builtinClient
  const hasOwnClient = Boolean(dest.client_id?.trim())
  const clientRows = (
    <>
      <SettingsRow label="Client ID" htmlFor="backup-gdrive-client-id" control={
        <input id="backup-gdrive-client-id" type="text" data-no-draft="autosave" autoComplete="off" spellCheck={false}
          className="settings-input settings-input--short" placeholder="e.g. 123-abc.apps.googleusercontent.com"
          value={dest.client_id ?? ''} onChange={(e) => onChange({ ...dest, client_id: e.target.value })} />
      } />
      <SettingsRow label="Client secret" htmlFor="backup-gdrive-client-secret" control={
        <KeyInput id="backup-gdrive-client-secret" value={dest.client_secret ?? ''} onChange={(v) => onChange({ ...dest, client_secret: v })} />
      } />
    </>
  )
  const steps = (
    <>
      <ol className="settings-steps" data-testid="backup-gdrive-steps">
        <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud: new project</a>, name it <code>Walnut Backup</code>, choose <b>Create</b>.</li>
        <li>Open <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">Google Drive API</a> and choose <b>Enable</b>.</li>
        <li>Open <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">Google Auth Platform</a>, choose <b>Get started</b>: any app name, your email, Audience <b>External</b>.</li>
        <li>Under <b>Audience</b> choose <b>Publish app</b> (otherwise Google signs Walnut out every 7 days).</li>
        <li>Under <b>Clients</b> choose <b>Create client</b>, type <b>Desktop app</b>, then copy its Client ID and Client secret into the rows below.</li>
      </ol>
      <p className="settings-steps-note">Walnut asks only to see the files it makes. Keep the ID and secret with your recovery key: a new computer needs the same ones to find these backups.</p>
    </>
  )
  return (
    <>
      {needsOwnClient && (
        <>
          <SettingsDisclosure id="backup-gdrive-client-help" label="Set up a Google client for Walnut (once, about 5 minutes)"
            defaultOpen={!hasOwnClient} data-testid="backup-gdrive-client-help">
            {steps}
          </SettingsDisclosure>
          {clientRows}
        </>
      )}
      <SettingsRow
        label="Google account"
        help={waiting
          ? <>Finish signing in on the Google page that opened. This row updates by itself.{authUrl && <> No page? <a href={authUrl} target="_blank" rel="noreferrer" data-testid="backup-gdrive-open-link">Open Google sign-in</a>.</>}</>
          : needsOwnClient && !hasOwnClient
            ? 'First add a Google client above (once, about 5 minutes).'
            : 'Sign in with Google and allow Walnut to make its own backup folder.'}
        error={error ?? undefined}
        data-testid="backup-gdrive-row"
        control={
          <SettingsButton variant={waiting ? undefined : 'primary'} onClick={connect} busy={busy || waiting} busyLabel={waiting ? 'Waiting for Google...' : 'Opening...'}
            disabled={needsOwnClient && !hasOwnClient}
            data-testid="backup-gdrive-connect">
            Connect Google Drive
          </SettingsButton>
        }
      />
      {waiting && (
        <SettingsRow
          label="Signed in on another device?"
          htmlFor="backup-gdrive-paste"
          indent
          wide
          help="Paste the whole address the browser showed at the end (it starts with http://127.0.0.1)."
          control={
            <span className="settings-inline-pair">
              <input id="backup-gdrive-paste" type="text" data-no-draft="autosave" className="settings-input"
                value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://127.0.0.1:...?code=..." />
              <SettingsButton onClick={finish} busy={finishing} busyLabel="Finishing..." disabled={!pasted.trim()} data-testid="backup-gdrive-finish">
                Finish
              </SettingsButton>
            </span>
          }
        />
      )}
      {!needsOwnClient && (
        <SettingsDisclosure id="backup-gdrive-own-client" label="Use your own Google client (optional)" defaultOpen={hasOwnClient}
          data-testid="backup-gdrive-own-client">
          {steps}
          {clientRows}
          <p className="settings-steps-note">Then choose Connect Google Drive above.</p>
        </SettingsDisclosure>
      )}
    </>
  )
}
