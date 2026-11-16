/**
 * Settings → Browser extension (BrowserSection.tsx), the parts about the extension itself:
 *   - Your browsers: each extension connected to this Walnut (devices named `extension-*`, from
 *     the browser pairing code) with whether it is connected now, the version it runs against the
 *     one Walnut ships and how it updates (browser-extension-model.ts), and Remove, which ends its
 *     token at once;
 *   - Install: the steps for Chrome or Firefox, with Set up in Chrome on this machine;
 *   - What it does: what the extension adds, each with where to turn it on.
 */
import { useCallback, useEffect, useState } from 'react'
import { apiDelete } from '@/api/client'
import { SettingsGroup, SettingsRow } from '../SettingsSection'
import { SettingsButton } from '../inputs/SettingsButton'
import { SegmentedControl } from '../inputs/SegmentedControl'
import { fetchDevicesList, devicesListChanged } from './cloud/devices-list'
import { saveErrorMessage } from '../settings-pane-context'
import { ExtensionInstallSteps, detectBrowser, type ExtBrowser } from '@/components/passwords/ExtensionInstall'
import { extRows, type ExtDevice, type ExtSeen, type ExtShipped } from './browser-extension-model'

export interface ExtensionStatus {
  /** The browsers that let agents in now, with their caps. */
  browsers: Array<{ device: string; caps: string[] }>
  /** The build this Walnut ships (null: built without the extension). */
  extension?: ExtShipped | null
  extensions?: ExtSeen[]
}

/** What the extension adds, in the order a new person meets it. */
export const EXTENSION_FEATURES: Array<{ id: string; label: string; help: string }> = [
  { id: 'passwords', label: 'Fill and save passwords', help: 'Fills logins and one-time codes from Passwords on their own site only, and offers to save a new one. It asks for your master password like any Walnut window.' },
  { id: 'agents', label: 'Agents use your browser', help: 'Once you turn it on in the extension (its popup, Settings), agents open their own tabs in a separate window, signed in as you. A Walnut cursor shows where they act and goes away when they stop; every tab has Stop and Take over.' },
  { id: 'hand-over', label: 'Hand a tab to an agent', help: 'In the side panel, Act in tab lets the agent of that chat use the tab you are on, and only that tab. Take it back any time.' },
  { id: 'side-panel', label: 'Ask about the page', help: 'The side panel opens Walnut beside any page, which it can read. Select text and right-click for a quick question about it.' },
  { id: 'view', label: 'Watch and replay', help: 'A task\'s Browser view shows its tabs live, and plays back the steps an agent took (kept for the days set below).' },
]

export function BrowserExtensionGroup({ status }: { status?: ExtensionStatus | null }) {
  const [browser, setBrowser] = useState<ExtBrowser>(detectBrowser())
  const [devices, setDevices] = useState<ExtDevice[] | null>(null)
  const [error, setError] = useState('')
  /** The list could not be read: said only while there is no list to show (a later read that works clears it). */
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState('')

  const refresh = useCallback(() => {
    fetchDevicesList<{ devices: ExtDevice[] }>()
      .then((r) => { setDevices(r.devices.filter((d) => d.name.startsWith('extension-'))); setLoadError('') })
      .catch((err) => setLoadError(saveErrorMessage(err)))
  }, [])
  // A browser connected meanwhile (the person is installing it in another window) shows within seconds.
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 10_000)
    return () => clearInterval(t)
  }, [refresh])

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

  const polling = new Map((status?.browsers ?? []).map((b) => [b.device, b.caps]))
  const rows = devices ? extRows(devices, status?.extensions ?? [], polling, status?.extension) : null
  const shipped = status?.extension

  return (
    <>
      <SettingsGroup
        heading="Your browsers"
        data-testid="ext-browsers"
        footer={shipped ? <>This Walnut ships version {shipped.version} (build {shipped.build.slice(0, 7)}). An extension set up from Walnut&apos;s folder updates itself with every Walnut update.</> : undefined}
      >
        {rows === null && <SettingsRow label={loadError ? 'Could not read the connected browsers' : 'Loading…'} help={loadError || undefined} control={null} />}
        {rows?.length === 0 && (
          <SettingsRow
            data-testid="ext-none"
            label="Not installed yet"
            help="No browser has the Walnut extension connected to this Walnut. Install it below; it takes a minute."
            control={null}
          />
        )}
        {rows?.map((r) => (
          <SettingsRow
            key={r.device}
            data-device={r.device}
            data-live={r.live ? 'true' : 'false'}
            data-update={r.update}
            label={<><span className="ext-live-dot" data-live={r.live ? 'true' : 'false'} aria-hidden="true" />{r.label}</>}
            help={r.line}
            control={<SettingsButton busy={busy === r.device} onClick={() => void remove(r.device)}>Remove</SettingsButton>}
          />
        ))}
        {error && <p className="settings-test-result" data-kind="fail" role="alert">{error}</p>}
      </SettingsGroup>
      <SettingsGroup
        heading="Install"
        data-testid="ext-install"
        footer={browser === 'chrome'
          ? <>Chrome lets only you add an extension that is not from its store, so two clicks are yours: Developer mode and Load unpacked. Walnut does the rest. Then click the Walnut icon in the toolbar and Connect: it shows up under Your browsers.</>
          : <>After Connect in the extension&apos;s popup, it shows up under Your browsers.</>}
      >
        <SettingsRow
          label={browser === 'chrome' ? 'Chrome, Edge, Brave or Arc' : 'Firefox'}
          help={<span className="pw-ext-install" style={{ display: 'block', marginTop: 8 }}><ExtensionInstallSteps browser={browser} /></span>}
          control={<SegmentedControl<ExtBrowser> id="pw-ext-browser" aria-label="Browser" value={browser}
            options={[{ value: 'chrome', label: 'Chrome' }, { value: 'firefox', label: 'Firefox' }]}
            onChange={setBrowser} />}
        />
      </SettingsGroup>
      <SettingsGroup heading="What it does" data-testid="ext-features">
        {EXTENSION_FEATURES.map((f) => <SettingsRow key={f.id} data-feature={f.id} label={f.label} help={f.help} control={null} />)}
      </SettingsGroup>
    </>
  )
}
