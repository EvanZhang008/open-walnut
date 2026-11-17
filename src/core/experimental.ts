/** Browser-safe registry. An experiment changes no default until it graduates. */
export const EXPERIMENTAL_FEATURES = [
  {
    id: 'leader_status_follows_workers',
    name: 'Leader status follows workers',
    description: 'Show Working while any worker works, Waiting while all open workers wait, and To read when every worker has finished. Requests that need you keep priority.',
    default: false,
  },
  {
    id: 'chat_reading_split',
    name: 'Reading split in session chats',
    description: 'Read a message on top while you ask below: "Send in split" in the Send menu, and "Read in split" on a message (its hover strip and its right-click menu). The pane on top keeps its place while the chat below goes on.',
    default: false,
  },
  {
    id: 'router_tidies_noise_mail',
    name: 'Mail router tidies noise',
    description: 'When a mail router judges an email to be noise, Walnut marks it read and moves it from the inbox to the archive. Nothing is deleted or sent, and its recorded reason says what was done.',
    default: false,
  },
  {
    id: 'isolated_workspace_by_default',
    name: 'Code tasks start in an isolated workspace',
    description: 'A new task whose folder is in a git repository, or one a workspace plugin claims, starts in its own workspace (a git worktree, or the plugin\'s), so tasks never edit the same checkout. A project\'s settings can turn it on or off for that project; a start can opt out with workspace: false.',
    default: false,
  },
  {
    id: 'apps_stay_open',
    name: 'Open apps stay on the sidebar',
    description: 'An app you open keeps a row on the sidebar until you close it, wherever you go next. A plugin app is pinned on the sidebar only when you pin it, never by itself when it is installed. The Apps page shows the apps you used recently and the ones you pinned there, to open again in one click.',
    default: false,
  },
  {
    id: 'router_chat_sources',
    name: 'Router reads chat messages',
    description: 'New direct messages, mentions and watched-channel messages from a connected chat (Slack) go to your router, the one that reads your mail, which hands each one with its link to the task or VP that owns it. Each chat account can be filtered in Router settings. Off: the chat plugin keeps its own letters.',
    default: false,
  },
  {
    id: 'plugin_ai_configure',
    name: 'Configure plugins with AI',
    description: 'A "Configure with AI" button on each plugin\'s page in Apps opens a chat beside it: say what to change and Walnut changes the plugin\'s settings, which the page shows at once. Any chat can configure a plugin the same way, with this switch on or off.',
    default: false,
  },
  {
    id: 'payments_always_ask',
    name: 'A step that pays always asks',
    description: 'With approvals off, an agent\'s browser step that buys or pays (a Pay, Buy or Place order button, a form with card details) still waits for your yes. Everything else goes ahead and is listed under Approvals.',
    default: false,
  },
  {
  id: 'drawing_app',
  name: 'Drawing app',
  description: 'An editable hand-drawn whiteboard saved in Notes, as an app and beside a session.',
  default: false,
},
  {
    id: 'agent_window_hides_while_sharing',
    name: 'Hide the agent window while you share your screen',
    description: 'While this Mac shares or records its screen (a meeting app sharing a window, an app or the whole screen), the browser on this Mac keeps Walnut\'s agent window minimized, so an agent\'s pages never show in the share. It stays minimized after the share: open it from the Dock.',
    default: false,
  },
  {
    id: 'change_status',
    name: 'Change status in link tags',
    description: 'A task\'s change links (pull requests, code reviews, commits) show how far each got inside its link pill: in review, approved, merged, deploying, deployed or blocked. Click the pill for the review and every deploy stage; Walnut tells the task\'s session when a change is approved, fails, is blocked or finishes deploying.',
    default: false,
  },
] as const;

export type ExperimentalFeatureId = typeof EXPERIMENTAL_FEATURES[number]['id'];
/** Unknown boolean flags stay on disk for newer versions, but have no effect here. */
export type ExperimentalFlags = Record<string, boolean>;

export function experimentalEnabled(flags: ExperimentalFlags | undefined, id: ExperimentalFeatureId): boolean {
  const feature = EXPERIMENTAL_FEATURES.find((f) => f.id === id)!;
  return typeof flags?.[id] === 'boolean' ? flags[id] : feature.default;
}

export function validExperimentalFlags(value: unknown): value is ExperimentalFlags {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((flag) => typeof flag === 'boolean');
}
