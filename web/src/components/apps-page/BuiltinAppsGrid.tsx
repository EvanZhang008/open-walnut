/**
 * The Built in cards: one per built-in rail entry, drawn like every other card on the
 * Apps page, and its detail page. A card that can leave the sidebar carries that switch
 * itself, so the one thing a built-in offers is in plain sight; one that must stay (Home,
 * Apps, Settings) shows a lock and no control at all (builtin-apps.ts has the rules). Taking a Home panel's toggle off the rail
 * also closes that panel when it is open, or it would be stuck open with no button to
 * close it.
 */
import { useSyncExternalStore, type ComponentType } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppCatalog } from '@/apps/hooks'
import { ChatBubbleIcon, OrgChartIcon, ScratchpadIcon, TaskPanelIcon, CalendarIcon } from '@/apps/icons'
import type { RailItemId } from '@/apps/rail-items'
import { getAppPreferences, subscribeAppPreferences, updateAppDisposition } from '@/apps/store'
import { homePanelOpen, type HomePanelId } from '@/pages/home-panel-live'
import { usePhoneLayout } from '@/hooks/usePhoneLayout'
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch'
import { SettingsButton } from '@/components/settings/inputs/SettingsButton'
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsSection'
import { builtinEntries, builtinMatches, type BuiltinEntry } from './builtin-apps'
import { StoreCard } from './StoreCard'

const RAIL_ICONS: Readonly<Record<RailItemId, ComponentType<{ size?: number }>>> = {
  'home-todo': TaskPanelIcon,
  'home-chat': ChatBubbleIcon,
  org: OrgChartIcon,
  'home-agenda': CalendarIcon,
  'home-scratchpad': ScratchpadIcon,
}

/**
 * The Home panel a toggle drives, and the event MainPage toggles it on. Ask Walnut is
 * left alone: its spot has its own close button, and its toggle event also clears the
 * Focus Dock's selection.
 */
const HOME_PANELS: Partial<Record<RailItemId, { panel: HomePanelId; toggleEvent: string }>> = {
  'home-todo': { panel: 'todo', toggleEvent: 'sidebar:toggle-todo' },
  'home-agenda': { panel: 'calendar', toggleEvent: 'sidebar:toggle-calendar' },
  'home-scratchpad': { panel: 'scratchpad', toggleEvent: 'sidebar:toggle-scratchpad' },
}

function setOnRail(entry: BuiltinEntry, on: boolean): void {
  updateAppDisposition(entry.key, on ? 'pinned' : 'unpinned')
  const drive = !on && entry.rail ? HOME_PANELS[entry.rail] : undefined
  // The event TOGGLES, so it fires only when this window's MainPage said the panel is open.
  if (drive && homePanelOpen(drive.panel) === true) window.dispatchEvent(new CustomEvent(drive.toggleEvent))
}

function useBuiltinEntries(): BuiltinEntry[] {
  const apps = useAppCatalog()
  const preferences = useSyncExternalStore(subscribeAppPreferences, getAppPreferences, getAppPreferences)
  const phone = usePhoneLayout()
  return builtinEntries(apps.all.filter((app) => app.kind === 'core'), preferences, { phone })
}

const openPath = (entry: BuiltinEntry): string => (entry.app ? entry.app.path : entry.rail === 'org' ? '/org' : '/')

function EntryIcon({ entry, size }: { entry: BuiltinEntry; size: number }) {
  const Icon = entry.app?.icon ?? (entry.rail ? RAIL_ICONS[entry.rail] : undefined)
  return (
    <span className="apps-builtin-icon" style={{ background: entry.tint, width: size, height: size, borderRadius: Math.round(size * 0.26) }}>
      {Icon && <Icon size={Math.round(size * 0.5)} />}
    </span>
  )
}

const statusOf = (entry: BuiltinEntry) => entry.lock
  ? { text: 'Always on the sidebar', tone: 'fixed' as const }
  : entry.shown ? { text: 'On the sidebar', tone: 'on' as const } : { text: 'Only in Apps', tone: 'off' as const }

