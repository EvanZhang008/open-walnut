/**
 * Browser-safe registry. An experiment changes no default until it graduates. One that graduates
 * by its default (`default: true`) keeps its switch, so a person can still turn it off; a stored
 * choice (true or false) always wins, and an older release reads the unset switch as off.
 */
export const EXPERIMENTAL_FEATURES = [
  {
    id: 'leader_status_follows_workers',
    name: 'Leader status follows workers',
    description: 'Show Working while any worker works, Waiting while all open workers wait, and To read when every worker has finished. Requests that need you keep priority.',
    summary: 'A leader\'s status shows what its workers do: Working, Waiting or To read. Requests that need you come first.',
    default: false,
  },
  {
    id: 'chat_reading_split',
    name: 'Reading split in session chats',
    description: 'Read a message on top while you ask below: "Send in split" in the Send menu, and "Read in split" on a message (its hover strip and its right-click menu). The pane on top keeps its place while the chat below goes on.',
    summary: 'Read a message in a pane on top of the chat while you keep asking below.',
    default: false,
  },
  {
    id: 'chat_glass_edges',
    name: 'Glass edges in session chats',
    description: 'A session chat scrolls on behind its header, Tree Mode\'s path bar, the threads line above the chat and the box you type in, which turn to frosted glass the text shows softly through, with no hard line where the text meets them. At rest the newest line still ends above the box, and the scroll bar still stops where the box and the header begin. Off: the chat ends at a straight edge above the box, as before.',
    default: false,
  },
  {
    id: 'router_tidies_noise_mail',
    name: 'Mail router tidies noise',
    description: 'When a mail router judges an email to be noise, Walnut marks it read and moves it from the inbox to the archive. Nothing is deleted or sent, and its recorded reason says what was done.',
    summary: 'Mail the router judges to be noise is marked read and archived. Nothing is deleted or sent.',
    default: false,
  },
  {
    id: 'isolated_workspace_by_default',
    name: 'Code tasks start in an isolated workspace',
    description: 'Each new code task gets its own copy of the code, so two tasks never edit the same files. It applies when the task\'s folder is in a git repository (the copy is a git worktree) or a workspace plugin manages it. A project\'s own settings can turn it on or off for that project.',
    summary: 'A new code task in a git repository gets its own copy of the code, unless its project turns this off.',
    default: false,
  },
  {
    id: 'apps_stay_open',
    name: 'Open apps stay on the sidebar',
    description: 'An app you open keeps a row on the sidebar until you close it, wherever you go next. A plugin app is pinned on the sidebar only when you pin it, never by itself when it is installed. The Apps page shows the apps you used recently and the ones you pinned there, to open again in one click.',
    summary: 'An app you open keeps a row on the sidebar until you close it.',
    default: false,
  },
  {
    id: 'quiet_rail',
    name: 'Fewer icons on the sidebar',
    description: 'Tasks, Routines, Passwords and Calendar leave the sidebar and open from the Apps page instead. Each keeps its address and its links; turn its switch on in Apps to put it back on the sidebar.',
    summary: 'Tasks, Routines, Passwords and Calendar leave the sidebar and open from the Apps page instead.',
    default: false,
  },
  {
    id: 'router_chat_sources',
    name: 'Router reads chat messages',
    description: 'On: new chat messages (Slack) go to the router that reads your mail, which passes each one, with its link, to the task or VP that owns it. Direct messages, mentions and watched channels count; Router settings can filter each chat account. Off: the chat plugin writes its own letters, as before.',
    summary: 'New Slack messages go to the router that reads your mail, which passes each to the task or VP that owns it.',
    default: false,
  },
  {
    id: 'plugin_ai_configure',
    name: 'Configure plugins with AI',
    description: 'A "Configure with AI" button on each plugin\'s page in Apps opens a chat beside it: say what to change and Walnut changes the plugin\'s settings, which the page shows at once. Any chat can configure a plugin the same way, with this switch on or off.',
    summary: 'Adds Configure with AI to each plugin\'s page: say what to change and Walnut changes its settings.',
    default: false,
  },
  {
    id: 'payments_always_ask',
    name: 'A step that pays always asks',
    description: 'With approvals off, an agent\'s browser step that buys or pays (a Pay, Buy or Place order button, a form with card details) still waits for your yes. Everything else goes ahead and is listed under Approvals.',
    summary: 'With approvals off, an agent\'s browser step that buys or pays still waits for your yes.',
    default: false,
  },
  {
  id: 'drawing_app',
  name: 'Drawing app',
  description: 'An editable hand-drawn whiteboard saved in Notes, as an app and beside a session.',
  default: false,
},
  {
    id: 'voice_conversation',
    name: 'Voice conversation',
    description: 'A Talk button in a session\'s chat box: speak, and a pause sends what you said; the answer comes back as a short spoken reply read aloud (the full answer stays on screen), and talking again stops it. Uses ElevenLabs when a key is set in Settings, else this device\'s own voice.',
    summary: 'Adds a Talk button to the chat box: speak, pause to send, and hear a short spoken answer.',
    default: false,
  },
  {
    id: 'drawing_narration',
    name: 'Record a walkthrough of a drawing',
    description: 'A Record button in the Drawing app: talk while you draw, and Walnut keeps each sentence with the time you said it and the shapes you drew, selected or pointed at then, so the drawing\'s assistant knows which part you meant (for example which table you called the core table).',
    summary: 'Adds a Record button to the Drawing app: talk while you draw, and its assistant knows which part you meant.',
    default: false,
  },
  {
    id: 'agent_window_hides_while_sharing',
    name: 'Hide the agent window while you share your screen',
    description: 'While this Mac shares or records its screen (a meeting app sharing a window, an app or the whole screen), the browser on this Mac keeps Walnut\'s agent window minimized, so an agent\'s pages never show in the share. It stays minimized after the share: open it from the Dock.',
    summary: 'While this Mac shares or records its screen, the agent window stays minimized, so agents\' pages never show.',
    default: false,
  },
  {
    id: 'service_launcher',
    name: 'A launcher keeps each host\'s daemon running',
    description: 'Each remote host runs its session daemon under a small launcher script (systemd, launchd or cron starts it): it restarts the daemon when it exits or stops answering, tries each new version first and puts the previous one back when the new one does not start or keeps failing in its first 15 minutes. Settings shows each host\'s current version, the one it would go back to, and the last put-back. Off: hosts keep their plain service, and one that has the launcher gets the plain service back at its next update.',
    summary: 'A small launcher restarts each remote host\'s daemon when it stops, and puts the old version back if a new one fails.',
    default: false,
  },
  {
    id: 'follower_on_every_host',
    name: 'Walnut on every host',
    description: 'Every host you connect runs its own copy of Walnut, which keeps working there while this computer is away, unless you turn it off for that host. Walnut skips a host without enough memory or disk, or one its program cannot run on, and says why in that host\'s settings.',
    default: true,
    summary: 'Every host you connect runs its own copy of Walnut, so work there goes on while this computer is away.',
  },
  {
    id: 'host_call_entry',
    name: 'A host\'s calls go through its own Walnut, also while this computer answers',
    description: 'On a host that runs its own copy of Walnut, a session or plugin job started there from now on sends its Walnut calls straight to that copy, whether or not this computer is there, instead of through the host\'s daemon socket; and a message between two sessions on that host is delivered by that copy while this computer answers too, in place of the daemon. Sessions already running keep the socket, and a call falls back to it (and a message to this computer) whenever the host\'s copy cannot take it. The answers are the same either way.',
    summary: 'Sessions on a host that runs its own Walnut send their calls to that copy, also while this computer answers.',
    default: false,
  },
  {
    id: 'change_status',
    name: 'Change status in link tags',
    description: 'A task\'s change links (pull requests, code reviews, commits) show how far each got inside its link pill: in review, approved, merged, deploying, deployed or blocked. Click the pill for the review and every deploy stage; Walnut tells the task\'s session when a change is approved, fails, is blocked or finishes deploying.',
    summary: 'Link pills for pull requests, reviews and commits show how far each got: in review, approved, merged or deployed.',
    default: false,
  },
  {
    id: 'task_threads',
    name: 'Threads for every task',
    description: 'Every task keeps Threads, not only the leads: what you ask a task is filed one thread per subject, and its session sees them. A task\'s rows also carry its lines: what it asks of you, does and waits on at once, each with its own state. Turn Threads off for one task in its menu.',
    summary: 'Every task keeps Threads, not only leads: what you ask a task is filed one thread per subject.',
    default: false,
  },
  {
    id: 'threads_sqlite',
    name: 'Threads in a database',
    description: 'Threads are kept in a database (org/threads.sqlite) instead of one file per task, so reading and changing one stays quick however many threads a task keeps. The first time it is on, the files are copied to a backup and moved in only when every thread reads back the same. Each task\'s threads file is still written within a minute of a change, so turning this off or going back to an older Walnut keeps every thread.',
    summary: 'Threads are kept in one database, so they stay quick however many a task has. Turning it off loses nothing.',
    default: false,
  },
  {
    id: 'threads_pop_up',
    name: 'Threads pop up to the leaders',
    description: 'A thread of a task that waits on you also shows on the Threads of the tasks above it, its VP and Main: the same card, kept once by the task doing the work. Your reply on it at any level goes straight to that task, and the ones above get one line with their next message instead of a wake. Handing a thread over moves it instead of copying it.',
    summary: 'A thread that waits on you also shows on the leaders above its task, and your reply there goes to that task.',
    default: false,
  },
  {
    id: 'action_needed_everywhere',
    name: 'Action needed in sessions',
    description: 'What a task needs from you (an approval, a question, a letter, a choice) also shows in a strip under its session\'s title bar. It is the same item as on the task\'s row: answer or snooze it in either and it goes from both.',
    summary: 'What a task needs from you also shows in a strip under its session\'s title bar.',
    default: false,
  },
  {
    id: 'top_thread',
    name: 'The first thread above the chat',
    description: 'A chat whose task keeps Threads (Main, a VP, a lead, or a task with Threads on) shows the first of its Threads above the chat, the same card as in Threads with its own reply box: "1 / 16" and the arrows step through every one, the ones that need you first. Hide it to one line that counts them; Show brings it back. Asks that are not threads yet, like a permission prompt, still show above it.',
    summary: 'A chat that keeps Threads shows the first one above the chat, with its own reply box and arrows to step through.',
    default: false,
  },
  {
    id: 'org_leaders',
    name: 'Directors under each VP',
    description: 'On the Org page and in the Org chart, a VP gets one line under it, "6 directors", folded. A Director is a task that leads its own team, or any task you made one. Open the line to see them by project and the Directors under each; right-click one to take it off, add one with "+ New Director", or make any task one from its menu (Team). Settings → Org picks the layout. Every fold stays as you left it.',
    summary: 'On the Org page, each VP gets a folded line with the Directors under it, by project.',
    default: false,
  },
  {
    id: 'reply_thread_line',
    name: 'Show which thread a message is about',
    description: 'In the chat of Main, a VP, a lead or a task with Threads, a small gray line under each message you send names the thread Walnut filed it under, and the same line under the answer names that thread and the task it is about. Click the line to open that thread. A message that arrived no longer says Delivered.',
    summary: 'A small gray line under each message names the thread it was filed under. Click it to open that thread.',
    default: false,
  },
  {
    id: 'project_first_start',
    name: 'Start new tasks from a project',
    description: 'A new task asks one question, "Work in": a project or a folder. A project that knows where its code comes from (a git checkout, or a workspace plugin with its list of packages) and its host gives every new task a fresh isolated workspace from there, and removes it once the task is done and its work is merged. A folder is tagged with the project whose code it holds, which offers a fresh workspace instead. Projects without a code source, and the Inbox, work in a folder.',
    summary: 'A new task asks where to work: a project or a folder. A project with a code source gives it a fresh workspace.',
    default: false,
  },
  {
    id: 'notes_unified',
    name: 'Notes and artifacts in one tree',
    description: 'Your notes and what Walnut\'s agents keep live in one folder, by project: each project gets its notes, skills, task memory and drawings in artifacts/projects/<project>/, and what belongs to no project sits at the top (notes, skills, memory, drawings). Turning it on moves your notes there at the next restart (a byte-for-byte checked copy first, the old folders kept whole as a backup); turning it off moves everything back. Old note paths keep opening.',
    summary: 'Your notes and what agents keep live in one folder, by project. Switching moves your notes at the next restart.',
    default: false,
  },
  {
    id: 'letters_as_threads',
    name: 'Decision letters wait on the thread',
    description: 'A decision letter from a task that keeps Threads also waits on you as a thread of that task, with the letter\'s buttons on its card. Answer it on the card or in the inbox: either one answers both. The Action needed strip and the counts show it once, as the thread. Letters already waiting get their thread when you turn this on.',
    summary: 'A decision letter also waits on you as a thread of its task. Answer it in either place and both are answered.',
    default: false,
  },
  {
    id: 'quick_bar',
    name: 'Quick bar (Control-Option-Command-Space)',
    description: 'Press Control-Option-Command-Space to open a small bar: it listens at once, shows your words as you speak, and sends them to the CEO, a VP or any task you pick (Tab, or start with "to Walnut VP, ..."). Two seconds after you stop it sends; Esc cancels and any key lets you edit. A small note in the corner shows when the message arrived and the first line of the reply. In the Mac app the key works from any app once your Mac app has this version; in a browser, while Walnut is open.',
    summary: 'Control-Option-Command-Space opens a small bar: speak, and your words go to the CEO, a VP or any task you pick.',
    default: false,
  },
  {
    id: 'threads_one_card',
    name: 'One card for what waits on you',
    description: 'A thread that waits on you is one card everywhere it shows: its choices are buttons you click (the recommended one first), your typed reply goes in its box, and it has no Acknowledge, which is for a thread that asks no choice. A task\'s own question lives on its thread instead of a second card, an open thread with an answer reads To read (Done is one you closed), and words you type on a decision letter\'s thread answer that letter, a short yes picking the option it recommends.',
    summary: 'A thread that waits on you is one card everywhere, with its choices as buttons and a box for your reply.',
    default: false,
  },
  {
    id: 'threads_kept_by_walnut',
    name: 'Walnut keeps your Threads',
    description: 'Main, every VP and lead, and every task with Threads answer you in the chat first and stop writing a thread on each of your messages. At the end of each turn Walnut already asks the agent where its work stands; with this on, the same question asks where each open thread stands, and Walnut writes the answer as the thread\'s state, summary and title, and marks an answer known only when the agent says you reacted to it. The agent writes a thread itself only for a decision you must make, a close you asked for, or a merge, split or move.',
    summary: 'Agents answer you in the chat; Walnut writes each thread\'s state and summary from the agent\'s end-of-turn answer.',
    default: false,
  },
  {
    id: 'ack_means_known',
    name: 'Acknowledge means you know',
    description: 'Acknowledging a card that already holds the result closes it, as before. Acknowledging a thread whose work is still open (a task it went to not done, your reply still on its way, its letter still waiting) no longer closes it: it moves to a Known group that says what it waits on. When that work ends it comes back to To read only if there is something new for you; otherwise it closes (Walnut closes it 10 minutes later if its agent has not). Neither buzzes your phone.',
    summary: 'Acknowledging a thread whose work is still open moves it to Known instead of closing it, until that work ends.',
    default: false,
  },
  {
    id: 'topics',
    name: 'Topics: group chats of tasks',
    description: 'A topic is a group chat you start with tasks, Main, a VP or people by email. What you write wakes every task in it (or only the ones you @mention), and each one\'s answer is posted back as its own message. Tasks wake each other only by @mention, at most three wakes between your messages, so two agents never talk in a loop.',
    summary: 'Start a group chat with tasks, Main, a VP or people by email. What you write wakes every task in it.',
    default: false,
  },
  {
    id: 'brief_off',
    name: 'Threads instead of the Brief',
    description: 'The Brief is gone from Main, every VP and every lead: their Threads, grouped by state (Needs you, To read, Working, Waiting, Done), take its place, and their agents are no longer asked to write one. A choice a Board asks you waits on you as a thread of the leader that keeps that Board, its options as buttons: answer it there or on the Board, either one answers both. A Board card\'s status comes from its task\'s threads. Briefs already written are kept.',
    summary: 'Main, VPs and leads show their Threads in place of the Brief. Briefs already written are kept.',
    default: false,
  },
  {
    id: 'work_survives_restart',
    name: 'Work on a host survives a restart',
    description: 'A command an agent runs on a host (host_exec), a plugin\'s script there and an agent such as Codex keep running when Walnut\'s service on that host restarts or updates, and the next service picks each one up where it was: its whole output, its exit code, the turn it was in. Off: they run as before, and an update there waits for them or ends them.',
    summary: 'Commands, plugin scripts and agents on a host keep running when Walnut\'s service there restarts or updates.',
    default: false,
  },
  {
    id: 'in_process_daemon',
    name: 'Sessions run inside Walnut\'s own process',
    description: 'This computer\'s sessions, host commands and triggers are run by Walnut\'s own process instead of a separate background program: Walnut calls them directly, with nothing between. Running sessions are picked up when you turn this on or off (it applies at the next start of Walnut). With "A launcher keeps each host\'s daemon running" on too, each of your hosts is offered the same: its session daemon and its Walnut server become one Walnut service there, switched at its next daemon update (and back when you turn this off). Off: a separate background program runs them, as before.',
    summary: 'Walnut runs this computer\'s sessions and triggers itself, not in a separate program. Applies when Walnut next starts.',
    default: false,
  },
  {
    id: 'host_runs_sessions',
    name: 'Each computer runs its own sessions',
    description: 'A new session on another computer is run and watched by Walnut\'s service on that computer, which sends this Walnut what happened in it, so the session keeps going and keeps being watched while this Walnut is away. Only computers whose Walnut is new enough take it; others run their sessions as before. Sessions started before you turn this off keep reporting. "Every experiment on" does not turn this on: it changes which machine runs your sessions, so it keeps its own switch.',
    summary: 'A new session on another computer is run by that computer\'s Walnut, so it keeps going while this one is away.',
    default: false,
    ownSwitchOnly: true,
  },
  {
    id: 'restore_drill',
    name: 'Weekly restore drill',
    description: 'Once a week Walnut restores your newest backup into a temporary folder, checks every file and database in it, compares it with the list of what a backup must hold, then deletes the folder. Your data and your backups are only read. A drill that fails shows in Walnut Health. "Every experiment on" does not turn this on: it copies or downloads all of your data, so it keeps its own switch.',
    summary: 'Once a week Walnut restores your newest backup into a temporary folder and checks it. Your data is only read.',
    default: false,
    ownSwitchOnly: true,
  },
  {
    id: 'focus_workspace',
    name: 'Focus spaces',
    description: 'Make a focus space from a few projects or one task, and while you are in it Walnut shows only what is inside: Home, the Tasks page and the board list only its tasks, chat columns of other tasks are covered, the quick bar lists only its tasks, and everything else waits behind one number with its notices and pushes held. Search and the Org page still show everything. A Rhythm focus block on a task enters a focus on that task. Your tasks never move: a space is a list read beside the board, and Main still sees everything.',
    summary: 'Make a focus space from a few projects or one task: Walnut shows only what is inside and holds the rest.',
    default: false,
  },
  {
    id: 'switchable_leader',
    name: 'Standby copy of this Walnut',
    description: 'Every 30 seconds this Walnut copies its whole data folder, as it was at one moment, to the folder set as standby.dir in config.yaml (on this machine), keeps only complete copies there, and repairs and reports any file changed there directly. Off: nothing is copied and nothing runs. "Every experiment on" does not turn this on: it copies or downloads all of your data, so it keeps its own switch.',
    summary: 'Every 30 seconds Walnut copies its whole data folder to a standby folder on this machine, set in its config file.',
    default: false,
    ownSwitchOnly: true,
  },
  {
    id: 'reply_language_gate',
    name: 'Hold sends that are not in your reply language',
    description: 'When your Reply language setting names a language, words an agent sends you (a message to another task, a thread, a letter, the Board, the Brief, a task report, a question it asks you) that are not in that language are not sent: the agent is told to write them again in it. Code, commands, paths and quoted words do not count. Its chat replies are never held or corrected. Off: every send goes out as written.',
    default: false,
  },
  {
    id: 'real_use_watch',
    name: 'Real-use watch',
    description: 'When a real-use alarm rings (a tool answer the agent got cut, tool errors, slow reads, server errors, page failures), Walnut tells the task that shipped the change and watches it, or the project lead when none does, at most one note every 4 hours. A task that shipped a change cannot complete before it names what real use should show (usage_watch). Off: Walnut still records real use and shows it in Settings, and tells nobody.',
    summary: 'When a real-use alarm rings, Walnut tells the task that shipped the change, at most once every 4 hours.',
    default: false,
  },
  {
    id: 'mcp_tools_by_role',
    name: 'Fewer Walnut tools listed per role',
    description: 'A Claude Code session lists only the Walnut tools its role uses: a task lists its work tools (tasks, notes, memory, hosts, watches, subagents, the browser and Boards) and the tools of the plugin it comes from, and Main, the VPs and Ask Walnut also list Threads, the Brief, the inbox, the org and the tools of every plugin. Every other tool still runs through the walnut CLI, and the walnut tools list command shows them all by group. It applies when a session next starts its Walnut tools. Off: every session lists every tool, as before.',
    summary: 'A Claude Code session lists only the Walnut tools its role uses. The others still run from the walnut command.',
    default: false,
  },
  {
    id: 'replica_takeover',
    name: 'Letter replies reach a session while the Mac is away',
    description: 'When your Mac has not answered for 5 minutes (asleep, offline or shut down) and the cloud companion has taken over for it (Settings, Phones & Cloud, Cloud companion: "Cloud companion takes over"), your replies to letters and the options you pick on them go straight to the session that sent the letter, if that session runs on another host such as a dev box. Without it they wait on the companion and reach the session when the Mac is back. Either way, the Mac records them on their letters when it returns and sends nothing twice. Replies with pictures, and sessions that run on the Mac itself, always wait for the Mac.',
    summary: 'While the cloud companion stands in for your Mac, your replies to letters reach sessions on other hosts at once.',
    default: false,
  },
  {
    id: 'mail_calendars',
    name: 'Calendars of mail accounts',
    description: 'A mail account set up in Walnut can bring its calendar too: Apps > Calendar offers "Add its calendar" on each mail account, which finds the account\'s calendars on its mail provider (CalDAV: iCloud, Fastmail, Yahoo and most mail hosts) with the password already saved for its mail. Its events then show in the Calendar page and the Agenda beside the Mac\'s. Gmail and Outlook calendars need their own sign-in and say so. Off: Walnut reads only the Mac\'s calendars, as before.',
    summary: 'A mail account in Walnut can add its calendar from Apps > Calendar, so its events show beside the Mac\'s.',
    default: false,
  },
  {
    id: 'stt_compare',
    name: 'Voice Accuracy',
    description: 'Settings › Diagnostics › Voice Accuracy hears your recent voice takes again with other speech-to-text engines and shows how often each one gets your words wrong, against a reference an AI judge writes from all their texts. Engines that run on this computer start right away; an engine or the judge that sends audio or text to a cloud service runs only after you tick its consent. Off: nothing is run or uploaded and nothing new is kept; to remove what it kept, use Delete comparison data in its pane before turning it off.',
    summary: 'Replays your recent voice takes through other speech engines and shows how often each gets your words wrong.',
    default: false,
  },
  {
    id: 'local_chinese_voice',
    name: 'Local Chinese voice',
    summary: 'Voice mode reads Chinese answers in a local Mandarin voice on this Mac (Apple Silicon, about 2.5 GB once).',
    description: 'Voice mode reads Chinese answers with Qwen3-TTS on this Mac, a male standard Mandarin voice by default (tts.qwen_voice in the config names another speaker). Needs a Mac with Apple Silicon: the first time it is on, Walnut sets up the voice model in the background (about 2.5 GB to download), and until it is ready Chinese is read the way it is today. English keeps its voice. Off: every answer is read as before.',
    default: false,
  },
] as const;

