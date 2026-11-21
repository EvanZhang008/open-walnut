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
    id: 'quiet_rail',
    name: 'Fewer icons on the sidebar',
    description: 'Tasks, Routines, Passwords and Calendar leave the sidebar and open from the Apps page instead. Each keeps its address and its links; turn its switch on in Apps to put it back on the sidebar.',
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
    id: 'camera_capture',
    name: 'Camera in chat',
    description: 'A Camera item in the chat box\'s + menu: take a photo or record a video up to a minute (and take photos while it records), look at it, then retake it or send it. A video goes to the AI as a few stills and what was said in it, with the video file beside them. The camera is on only while its panel is open.',
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
    id: 'service_launcher',
    name: 'A launcher keeps each host\'s daemon running',
    description: 'Each remote host runs its session daemon under a small launcher script (systemd, launchd or cron starts it): it restarts the daemon when it exits or stops answering, tries each new version first and puts the previous one back when the new one does not start or keeps failing in its first 15 minutes. Settings shows each host\'s current version, the one it would go back to, and the last put-back. Off: hosts keep their plain service, and one that has the launcher gets the plain service back at its next update.',
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
    id: 'reply_thread_line',
    name: 'Show which thread a message is about',
    description: 'In the chat of Main, a VP, a lead or a task with Threads, a small gray line under each message you send names the thread Walnut filed it under, and the same line under the answer names that thread and the task it is about. Click the line to open that thread. A message that arrived no longer says Delivered.',
    default: false,
  },
  {
    id: 'project_first_start',
    name: 'Start new tasks from a project',
    description: 'A new task asks one question, "Work in": a project or a folder. A project that knows where its code comes from (a git checkout, or a workspace plugin with its list of packages) and its host gives every new task a fresh isolated workspace from there, and removes it once the task is done and its work is merged. A folder is tagged with the project whose code it holds, which offers a fresh workspace instead. Projects without a code source, and the Inbox, work in a folder.',
    default: false,
  },
  {
    id: 'notes_unified',
    name: 'Notes and artifacts in one tree',
    description: 'Your notes and what Walnut\'s agents keep live in one folder, by project: each project gets its notes, skills, task memory and drawings in artifacts/projects/<project>/, and what belongs to no project sits at the top (notes, skills, memory, drawings). Turning it on moves your notes there at the next restart (a byte-for-byte checked copy first, the old folders kept whole as a backup); turning it off moves everything back. Old note paths keep opening.',
    default: false,
  },
  {
    id: 'letters_as_threads',
    name: 'Decision letters wait on the thread',
    description: 'A decision letter from a task that keeps Threads also waits on you as a thread of that task, with the letter\'s buttons on its card. Answer it on the card or in the inbox: either one answers both. The Action needed strip and the counts show it once, as the thread. Letters already waiting get their thread when you turn this on.',
    default: false,
  },
  {
    id: 'quick_bar',
    name: 'Quick bar (Control-Option-Command-Space)',
    description: 'Press Control-Option-Command-Space to open a small bar: it listens at once, shows your words as you speak, and sends them to the CEO, a VP or any task you pick (Tab, or start with "to Walnut VP, ..."). Two seconds after you stop it sends; Esc cancels and any key lets you edit. A small note in the corner shows when the message arrived and the first line of the reply. In the Mac app the key works from any app once your Mac app has this version; in a browser, while Walnut is open.',
    default: false,
  },
  {
    id: 'threads_one_card',
    name: 'One card for what waits on you',
    description: 'A thread that waits on you is one card everywhere it shows: its choices are buttons you click (the recommended one first), your typed reply goes in its box, and it has no Acknowledge, which is for a thread that asks no choice. A task\'s own question lives on its thread instead of a second card, an open thread with an answer reads To read (Done is one you closed), and words you type on a decision letter\'s thread answer that letter, a short yes picking the option it recommends.',
    default: false,
  },
  {
    id: 'ack_means_known',
    name: 'Acknowledge means you know',
    description: 'Acknowledging a card that already holds the result closes it, as before. Acknowledging a thread whose work is still open (a task it went to not done, your reply still on its way, its letter still waiting) no longer closes it: it moves to a Known group that says what it waits on. When that work ends it comes back to To read only if there is something new for you; otherwise it closes (Walnut closes it 10 minutes later if its agent has not). Neither buzzes your phone.',
    default: false,
  },
  {
    id: 'topics',
    name: 'Topics: group chats of tasks',
    description: 'A topic is a group chat you start with tasks, Main, a VP or people by email. What you write wakes every task in it (or only the ones you @mention), and each one\'s answer is posted back as its own message. Tasks wake each other only by @mention, at most three wakes between your messages, so two agents never talk in a loop.',
    default: false,
  },
  {
    id: 'brief_off',
    name: 'Threads instead of the Brief',
    description: 'The Brief is gone from Main, every VP and every lead: their Threads, grouped by state (Needs you, To read, Working, Waiting, Done), take its place, and their agents are no longer asked to write one. A choice a Board asks you waits on you as a thread of the leader that keeps that Board, its options as buttons: answer it there or on the Board, either one answers both. A Board card\'s status comes from its task\'s threads. Briefs already written are kept.',
    default: false,
  },
  {
    id: 'work_survives_restart',
    name: 'Work on a host survives a restart',
    description: 'A command an agent runs on a host (host_exec), a plugin\'s script there and an agent such as Codex keep running when Walnut\'s service on that host restarts or updates, and the next service picks each one up where it was: its whole output, its exit code, the turn it was in. Off: they run as before, and an update there waits for them or ends them.',
    default: false,
  },
  {
    id: 'restore_drill',
    name: 'Weekly restore drill',
    description: 'Once a week Walnut restores your newest backup into a temporary folder, checks every file and database in it, compares it with the list of what a backup must hold, then deletes the folder. Your data and your backups are only read. A drill that fails shows in Walnut Health.',
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
