/**
 * The Built in cards: one per built-in app, drawn like every other card on the Apps page,
 * and its detail page. Every card has Open, and every part that can leave the sidebar has
 * its own switch on the card (one part: in the footer; several: one row each), so what a
 * built-in offers is in plain sight; a part that must stay (Home's page, Apps, Settings)
 * shows a lock and no control at all (builtin-apps.ts has the rules). An app whose data
 * lives in a plugin (Calendar, Mail) is one card with that plugin: its status is the
 * plugin's while the plugin is not simply on, and the card opens the plugin's page, which
 * holds the parts too (`AppPartsGroup`). Taking a Home panel's or a side bar's toggle off
 * the rail also closes it when it is open, or it would be stuck open with no button to
 * close it.
 */
import { useMemo, useSyncExternalStore, type ComponentType } from 'react'
import { ICON_CHEVRON_LEFT } from '@/components/common/Icons'
import { useNavigate } from 'react-router-dom'
import { useSidebarDefault } from '@/apps/hooks'
import { activePluginKey, appRegistry } from '@/apps/registry'
import { useWebPluginRuntime } from '@/plugins/runtime-store'
import { AgendaIcon, ChatBubbleIcon, OrgChartIcon, ScratchpadIcon, TaskPanelIcon } from '@/apps/icons'
import type { RailItemId } from '@/apps/rail-items'
import { getAppPreferences, subscribeAppPreferences, updateAppDisposition, updateAppOnSidebar } from '@/apps/store'
import { useExperimental } from '@/hooks/useExperimental'
import { homePanelOpen, type HomePanelId } from '@/pages/home-panel-live'
import { usePhoneLayout } from '@/hooks/usePhoneLayout'
import { SettingsButton } from '@/components/settings/inputs/SettingsButton'
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsSection'
import { PART_KIND_LABEL, builtinEntries, partsStatus, type AppPart, type BuiltinEntry, type HeldPlugin } from './builtin-apps'
import { AppsGrid, SidebarSwitch } from './app-bits'
import type { RegistryRow } from './plugin-store-model'
import { categoryOf } from './categories'
import { setSideBarPane, sideBarPageOf } from '@/components/layout/page-side-bar'
import { pluginCardFacts, type PluginCardFacts } from './plugin-card-facts'
import type { PluginStore } from './usePluginStore'
import { StoreCard, type StoreCardPart } from './StoreCard'

