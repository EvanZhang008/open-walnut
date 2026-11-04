/**
 * Settings → Browser extension (BrowserSection.tsx): how to install it in Chrome or Firefox,
 * and the extensions connected to this Walnut (devices named `extension-*`, from the browser
 * pairing code), each with Remove, which ends its token at once.
 */
import { useCallback, useEffect, useState } from 'react'
import { apiDelete } from '@/api/client'
import { SettingsGroup, SettingsRow } from '../SettingsSection'
import { SettingsButton } from '../inputs/SettingsButton'
import { SegmentedControl } from '../inputs/SegmentedControl'
import { fetchDevicesList, devicesListChanged } from './cloud/devices-list'
import { saveErrorMessage } from '../settings-pane-context'
import { ExtensionInstallSteps, detectBrowser, type ExtBrowser } from '@/components/passwords/ExtensionInstall'

interface Device { name: string; info?: { deviceName?: string }; createdAt: string; lastUsedAt?: string }

function when(iso?: string): string {
  if (!iso) return 'not used yet'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `last used ${d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
}

export function BrowserExtensionGroup({ agentsOn }: { agentsOn?: ReadonlySet<string> }) {
  const [browser, setBrowser] = useState<ExtBrowser>(detectBrowser())
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const refresh = useCallback(() => {
    fetchDevicesList<{ devices: Device[] }>()
      .then((r) => setDevices(r.devices.filter((d) => d.name.startsWith('extension-'))))
      .catch((err) => setError(saveErrorMessage(err)))
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const remove = async (name: string) => {
    setBusy(name); setError('')
    try {
      await apiDelete(`/api/devices/${encodeURIComponent(name)}`)
      devicesListChanged()
      refresh()
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setBusy('')
    }
  }

  return (
    <SettingsGroup
      heading="Install and connect"
      footer={<>The extension fills and saves logins on the sites you visit, from Passwords. It asks for your master password like any window, and fills a login only on its own site.</>}
    >
      <SettingsRow
        label="Install"
        help={<span className="pw-ext-install" style={{ display: 'block', marginTop: 8 }}><ExtensionInstallSteps browser={browser} /></span>}
        control={<SegmentedControl<ExtBrowser> id="pw-ext-browser" aria-label="Browser" value={browser}
          options={[{ value: 'chrome', label: 'Chrome' }, { value: 'firefox', label: 'Firefox' }]}
          onChange={setBrowser} />}
      />
      {devices?.length === 0 && <SettingsRow label="Connected" help="No browser connected yet. After installing, click the Walnut icon in the toolbar, then Connect." control={null} />}
      {devices?.map((d) => (
        <SettingsRow
          key={d.name}
          label={d.info?.deviceName ?? 'Walnut extension'}
          help={`Connected ${new Date(d.createdAt).toLocaleDateString()}, ${when(d.lastUsedAt)}${agentsOn ? (agentsOn.has(d.name) ? '. Agents: on' : '. Agents: off') : ''}`}
          control={<SettingsButton busy={busy === d.name} onClick={() => void remove(d.name)}>Remove</SettingsButton>}
        />
      ))}
      {error && <p className="settings-test-result" data-kind="fail" role="alert">{error}</p>}
    </SettingsGroup>
  )
}
