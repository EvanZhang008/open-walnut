/**
 * Settings → Browser extension: the Walnut extension for Chrome and Firefox. It fills and saves
 * logins from Passwords, and, when the person turns agents on in its popup, lets Walnut agents
 * use the browser (core/browser-control): this pane installs it, lists the connected browsers
 * with Remove, and holds which sites agents may use.
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiPut } from '@/api/client'
import { SettingsGroup, SettingsRow } from '../SettingsSection'
import { SettingsButton } from '../inputs/SettingsButton'
import { SegmentedControl } from '../inputs/SegmentedControl'
import { saveErrorMessage } from '../settings-pane-context'
import { BrowserExtensionGroup } from './BrowserExtensionGroup'

type SiteMode = 'ask' | 'any'
export interface BrowserStatus {
  browsers: Array<{ device: string; label: string; browser: string; caps: string[]; tabs?: unknown[] }>
  mode: SiteMode
  sites: Array<{ site: string; addedAt: string }>
}

export function BrowserSection() {
  const [st, setSt] = useState<BrowserStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const refresh = useCallback(() => {
    apiGet<BrowserStatus>('/api/v1/browser/status').then(setSt).catch((err) => setError(saveErrorMessage(err)))
  }, [])
  useEffect(() => {
    refresh()
    // A browser turning agents on or off shows within seconds.
    const t = setInterval(refresh, 10_000)
    return () => clearInterval(t)
  }, [refresh])

  const save = async (key: string, body: Record<string, unknown>) => {
    setBusy(key); setError('')
    try {
      const r = await apiPut<Pick<BrowserStatus, 'mode' | 'sites'>>('/api/v1/browser/settings', body)
      setSt((s) => (s ? { ...s, ...r } : s))
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setBusy('')
    }
  }

  const agentsOn = new Set(st?.browsers.map((b) => b.device) ?? [])
  return (
    <>
      <BrowserExtensionGroup agentsOn={agentsOn} />
      <SettingsGroup
        heading="Agents in your browser"
        footer={<>Agents use your browser only after you turn it on in the extension (its popup, Settings). They open their own tabs in a separate window, never yours, see and act only in those, and each tab has a Stop button that takes it back. They never use Walnut's own pages.</>}
      >
        <SettingsRow
          label="Browsers that let agents in now"
          help={st === null ? 'Loading…' : st.browsers.length ? st.browsers.map((b) => b.label).join(', ') : 'None: in the extension popup, Settings, turn on "Let Walnut agents use this browser".'}
          control={null}
        />
        <SettingsRow
          label="When an agent opens a site it has not used"
          help={st?.mode === 'any' ? 'Agents may open any site.' : 'You approve each new site once, on your Mac or phone; it is allowed from then on.'}
          control={<SegmentedControl<SiteMode> id="browser-site-mode" aria-label="When an agent opens a site it has not used" value={st?.mode ?? 'ask'} disabled={!st || busy === 'mode'}
            options={[{ value: 'ask', label: 'Ask me first' }, { value: 'any', label: 'Allow any site' }]}
            onChange={(v) => void save('mode', { mode: v })} />}
        />
        {st && st.mode === 'ask' && st.sites.length === 0 && <SettingsRow label="Allowed sites" help="None yet. A site you approve shows here." control={null} />}
        {st?.sites.map((s) => (
          <SettingsRow
            key={s.site}
            label={s.site}
            help={`Allowed ${new Date(s.addedAt).toLocaleDateString()}`}
            control={<SettingsButton busy={busy === s.site} onClick={() => void save(s.site, { removeSite: s.site })}>Remove</SettingsButton>}
          />
        ))}
        {error && <p className="settings-test-result" data-kind="fail" role="alert">{error}</p>}
      </SettingsGroup>
    </>
  )
}