/**
 * Experiments that ended on (their behavior is now everyone's): a client built while one was a
 * switch (an older phone app) still asks for it by id, so clients are told it is on.
 * camera_capture: the chat box's Camera, 2026-11-21.
 */
export const GRADUATED_EXPERIMENTS: readonly string[] = ['camera_capture'];

export type ExperimentalFeatureId = typeof EXPERIMENTAL_FEATURES[number]['id'];
/** Unknown boolean flags stay on disk for newer versions, but have no effect here. */
export type ExperimentalFlags = Record<string, boolean>;

/**
 * A key in the same flag map that names no experiment: on, every experiment whose own switch was
 * never set reads as on, each new one included as soon as it ships (for people who build or test
 * Walnut), except the few that keep their own switch (keepsOwnSwitch). An experiment's own choice still wins, so one that misbehaves can be turned off alone.
 * An older Walnut keeps it as an unknown flag and ignores it.
 */
export const EVERY_EXPERIMENT = 'every_experiment';

export function everyExperimentOn(flags: ExperimentalFlags | undefined): boolean {
  return flags?.[EVERY_EXPERIMENT] === true;
}

/**
 * An experiment "Every experiment on" never turns on (`ownSwitchOnly` in the registry): one that
 * copies or downloads all of the user's data, or changes which machine leads. A person who
 * turned every experiment on to try new screens did not ask for that; its own switch does.
 */
