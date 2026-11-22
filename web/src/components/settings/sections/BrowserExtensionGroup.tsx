/**
 * Settings → Browser extension (BrowserSection.tsx), the parts about the extension itself:
 *   - Your browsers: each extension connected to this Walnut (devices named `extension-*`, from
 *     the browser pairing code) with whether it is connected now, the version it runs against the
 *     one Walnut ships and how it updates (browser-extension-model.ts), and Remove, which ends its
 *     token at once;
 *   - Install: Chrome's store first, then loading it from Walnut (Set up in Chrome on this
 *     machine), or Firefox;
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
import { LoadingState, UnavailableState } from '@/components/common/EmptyState';

export interface ExtensionStatus {
  /** The browsers that let agents in now, with their caps. */
  browsers: Array<{ device: string; caps: string[] }>
  /** The build this Walnut ships (null: built without the extension). */
  extension?: ExtShipped | null
  extensions?: ExtSeen[]
}

/** What the extension adds, in the order a new person meets it. */
export const EXTENSION_FEATURES: Array<{ id: string; label: string; help: string }> = [
  { id: 'passwords', label: 'Fill and save passwords', help: 'Fills logins and one-time codes from Passwords on their own site only, and offers to save new ones.' },
  { id: 'agents', label: 'Agents use your browser', help: 'On in the extension\'s Settings, agents work in their own window, signed in as you. Every tab has Stop and Take over.' },
  { id: 'hand-over', label: 'Hand a tab to an agent', help: 'In the side panel, Act in tab lets that chat\'s agent use the tab you are on, and only that tab. Take it back any time.' },
  { id: 'side-panel', label: 'Ask about the page', help: 'The side panel opens Walnut beside any page, which it can read. Select text and right-click to ask about it.' },
  { id: 'view', label: 'Watch and replay', help: 'A task\'s Browser view shows its tabs live and replays an agent\'s steps (kept for the days set below).' },
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
        footer={shipped ? <>Walnut ships version {shipped.version} (build {shipped.build.slice(0, 7)}). Installed from the Chrome Web Store, the extension updates through the store. Set up from Walnut&apos;s folder, it updates itself after each Walnut update.</> : undefined}
      >
        {rows === null && (loadError
          ? <UnavailableState title="Couldn't read the connected browsers" detail={loadError} />
          : <LoadingState title="Loading the connected browsers…" />)}
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
            title={r.detail}
            control={<SettingsButton variant="danger" busy={busy === r.device} onClick={() => void remove(r.device)}>Remove</SettingsButton>}
          />
        ))}
        {error && <p className="settings-test-result" data-kind="fail" role="alert">{error}</p>}
      </SettingsGroup>
      <SettingsGroup
        heading="Install"
        data-testid="ext-install"
        footer={browser === 'chrome'
          ? <>Add it from the Chrome Web Store in one click. After Connect in the extension&apos;s popup, it shows up under Your browsers.</>
          : <>After Connect in the extension&apos;s popup, it shows up under Your browsers.</>}
      >
        {/* The choice first, on its own row; the steps under it at the copy column's full width,
            not squeezed beside a control in the middle of the card (2026-11-22 audit). */}
        <SettingsRow
          label="Browser"
          control={<SegmentedControl<ExtBrowser> id="pw-ext-browser" aria-label="Browser" value={browser}
            options={[{ value: 'chrome', label: 'Chrome' }, { value: 'firefox', label: 'Firefox' }]}
            onChange={setBrowser} />}
        />
        <SettingsRow
          label={browser === 'chrome' ? 'Chrome, Edge, Brave or Arc' : 'Firefox'}
          help={<span className="pw-ext-install" style={{ display: 'block', marginTop: 8 }}><ExtensionInstallSteps browser={browser} /></span>}
        />
      </SettingsGroup>
      <SettingsGroup heading="What it does" data-testid="ext-features">
        {EXTENSION_FEATURES.map((f) => <SettingsRow key={f.id} data-feature={f.id} label={f.label} help={f.help} control={null} />)}
      </SettingsGroup>
    </>
  )
}
