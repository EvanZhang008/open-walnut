/**
 * The Built in tiles: one per built-in rail entry, with the switch that puts it on
 * or takes it off the rail (builtin-apps.ts has the rules). Taking a Home panel's
 * toggle off the rail also closes that panel when it is open, or it would be stuck
 * open with no button to close it.
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
import { builtinEntries, builtinMatches, type BuiltinEntry } from './builtin-apps'

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

export function BuiltinAppsGrid({ query }: { query: string }) {
  const navigate = useNavigate()
  const apps = useAppCatalog()
  const preferences = useSyncExternalStore(subscribeAppPreferences, getAppPreferences, getAppPreferences)
  const phone = usePhoneLayout()
  const entries = builtinEntries(apps.all.filter((app) => app.kind === 'core'), preferences, { phone })
    .filter((entry) => builtinMatches(entry, query))
  if (entries.length === 0) return null
  return (
    <div className="apps-grid" data-testid="apps-builtin-grid">
      {entries.map((entry) => {
        const Icon = entry.app?.icon ?? (entry.rail ? RAIL_ICONS[entry.rail] : undefined)
        const status = entry.lock ?? (entry.shown ? 'On the sidebar' : 'Hidden from the sidebar')
        return (
          <div
            key={entry.key}
            className={`apps-tile${entry.shown ? '' : ' apps-tile-off'}`}
            data-testid={`apps-builtin-${entry.id}`}
            data-shown={entry.shown}
          >
            <div className="apps-tile-top">
              <button
                type="button"
                className="apps-tile-icon"
                style={{ background: entry.tint }}
                aria-label={`Open ${entry.title}`}
                title={`Open ${entry.title}`}
                onClick={() => navigate(entry.app ? entry.app.path : entry.rail === 'org' ? '/org' : '/')}
              >
                {Icon && <Icon size={19} />}
              </button>
              <div className="apps-tile-text">
                <div className="apps-tile-name">{entry.title}</div>
                <div className="apps-tile-line">{entry.homePanel ? `Home panel · ${entry.line}` : entry.line}</div>
              </div>
            </div>
            <div className="apps-tile-foot">
              <span className="apps-tile-status">{status}</span>
              {entry.lock ? (
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
            </div>
          </div>
        )
      })}
    </div>
  )
}
