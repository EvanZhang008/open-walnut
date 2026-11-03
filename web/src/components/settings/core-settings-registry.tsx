import type { ReactNode } from 'react'
import type { Config } from '@open-walnut/core'
import { AdvancedSection } from './sections/AdvancedSection'
import { AudioCaptureSection } from './sections/AudioCaptureSection'
import { BackupSection } from './sections/BackupSection'
import { BugReportSection } from './sections/BugReportSection'
import { CalendarSection } from './sections/CalendarSection'
import { CloudSection } from './sections/CloudSection'
import { DevicesSection } from './sections/DevicesSection'
import { DevicesWaySection } from './sections/DevicesWaySection'
import { FocusTiersSection } from './sections/FocusTiersSection'
import { GeneralSection } from './sections/GeneralSection'
import { HooksSection } from './sections/HooksSection'
import { MailRulesSection } from './sections/MailRulesSection'
import { OrgSection } from './sections/OrgSection'
import { PageUseSection } from './sections/PageUseSection'
import { PasswordsSection } from './sections/PasswordsSection'
import { PermissionsSection } from './sections/PermissionsSection'
import { ProvidersSection } from './sections/ProvidersSection'
import { RemoteHostsSection } from './sections/RemoteHostsSection'
import { SearchSection } from './sections/SearchSection'
import { SessionsSection } from './sections/SessionsSection'
import { SttSection } from './sections/SttSection'
import { SuggestAccuracySection } from './sections/SuggestAccuracySection'
import { TagsSection } from './sections/TagsSection'
import { TaskProvidersSection } from './sections/TaskProvidersSection'
import { TasksSection } from './sections/TasksSection'
import { TriageSection } from './sections/TriageSection'
import { UsageSection } from './sections/UsageSection'
import type { SettingsGlyphName } from './settings-icons'
import type { SettingsPaneGate } from './settings-pane-gates'

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
  /**
   * A sub-page of another entry (iOS / macOS Settings style): its nav row sits indented
   * under the parent and shows while the parent or one of its sub-pages is open, and the
   * pane leads with a way back to the parent (SettingsPaneBack).
   */
  parent?: string
  /**
   * A server fact the pane needs to have anything to show (settings-pane-gates.ts).
   * A section that can render nothing names one, so no nav entry opens an empty pane
   * (tests/web/settings-registry.test.ts finds the ones that do not).
   */
  requires?: SettingsPaneGate
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
  // Plugins are not a section here: the Apps page (/apps, pages/AppsPage.tsx) owns
  // every plugin and every App, built in or not. The nav's Plugins group links to it
  // (SettingsNav APPS_LINK_ROW) above the plugins' own settings panels, and
  // the old `#plugin-store` deep link forwards there (SettingsPage).
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
  {
    owner: 'walnut', id: 'general', label: 'General', title: 'General', group: 'configure',
    icon: 'gear', tint: '#8E8E93',
    description: 'Appearance, window layout and updates.',
    keywords: [
      { word: 'theme', rowLabel: 'Appearance', anchor: 'settings-theme' },
      { word: 'dark', rowLabel: 'Appearance', anchor: 'settings-theme' },
      { word: 'light', rowLabel: 'Appearance', anchor: 'settings-theme' },
      'appearance', 'panels', 'columns',
      { word: 'your name', rowLabel: 'Your name', anchor: 'settings-name' },
      'focus bar',
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
  // Tags: how tags show on tasks. Folded under Tasks with Focus Tiers (`#tags` still works).
  {
    owner: 'walnut', id: 'tags', label: 'Tags', title: 'Tags', group: 'configure', navHidden: true,
    icon: 'checklist', tint: '#AF52DE',
    description: 'How tags show on tasks, and what they open.',
    keywords: ['tags', 'tag', 'hide tag', 'show tag', 'tag value', 'key', 'namespace', 'pill', 'tag link', 'link', 'url'],
    render: () => <TagsSection />,
  },
  // Task providers: each plugin that syncs tasks, with the rules a task must pass before it
  // syncs there (src/core/private-tasks/provider-rules.ts). Folded under Tasks (`#task-providers`
  // still works, and each task plugin's own settings link here).
  {
    owner: 'walnut', id: 'task-providers', label: 'Task providers', title: 'Task providers', group: 'configure', navHidden: true,
    icon: 'plug', tint: '#007AFF',
    description: 'Each service tasks sync to, and the rules a task must pass first.',
    keywords: [
      'private', 'sensitive', 'local only', 'keep local', 'hard rules', 'ai rule', 'words', 'sync',
      'to do', 'tracker', 'provider',
    ],
    render: ({ config, saveSection }) => <TaskProvidersSection config={config} onSave={saveSection} />,
  },
  {
    owner: 'walnut', id: 'sessions', label: 'Sessions', title: 'Sessions', group: 'configure',
    icon: 'two-speech-bubbles', tint: '#5856D6',
    description: 'How sessions run, time out and ask before acting.',
    keywords: [
      { word: 'default engine', rowLabel: 'Default engine', anchor: 'default-engine-select' },
      'engine', 'claude code', 'codex', 'coding agent',
      { word: 'idle timeout', rowLabel: 'Idle timeout', anchor: 'idle-timeout' },
      { word: 'max idle sessions', rowLabel: 'Max idle sessions', anchor: 'max-idle' },
      { word: 'permission prompts', rowLabel: 'Intercept permission prompts', anchor: 'permission-prompt' },
      { word: 'bypass', rowLabel: 'Auto approve in bypass mode', anchor: 'auto-approve-bypass' },
      'approve', 'mode', 'plan',
      { word: 'output mode', rowLabel: 'Output mode', anchor: 'session-output-mode' },
      'html', 'markdown',
      { word: 'reply language', rowLabel: 'Reply language', anchor: 'session-reply-language' },
      'language', 'chinese', 'english',
      { word: 'message hints', rowLabel: 'Message hints', anchor: 'message-hints' },
      { word: 'walnut added', rowLabel: 'Always show what Walnut added to a message', anchor: 'settings-show-walnut-additions' },
      'hint', 'reminder', 'system-reminder',
    ],
    render: ({ config, saveSection }) => <SessionsSection config={config} onSave={saveSection} />,
  },
  // Voice = dictation (STT) and the recordings it keeps.
  {
    owner: 'walnut', id: 'stt', label: 'Voice', title: 'Voice', group: 'configure',
    icon: 'waveform', tint: '#FF2D55',
    description: 'Dictation and the recordings it keeps.',
    keywords: ['speech', 'transcription', 'microphone', 'dictate', 'stt', 'whisper'],
    render: ({ config, saveSection, reload }) => <SttSection config={config} onSave={saveSection} onReload={reload} />,
  },
  {
    owner: 'walnut', id: 'audio-capture', label: 'Audio Capture', title: 'Audio Capture', group: 'configure',
    icon: 'microphone', tint: '#FF9500',
    description: 'Recording audio on this Mac for transcripts.',
    keywords: ['record', 'meeting', 'system audio', 'capture'],
    render: ({ config, saveSection }) => <AudioCaptureSection config={config} onSave={saveSection} />,
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
    requires: 'mac-access',
    icon: 'hand-raised', tint: '#007AFF',
    description: 'What macOS allows Walnut to do on this Mac.',
    keywords: ['privacy', 'accessibility', 'screen recording', 'full disk', 'automation', 'tcc'],
    render: () => <PermissionsSection />,
  },
  // The org above the work (Main and the VPs) and the one switch that turns it off.
  {
    owner: 'walnut', id: 'org', label: 'Org', title: 'Org', group: 'configure',
    icon: 'two-person', tint: '#AF52DE',
    description: 'Main and the VPs that lead your projects, and whether they run at all.',
    keywords: ['org', 'main', 'ceo', 'vp', 'lead', 'brief', 'turn off', 'disable', 'organization'],
    render: () => <OrgSection />,
  },
  {
    owner: 'walnut', id: 'triage', label: 'Inbox Triage', title: 'Inbox Triage', group: 'configure',
    icon: 'tray', tint: '#007AFF',
    description: 'Walnut reads new mail and messages and sorts out what needs you.',
    keywords: [
      'mail', 'slack', 'inbox', 'assist', 'mark read', 'interval',
    ],
    render: ({ config, saveSection }) => <TriageSection config={config} onSave={saveSection} />,
  },
  // Mail rules: how the Mail app sorts an inbox into Important and groups. Right after Inbox Triage,
  // which reads only Important when grouping is on; a different icon (a funnel, not the tray) and a
  // different sentence, so the two are never mistaken for one another. With the Mail plugin off the
  // section says so itself (`This panel is from Mail, which is off.`).
  {
    owner: 'walnut', id: 'mail-rules', label: 'Mail rules', title: 'Mail rules', group: 'configure',
    icon: 'filter', tint: '#5AC8FA',
    description: 'Sorts your inbox into Important and groups with rules you control.',
    keywords: ['mail', 'inbox', 'group', 'sort', 'rules', 'important', 'notifications', 'newsletters'],
    render: () => <MailRulesSection />,
  },
  {
    owner: 'walnut', id: 'search', label: 'Search', title: 'Search', group: 'configure',
    icon: 'magnifier', tint: '#636366',
    description: 'What search results show.',
    keywords: ['index', 'exclude', 'folders', 'notes'],
    render: ({ config, saveSection }) => <SearchSection config={config} onSave={saveSection} />,
  },
  {
    owner: 'walnut', id: 'passwords', label: 'Passwords', title: 'Passwords', group: 'configure',
    icon: 'key', tint: '#FF9500',
    description: 'Your password vault: auto-lock, agent access, master password, recovery kit and export.',
    keywords: ['password', 'vault', 'master password', 'secret key', 'recovery', 'forgot', 'auto-lock', 'export', 'agents', 'autofill'],
    render: ({ config, saveSection }) => <PasswordsSection config={config} onSave={saveSection} />,
  },
  {
    owner: 'walnut', id: 'backup', label: 'S3 Backup', title: 'S3 Backup', group: 'configure',
    icon: 'archive-box', tint: '#34C759',
    description: 'Scheduled copies of your Walnut data to an S3 bucket.',
    keywords: ['s3', 'bucket', 'region', 'prefix', 'aws', 'profile', 'access key'],
    render: ({ config, saveSection }) => <BackupSection config={config} onSave={saveSection} />,
  },
  // Machines: Phones & Cloud is the main entry (paired phones and browsers, pairing a
  // phone, and the three ways at a glance); each way is its own sub-page under it.
  // SSH hosts for remote sessions are their own entry.
  {
    owner: 'walnut', id: 'devices', label: 'Phones & Cloud', title: 'Phones & Cloud', group: 'configure',
    icon: 'phone', tint: '#5856D6',
    description: 'How your phone and browsers reach Walnut: the cloud companion, Tailscale, or a browser link.',
    keywords: ['phone', 'iphone', 'pair', 'paired phones', 'signed-in browsers',
      { word: 'qr code', rowLabel: 'Device name', anchor: 'devices-new-name' },
      { word: 'wifi wi-fi', rowLabel: 'Pairing target' }],
    render: () => <DevicesSection />,
  },
  // `#cloud` keeps its old deep link: it is the Cloud companion sub-page now.
  {
    owner: 'walnut', id: 'cloud', label: 'Cloud companion', title: 'Cloud companion', group: 'configure', parent: 'devices',
    icon: 'cloud', tint: '#5856D6',
    description: 'A small server of yours in the cloud that your phone talks to, even while this Mac sleeps.',
    keywords: ['cloud', 'companion', 'bridge', 'relay', 'updates',
      { word: 'away sleep take over backup leader', rowLabel: 'Cloud companion takes over', anchor: 'devices-backup-leader' },
      { word: 'keeps copies', rowLabel: 'What the cloud companion keeps', anchor: 'companion-keep' }],
    render: ({ config, saveSection }) => <CloudSection config={config} onSave={saveSection} />,
  },
  {
    owner: 'walnut', id: 'devices-tailscale', label: 'Tailscale', title: 'Tailscale', group: 'configure', parent: 'devices',
    requires: 'primary',
    icon: 'network', tint: '#5856D6',
    description: 'A private network between this Mac and your phone, so the phone talks to this Mac directly.',
    keywords: ['tailscale', 'tailnet', 'vpn', 'from anywhere'],
    render: () => <DevicesWaySection way="tailscale" />,
  },
  {
    owner: 'walnut', id: 'devices-browser', label: 'Browser link', title: 'Browser link', group: 'configure', parent: 'devices',
    requires: 'primary',
    icon: 'globe', tint: '#5856D6',
    description: 'An HTTPS address that opens Walnut in any browser after you sign in.',
    keywords: ['browser link', 'tunnel', 'open from a browser', 'sign-in code', 'https'],
    render: () => <DevicesWaySection way="browser" />,
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
    description: 'Keep awake and developer options.',
    keywords: [
      'keep awake', 'lid', 'battery', 'sdk',
      { word: 'port', rowLabel: 'Port', anchor: 'sdk-port' }, // the row's real label (N17)
      'raw config', 'json', 'background jobs',
    ],
    render: ({ config, saveSection }) => <AdvancedSection config={config} onSave={saveSection} />,
  },
  // The API alternative to Claude Code for Walnut's small background jobs
  // (names, summaries, memory upkeep, quick-add on the default runner). Folded
  // under Advanced and collapsed: there is ONE engine choice (Sessions > Default engine), and
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
    description: 'What models cost: Walnut itself and every coding agent, estimated from tokens at public list prices.',
    keywords: ['cost', 'tokens', 'spend', 'price'],
    render: () => <UsageSection />,
  },
  {
    owner: 'walnut', id: 'page-use', label: 'Page Use', title: 'Page Use', group: 'diagnostics',
    icon: 'bar-chart', tint: '#5AC8FA',
    description: 'Where you go in Walnut and what you never open, counted on this Mac only.',
    keywords: ['page use', 'visits', 'analytics', 'statistics', 'never opened', 'unused'],
    render: () => <PageUseSection corePanes={CORE_SETTINGS_CONTRIBUTIONS} />,
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
  // The `timeline` pane (Screen Tracking, the screenshot Life Tracker) was removed
  // with that feature on 2026-10-31; /timeline links land on Settings.
  {
    owner: 'walnut', id: 'bug-report', label: 'Bug Report', title: 'Bug Report', group: 'diagnostics',
    icon: 'ladybug', tint: '#FF3B30',
    description: 'Collect logs and details for a bug report.',
    keywords: ['bug', 'logs', 'diagnostics', 'feedback'],
    render: () => <BugReportSection />,
  },
]