const RAIL_ICONS: Readonly<Record<RailItemId, ComponentType<{ size?: number }>>> = {
  'home-todo': TaskPanelIcon,
  'home-chat': ChatBubbleIcon,
  org: OrgChartIcon,
  'home-agenda': AgendaIcon,
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

export function setPartOnRail(part: AppPart, on: boolean, quietRail: boolean): void {
  // A registry app goes through the one Sidebar switch: a quiet_rail app's pin is a placement.
  if (part.app) updateAppOnSidebar(part.app, on, quietRail)
  else updateAppDisposition(part.key, on ? 'pinned' : 'unpinned')
  const drive = !on && part.rail ? HOME_PANELS[part.rail] : undefined
  // The event TOGGLES, so it fires only when this window's MainPage said the panel is open.
  if (drive && homePanelOpen(drive.panel) === true) window.dispatchEvent(new CustomEvent(drive.toggleEvent))
}

/** The built-in entries every part of the Apps page reads (the grid, a detail page, the page's count). */
export function useBuiltinEntries(): BuiltinEntry[] {
  // Every core app, its plugin on or off: Mail's card stays in place, Off, while its plugin is
  // off (the catalogue drops the app then, which would move the plugin back to the plugin list).
  const registry = useSyncExternalStore(appRegistry.subscribe, appRegistry.getSnapshot, appRegistry.getSnapshot)
  const runtime = useWebPluginRuntime()
  const activeKey = activePluginKey(runtime)
  const preferences = useSyncExternalStore(subscribeAppPreferences, getAppPreferences, getAppPreferences)
  const phone = usePhoneLayout()
  const sidebarDefault = useSidebarDefault()
  const quietRail = useExperimental('quiet_rail')
  return useMemo(() => {
    const core = registry.apps.filter((app) => app.kind === 'core').sort((a, b) => a.order - b.order)
    // Until the runtime answers, every plugin reads on (nothing flickers to Off at load).
    const activePlugins = runtime.ready ? new Set(activeKey.split(',').filter(Boolean)) : undefined
    return builtinEntries(core, preferences, { phone, sidebarDefault, quietRail, activePlugins })
  }, [registry, runtime.ready, activeKey, preferences, phone, sidebarDefault, quietRail])
}

/**
 * The plugin rows a built-in card holds (Calendar's, Mail's): the plugin list leaves them
 * out, so each shows once. Only an installed row folds; one this build lacks has no card to fold.
 */
export function foldedPluginRows(entries: readonly BuiltinEntry[], installed: readonly RegistryRow[]): Map<string, RegistryRow> {
  const out = new Map<string, RegistryRow>()
  for (const entry of entries) {
    const row = entry.plugin ? installed.find((candidate) => candidate.id === entry.plugin) : undefined
    if (row) out.set(entry.key, row)
  }
  return out
}

/** The card that holds this plugin, if a built-in app does. */
export function entryHoldingPlugin(entries: readonly BuiltinEntry[], row: Pick<RegistryRow, 'id' | 'installed'>): BuiltinEntry | undefined {
  return row.installed ? entries.find((entry) => entry.plugin === row.id) : undefined
}

/** Each held plugin's facts and what the page filters it by, for `builtinsShown`/`builtinsMatching`. */
export function heldPlugins(
  folded: ReadonlyMap<string, RegistryRow>,
  store: Pick<PluginStore, 'installed' | 'connections' | 'stateFor'>,
): { facts: Map<string, PluginCardFacts>; held: Map<string, HeldPlugin> } {
  const facts = new Map<string, PluginCardFacts>()
  const held = new Map<string, HeldPlugin>()
  for (const [key, row] of folded) {
    const own = pluginCardFacts(store, row)
    facts.set(key, own)
    held.set(key, { category: categoryOf(row), text: heldPluginText(row, own) })
  }
  return { facts, held }
}

const iconOf = (target: { app?: AppPart['app']; rail?: RailItemId }) => target.app?.icon ?? (target.rail ? RAIL_ICONS[target.rail] : undefined)

export function EntryIcon({ entry, size }: { entry: Pick<BuiltinEntry, 'app' | 'rail' | 'tint'>; size: number }) {
  const Icon = iconOf(entry)
  return (
    <span className="apps-builtin-icon" style={{ background: entry.tint, width: size, height: size, borderRadius: Math.round(size * 0.26) }}>
      {Icon && <Icon size={Math.round(size * 0.5)} />}
    </span>
  )
}

export const LockGlyph = () => (
  <svg className="apps-card-lock" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
)

/** One switch per part on the card: the footer's for a one-part app, a row each for more. */
function partSwitch(part: AppPart, quietRail: boolean, testId: string, labelled = false) {
  return <SidebarSwitch name={part.title} shown={part.shown} onChange={(next) => setPartOnRail(part, next, quietRail)} testId={testId} labelled={labelled} />
}

/** What a search finds a held plugin by: its name, its description and its plugin parts. */
export function heldPluginText(row: RegistryRow | undefined, facts: PluginCardFacts | undefined): string[] {
  return row ? [row.name, row.description ?? '', ...(facts?.parts ?? []).flatMap((part) => [part.name, part.description ?? ''])] : []
}

export function BuiltinAppsGrid({ entries, folded, facts, onOpen, onOpenPlugin }: {
  /** The cards to draw, already narrowed by the search and the chip (`builtinsMatching`). */
  entries: readonly BuiltinEntry[]
  /** The plugin row each held card carries (`foldedPluginRows`) and its card facts (`heldPlugins`). */
  folded: ReadonlyMap<string, RegistryRow>
  facts: ReadonlyMap<string, PluginCardFacts>
  onOpen: (key: string) => void
  /** Opens a plugin's page: a card that holds a plugin opens it. */
  onOpenPlugin: (pluginId: string) => void
}) {
  const navigate = useNavigate()
  const quietRail = useExperimental('quiet_rail')
  if (entries.length === 0) return null
  return (
    <AppsGrid data-testid="apps-builtin-grid">
      {entries.map((entry) => {
        const row = folded.get(entry.key)
        const own = facts.get(entry.key)
        // The plugin speaks first while it is not simply on (off, needs setup, failed, a part's trouble).
        const status = own && own.status.tone !== 'on' ? own.status : partsStatus(entry)
        const one = entry.parts.length === 1 ? entry.parts[0] : undefined
        const parts: StoreCardPart[] | undefined = one ? undefined : entry.parts.map((part) => ({
          id: part.id,
          title: part.title,
          kind: PART_KIND_LABEL[part.kind],
          shown: part.shown,
          control: part.lock
            ? <span className="apps-card-part-lock" role="img" aria-label={`${part.title} always stays on the sidebar`} title={part.lock}><LockGlyph /></span>
            : partSwitch(part, quietRail, `apps-builtin-card-toggle-${part.id}`),
        }))
        return (
          <StoreCard
            key={entry.key}
            testId={`apps-builtin-${entry.id}`}
            data={{ 'data-shown': entry.shown, 'data-plugin': row?.id }}
            icon={<EntryIcon entry={entry} size={40} />}
            name={entry.title}
            line={entry.line}
            note={own?.note}
            parts={parts}
            status={status}
            statusGlyph={status.tone === 'fixed' ? <LockGlyph /> : undefined}
            control={one && !one.lock ? partSwitch(one, quietRail, `apps-builtin-card-toggle-${one.id}`, true) : undefined}
            dim={row ? row.status === 'disabled' || row.status === 'unsupported' || !entry.shown : !entry.shown}
            onSelect={() => (row ? onOpenPlugin(row.id) : onOpen(entry.key))}
            // Every card opens its app; Apps is this page, and a page whose plugin is off has nothing to show.
            open={entry.id === 'apps' || entry.pluginOff ? undefined : { label: 'Open', onClick: () => navigate(entry.openPath), testId: `apps-builtin-card-open-${entry.id}` }}
          />
        )
      })}
    </AppsGrid>
  )
}

/**
 * An app's parts on its page: each with what it is, whether it sits on the sidebar, and
 * Open. The built-in page and a held plugin's page both show it.
 */
export function AppPartsGroup({ entry }: { entry: BuiltinEntry }) {
  const quietRail = useExperimental('quiet_rail')
  const several = entry.parts.length > 1
  return (
    <SettingsGroup heading={several ? 'Parts' : 'Sidebar'} className="apps-detail-group" data-testid={`apps-parts-${entry.id}`}>
      {entry.parts.map((part) => {
        const Icon = iconOf(part)
        const where = part.lock
          ? `${part.lock}, so it always stays on the sidebar.`
          : !several
            ? 'Off takes its icon off the sidebar. It keeps working from links, the Command Palette and this page.'
            : part.shown ? 'On the sidebar.' : PART_OFF_HELP[part.kind]
        return (
          <SettingsRow
            key={part.key}
            data-testid={`apps-part-${part.id}`}
            data-shown={part.shown}
            className="apps-app-row"
            label={several ? (
              <span className="settings-addons-inline">
                <span className="apps-app-glyph" style={{ background: entry.tint }}>{Icon && <Icon size={14} />}</span>
                <span>{part.title}</span>
                <span className="apps-part-kind">{PART_KIND_LABEL[part.kind]}</span>
              </span>
            ) : 'Show on the sidebar'}
            help={several && part.line ? `${part.line}. ${where}` : where}
            control={(
              <>
                {/* A side bar opens beside this page, on the sidebar or not; the page opens from the header. */}
                {several && part.kind === 'side-bar' && part.rail && (
                  <SettingsButton onClick={() => openSideBarHere(part.rail!)} data-testid={`apps-part-open-${part.id}`}>Open</SettingsButton>
                )}
                {part.lock ? (
                  <span className="apps-lock" role="img" title={part.lock} aria-label={`${part.title} always stays on the sidebar`}><LockGlyph /></span>
                ) : (
                  <>
                    {several && <span className="apps-app-switch-label">Show on the sidebar</span>}
                    <SidebarSwitch name={part.title} shown={part.shown} onChange={(next) => setPartOnRail(part, next, quietRail)} testId={`apps-builtin-toggle-${part.id}`} />
                  </>
                )}
              </>
            )}
          />
        )
      })}
    </SettingsGroup>
  )
}

/** What a part off the sidebar still does, by kind. */
const PART_OFF_HELP: Readonly<Record<AppPart['kind'], string>> = {
  page: 'Off the sidebar: Open above and the Command Palette still open it.',
  'side-bar': 'Off the sidebar: Open shows it beside this page.',
  'home-panel': 'Off the sidebar: its panel on Home stays as it is.',
}

/** The side bar a part names, opened beside the page on screen (the Apps page here). */
function openSideBarHere(rail: RailItemId): void {
  const pane = rail === 'home-agenda' ? 'agenda' : rail === 'home-scratchpad' ? 'scratchpad' : null
  const page = sideBarPageOf(window.location.pathname)
  if (pane && page) setSideBarPane(page, pane, true)
}

/** A built-in app's page: what it is, Open, and its parts on the sidebar. */
export function BuiltinDetail({ entryKey, onBack }: { entryKey: string; onBack: () => void }) {
  const navigate = useNavigate()
  const entry = useBuiltinEntries().find((candidate) => candidate.key === entryKey || candidate.parts.some((part) => part.key === entryKey))
  const back = (
    <button type="button" className="apps-back" onClick={onBack} data-testid="plugin-detail-back">
      {ICON_CHEVRON_LEFT}
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
          <h1 className="page-title">{entry.title}</h1>
          <p className="page-subtitle apps-detail-line">{entry.line}</p>
          <div className="apps-detail-actions">
            <SettingsButton variant="primary" onClick={() => navigate(entry.openPath)} data-testid={`apps-builtin-open-${entry.id}`}>Open</SettingsButton>
          </div>
        </div>
      </header>
      <AppPartsGroup entry={entry} />
      <SettingsGroup heading="Where it comes from" className="apps-detail-group">
        <SettingsRow label="Comes from" control={<span className="apps-fact-value">Built into Walnut</span>} />
        <SettingsRow label="Updates" control={<span className="apps-fact-value">Comes with each new Walnut version</span>} />
      </SettingsGroup>
    </div>
  )
}
