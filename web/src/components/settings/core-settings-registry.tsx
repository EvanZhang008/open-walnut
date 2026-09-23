import type { ReactNode } from 'react'
import type { Config } from '@open-walnut/core'
import { AdvancedSection } from './sections/AdvancedSection'
import { AudioCaptureSection } from './sections/AudioCaptureSection'
import { BackupSection } from './sections/BackupSection'
import { BugReportSection } from './sections/BugReportSection'
import { CalendarSection } from './sections/CalendarSection'
import { CloudSection } from './sections/CloudSection'
import { DevicesSection } from './sections/DevicesSection'
import { EnginesSection } from './sections/EnginesSection'
import { FocusTiersSection } from './sections/FocusTiersSection'
import { GeneralSection } from './sections/GeneralSection'
import { HeartbeatSection } from './sections/HeartbeatSection'
import { HooksSection } from './sections/HooksSection'
import { IntegrationsSection } from './sections/IntegrationsSection'
import { PermissionsSection } from './sections/PermissionsSection'
import { PluginStoreSection } from './sections/PluginStoreSection'
import { ProvidersSection } from './sections/ProvidersSection'
import { RemoteHostsSection } from './sections/RemoteHostsSection'
import { SearchSection } from './sections/SearchSection'
import { SessionsSection } from './sections/SessionsSection'
import { SttSection } from './sections/SttSection'
import { SuggestAccuracySection } from './sections/SuggestAccuracySection'
import { TasksSection } from './sections/TasksSection'
import { TimelineSection } from './sections/TimelineSection'
import { TriageSection } from './sections/TriageSection'
import { UsageSection } from './sections/UsageSection'
import type { SettingsGlyphName } from './settings-icons'

export interface SaveSectionOptions {
  /** Row that made the change: a failure is replayed on that row if its pane was hidden. */
  rowKey?: string
}

export interface CoreSettingsContext {
  config: Config
  saveSection(partial: Partial<Config>, opts?: SaveSectionOptions): Promise<void>
  reload(): Promise<void>
}

/**
 * A filter keyword. The object form points at a row inside the section: a hit
 * shows `Matches "<rowLabel>"` and, when `anchor` names an element id that
 * exists in the section source, opening the pane scrolls to that row.
 */
export type SettingsKeyword = string | { word: string; rowLabel: string; anchor?: string }

export interface CoreSettingsContribution {
  owner: 'walnut'
  id: string
  label: string
  title: string
  group: 'manage' | 'plugins' | 'configure' | 'diagnostics'
  divider?: boolean
  /** Rendered in its owner's pane (keeps its `#id` deep link) but has no nav entry of its own. */
  navHidden?: boolean
  /** Glyph name in SETTINGS_ICONS (settings-icons.tsx). */
  icon: SettingsGlyphName
  /** Tile colour behind the white glyph. */
  tint: string
  /** The one sentence under the pane title. */
  description: string
  /** Extra lowercase words the Find a setting box matches. */
  keywords: readonly SettingsKeyword[]
  render(context: CoreSettingsContext): ReactNode
}

