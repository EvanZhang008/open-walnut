/**
 * Google Drive as the destination: one "Connect Google Drive" sign-in.
 *
 * Walnut asks Google only for `drive.file` (the files it makes itself). When
 * this build carries no Google client of Walnut's own, the user makes one
 * (steps in place, about five minutes, once) and pastes its ID and secret.
 * The sign-in opens in the browser; Google sends it back to this computer,
 * and when the browser is on another device the user pastes the address it
 * ended on instead.
 */
import { useCallback, useEffect, useState } from 'react'
import { SettingsDisclosure, SettingsRow } from '../../SettingsSection'
import { SettingsButton } from '../../inputs/SettingsButton'
import { SecretInput } from '../../inputs/SecretInput'
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
  /** Told when the sign-in finished, so the pane can ask for the recovery key. */
  onConnected: () => void
  /** Told whenever the connection state is read. */
  onConnectedChange?: (connected: boolean) => void
}

export function DriveConnect({ dest, onChange, onConnected, onConnectedChange }: Props) {
  const [status, setStatus] = useState<DriveStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [authUrl, setAuthUrl] = useState<string | null>(null)

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

  useEvent('backup:gdrive', useCallback((data: unknown) => {
    const d = data as { connected: boolean; error: string | null }
    setWaiting(false)
    setError(d.connected ? null : d.error)
    void refresh()
    if (d.connected) onConnected()
  }, [refresh, onConnected]))

  const connect = async () => {
    setBusy(true)
    setError(null)
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
      setWaiting(false)
      await refresh()
      onConnected()
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setFinishing(false)
    }
  }

  const disconnect = async () => {
    await apiPost('/api/backup/gdrive/disconnect', {}).catch(() => {})
    await refresh()
  }

  if (!status) return <SettingsRow label="Google account" help="Checking..." />

  if (status.connected) {
    return (
      <SettingsRow
        label="Google account"
        help={`Connected${status.email ? ` as ${status.email}` : ''}. Backups go to the "${status.folderName ?? 'Walnut Backup'}" folder in your Drive.`}
        data-testid="backup-gdrive-connected"
        control={<SettingsButton onClick={disconnect} data-testid="backup-gdrive-disconnect">Disconnect</SettingsButton>}
      />
    )
  }

  const needsOwnClient = !status.builtinClient
  const hasOwnClient = Boolean(dest.client_id?.trim())
  return (
    <>
      {needsOwnClient && (
        <>
          <SettingsDisclosure id="backup-gdrive-client-help" label="Set up a Google sign-in for Walnut (once, about 5 minutes)"
            defaultOpen={!hasOwnClient} data-testid="backup-gdrive-client-help">
            <ol className="settings-steps" data-testid="backup-gdrive-steps">
              <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud: new project</a>, name it <code>Walnut Backup</code>, choose <b>Create</b>.</li>
              <li>Open <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">Google Drive API</a> and choose <b>Enable</b>.</li>
              <li>Open <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">Google Auth Platform</a>, choose <b>Get started</b>: any app name, your email, Audience <b>External</b>.</li>
              <li>Under <b>Audience</b> choose <b>Publish app</b> (otherwise Google signs Walnut out every 7 days).</li>
              <li>Under <b>Clients</b> choose <b>Create client</b>, type <b>Desktop app</b>, then copy its Client ID and Client secret into the rows below.</li>
            </ol>
            <p className="settings-steps-note">Walnut asks only to see the files it makes. Keep the ID and secret with your recovery key: a new computer needs the same ones to find these backups.</p>
          </SettingsDisclosure>
          <SettingsRow label="Client ID" htmlFor="backup-gdrive-client-id" control={
            <input id="backup-gdrive-client-id" type="text" data-no-draft="autosave" autoComplete="off" spellCheck={false}
              className="settings-input settings-input--short settings-input--mono" placeholder="...apps.googleusercontent.com"
              value={dest.client_id ?? ''} onChange={(e) => onChange({ ...dest, client_id: e.target.value })} />
          } />
          <SettingsRow label="Client secret" htmlFor="backup-gdrive-client-secret" control={
            <SecretInput id="backup-gdrive-client-secret" value={dest.client_secret ?? ''} onChange={(v) => onChange({ ...dest, client_secret: v })} />
          } />
        </>
      )}
      <SettingsRow
        label="Google account"
        help={waiting
          ? <>Finish signing in on the Google page that opened. This row updates by itself.{authUrl && <> No page? <a href={authUrl} target="_blank" rel="noreferrer" data-testid="backup-gdrive-open-link">Open Google sign-in</a>.</>}</>
          : 'Sign in with Google and allow Walnut to make its own backup folder.'}
        error={error ?? undefined}
        data-testid="backup-gdrive-row"
        control={
          <SettingsButton variant="primary" onClick={connect} busy={busy || waiting} busyLabel={waiting ? 'Waiting for Google...' : 'Opening...'}
            disabled={needsOwnClient && !hasOwnClient} title={needsOwnClient && !hasOwnClient ? 'Add the Client ID first.' : undefined}
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
              <input id="backup-gdrive-paste" type="text" data-no-draft="autosave" className="settings-input settings-input--mono"
                value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://127.0.0.1:...?code=..." />
              <SettingsButton onClick={finish} busy={finishing} busyLabel="Finishing..." disabled={!pasted.trim()} data-testid="backup-gdrive-finish">
                Finish
              </SettingsButton>
            </span>
          }
        />
      )}
    </>
  )
}