export function keepsOwnSwitch(id: ExperimentalFeatureId): boolean {
  const feature = EXPERIMENTAL_FEATURES.find((f) => f.id === id)!;
  return 'ownSwitchOnly' in feature && feature.ownSwitchOnly === true;
}

/**
 * The one line Settings shows under an experiment's name: its `summary` when it has one, else its
 * description. A description longer than a help line (tests/web/ui-words-scan.ts HELP_MAX) needs a
 * summary; the description stays whole as the row's hover.
 */
export function experimentSummary(feature: { description: string; summary?: string }): string {
  return feature.summary ?? feature.description;
}

export function experimentalEnabled(flags: ExperimentalFlags | undefined, id: ExperimentalFeatureId): boolean {
  const feature = EXPERIMENTAL_FEATURES.find((f) => f.id === id)!;
  if (typeof flags?.[id] === 'boolean') return flags[id];
  return (everyExperimentOn(flags) && !keepsOwnSwitch(id)) || feature.default;
}

/**
 * What a client that only reads `flags[id] === true` (the phone) should see: every stored boolean
 * as it is, each registered experiment as `experimentalEnabled` reads it, and each graduated one on.
 */
export function effectiveExperimentalFlags(flags: ExperimentalFlags | undefined): ExperimentalFlags {
  const out: ExperimentalFlags = {};
  for (const [id, on] of Object.entries(flags ?? {})) if (typeof on === 'boolean') out[id] = on;
  for (const feature of EXPERIMENTAL_FEATURES) out[feature.id] = experimentalEnabled(flags, feature.id);
  // A switch that ended on is on for every client, whatever an old choice on disk says.
  for (const id of GRADUATED_EXPERIMENTS) out[id] = true;
  return out;
}

export function validExperimentalFlags(value: unknown): value is ExperimentalFlags {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((flag) => typeof flag === 'boolean');
}