export const CORE_SETTINGS_CONTRIBUTIONS: readonly CoreSettingsContribution[] = [
  // There is deliberately NO "Apps" section: a plugin's app entries are managed on
  // the plugin's own row in the Plugins section (PluginAppControls). One panel is
  // the start point for everything plugin-shaped.
  // Repositories is hidden until the feature is ready: the section component
  // (ReposSection), the /api/repositories routes and the agent tools stay; only
  // the Settings entry is gone. Re-add the row here to bring it back.
  {
    owner: 'walnut', id: 'hooks', label: 'Hooks', title: 'Hooks', group: 'manage',
    icon: 'bolt', tint: '#FF9500',
    description: 'What Walnut runs on its own when sessions, tasks and schedules change.',
    keywords: ['automation', 'builtin', 'lifecycle', 'cron', 'daemon policy', 'rename', 'summary', 'auto title'],
    render: () => <HooksSection />,
  },
  // The id stays `plugin-store` (the nav testid, the `#plugin-store` deep link and
  // several specs address it), while the LABEL is now what the section actually is:
  // every plugin on this machine, not just a shop. It anchors the nav's own Plugins
  // group, where every plugin-provided page (a settings-placed App, a plugin
  // settings panel) also lives: one group for everything plugin-shaped.
  // Array position matters: the page renders sections in THIS order, and the nav
  // groups must read in the same top-to-bottom order or a nav click lands somewhere
  // the eye did not expect. Keep this entry directly after the Manage sections.
  {
    owner: 'walnut', id: 'plugin-store', label: 'Plugins', title: 'Plugins', group: 'plugins',
    icon: 'puzzle-piece', tint: '#34C759',
    description: 'Every plugin on this Mac, with its setup and updates.',
    keywords: ['install', 'update', 'mail', 'slack', 'to-do', 'sync', 'app', 'sidebar', 'configure'],
    render: ({ config, saveSection }) => <PluginStoreSection config={config} onSave={saveSection} />,
  },
  {
    owner: 'walnut', id: 'general', label: 'General', title: 'General', group: 'configure',
    icon: 'gear', tint: '#8E8E93',
    description: 'Appearance, window layout and what shows up in chat.',
    keywords: [
      { word: 'theme', rowLabel: 'Appearance', anchor: 'settings-theme' },
      { word: 'dark', rowLabel: 'Appearance', anchor: 'settings-theme' },
      { word: 'light', rowLabel: 'Appearance', anchor: 'settings-theme' },
      'appearance', 'panels', 'columns',
      { word: 'your name', rowLabel: 'Your name', anchor: 'settings-name' },
      'notifications', 'focus bar',
      { word: 'heartbeat all clear', rowLabel: 'Heartbeat all clear', anchor: 'settings-notify-heartbeat' },
      'triage', 'session results', 'subagent',
    ],
    render: ({ config, saveSection }) => <GeneralSection config={config} onSave={saveSection} />,
  },
  // Tasks = where new tasks land + how a finished session reports back onto its
  // task. Focus Tiers is part of the same story (the pinned-task tiers), so it
  // renders right under it and shares the nav entry; `#focus-tiers` still works.
  {
    owner: 'walnut', id: 'tasks', label: 'Tasks', title: 'Tasks', group: 'configure',
    icon: 'checklist', tint: '#007AFF',
    description: 'Where new tasks land and how Walnut fills in their details.',
    keywords: [
      'project', 'inbox', 'priority',
      { word: 'show task priority', rowLabel: 'Show task priority', anchor: 'settings-show-priority' },
      { word: 'default priority', rowLabel: 'Default priority', anchor: 'settings-priority' },
      { word: 'default project', rowLabel: 'Default project', anchor: 'settings-project' },
      'quick add', 'smart', 'jev', 'api key', 'pin', 'triage',
      { word: 'notify', rowLabel: 'Tell Ask Walnut', anchor: 'triage-notify-mode' },
      'summary', 'debounce',
      { word: 'jev model', rowLabel: 'Jev model', anchor: 'jev-model' },
    ],
    render: ({ config, saveSection, reload }) => <TasksSection config={config} onSave={saveSection} onReload={reload} />,
  },
  {
    owner: 'walnut', id: 'focus-tiers', label: 'Focus Tiers', title: 'Focus Tiers', group: 'configure', navHidden: true,
    icon: 'layers', tint: '#007AFF',
    description: 'The tiers pinned tasks are sorted into.',
    keywords: ['focus tiers', 'tier', 'pinned'],
    render: () => <FocusTiersSection />,
  },
  {
    owner: 'walnut', id: 'sessions', label: 'Sessions', title: 'Sessions', group: 'configure',
    icon: 'two-speech-bubbles', tint: '#5856D6',
    description: 'How sessions run, time out and ask before acting.',
    keywords: [
      { word: 'idle timeout', rowLabel: 'Idle timeout', anchor: 'idle-timeout' },
      { word: 'max idle sessions', rowLabel: 'Max idle sessions', anchor: 'max-idle' },
      { word: 'permission prompts', rowLabel: 'Intercept permission prompts', anchor: 'permission-prompt' },
      { word: 'bypass', rowLabel: 'Auto approve in bypass mode', anchor: 'auto-approve-bypass' },
      'approve', 'mode', 'plan',
      { word: 'output mode', rowLabel: 'Output mode', anchor: 'session-output-mode' },
      'html', 'markdown',
    ],
    render: ({ config, saveSection }) => <SessionsSection config={config} onSave={saveSection} />,
  },
  // Sessions is how WALNUT runs an engine; Engines is the engine's OWN settings
  // (what its command-line config screen edits) on the host the sessions run on.
  // Directly after Sessions because that is the question a reader asks next.
  // `saveSection` is for the ONE Walnut-config control in there (the default
  // engine for new sessions); the rest of the section writes the engines' own files.
  {
    owner: 'walnut', id: 'engines', label: 'Engines', title: 'Engines', group: 'configure',
    icon: 'cpu-chip', tint: '#AF52DE',
    description: "The coding agents' own settings on the host your sessions run on.",
    keywords: [
      'claude code', 'codex',
      { word: 'default engine', rowLabel: 'Default engine', anchor: 'default-engine-select' },
      'coding agent', 'engine',
      { word: 'model', rowLabel: 'Claude Code model' },
      'claude code model', 'language', 'output style',
      'fast mode', 'checkpoints', 'workflow',
    ],
    render: ({ config, saveSection }) => <EnginesSection config={config} onSave={saveSection} />,
  },
  // Voice = both directions: dictation in (STT) and read-aloud out (TTS).
  {
    owner: 'walnut', id: 'stt', label: 'Voice', title: 'Voice', group: 'configure',
    icon: 'waveform', tint: '#FF2D55',
    description: 'Dictation in and read aloud out.',
    keywords: ['speech', 'transcription', 'microphone', 'dictate', 'read aloud', 'tts', 'stt', 'whisper'],
    render: ({ config, saveSection, reload }) => <SttSection config={config} onSave={saveSection} onReload={reload} />,
  },
  {
    owner: 'walnut', id: 'audio-capture', label: 'Audio Capture', title: 'Audio Capture', group: 'configure',
    icon: 'microphone', tint: '#FF9500',
    description: 'Recording audio on this Mac for transcripts.',
    keywords: ['record', 'meeting', 'system audio', 'capture'],
    render: ({ config, saveSection }) => <AudioCaptureSection config={config} onSave={saveSection} />,
  },
  {
    owner: 'walnut', id: 'integrations', label: 'Integrations', title: 'Integrations', group: 'configure',
    icon: 'plug', tint: '#30B0C7',
    description: "Keys for the agent's own tools.",
    keywords: ['token', 'bot', 'web search', 'key', 'tool',
      { word: 'slack', rowLabel: 'Slack bot for the agent', anchor: 'slack-token' }],
    render: ({ config, saveSection }) => <IntegrationsSection config={config} onSave={saveSection} />,
  },
  // "Calendar Accounts" / "macOS Access": the two used to be "Calendar" and
  // "Permissions", which collided with the Calendar page and with the session
  // permission-prompt settings.
  {
    owner: 'walnut', id: 'calendar', label: 'Calendar Accounts', title: 'Calendar Accounts', group: 'configure',
    icon: 'calendar-page', tint: '#FF3B30',
    description: 'Which Mac calendars show in Walnut; edits write back through macOS.',
    keywords: ['events', 'icloud', 'google', 'exchange', 'internet accounts', 'refresh'],
    render: () => <CalendarSection />,
  },
  {
    owner: 'walnut', id: 'permissions', label: 'macOS Access', title: 'macOS Access', group: 'configure',
    icon: 'hand-raised', tint: '#007AFF',
    description: 'What macOS allows Walnut to do on this Mac.',
    keywords: ['privacy', 'accessibility', 'screen recording', 'full disk', 'automation', 'tcc'],
    render: () => <PermissionsSection />,
  },
  {
    owner: 'walnut', id: 'heartbeat', label: 'Heartbeat', title: 'Heartbeat', group: 'configure',
    icon: 'heart-pulse', tint: '#FF6B6B',
    description: 'A regular check-in where Walnut works through your checklist.',
    keywords: [
      { word: 'interval', rowLabel: 'Interval', anchor: 'hb-every' },
      { word: 'active hours', rowLabel: 'Active hours', anchor: 'hb-hours' },
      'checklist', 'heartbeat.md', 'schedule',
    ],
    render: ({ config, saveSection }) => <HeartbeatSection config={config} onSave={saveSection} />,
  },
  // Directly after Heartbeat: both are "Walnut wakes itself up and works", and a
  // reader who just set the heartbeat's clock asks about this one next.
  {
    owner: 'walnut', id: 'triage', label: 'Inbox Triage', title: 'Inbox Triage', group: 'configure',
    icon: 'tray', tint: '#007AFF',
    description: 'Walnut reads new mail and messages and sorts out what needs you.',
    keywords: [
      'mail', 'slack', 'inbox', 'assist', 'mark read', 'interval',
    ],
    render: ({ config, saveSection }) => <TriageSection config={config} onSave={saveSection} />,
  },
  {
    owner: 'walnut', id: 'search', label: 'Search', title: 'Search', group: 'configure',
    icon: 'magnifier', tint: '#636366',
    description: 'What search results show.',
    keywords: ['index', 'exclude', 'folders', 'notes'],
    render: ({ config, saveSection }) => <SearchSection config={config} onSave={saveSection} />,
  },
  {
    owner: 'walnut', id: 'backup', label: 'S3 Backup', title: 'S3 Backup', group: 'configure',
    icon: 'archive-box', tint: '#34C759',
    description: 'Scheduled copies of your Walnut data to an S3 bucket.',
    keywords: ['s3', 'bucket', 'region', 'prefix', 'aws', 'profile', 'access key'],
    render: ({ config, saveSection }) => <BackupSection config={config} onSave={saveSection} />,
  },
  // Machines: phones + the cloud companion they reach this Mac through share one
  // nav entry ("Phones & Cloud"); SSH hosts for remote sessions are their own.
  {
    owner: 'walnut', id: 'devices', label: 'Phones & Cloud', title: 'Phones & Cloud', group: 'configure',
    icon: 'phone', tint: '#5856D6',
    description: 'Phones paired with this Mac and the cloud companion they reach it through.',
    keywords: ['phone', 'iphone', 'pair',
      { word: 'qr code', rowLabel: 'Device name', anchor: 'devices-new-name' },
      { word: 'wifi wi-fi', rowLabel: 'Pairing target' }],
    render: () => <DevicesSection />,
  },
  {
    owner: 'walnut', id: 'cloud', label: 'Cloud Companion', title: 'Cloud Companion', group: 'configure', navHidden: true,
    icon: 'cloud', tint: '#5856D6',
    description: 'The cloud relay your phones reach this Mac through.',
    keywords: ['cloud', 'companion', 'bridge'],
    render: () => <CloudSection />,
  },
  {
    owner: 'walnut', id: 'remote-hosts', label: 'Remote Hosts', title: 'Remote Hosts', group: 'configure',
    icon: 'server-stack', tint: '#64748B',
    description: 'SSH hosts that run sessions on another machine.',
    keywords: ['ssh', 'host', 'dev box', 'daemon', 'remote'],
    render: ({ config, saveSection }) => <RemoteHostsSection config={config} onSave={saveSection} />,
  },
  {
    owner: 'walnut', id: 'advanced', label: 'Advanced', title: 'Advanced', group: 'configure',
    icon: 'sliders', tint: '#8E8E93',
    description: 'Git versioning, command safety, subagents and developer options.',
    keywords: [
      'git', 'commit', 'push', 'exec', 'timeout', 'subagent',
      { word: 'subagent model', rowLabel: 'Subagent model', anchor: 'sub-model' },
      'keep awake', 'lid', 'battery', 'sdk',
      { word: 'port', rowLabel: 'Port', anchor: 'sdk-port' }, // the row's real label (N17)
      'raw config', 'json', 'background jobs',
    ],
    render: ({ config, saveSection }) => <AdvancedSection config={config} onSave={saveSection} />,
  },
  // The API alternative to Claude Code for Walnut's small background jobs
  // (names, summaries, memory upkeep, quick-add on the default runner). Folded
  // under Advanced and collapsed: there is ONE engine choice (Engines), and
  // this only matters on a machine without Claude Code or for someone who wants
  // those jobs faster. The `#providers` anchor (setup banner) expands it.
  {
    owner: 'walnut', id: 'providers', label: 'API Provider', title: 'Use an API instead of Claude Code', group: 'configure', navHidden: true,
    icon: 'key', tint: '#8E8E93',
    description: "An API for Walnut's small background jobs instead of Claude Code.",
    keywords: ['api provider', 'bedrock', 'anthropic', 'openrouter', 'api model', 'api'],
    render: ({ config, saveSection }) => <ProvidersSection config={config} onSave={saveSection} />,
  },
  // Diagnostics: read-mostly panels about what Walnut did, not knobs.
  {
    owner: 'walnut', id: 'usage', label: 'Usage & Costs', title: 'Usage & Costs', group: 'diagnostics',
    icon: 'bar-chart', tint: '#34C759',
    description: "What Walnut's model calls cost, by day and by feature.",
    keywords: ['cost', 'tokens', 'spend', 'price'],
    render: () => <UsageSection />,
  },
  {
    owner: 'walnut', id: 'suggest-accuracy', label: 'Suggestion Accuracy', title: 'Suggestion Accuracy', group: 'diagnostics',
    icon: 'target', tint: '#FF9500',
    description: "How often a new session's draft guesses its project and folder right.",
    keywords: ['suggestion', 'accuracy', 'quick add', 'guesses'],
    render: () => <SuggestAccuracySection />,
  },
  // Time tracking's OWN UI is the walnut-time Plugin App, not a section here. The old
  // `time` section was a second copy of it and was deleted; the server side
  // (/api/time/*, the heartbeat capture) is untouched and is what the app reads.
  //
  // This `timeline` row is NOT that feature and did not go with it: it is the
  // screen-activity Life Tracker (/api/timeline/*, screenshot-derived categories, and
  // the only control that enables or disables its cron). Nothing else exposes it, so
  // deleting it as "the duplicated Timeline" would delete a live feature. Labelled
  // "Screen Tracking" so it stops reading as a third Time/Timeline thing.
  {
    owner: 'walnut', id: 'timeline', label: 'Screen Tracking', title: 'Screen Tracking', group: 'diagnostics',
    icon: 'display', tint: '#30B0C7',
    description: 'Screen activity tracking and how it is categorized.',
    keywords: ['screen time', 'screenshots', 'life tracker', 'categories'],
    render: () => <TimelineSection />,
  },
  {
    owner: 'walnut', id: 'bug-report', label: 'Bug Report', title: 'Bug Report', group: 'diagnostics',
    icon: 'ladybug', tint: '#FF3B30',
    description: 'Collect logs and details for a bug report.',
    keywords: ['bug', 'logs', 'diagnostics', 'feedback'],
    render: () => <BugReportSection />,
  },
]
