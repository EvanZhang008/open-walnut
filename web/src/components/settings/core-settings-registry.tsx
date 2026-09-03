import type { ReactNode } from 'react'
import type { Config } from '@open-walnut/core'
import { AdvancedSection } from './sections/AdvancedSection'
import { AudioCaptureSection } from './sections/AudioCaptureSection'
import { BackupSection } from './sections/BackupSection'
import { BugReportSection } from './sections/BugReportSection'
import { CalendarSection } from './sections/CalendarSection'
import { CloudSection } from './sections/CloudSection'
import { DevicesSection } from './sections/DevicesSection'
import { FocusTiersSection } from './sections/FocusTiersSection'
import { GeneralSection } from './sections/GeneralSection'
import { HeartbeatSection } from './sections/HeartbeatSection'
import { HooksSection } from './sections/HooksSection'
import { IntegrationsSection } from './sections/IntegrationsSection'
import { PermissionsSection } from './sections/PermissionsSection'
import { PluginStoreSection } from './sections/PluginStoreSection'
import { ProvidersSection } from './sections/ProvidersSection'
import { RemoteHostsSection } from './sections/RemoteHostsSection'
import { ReposSection } from './sections/ReposSection'
import { SearchSection } from './sections/SearchSection'
import { SessionsSection } from './sections/SessionsSection'
import { SttSection } from './sections/SttSection'
import { TimelineSection } from './sections/TimelineSection'
import { UsageSection } from './sections/UsageSection'

export interface CoreSettingsContext {
  config: Config
  saveSection(partial: Partial<Config>): Promise<void>
  reload(): Promise<void>
}

export interface CoreSettingsContribution {
  owner: 'walnut'
  id: string
  label: string
  title: string
  group: 'manage' | 'plugins' | 'configure'
  divider?: boolean
  render(context: CoreSettingsContext): ReactNode
}

export const CORE_SETTINGS_CONTRIBUTIONS: readonly CoreSettingsContribution[] = [
  // There is deliberately NO "Apps" section: a plugin's app entries are managed on
  // the plugin's own row in the Plugins section (PluginAppControls). One panel is
  // the start point for everything plugin-shaped.
  { owner: 'walnut', id: 'repositories', label: 'Repositories', title: 'Repositories', group: 'manage', render: () => <ReposSection /> },
  { owner: 'walnut', id: 'hooks', label: 'Hooks', title: 'Hooks', group: 'manage', render: () => <HooksSection /> },
  // The id stays `plugin-store` — the nav testid, the `#plugin-store` deep link and
  // several specs address it — while the LABEL is now what the section actually is:
  // every plugin on this machine, not just a shop. It anchors the nav's own Plugins
  // group, where every plugin-provided page (a settings-placed App, a plugin
  // settings panel) also lives — one group for everything plugin-shaped.
  // Array position matters: the page renders sections in THIS order, and the nav
  // groups must read in the same top-to-bottom order or a nav click lands somewhere
  // the eye did not expect. Keep this entry directly after the Manage sections.
  { owner: 'walnut', id: 'plugin-store', label: 'Plugins', title: 'Plugins', group: 'plugins', render: ({ config, saveSection }) => <PluginStoreSection config={config} onSave={saveSection} /> },
  { owner: 'walnut', id: 'providers', label: 'Ask Walnut Provider', title: 'Ask Walnut (Walnut Agent) Provider', group: 'configure', render: ({ config, saveSection }) => <ProvidersSection config={config} onSave={saveSection} /> },
  { owner: 'walnut', id: 'general', label: 'General', title: 'General', group: 'configure', render: ({ config, saveSection }) => <GeneralSection config={config} onSave={saveSection} /> },
  { owner: 'walnut', id: 'sessions', label: 'Tasks & Sessions', title: 'Tasks & Sessions', group: 'configure', render: ({ config, saveSection }) => <SessionsSection config={config} onSave={saveSection} /> },
  { owner: 'walnut', id: 'focus-tiers', label: 'Focus Tiers', title: 'Focus Tiers', group: 'configure', render: () => <FocusTiersSection /> },
  { owner: 'walnut', id: 'integrations', label: 'Integrations', title: 'Integrations', group: 'configure', render: ({ config, saveSection }) => <IntegrationsSection config={config} onSave={saveSection} /> },
  { owner: 'walnut', id: 'calendar', label: 'Calendar', title: 'Calendar', group: 'configure', render: () => <CalendarSection /> },
  { owner: 'walnut', id: 'permissions', label: 'Permissions', title: 'Permissions', group: 'configure', render: () => <PermissionsSection /> },
  { owner: 'walnut', id: 'search', label: 'Search & Embeddings', title: 'Search', group: 'configure', render: ({ config, saveSection }) => <SearchSection config={config} onSave={saveSection} /> },
  { owner: 'walnut', id: 'stt', label: 'Speech-to-Text', title: 'Speech-to-Text', group: 'configure', render: ({ config, saveSection, reload }) => <SttSection config={config} onSave={saveSection} onReload={reload} /> },
  { owner: 'walnut', id: 'audio-capture', label: 'Audio Capture', title: 'Audio Capture', group: 'configure', render: ({ config, saveSection }) => <AudioCaptureSection config={config} onSave={saveSection} /> },
  { owner: 'walnut', id: 'heartbeat', label: 'Heartbeat', title: 'Heartbeat', group: 'configure', render: ({ config, saveSection }) => <HeartbeatSection config={config} onSave={saveSection} /> },
  { owner: 'walnut', id: 'backup', label: 'S3 Backup', title: 'S3 Backup', group: 'configure', render: ({ config, saveSection }) => <BackupSection config={config} onSave={saveSection} /> },
  { owner: 'walnut', id: 'remote-hosts', label: 'Remote Hosts', title: 'Remote Hosts', group: 'configure', render: ({ config, saveSection }) => <RemoteHostsSection config={config} onSave={saveSection} /> },
  { owner: 'walnut', id: 'devices', label: 'Devices', title: 'Devices', group: 'configure', render: () => <DevicesSection /> },
  { owner: 'walnut', id: 'cloud', label: 'Cloud Companion', title: 'Cloud Companion', group: 'configure', render: () => <CloudSection /> },
  { owner: 'walnut', id: 'advanced', label: 'Advanced', title: 'Advanced', group: 'configure', render: ({ config, saveSection }) => <AdvancedSection config={config} onSave={saveSection} /> },
  { owner: 'walnut', id: 'usage', label: 'Usage & Costs', title: 'Usage & Costs', group: 'configure', divider: true, render: () => <UsageSection /> },
  // Time tracking's OWN UI is the walnut-time Plugin App, not a section here. The old
  // `time` section was a second copy of it and was deleted; the server side
  // (/api/time/*, the heartbeat capture) is untouched and is what the app reads.
  //
  // This `timeline` row is NOT that feature and did not go with it: it is the
  // screen-activity Life Tracker (/api/timeline/*, screenshot-derived categories, and
  // the only control that enables or disables its cron). Nothing else exposes it, so
  // deleting it as "the duplicated Timeline" would delete a live feature.
  { owner: 'walnut', id: 'timeline', label: 'Timeline', title: 'Timeline', group: 'configure', render: () => <TimelineSection /> },
  { owner: 'walnut', id: 'bug-report', label: 'Bug Report', title: 'Bug Report', group: 'configure', divider: true, render: () => <BugReportSection /> },
]
