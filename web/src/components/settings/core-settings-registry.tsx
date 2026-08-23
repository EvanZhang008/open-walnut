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
  group: 'manage' | 'configure'
  divider?: boolean
  render(context: CoreSettingsContext): ReactNode
}

export const CORE_SETTINGS_CONTRIBUTIONS: readonly CoreSettingsContribution[] = [
  { owner: 'walnut', id: 'repositories', label: 'Repositories', title: 'Repositories', group: 'manage', render: () => <ReposSection /> },
  { owner: 'walnut', id: 'hooks', label: 'Hooks', title: 'Hooks', group: 'manage', render: () => <HooksSection /> },
  { owner: 'walnut', id: 'providers', label: 'AI Provider', title: 'AI Provider', group: 'configure', render: ({ config, saveSection }) => <ProvidersSection config={config} onSave={saveSection} /> },
  { owner: 'walnut', id: 'general', label: 'General', title: 'General', group: 'configure', render: ({ config, saveSection }) => <GeneralSection config={config} onSave={saveSection} /> },
  { owner: 'walnut', id: 'sessions', label: 'Tasks & Sessions', title: 'Tasks & Sessions', group: 'configure', render: ({ config, saveSection }) => <SessionsSection config={config} onSave={saveSection} /> },
  { owner: 'walnut', id: 'focus-tiers', label: 'Focus Tiers', title: 'Focus Tiers', group: 'configure', render: () => <FocusTiersSection /> },
  { owner: 'walnut', id: 'integrations', label: 'Integrations', title: 'Integrations', group: 'configure', render: ({ config, saveSection }) => <IntegrationsSection config={config} onSave={saveSection} /> },
  { owner: 'walnut', id: 'calendar', label: 'Calendar', title: 'Calendar', group: 'configure', render: () => <CalendarSection /> },
  { owner: 'walnut', id: 'permissions', label: 'Permissions', title: 'Permissions', group: 'configure', render: () => <PermissionsSection /> },
  { owner: 'walnut', id: 'plugin-store', label: 'Plugin Store', title: 'Plugin Store', group: 'configure', render: () => <PluginStoreSection /> },
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
  { owner: 'walnut', id: 'timeline', label: 'Timeline', title: 'Timeline', group: 'configure', render: () => <TimelineSection /> },
  { owner: 'walnut', id: 'bug-report', label: 'Bug Report', title: 'Bug Report', group: 'configure', divider: true, render: () => <BugReportSection /> },
]
