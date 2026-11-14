/**
 * Settings → Browser extension: the Walnut extension for Chrome and Firefox. It fills and saves
 * logins from Passwords, and, when the person turns agents on in its popup, lets Walnut agents
 * use the browser (core/browser-control): this pane installs it, lists the connected browsers
 * with Remove, and holds which sites agents may use.
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiPut } from '@/api/client'
import { SettingsGroup, SettingsRow, SettingsSection } from '../SettingsSection'
import { SettingsButton } from '../inputs/SettingsButton'
import { SegmentedControl } from '../inputs/SegmentedControl'
import { saveErrorMessage } from '../settings-pane-context'
import { BrowserExtensionGroup } from './BrowserExtensionGroup'

type SiteMode = 'ask' | 'any'
export interface BrowserStatus {
  browsers: Array<{ device: string; label: string; browser: string; caps: string[]; tabs?: unknown[] }>
  mode: SiteMode
  sites: Array<{ site: string; addedAt: string }>
  /** How long the Browser replay keeps agents' steps (0: off), and what it holds now. */
  replayDays?: number
  replayBytes?: number
}

/** Settings' choices for the replay (the server takes these only: replay-store.ts REPLAY_DAY_CHOICES). */
export const REPLAY_DAY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '0', label: 'Off' }, { value: '1', label: '1 day' }, { value: '3', label: '3 days' },
  { value: '7', label: '7 days' }, { value: '14', label: '14 days' }, { value: '30', label: '30 days' },
]

/** Bytes as a person reads them. */
export function sizeLine(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
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
      const r = await apiPut<Pick<BrowserStatus, 'mode' | 'sites' | 'replayDays' | 'replayBytes'>>('/api/v1/browser/settings', body)
      setSt((s) => (s ? { ...s, ...r } : s))
    } catch (err) {
      setError(saveErrorMessage(err))
    } finally {
      setBusy('')
    }
  }

  const agentsOn = new Set(st?.browsers.map((b) => b.device) ?? [])
  // Every pane is a settings section with its registry id: that draws the pane's title and is
  // what the nav, search and deep links find (tests/e2e/browser/settings-panes.spec.ts C2).
  return (
    <SettingsSection id="browser" title="Browser extension">
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
          control={<SegmentedControl<SiteMode> id="browser-site-mode" aria-label="When an agent opens a site it has not used" value={st?.mode ?? 'any'} disabled={!st || busy === 'mode'}
            options={[{ value: 'any', label: 'Allow any site' }, { value: 'ask', label: 'Ask me first' }]}
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
        <SettingsRow
          label="Keep replays of agents' steps"
          help={st?.replayDays === 0
            ? 'Off: no picture of an agent\'s step is kept.'
            : `A picture of each step an agent takes in your browser, so a task's Browser view can play it back. Kept on this computer only, never synced or backed up, and deleted after ${st?.replayDays ?? 7} day${st?.replayDays === 1 ? '' : 's'}${st?.replayBytes !== undefined ? `. Using ${sizeLine(st.replayBytes)} now (at most 2 GB)` : ''}.`}
          control={(
            <select id="browser-replay-days" className="settings-select" aria-label="Keep replays of agents' steps" data-testid="browser-replay-days"
              value={String(st?.replayDays ?? 7)} disabled={!st || busy === 'replay'}
              onChange={(e) => void save('replay', { replayDays: Number(e.target.value) })}>
              {REPLAY_DAY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
        />
        {error && <p className="settings-test-result" data-kind="fail" role="alert">{error}</p>}
      </SettingsGroup>
    </SettingsSection>
  )
}