const LockGlyph = () => (
  <svg className="apps-card-lock" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
)

export function BuiltinAppsGrid({ query, onOpen }: { query: string; onOpen: (key: string) => void }) {
  const navigate = useNavigate()
  const entries = useBuiltinEntries().filter((entry) => builtinMatches(entry, query))
  if (entries.length === 0) return null
  return (
    <div className="apps-grid" data-testid="apps-builtin-grid">
      {entries.map((entry) => (
        <StoreCard
          key={entry.key}
          testId={`apps-builtin-${entry.id}`}
          data={{ 'data-shown': entry.shown }}
          icon={<EntryIcon entry={entry} size={40} />}
          name={entry.title}
          line={entry.homePanel ? `Home panel · ${entry.line}` : entry.line}
          status={statusOf(entry)}
          statusGlyph={entry.lock ? <LockGlyph /> : undefined}
          control={entry.lock ? undefined : (
            <ToggleSwitch
              checked={entry.shown}
              onChange={(next) => setOnRail(entry, next)}
              aria-label={`Show ${entry.title} on the sidebar`}
              data-testid={`apps-builtin-card-toggle-${entry.id}`}
            />
          )}
          dim={!entry.shown}
          onSelect={() => onOpen(entry.key)}
          // On the sidebar it opens from there; off it, the card is the way in.
          open={entry.shown ? undefined : { label: 'Open', onClick: () => navigate(openPath(entry)), testId: `apps-builtin-card-open-${entry.id}` }}
        />
      ))}
    </div>
  )
}

/** A built-in app's page: what it is, Open, and whether it sits on the sidebar. */
export function BuiltinDetail({ entryKey, onBack }: { entryKey: string; onBack: () => void }) {
  const navigate = useNavigate()
  const entry = useBuiltinEntries().find((candidate) => candidate.key === entryKey)
  const back = (
    <button type="button" className="apps-back" onClick={onBack} data-testid="plugin-detail-back">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
      Apps
    </button>
  )
  if (!entry) {
    return (
      <div className="apps-detail" data-testid="builtin-detail">
        {back}
        <SettingsGroup><SettingsRow label="This app is not available here" help="It may not run on this device." /></SettingsGroup>
      </div>
    )
  }
  return (
    <div className="apps-detail" data-testid="builtin-detail" data-builtin-id={entry.id}>
      {back}
      <header className="apps-detail-head">
        <EntryIcon entry={entry} size={72} />
        <div className="apps-detail-title">
          <h1>{entry.title}</h1>
          <p className="apps-detail-line">{entry.line}</p>
          <div className="apps-detail-actions">
            <SettingsButton variant="primary" onClick={() => navigate(openPath(entry))} data-testid={`apps-builtin-open-${entry.id}`}>Open</SettingsButton>
          </div>
        </div>
      </header>
      <SettingsGroup heading="Sidebar" className="apps-detail-group">
        <SettingsRow
          label="Show on the sidebar"
          help={entry.lock
            ? `${entry.lock}, so it always stays on the sidebar.`
            : 'Off takes its icon off the sidebar. It keeps working from links, the Command Palette and this page.'}
          control={entry.lock ? (
            <span className="apps-lock" role="img" title={entry.lock} aria-label={`${entry.title} always stays on the sidebar`}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
            </span>
          ) : (
            <ToggleSwitch
              checked={entry.shown}
              onChange={(next) => setOnRail(entry, next)}
              aria-label={`Show ${entry.title} on the sidebar`}
              data-testid={`apps-builtin-toggle-${entry.id}`}
            />
          )}
        />
      </SettingsGroup>
      <SettingsGroup heading="Where it comes from" className="apps-detail-group">
        <SettingsRow label="Comes from" control={<span className="apps-fact-value">Built into Walnut</span>} />
        <SettingsRow label="Updates" control={<span className="apps-fact-value">Comes with each new Walnut version</span>} />
      </SettingsGroup>
    </div>
  )
}
