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
    id: 'drawing_narration',
    name: 'Record a walkthrough of a drawing',
    description: 'A Record button in the Drawing app: talk while you draw, and Walnut keeps each sentence with the time you said it and the shapes you drew, selected or pointed at then, so the drawing\'s assistant knows which part you meant (for example which table you called the core table).',
    default: false,
  },
  {
    id: 'agent_window_hides_while_sharing',
    name: 'Hide the agent window while you share your screen',
    description: 'While this Mac shares or records its screen (a meeting app sharing a window, an app or the whole screen), the browser on this Mac keeps Walnut\'s agent window minimized, so an agent\'s pages never show in the share. It stays minimized after the share: open it from the Dock.',
    default: false,
  },
  {
    id: 'follower_on_every_host',
    name: 'Walnut on every host',
    description: 'Every host you connect runs its own copy of Walnut, which keeps working there while this computer is away, unless you turn it off for that host. Walnut skips a host without enough memory or disk, or one its program cannot run on, and says why in that host\'s settings.',
    default: false,
  },
  {
    id: 'change_status',
    name: 'Change status in link tags',
    description: 'A task\'s change links (pull requests, code reviews, commits) show how far each got inside its link pill: in review, approved, merged, deploying, deployed or blocked. Click the pill for the review and every deploy stage; Walnut tells the task\'s session when a change is approved, fails, is blocked or finishes deploying.',
    default: false,
  },
  {
    id: 'task_threads',
    name: 'Threads for every task',
    description: 'Every task keeps Threads, not only the leads: what you ask a task is filed one thread per subject, and its session sees them. A task\'s rows also carry its lines: what it asks of you, does and waits on at once, each with its own state. Turn Threads off for one task in its menu.',
    default: false,
  },
  {
    id: 'threads_sqlite',
    name: 'Threads in a database',
    description: 'Threads are kept in a database (org/threads.sqlite) instead of one file per task, so reading and changing one stays quick however many threads a task keeps. The first time it is on, the files are copied to a backup and moved in only when every thread reads back the same. Each task\'s threads file is still written within a minute of a change, so turning this off or going back to an older Walnut keeps every thread.',
    default: false,
  },
  {
    id: 'threads_pop_up',
    name: 'Threads pop up to the leaders',
    description: 'A thread of a task that waits on you also shows on the Threads of the tasks above it, its VP and Main: the same card, kept once by the task doing the work. Your reply on it at any level goes straight to that task, and the ones above get one line with their next message instead of a wake. Handing a thread over moves it instead of copying it.',
    default: false,
  },
  {
    id: 'action_needed_everywhere',
    name: 'Action needed in sessions',
    description: 'What a task needs from you (an approval, a question, a letter, a choice) also shows in a strip under its session\'s title bar. It is the same item as on the task\'s row: answer or snooze it in either and it goes from both.',
    default: false,
  },
  {
    id: 'top_thread',
    name: 'The first thread above the chat',
    description: 'A chat whose task keeps Threads (Main, a VP, a lead, or a task with Threads on) shows the first of its Threads above the chat, the same card as in Threads with its own reply box: "1 / 16" and the arrows step through every one, the ones that need you first. Hide it to one line that counts them; Show brings it back. Asks that are not threads yet, like a permission prompt, still show above it.',
    default: false,
  },
  {
    id: 'org_leaders',
    name: 'Directors under each VP',
    description: 'On the Org page and in the Org chart, a VP gets one line under it, "6 directors", folded. A Director is a task that leads its own team, or any task you made one. Open the line to see them by project and the Directors under each; right-click one to take it off, add one with "+ New Director", or make any task one from its menu (Team). Settings → Org picks the layout. Every fold stays as you left it.',
    default: false,
  },
  {
    id: 'notes_artifacts',
    name: 'Walnut artifacts in Notes',
    description: 'A "Walnut artifacts" section under the notes tree lists what Walnut\'s agents keep as standing knowledge: the org\'s skills, the shared notes, and each VP\'s and lead\'s MEMORY.md, team guidance, skills, notes and reflections. Click one to read it.',
    default: false,
  },
  {
    id: 'letters_as_threads',
    name: 'Decision letters wait on the thread',
    description: 'A decision letter from a task that keeps Threads also waits on you as a thread of that task, with the letter\'s buttons on its card. Answer it on the card or in the inbox: either one answers both. The Action needed strip and the counts show it once, as the thread. Letters already waiting get their thread when you turn this on.',
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
