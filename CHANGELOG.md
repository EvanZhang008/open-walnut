# Changelog

All notable changes to Open Walnut are documented here. This project follows
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may include
breaking changes).

## [Unreleased]

## [0.6.8] - 2026-10-11

### Added

- The cloud companion searches a copy of the Mac's index by meaning
- The phone's search runs the Mac's hybrid search and shows Completed like the web
- Open Walnut from a browser anywhere through a tunnel it runs

### Fixed

- A changed doc keeps the vectors of its unchanged passages, and a worker failure never quarantines a doc
- An answer whose caller asked for no semantic wait is never memoized

## [0.6.7] - 2026-10-09

### Added

- While the Mac is away, a host and the companion search what they hold
- While the Mac is away, the phone's model picker answers from the companion and a switch reaches the session's host
- While the Mac answers, a phone's call to the companion is answered by the Mac
- A message between two sessions on one host is delivered by that host, also while the server answers

### Fixed

- The 5-minute projection sweep keeps the host model catalogs on the companion's copy
- The Mac app job runs its checks from its own commit, not the tag
- The Mac app smoke waits for the server and every holder of its dir

## [0.6.6] - 2026-10-08

### Added

- The companion keeps an exact copy of the Mac's task store
- The task details popup reads as a header, a main column and a rail of facts
- A host stops waiting on a server that has stopped answering
- A scanning line while a question is answered; one turn per question; done folds away in green
- Pin a session fact to the header from its menu row, off by default
- Every host reads its own copy of the notes, memory and skills
- The cloud companion leads while the Mac is away, and the Mac takes the lead back
- A team kanban, the Cards view beside Projects and Page
- A task and each of its sessions show their time, with a per-day page
- Load earlier on the session page
- An hourly run hands mail to the task that owns it and may mark promotional mail read
- Folder and project menus get the task menu's Pinned, Project and Sprint rows
- Folder and project menus get setting rows like the task menu
- A crowded task row folds its pills to one letter, and the TRIGGER pill drops its count and PAUSED
- Each row in the Leader pill's list ends in an unlink icon that releases that worker
- The task menu's team actions fold into one Team row, and a leader can release a worker
- The iPhone records the places you visit once you turn Places on, and keeps them on your Mac
- The Mac app installs the self-contained Walnut, and releases sign and notarize it
- The model pill opens a Select model sheet, and the chat's mode pill keeps its seat
- Completing a task from its column header rolls the column up and closes it, with an Undo
- The Overview is a project board: a status strip, and a card per project with its tasks, the leader's text, choices and questions
- Deploy the committed HEAD from a clean clone, and done means live on prod
- A trigger parks its task by default, and every park a session makes sends the user a receipt
- A one-line installer and a Homebrew formula, no Node needed
- The Overview reads by the board's projects when the leader defined any
- Sort and Group work in every view, and each filter page names its default
- One model pill with its effort, a mode pill on every composer, Side question/Note/Fork in the + menu
- Messages between sessions fold to who and a one-line title
- The composer is a floating card; New Session's model and mode sit on its bottom row
- Transcript pages reach back to the first message
- The Mac keeps the places the iPhone records once the user turns Places on, and agents can read them

### Fixed

- The Mac app smoke waits for its daemon before removing its dir
- A wss bridge is tested end to end, and the bridge socket always has an error listener
- The phone's model pill shows the companion's own chat while the Mac is away
- A replica step whose reused socket was reset goes out once more
- A family keeps the folder made for it
- A server restart keeps the host's SSH connection, so it needs no new login
- A scripted fan-out's workers are not outside sessions
- A command waiting on a socket that closed fails at once
- A deploy no longer resends the shipped skills to every host
- Only letters reach the phone, and no push log line carries a device token
- The time is one fact in the session menu and the task details, never a header chip
- A turn that ends on its idle line settles at once, not on the 30s pull
- A self-completed session writes its last summary before it stops
- A menu with the Pinned pills is wide enough to keep them on one line
- A task change made while the server restarts is not a sync failure
- One quick folder chip per folder name, not per path
- No other process can read a session's stdin, and a stolen line goes out again
- A working turn stays one closed run, its reasoning inside
- A mail-only run counts only mail, and a Mac session reaches plugin ops
- A turn past the server's reach keeps the chat and fills the gap
- A working turn stays one closed run, its reasoning inside
- Load earlier messages pages a transcript past the full read's byte ceiling
- The darwin-x64 archive builds without onnxruntime's missing binary
- A trigger's memory survives a reboot
- The local walnut CLI runs the build that serves
- A slow bridge link stays up, and a dead one is reset, not left draining
- A park's clock is short and checks the trigger
- Completing a task closes its column even when the column is pinned
- A session that completes its own task stops when that turn ends
- Completing a task from its column header closes the column with the ordinary fade
- A slow start under the session host waits once more, and a failed start's card retires
- A retired op field is dropped, so a park queued offline is not refused at replay
- A run with nothing for the user sends no summary letter
- A tight task column draws every pill as one letter, a lone one too
- A fire reaches its live session on the same host while Walnut is away
- A message the user sent runs exactly once, across crashes and restarts
- The nightly finds the newest green commit from git, not from GitHub's branch run list
- A whale fork's turn-end delta reaches back for its anchor too
- A turn bigger than a whale's tail window no longer wipes the chat
- A teammate's message is the user's, and a worker's question goes to its leader
- This-Mac-only routes refuse a self-call made for a remote caller
- A park sends no letter, and agents write to the inbox only when the user is needed or asked
- A dead or slow bridge link is noticed in seconds and never starves the next one
- The source fallback daemon starts when the server was built with name helpers
- Only this Mac itself may act on its cloud companion
- Sweep transfer corpses on every pull, and give the repo-size card its own lifecycle
- An append inside the mtime's resolution is not served from the cache
- A stable whose updater predates the archive gets no archives, and the run stays green
- A nightly is due at 4.5h, so a check GitHub runs a little early still ships it
- No session error card for a turn auto-continue is about to resume
- A leader completes with its subtasks still open, and then hears nothing more from them
- A park holds for the rest of its turn, whoever made it
- A project card shows every task its project names, and a thread's peek line drops markdown marks
- A plugin's push failures fold into one card across tasks
- A full pull has a deadline, and its card waits while the delta loop is already failing
- The rehearsal's formula takes its prerelease version, and archives skip the CUDA provider
- Opening Display covers no bar, the filter row sits above the list, and Show tab bar keeps the menu open
- Lock, Expand and Close end the header row in a fixed order, and the button reads Lock
- The Apple Health history read survives a dropped connection, and recent days never wait behind it
- Message cards name the other side by its task, never by a session id
- The header keeps Pin on the row and fills the room beside the "..." menu
- A reply card names the session that asked even when the tool output was cut
- The pinned chip rail sits inside its card, so it is never stretched under the bar
- The web-assets check has a lifecycle, a refused list shows its remedy, a redirect names the sign-in
- Apple Health history recorded while access was off reaches the Mac
- Ask for Apple Health only when a health question comes up, and recover after Don't Allow
- Opening the same path again lands on it after browsing elsewhere
- The pinned band bar keeps its chips; Show done moves into Filters
- Board rows show the web's unread dots instead of a status line
- An opened tool run stays open; messages to other tasks stay out of runs
- A finished turn no longer reopens on the phone
- "Save as todo" sits beside the send arrow
- The Date filter drops No dates, Source folds into More filters, New task loses its frame
- A peer is named by its tailnet machine name, not its OS hostname
- The darwin-x64 archive builds without onnxruntime's missing binary

## [0.6.5] - 2026-10-07

### Added

- **Install with one command, no Node needed.** On macOS or Linux,
  `curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh | sh`
  installs a self-contained Walnut (its own Node inside) into `~/.local/share/open-walnut` and
  links `walnut` into `~/.local/bin`; with Homebrew, `brew install evanzhang008/tap/open-walnut`.
  Every release ships the archives for macOS and Linux on arm64 and x64, each one installed and
  started on its own platform before it is attached. These installs update themselves the way
  an npm install does, with the Node inside them.
- **The Mac app needs nothing else installed.** Its Get Started now installs the same
  self-contained Walnut that `install.sh` installs (no Node, npm or git needed) instead of cloning
  and building the source, and Retry after a failed download tries the download again.

## [0.6.4] - 2026-10-06

### Added

- **Install with one command, no Node needed.** On macOS or Linux,
  `curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh | sh`
  installs a self-contained Walnut (its own Node inside) into `~/.local/share/open-walnut` and
  links `walnut` into `~/.local/bin`; with Homebrew, `brew install evanzhang008/tap/open-walnut`.
  Every release ships the archives for macOS and Linux on arm64 and x64, each one installed and
  started on its own platform before it is attached. These installs update themselves the way
  an npm install does, with the Node inside them.

## [0.6.3] - 2026-10-05

### Fixed

- **An effort you pick right after starting a session is kept.** A reasoning effort chosen
  while the session's Claude Code was still starting was saved, then replaced by the launch
  effort a moment later, and that Claude Code ran the launch effort until it ended. The pick
  now holds, and the starting Claude Code is told.
- **A session keeps the mode you picked while it was not running.** Switching a session's
  permission mode (to accept edits, say) while its Claude Code process had ended was saved,
  but the next message resumed it in the old mode.
- **Stopping the search model can no longer crash the server.** The model ran on a thread
  inside the server, and ending that thread in the middle of a model run (an idle stop
  firing after the Mac woke, a shutdown, the server exiting) aborted the whole server. It
  now runs in a process of its own, which is the only thing a forced stop can end.

## [0.6.2] - 2026-10-04

### Changed

- **Stable releases are automatic and daily.** Every day the newest nightly that has been out
  for a day becomes the next stable release when it carries a feature or a fix and installs
  and starts on fresh Linux and macOS machines. Before 1.0 each release is the next patch (a
  breaking change makes the next minor), and the notes come from this file (or the commit
  titles when nobody wrote any). Nightlies now publish every six hours instead of twice a
  day. `npm run release` still cuts one by hand.
- **Every push rehearses the release.** CI installs the package that commit would publish
  the way a user does, on Linux and macOS, serves it, runs a session against a mock Claude
  Code across a restart, and checks that both an older build and the version on npm today
  update themselves to it. The slow test tier (about 1,000 tests with real daemons and
  servers) and the e2e tier (real servers with a mock Claude Code) now block too, and the
  browser suite runs on every push.

### Fixed

- **An effort you pick right after starting a session is kept.** A reasoning effort chosen
  while the session's Claude Code was still starting was saved, then replaced by the launch
  effort a moment later, and that Claude Code ran the launch effort until it ended. The pick
  now holds, and the starting Claude Code is told.
- **A session keeps the mode you picked while it was not running.** Switching a session's
  permission mode (to accept edits, say) while its Claude Code process had ended was saved,
  but the next message resumed it in the old mode.
- **On Linux, editing notes no longer stops the server.** Linux watches the notes folder one
  subfolder at a time, and a folder that vanished while it was being read (each note save
  makes and removes a short-lived lock folder) was an error nobody handled, so the server
  exited. Those errors are now logged and watching carries on.
- **Stopping the search model can no longer crash the server.** The model ran on a thread
  inside the server, and ending that thread in the middle of a model run (an idle stop
  firing after the Mac woke, a shutdown, the server exiting) aborted the whole server. It
  now runs in a process of its own, which is the only thing a forced stop can end.
- **A published build no longer calls itself dirty.** `open-walnut --version` on 0.6.0 reads
  `33eb1cb+dirty` because the release rewrote a stale `web/package-lock.json` while it built.
  The lockfile is current again, CI and the release jobs install with `npm ci` (which never
  rewrites a lockfile), and a nightly's own version stamp does not count as an edit.

## [0.6.1] - 2026-10-03

### Changed

- **Stable releases are automatic and daily.** Every day the newest nightly that has been out
  for a day becomes the next stable release when it carries a feature or a fix and installs
  and starts on fresh Linux and macOS machines. Before 1.0 each release is the next patch (a
  breaking change makes the next minor), and the notes come from this file (or the commit
  titles when nobody wrote any). Nightlies now publish every six hours instead of twice a
  day. `npm run release` still cuts one by hand.
- **Every push rehearses the release.** CI installs the package that commit would publish
  the way a user does, on Linux and macOS, serves it, runs a session against a mock Claude
  Code across a restart, and checks that both an older build and the version on npm today
  update themselves to it. The slow test tier (about 1,000 tests with real daemons and
  servers) now blocks too, and the e2e and browser suites run on every push.

### Fixed

- **On Linux, editing notes no longer stops the server.** Linux watches the notes folder one
  subfolder at a time, and a folder that vanished while it was being read (each note save
  makes and removes a short-lived lock folder) was an error nobody handled, so the server
  exited. Those errors are now logged and watching carries on.
- **A published build no longer calls itself dirty.** `open-walnut --version` on 0.6.0 reads
  `33eb1cb+dirty` because the release rewrote a stale `web/package-lock.json` while it built.
  The lockfile is current again, CI and the release jobs install with `npm ci` (which never
  rewrites a lockfile), and a nightly's own version stamp does not count as an edit.

## [0.6.0] - 2026-10-01

### Added

- **Walnut tells you when a newer release is on npm, and updates itself when restarted.** The
  server asks the registry once a day (20 seconds after it starts, then every 24 hours, never
  during startup) and shows the answer where the version already lives: an `Open Walnut` card in
  the notification panel's System section (the version, `Up to date` or `0.6.0 available` with
  the one command that updates this install and a Copy button, `Check now`), a quiet accent dot
  on the System rail, an `0.6.0 available` segment on the Settings build line, and an `update`
  line in `open-walnut doctor`. `open-walnut update` installs the newer version through the
  package manager that installed Walnut (`--check` only reports, `--channel stable|nightly`
  follows the other channel), and `open-walnut web` installs a published update before it
  starts, then starts again as the new code (Settings > General > `Install updates on start`,
  config `updates.auto`, or `WALNUT_NO_AUTO_UPDATE=1`; off when the install directory is not
  writable, with the `sudo` command printed instead). A checkout run from source and a cloud
  replica never check or update; `WALNUT_NO_UPDATE_CHECK=1` turns the check off anywhere. The
  running server never replaces its own files: an update is applied by a restart.
- **A nightly channel and a one-command release.** `npm run release -- patch|minor|major` rolls
  the Unreleased section of this file under the new version, bumps `package.json`, commits,
  tags `vX.Y.Z` and pushes; GitHub Actions publishes the tag to npm through trusted publishing
  (no token in the repository, provenance attached) and opens a GitHub Release with that
  section as notes. Twice a day the same workflow publishes the newest commit on `main` that CI
  passed as `X.Y.(Z+1)-nightly.YYYYMMDD.N` under the `nightly` dist-tag, so
  `npm install -g open-walnut@nightly` follows the repository without waiting for a release.
  Both channels publish only commits CI passed, since every install updates itself on restart.
  See [Releasing](docs/reference/releasing.md).
- **Park a task until something happens: a Waiting status.** A task can now be Waiting, from the
  status control (with an optional `Until` time), the task menu's Status row, or an agent's
  `task_update` with `phase: "WAITING"`. It keeps its place on the board with an hourglass, an
  `until` chip and a Waiting line above its composer, and the end of the turn that set it, a
  session error or a restart leave it alone. Any new turn wakes it: a trigger firing, a message from
  you or another task, or the `Until` time passing (its session is woken, or a task with no session
  comes back as Need Action with a red dot). The task menu's `Start / Snooze until` row offers
  `Something happens...` beside a time, and the composer's `+` menu has `Snooze until something
  happens...`: either one asks the task's own session to write a small check, create a trigger and
  set the task Waiting, so there is no form to fill. The board's Wait tier is now labelled Parked,
  and a sync plugin that does not declare the new status sees a Waiting task as To Do.
- **A session's questions stay on screen, and each answer lands under the question it answers.** The
  timeline's top-left corner now holds the question list in place of the outline: a labelled tree
  (Main conversation, each question with its number and a status word such as Waiting, Answered or
  To check, pins, `N done` groups) when the panel is 640px or wider, and a rail of thin lines that
  opens the same tree on hover, focus or tap when it is narrower or you hide the tree. One header
  pill switches between Conversation Mode, the new default where every row stays in order with one
  label per question's turns, and Tree Mode, a page per question as before. In Conversation Mode a
  question opens as a comment card under the passage it is about, with its answers, the live reply
  and its own composer, and picking a question no longer scrolls the conversation away. Each
  question send asks the model to begin its reply with a `[Qn]` tag, which Walnut hides and files
  the answer by, so an answer no longer jumps to the main conversation once the transcript catches
  up, or leaves half of itself pinned at the bottom.
- **The model picker shows how fast a session's turn ran.** Inside the Switch Model popover, under
  the live settings, a row gives the model, output tokens, time to first token, tokens per second,
  the turn's wall time and its cost: `This turn` while it streams, `Last turn` with the final
  numbers after, and back after a reload. Two panels
  side by side compare two models on the same prompt. The numbers are Walnut's own measurements of
  Claude Code's stream (tokens per second counts generation time only, tool runs excluded), and a
  live estimate carries `~` until the CLI's own count replaces it. Usage records now keep each
  turn's token counts, model, first-token time and generation time, and the second turn of a session
  is no longer charged the whole session's cost so far ($0.18 shown for a $0.03 turn).
- **Task ids a session writes become clickable task pills.** Sessions mostly write a task's id in
  prose, in backticks or inside a command, and it used to stay dead text. Every id your board knows,
  completed tasks included, now shows as a pill with the task's current title (or keeps the id as
  its label when the title is already written beside it), and an id inside longer code is linked in
  place. Tool input and output link the id without renaming it, file previews and diffs are left
  alone, and unknown ids, file names and path segments stay text.
- **The Mail app opens on a grouped inbox.** Unread automated mail collapses into one line per
  group, named by your own configured model with a one-line summary under it, and mail meant for you
  sits under Important, one row each; a group with nothing unread is hidden. `Mark N read` and a
  batch unsubscribe checklist run only when you click them. Sorting follows your rules first
  (Settings > Mail rules), then the model, then sender signals, and telling Walnut a group is
  important or not, with a reason, is saved as a rule. `Keep out of Inbox` on a group moves its new
  mail (and, if you ask, what is unread now) to the archive, still unread; Walnut cannot create a
  rule on your mail server, so it does the move while it runs. The folder and message list columns
  resize by drag or keyboard and remember their width, refreshing one account no longer pauses
  new-mail watching for the others, and a `mailto` link the account cannot send offers Copy address
  and the mail app link.
- **Dictation sets itself up in one click.** Settings > Voice lists three engines: Qwen3-ASR (Apple
  Silicon, recommended), Whisper, and an OpenAI-compatible API. On a fresh install the recommended
  engine is preselected and one `Set up` row runs the whole chain (Homebrew installs ffmpeg and
  whisper-cpp, or a Python environment gets mlx-audio), downloads the default model with real
  progress and writes the config. Each engine shows one default model with the rest behind `Show all
  models`, and the mic button says `Set up dictation` until it works. A model download no longer
  sits at 0% until it is complete, and a cancelled download removes its partial files. Whisper CLI
  and sherpa-onnx keep working, but are offered only while they are the active engine.
- **A remote host keeps answering its sessions while Walnut is away.** Every `walnut` call a session
  made used to go through the Walnut server, so with the Mac asleep or the server restarting, two
  sessions on the same dev box could not even message each other. Walnut now keeps each host's
  daemon a copy of its sessions, their tasks and their pending reply requests. With no server
  connected the daemon answers `task_get`, `task_list`, `session_list`, `request_get` and
  `task_send` between sessions on that host itself, queues `task_update` and `task_complete`, and
  says what works offline for anything else. When the server is back it reads the daemon's journal
  first: replies land, queued writes replay unless the task changed since, and each session is told
  which of its writes did not land. A session on the Mac falls back to its own daemon the same way
  when the server does not answer at all.
- **After a compaction, a session is reminded of what is still open.** A compaction summary is the
  model's own writing, and it can drop a subtask that is still running. Right after every compaction
  (automatic or `/compact`), each Claude Code session now runs a hook that puts the task's
  unfinished subtasks, the replies it is still waiting for and the requests to it that it has not
  answered into context: a few lines, with no extra turn. Nothing open means nothing is added, and
  the hook never leaves an error row. `WALNUT_COMPACT_OPEN_ITEMS=0` turns it off; the `open_items`
  op and `GET /api/v1/me/open` give the same list.
- **Moving work between projects takes its folders along.** Dragging a task onto a folder, an empty
  folder row or (in the pinned tiers) a card of another project now moves the task into that project
  and folder, after the same confirm as a project move; the drop used to light up and then refuse.
  Agents, the CLI and MCP get `folder_list`, `folder_move` (a folder, its subfolders and every task
  in them, to another project) and `folder_add_tasks`. Renaming a project now carries its folders
  with it, where a folder used to keep naming the old project.
- **The session menu says when the session started, when it was last active, and where it runs.** A
  footer at the bottom of the panel's menu reads `Created` and `Updated` as relative times (the
  exact time on hover) and `Host` (`Local`, or the host alias with the full hostname on hover), in
  place of the old `SSH: <host>` line.
- **Sonnet 5.5 is in the model catalog** for Bedrock, the Anthropic API and OpenRouter, with 1M
  context (on Bedrock too), 128K output and adaptive thinking. Sonnet 5.5 and Sonnet 5 are priced at
  $2 / $10 per million input / output tokens (cache write $2.50, cache read $0.20); Sonnet 5 had no
  price before.
- **On the phone, reply to a letter by voice and see when the reply reached the agent.** The letter
  reply box has the chat composer's mic. Send clears the box at once, and the reply reads `Sending
  to <session>...` until the server records the delivery, then `Sent to <session> · <time>`; a
  refused reply keeps Retry and Edit, and a resend never makes a second reply. The inbox list gains
  a filter row (All, Unread, Action needed and the letter types). Voice notices in the chat composer
  and the reply box now say one thing with their actions beside it, and wrap instead of pushing the
  composer off screen at the largest text sizes.
- **Plugins can show a live item in the rail, file tasks in bulk and run scripts on a host.**
  `walnut.ui.statusItem` puts a small item at the bottom of the left rail, above Voice: a title, a
  detail line, a timer the browser ticks, a glyph and up to three buttons bound to the plugin's own
  ops. `tasks.fileIntoFolder`, `tasks.fileIntoProject`, `tasks.createFolder` and
  `tasks.deleteFolder` (empty folders only) file hundreds of tasks in seconds instead of one
  whole-store write each, leave alone a task the user changed after the plugin planned, and
  `TaskPatch` gains `addTags` and `removeTags`. `walnut.hosts.list/get/run` runs a POSIX `sh` script
  on a host from Settings with bounded time and output, `walnut.sessionImports` exposes the session
  importer's tag, project and runs, and `model.fastText` asks the user's own main provider for one
  short answer. The Rhythm plugin uses the rail item for a stand-up ring: `Start break` or `Stand up
  now` starts a break that counts down (`stand_break_minutes`, 10 by default), and a `Break over`
  notice sounds when it ends.
- **Some actions now answer only to this Mac.** Every request now carries where it came from: a
  task delete (single or batch) is refused for a caller that is not on this Mac, and a trigger check
  from a session on a remote host runs only on that host. The server also gains storage for Apple
  Health data sent by a paired phone (`/api/v1/health/*`, under `health/` in the data directory),
  readable only from this Mac and that phone and never synced to the cloud companion, backed up or
  copied into test-server snapshots. Agents on this Mac read it through `health_status`,
  `health_sleep`, `health_series`, `day_review` and `time_summary`; the phone side comes in a later
  release, and the morning brief and weekly health trend routines ship switched off.

### Changed

- **A new user's first screen opens on a New task draft.** An empty board used to show only a dashed
  `New Project` button beside an Ask Walnut chat column, and nobody could tell whether a project had
  to come first. Now the Ask Walnut slot starts hidden (opening it is remembered, and the sidebar
  toggle says `Ask Walnut`), an empty board opens one `New task` draft and says projects are created
  as you go, and `New project...` moves into the Projects heading menu. Each draft tab has its own
  quick actions, drawn as line icons: Ask Walnut offers three starter questions, and Start Task
  offers `Customize Walnut`, a coding session in Walnut's own source that also works on an npm
  install (it clones the source into `~/open-walnut` when there is no checkout). In the folder
  picker, Enter takes a typed folder that exists, creates a missing one when offered, or opens the
  highlighted row; a user with no history sees the home folder and the common work folders, and
  sessions imported from an existing Claude Code install add their folders as quick paths.
- **The draft column has one way to start: the send arrow.** The `Start ↵` and `Fork ↵` buttons only
  clicked the composer's send arrow, so they are gone; the arrow (or Enter) starts, forks or asks,
  and its tooltip says which. The no-run exit is now `Save as todo` (it was `Create task for
  later`). A draft bound to a task, or a fork, may still send with an empty composer; a plain draft
  needs words, so a stray Enter never starts Claude Code on nothing.
- **A session that needs you shows the board's red dot and a red composer.** The session header now
  carries the task list's own marker before the title: a solid red dot while the output is unread,
  and a hollow ring once it is read but the task still needs you. The composer card turns soft red
  while unread. Both clear on your first click or keystroke in that window (a window coming to the
  front does not count), on a new turn, or when the task completes; the ring stays until you reply
  or complete the task. The items of the header's title row also sit on one center line now.
- **Search finds what people type, not only what titles say.** Questions, one-letter typos, other
  word forms, full-width characters and an unfinished last word now find the document whose title
  spells it properly: over 300 real titles rewritten that way, a question found its target in the
  top 8 90% of the time (was 71%), a typo 87% (74%) and full-width input 94% (29%), and the first
  words of a title rank that task first far more often. A name typed as one word finds text that
  writes it as two (`nightwatch` finds `Night Watch`), versions and dates match across separators
  (`4.8` and `4-8`), and a spelling fix is chosen by which word fits the rest of the query. A match
  spelled as typed still ranks first, and keyword search is about twice as fast at the median (68ms
  to 32ms).
- **Host problems show the moment the notifications panel opens.** A remote host that cannot be
  reached, or a Claude Code that is missing or not signed in, now counts as an error: it leads the
  All view the panel opens on, and the Errors view, as the same row as on the Home card (the
  sentence, the Retry or Check again button, `Show details` for the reason and Open Settings), in
  the card's order and without the dismiss button. A host's failed attempts sit under its row
  instead of in a second block naming the same host, and the Errors badge counts each problem host
  once. A problem dismissed on the Home card stays out of these views too. System is back to
  long-running status: its `Remote hosts` list still names every host once (dismissed ones
  included), and its badge no longer counts hosts. A pending ask still opens Needs Action first.
- **Starting a session in a folder files it into that folder's own project.** The task goes to the
  project whose default folder is exactly this folder; otherwise Walnut creates a project named
  after the folder. When that name is taken, the name grows: the parent folder in front, then the
  host for a remote folder, then a number. The server picks the name and creates the project in one
  step, so two same-named folders started together never share a project, and the draft's project
  pill shows the same name before you start.
- **A session's subtasks get their own subfolder, and the board draws folders nested.** A task a
  session files from inside its task joins the caller's folder only when everything in it is the
  caller or its subtasks; otherwise the subtask gets a subfolder named after the caller, and the
  caller moves in with the subtasks it already had. A caller with no folder still gets a new folder
  holding both. On the Homepage board a subfolder sits inside its parent folder, stepped in 16px per
  level, and folding a folder hides its subfolders.
- **A task title a session writes is a few words.** A title over 60 characters from a session (a
  worker, or a Personal AI ask) is cut to its head at once, the long form becomes the description
  when there was none, and Walnut's fast model then refines the short title in the background.
  Titles you type, and the phone's, are never touched. Session prompts now also say that a
  "subagent" is Claude Code's own Agent tool and never a Walnut task, after a session asked to use a
  subagent filed a Walnut subtask with a 140-character title.
- **Pausing a trigger keeps it on its task, with Resume.** Disable on a task's trigger flyout made
  the trigger vanish, so it read as Delete. It is now Pause, there and on the Routines page: the
  pill turns muted and reads `TRIGGER · PAUSED`, the row shows a Paused badge and Resume, and Delete
  stays a separate confirmed action. Resume delivers whatever appeared while it was paused as one
  fire, and starts the error count over. A trigger the server stopped after 5 failed checks shows
  the same way, marked Stopped. Agents get `trigger_pause` and `trigger_resume`, and `trigger_list`
  reports each trigger's state.
- **Task rows show their tags.** A Homepage row shows a task's own tags as chips (one chip plus
  `+N`, every tag in the detail pane), with Walnut's machine tags hidden, and the chips shrink
  before the title or the row's controls do, at any column width.
- **The Ask drawer and the phone's chat list agree on which tasks are asks.** Both now read one
  server rule (`GET /api/v1/asks`), which answers in about 3ms on a board of 6,000 tasks. While the
  drawer is open its order and times hold still and a new ask reads `New`; reopening shows the true
  order.
- **Every skill Walnut ships is now named `walnut-<thing>`.** The prefix tells them apart from your
  own skills and Claude Code's. The 13 that had bare names (`triage`, `learn`, `morning-brief`,
  `rich-output` and others) moved. The old names keep working in routines, skill reads, saved enable
  and disable choices and `/api/skills/<name>` links, and your own skill under an old name still
  wins.

### Performance

- **The console stays responsive on a board with thousands of tasks.** Profiles of a server with
  6,500 tasks found 40% of its main thread copying and rewriting the whole task table on every
  single-row change, a second copy of the task store inside a sync plugin, and one sync tick that
  held the server for 16 seconds, so every page timed out at once. Row writes now patch the cached
  rows, built-in plugins share the server's own stores, and sync hands the server back between rows:
  reading a task went from 54ms to 1 to 2ms, and the list from up to 290ms to under 50ms. The board
  loads only the last 7 days of completed tasks (on one board, 6.8 MB per load had been almost all
  old completions) and fetches the rest the first time a view shows completed rows; statuses load
  for open tasks only, and a page load asks for the config once instead of five times. The skill
  list, the ffmpeg and keychain checks and the recovery of a missing session record no longer block
  the server.
- **The session daemon stays responsive with very large transcripts.** A daemon restart used to
  replay every live session's stream from the start before it listened (2.5 minutes with a 1.76 GB
  stream, with every local session unreachable meanwhile); it now resumes from a checkpoint, which
  takes a 594 MB stream from 8 seconds to 12ms. The Changed view reads only what was appended since
  its last pass, answers an unchanged session from a light copy, skips files outside every repo, and
  lists a binary file or one over 8 MB without content (`No textual diff`), where one session had
  cost 1.6 GB of memory per refresh. The scan for sessions started outside Walnut no longer freezes
  the daemon for up to 75 seconds every ten minutes. Catch-up replays stop at 8 MB and history and
  status reads at 32 MB (a longer history shows its newest part, and a capped replay says how much
  it skipped), and the daemon no longer runs a blocking `ps` for every session each second.

### Fixed

- **Installing with npm 12 gives a working Walnut.** npm 12 runs a dependency's install script
  only when it is allowed, and better-sqlite3 fetches its binary in one, so a plain
  `npm install -g open-walnut` left a Walnut that could not open its database. The first start
  now finishes that install itself (about 15 seconds, once), and the update Walnut runs allows
  the scripts it needs. A checkout installs under npm 12 too.
- **The Changed view shows a rewritten file as modified, with its old lines.** When a session
  replaced an existing file with Write, the view listed it as a new file and showed only added
  lines, so whatever the rewrite removed was missing from the review. It now uses the original
  file Claude Code records with each Write.
- **The collapsed tool line counts files, not calls.** Six edits to one file read
  `edited 6 files` beside a Changed view listing one file; it now reads `edited a file`. Reads
  are counted the same way.
- **A server restart no longer marks live sessions stopped or hands back tasks still working.** A
  session whose turn ended during a restart was marked `stopped` while its Claude Code was still
  running, so the next message took a slow resume, and a long turn with a background command started
  earlier was handed back as Need Action, then flipped back 30 seconds later. Both now ask the
  daemon first. A task also keeps its link to its session when the CLI stops, so a parent waiting on
  a child that errored is no longer told the child completed, and a task whose session has ended
  deletes without forcing. Retry after a failed resume now resends the message.
- **The Changed view shows a file a session rewrote as modified.** A Write over an existing file was
  listed as added, and every line the rewrite removed was missing from the review; it is now shown
  as modified against the original. The collapsed tool line counts files instead of calls, so six
  edits to one file no longer read `edited 6 files`.
- **A session's conversation no longer drops rows or pictures.** A message sent while a tool was
  running vanished from the history and left its Delivered bubble pinned below later turns. A local
  session whose daemon was slow showed only the live turn or `cached history`, with each load taking
  15 to 23 seconds; it now keeps its timeline and heals on retry, and the server no longer launches
  a second daemon that cannot start. A new session shows its first message from the click instead of
  `Claude Code is working...` over an empty timeline for up to 13 seconds, and an image in a
  remote-host session shows on its first render instead of as a broken icon.
- **A failed dictation no longer loses the end of what you said.** When the final pass of a
  dictation failed after its live draft was already in the text box, the error was dropped because a
  draft existed, and the rest of the recording was gone: no message, no Retry, no entry in the voice
  history. The box now keeps the draft, the mic says `Only part was transcribed` with a Retry that
  swaps in the complete words (or adds them, if the draft was edited or sent meanwhile), and the clip
  is stored in the voice history either way. The final pass also gets the two minutes a Retry gets
  instead of a preview's 20 seconds, so an engine still loading its model no longer fails the stop
  with `signal timed out`, and failures read as what went wrong (`Transcription timed out`, `The
  transcription engine stopped responding`) rather than the request plumbing.
- **A slow local transcription engine is no longer mistaken for a dead one.** Under heavy load a
  2 second health probe to the mlx or whisper-server engine could time out while the engine was
  fine. Walnut then shut it down, adopted it again on its way out and failed the dictation with
  `fetch failed`, and the next one waited out a cold model load. A missed probe now gets a patient
  second look, a real restart waits for the old engine to exit first, a request whose connection
  drops is retried once on a fresh engine, and a live preview the browser already dropped no longer
  takes a turn on the model ahead of the words you are waiting for.
- **A remote host comes back soon after you renew its SSH login.** Walnut now notices a renewed
  certificate or agent key (and, with the new `ssh_login_files` setting, an SSH proxy's own login
  file) and redials a waiting host at once, and its retries keep a 5 minute pace instead of going
  hourly. An SSH proxy whose own login expired reads as a login problem with its own next step, not
  as a passing failure retried every 3 seconds for hours. Every ssh call now ends at its deadline (a
  proxy had kept a 5 second probe open for 11 minutes), a session's Reconnect really dials the host
  and shows why it failed, and a host whose name is an ordinary word, such as `server`, no longer
  garbles Walnut's own error messages.
- **Semantic search works on an npm install, and can no longer crash the server.** An npm-installed
  Walnut never found its embedding worker, so it ran keyword-only search and never downloaded the
  model. Separately, stopping an embedding worker in the middle of a run aborted the whole server
  (when a Mac woke and every timer fired at once, and at some shutdowns); a worker now finishes its
  run before it exits, and the idle reaper skips a busy one.
- **The phone's connection through the cloud companion drops far less, and a late answer still
  reaches the phone.** The Mac to cloud bridge dropped about 50 times a day, mostly in the middle of
  the 1.7 MB the Mac re-sent every 5 minutes. Bulk uploads now go as their own gzipped request
  (about 150 KB), unchanged content is not re-sent, and `Synced X ago` stays within 10 minutes. On
  the phone, a chat turn that goes quiet shows a stall notice and unlocks the composer, its late
  answer lands in place when it arrives, and a follow-up never picks up the previous turn's answer.
- **A test server can no longer stop your real sessions.** A test server running over a copied
  sessions database once ended live Claude Code processes from its orphan sweep, because a pid in a
  record says nothing about who started the process. The server never signals a CLI itself now:
  every stop goes through the daemon that spawned it, which refuses a stop from another Walnut. Test
  servers (`open-walnut web --ephemeral`) refuse the production data directory, forget every
  inherited pid at boot, end their terminals when they exit, and a killed one's data snapshot
  (several GB) is removed within the hour.
- **Resuming a session whose model was retired keeps the same model family.** A session keeps the
  exact model it started with, so once that version left the host's model menu, a resume let Claude
  Code swap in its first allowed model with a `restricted by your organization` warning. Walnut now
  moves a retired Claude version to the one current model of the same family, and the picker shows
  it.
- **Notice and rail buttons answer the click at once.** A toast's button and a rail item's button
  used to wait for their action before closing, which under load took seconds and looked broken.
  Both now close on the click; the rail item shows it is working, and a failure comes back as an
  error toast or reopens the item with the reason.

## [0.5.1] - 2026-09-28

### Changed

- **Host problems read the same on Home and in the notifications panel, and appear once.** The
  attention card (a remote host that cannot be reached, or a Claude Code that is missing or not
  signed in) stays at the top of the task panel on Home. The notifications panel no longer shows a
  second copy of it above its sections: the System section's `Remote hosts` list names every host
  once, and a host with a problem is the same row as on Home (the sentence, the Retry or Check again
  button, `Show details` for the reason and Open Settings), without the dismiss button. This
  machine's Claude Code gets its own block there while it needs attention. The System badge counts
  the problem hosts, the bell opens on System when no card on the page shows the problem (another
  route, or the task panel hidden), and a pending ask still opens Needs Action. In Errors, a host's
  failures link to its row with `Shown in System`.

### Fixed

- **Codex, Gemini, OpenCode, Goose and Pi run on an npm install.** The npm package ships no
  compiled daemon, so a machine that installed Walnut from npm runs the Node daemon instead, and
  that daemon answered every non-Claude session with "ACP sessions are not supported on this host
  yet". It now loads the same ACP supervisor the compiled daemon uses (`acp-daemon-core.cjs`,
  shipped in the package), so those engines start, stream, answer permission prompts and resume
  after a daemon restart there too. They still run on this machine only.
- **A page reached through a port forward to another local port is this machine.** Behind
  `ssh -L 8080:localhost:3456`, or any forward that changes the port, the browser's `Origin` names
  the forwarded port rather than the server's, so 0.5.0 answered every write and the WebSocket with
  `403`: the page loaded and listed your tasks, but completing one silently did nothing, and
  nothing updated live. An `Origin` that matches the `Host` the browser addressed now counts as the
  server's own. A page from any other origin is still refused.
- **On Linux, an SSH login refused because a certificate expired is reported as that.** 0.5.0 ran
  `ssh-keygen -f /dev/stdin`, which fails with `ENXIO` on Linux when stdin is a socket (how Node
  hands a child its input), so the check that tells an expired certificate from a missing agent
  found nothing there and the failure read as a plain auth error. Both calls read from `-` now.

## [0.5.0] - 2026-09-27

### Security

- **Only the machine Walnut runs on skips auth.** The server listens on every interface and used
  to waive auth for any private-network address, and its `/ws` WebSocket (which can open a
  terminal and start sessions) had no gate outside cloud mode. Anyone on the same Wi-Fi could
  open a terminal on the host, and any web page you opened could do the same through a
  WebSocket. Now a request needs no credential only when it comes straight from this machine: a
  loopback connection with no proxy header, a loopback `Host`, and no `Origin` or the server's
  own. Everyone else, private networks included, sends a device token or a config API key; a
  page from another site gets `403`. `/ws` follows the same rule, and `POST /api/pastes` moved
  behind auth. A paired phone already sends its token, so it keeps working.
- A client that reset its connection while the `/ws` check was still running, or sent a
  malformed `Host`, could crash the server. Both are handled now.

### Fixed

- **A Mac needs no compiler for a persistent terminal: the package ships a prebuilt dtach.** The
  build compiles the vendored `dtach` for both Mac architectures and the npm package carries it, so
  a Mac without the Xcode Command Line Tools (this one, or a remote Mac over SSH) gets a terminal
  that survives a disconnect instead of a `Not persistent` shell. Walnut checks the binary runs
  before using it and still compiles from source when it does not.
- **A remote host without a C compiler still gets a terminal.** The session terminal needs
  `dtach` on the host so a shell survives a disconnect, and Walnut compiles it there from source.
  On a host with no compiler the terminal used to refuse to open at all. Walnut now also accepts a
  `dtach` already installed on the host, and when none can be provisioned it opens a plain shell
  marked `Not persistent` with the one command that enables persistence and a Retry. An SSH failure
  during provisioning is reported as an SSH failure, not as a missing compiler, and a failed build
  shows its build log instead of the compiler hint.
- **An npm-installed Claude Code on a remote host no longer fails on a missing Node.js.** The npm
  build is a Node.js script, and the PATH an SSH command sees often has no `node`. The daemon that
  runs under Bun now searches nvm, fnm, volta, asdf and the usual install directories for a working
  Node.js before it spawns `claude`, the same way the binary daemon already did, and when it finds
  none it says so and names the native install command. A missing `node` during a Node-runtime
  daemon start was labelled a Walnut bug; it is now reported as Node.js missing on the host.
- **Host status runs a preflight after connecting** (Claude Code present and which build, Node.js
  when the npm build needs it, a compiler for the terminal) and shows one actionable line per
  missing piece in Settings, with a Check again button. Older daemons without the capability
  simply show nothing extra.
- **Walnut installs what a remote host is missing instead of asking you to.** When the preflight
  finds Claude Code missing (or only the npm build with no Node.js), Walnut runs the native
  installer on the host. When `dtach` is missing it installs the prebuilt one that fits the host;
  only when none fits (or it does not run there) and there is no compiler does it install `gcc`
  and the C headers with the host's package manager under `sudo -n`, then build `dtach`. A
  daemon's refusal counts as a failed fix with the host's own words; a dropped connection does
  not count. Settings shows `Installing ... on <host>...` while that runs. Only when a fix cannot run
  (sudo needs a password, no network) does the line keep its command, now the exact one for that
  host, with the reason. Each fix runs once per host until you press Check again. Turn it off with
  `WALNUT_HOST_AUTOFIX=0`, or per host with `autofix: false` under `hosts.<alias>`. Signing in to
  Claude Code stays yours.
- **Sessions see the PATH your own terminal sees.** The daemon used to put its fallback directories
  (`/usr/local/bin`, `/usr/bin`, ...) ahead of the PATH your shell rc files build, and it read that
  rc PATH inside the environment the server was started from. A Walnut server started from a shell
  with an old Node.js first on PATH therefore handed that Node.js to every session and every MCP
  server the session spawned, and editing `.zshrc` could not win. The login-shell PATH is now
  captured in a clean environment and comes first; the fallback directories follow, then whatever
  the daemon inherited. Trade-off: a host with two `claude` installs now picks the one your shell
  picks.
- **The terminal's fix command matches the host's OS**: `xcode-select --install` on a Mac, the
  yum/apt pair on Linux, all three when the OS is unknown.
- **The folder picker sees a host added in Settings without a page reload**, and a bare word such
  as `work` on a remote host lists matching home folders (`~/workplace`, `~/workspace`) even on a
  fresh install with no session history. Previously a bare word searched history only, so a new
  user typing a folder name on a new host saw "No matches" although the folder existed.

### Added

- **One host problem reads the same everywhere: the home banner, the folder picker, Settings and
  the Start button.** A remote host that cannot be reached, whose Claude Code is outdated or not
  signed in, or whose daemon fell back to another directory, now appears as one row under the
  Claude Code line of the home banner (title `Remote hosts need attention` when only hosts have
  problems), with the host name first, the same sentence Settings shows, and the same action
  (Retry, Check again, Open Settings). The folder picker marks the host's tab with the same dot and
  puts the sentence and action at the top of its list; Settings opens on that host's row from any
  of them. Starting a session on such a host is refused before anything is written (`409`, codes
  `host_unreachable`, `host_not_ready`, `host_off`, `host_removed`) and the draft comes back with
  the sentence and, for an outdated or signed-out Claude Code, a `Start anyway`. Healthy hosts,
  disabled hosts, unsaved drafts and hosts still connecting take no space; a problem that clears
  disappears live; a dismissal is per host, problem and version, and the row returns when the
  problem changes. Routines and the phone launch path get the same refusal, deduplicated per host.
  A test server refuses remote hosts by design and says so in the picker instead of showing red.

- **`open-walnut doctor` prints one paste-ready report for support.** Build and commit (`+dirty`
  for an uncommitted tree), the server's node, port and nice value, which `claude` and `node`
  this machine runs, the login-shell and process PATH, compiler, dtach, SQLite, the provider and
  model, and one line per remote host with its connection, daemon version and preflight. Every
  probe has a deadline and a failed one becomes a warning line. Usernames and hostnames are
  masked by default. The same report is `GET /api/diagnostics` (`?format=text`), a **Copy
  diagnostics** link on the Settings build line, **Copy host diagnostics** on Remote Hosts, and
  part of the bug report.
- **A clean-room remote-host test in CI.** A container that looks like a bare dev box (no compiler,
  no Node.js, an npm-style `claude`, `~/workplace` a symlink) is added as an SSH host, and the real
  daemon connect, folder listing, terminal probe, preflight and session spawn run against it.
  `scripts/onboarding-test/remote-host/run.sh` runs the same thing locally with Docker.
- **Getting Started documents what a remote host needs** (SSH, curl or Bun or Node.js for the
  daemon, Claude Code, optionally a compiler) and what Walnut does when each is missing.
- **Every build says which commit it is.** `open-walnut --version`, `GET /api/config` (`build`),
  `GET /api/system/health` and a muted line at the bottom of Settings carry the version, commit,
  branch and build time (`+dirty` for an uncommitted tree), written by the build only after it
  succeeds. `package.json` moves only on a release, so a checkout of main and the last npm install
  used to be indistinguishable.

### Changed

- **Search reaches the whole document, and a body match can outrank a bare title.** Every indexed
  kind (task, session, note, memory, skill) is now split into passages that each fit the embedding
  model's token limit, instead of a single passage that took only the first 1,400 characters of the
  body. Before this the body was truncated out of the vector entirely for 26% of tasks, 64% of
  sessions, 31% of notes, 74% of memory files and 84% of skills, so a three-month task whose note
  says "iOS" 23 times could not be found by searching for iOS. Passage 0 carries a lead from the
  body whenever there is one, so a document is discoverable by what is in it and not only by its
  title.
- **Ranking gained a body-coverage component**: 0.20 of the keyword score, taken from BM25, applied
  only to queries of three terms or more. FTS5 normalises by whole-row length with constants that
  are not configurable, so no column-weight setting makes a long body outrank an empty stub that has
  the query words in its title, and the length-independent signal has to live outside BM25. Column
  weights are unchanged (title 10, summary 3, note 1, meta 2): rebalancing them was measured and
  cost more on single-word identifier queries than it gained.
- **A search no longer pollutes its own index.** Each Ask Walnut search writes a task and a session
  titled `Search query: <the query>`, which then matched that exact query on a 10x title weight and
  took result slots from real documents. Both are kept out of the index now, and out of the
  title-paraphrase lane, which reads live records rather than the index.
- **A result snippet comes from the region that actually matched**, chosen by term density, instead
  of from the earliest match in `title`, `summary` and `note` joined into one string, where a long
  title always won. Chinese and Japanese queries get a real snippet at all now: snippet terms were
  split on whitespace, so a CJK query matched nothing and fell back to showing the title.
- **The order a search returns is reproducible from the fields it returns.** Results are ranked by
  coverage tier first and score second, but the tier itself was not in the response, so a reader saw
  a row scoring 0.658 sitting below one scoring 0.279 and concluded the ranking was arbitrary. The
  tier the sort used is published as `coveredTermHits` on every row now.

### Upgrade notes

A browser, script or phone on another device that relied on the old private-network waiver now
gets `401 {code: "not_paired"}`. Pair it in Settings > Phones & Cloud (or `walnut device add
<name>`) and send `Authorization: Bearer <token>`; from another computer's browser, forward the
port over SSH (`ssh -L 3456:localhost:3456 <host>`) and open `http://localhost:3456`. A reverse
proxy in front of Walnut must send `X-Forwarded-For`.

The passage layout is versioned, so the first launch after upgrading clears the stored vectors and
re-embeds every document in the background. `search.sqlite` keeps its documents, so nothing has to
be re-read from tasks, notes or transcripts.

- Keyword search is unaffected and at full quality throughout.
- Semantic rescore reports itself as cold, and semantic recall (the extra candidates behind
  cross-lingual and paraphrase queries) is unavailable until the rebuild drains.
- For ~12,000 documents (~85,000 passages) the rebuild took roughly 26 hours on a machine busy with
  other work, measured at 0.93 passages per second, and is several times faster on an idle one.
  Short documents are embedded first, so most of the index is better than it was before the upgrade
  within the first hour.
- Progress is in Settings → Search and in `GET /api/search-index/status`.

Tasks and sessions are indexed on their own events, so an Ask Walnut `Search query: ...` row written
before this upgrade stays in the index until something touches that task or session, or until a full
rebuild.

The phone launch route (`POST /api/v1/sessions/launch`) now answers `409` with `code: host_removed`
for a host that is unknown or disabled, where it answered `400`; the other host refusals
(`host_unreachable`, `host_not_ready`, `host_off`) are new `409` codes. See the API v1 reference.

## [0.4.5] - 2026-09-03

### Changed

- **Settings reorganised so each card is about one thing.** New **Tasks** card (default priority/project, "Quick-add creates tasks in", Task Summary) with Focus Tiers folded under it; **Sessions** is now only the session runtime (idle timeout, permission interception, modes, output mode). Per-host Session Limits moved to **Remote Hosts**, the SDK Session Server switch to **Advanced**, Chat Notifications to **General**, and Text-to-Speech joins dictation under **Voice**. Renamed to stop the collisions: Calendar → **Calendar Accounts**, Permissions → **macOS Access**, Timeline → **Screen Tracking**, Devices → **Phones & Cloud** (Cloud Companion folds under it), Search & Embeddings → **Search**. A **Diagnostics** nav group holds Usage & Costs, Suggestion Accuracy (its own card now), Screen Tracking, and Bug Report. Every section keeps its `#id` deep link.
- The Claude Code provider card drops the duplicate "Protocol" row, and its model list reads Claude Code default / Opus / Sonnet / Haiku instead of "(subscription)", which was wrong on a Bedrock-backed machine.

### Fixed

- The Settings nav highlight now follows the scroll. It attached its scroll listener while the page was still a loading spinner and never re-attached, so it stayed on the first entry no matter how far you scrolled; the nav also scrolls its own list to keep the highlighted entry in view, and the last card lights up at the bottom of the page.

## [0.4.4] - 2026-09-03

### Changed

- Settings section renamed **Ask Walnut (Walnut Agent) Provider** and reduced to two choices: **Claude Code**, or **Walnut custom agent** with the provider list (Bedrock, Anthropic, OpenAI, OpenRouter, Gemini, Ollama) underneath. The explanatory box is gone.

## [0.4.3] - 2026-09-03

### Changed

- **Settings → AI Provider means one thing: what Ask Walnut runs on.** The chat engine (`agent.provider`) now follows the provider instead of being a separate hidden switch: Claude Code → a `claude` session; any other provider → the built-in agent loop calling it directly. The radio writes both fields together; an explicit `agent.provider` in config.yaml is still honored as an advanced override. Before this, picking Bedrock in Settings changed only the background helpers while Ask Walnut kept answering from Claude Code. The banner, the Settings copy, and the engine badge all say "Ask Walnut" now instead of "the chat" or "background work".

## [0.4.2] - 2026-09-03

### Changed

- **Claude Code is the default AI provider for everything.** Ask Walnut already ran on a `claude` session; the background helpers (summaries, titles, subagents, cheap-model calls) now default to the same `claude` CLI whenever it is installed, instead of expecting Bedrock credentials. Saved Bedrock credentials alone no longer decide, so a machine with Claude Code on it runs on Claude Code.
- The `claude-cli` adapter inherits the CLI's own login as-is (Anthropic account, Bedrock via `CLAUDE_CODE_USE_BEDROCK`, or Vertex). It used to strip the AWS environment and force a subscription-only settings override, which made it unusable on Bedrock-backed machines. Concurrent CLI calls are capped (`WALNUT_CLAUDE_CLI_CONCURRENCY`, default 3).
- The first-run banner is one card: "Walnut runs on your Claude Code, signed in with Bedrock (us-west-2)" when the CLI is found, or the install command when it is not. Settings → AI Provider lists Claude Code first, as the default, and shows how the CLI signs in instead of asking for a login.
- `GET /api/system/health` gains `mainProvider`, `mainProviderImplicit`, and `claudeCliAuth`; `GET /api/config/providers` reports `credential_source: cli_<mode>` plus a human `credential_detail` for Claude Code.

### Fixed

- Older Linux (glibc before 2.29) recipe: the Python step now uses `uv python install 3.12` (a static build that runs on glibc 2.17+, no sudo) because the distro Python channel is missing on many hosts; `npm start` prints the same commands.
- The onboarding harness gains an `ssh <host>` target for testing on any machine you can reach, ARM Linux defaults to a Graviton instance type, and CI now runs the `npm install -g open-walnut` route on Linux and macOS next to the checkout route.

## [0.4.1] - 2026-09-03

Onboarding on a machine that is not the maintainer's: every step below was found by installing
Walnut on fresh EC2 Linux boxes and GitHub's macOS runners, on video.

### Fixed

- **`git clone` + `npm start` no longer needs Bun.** `scripts/build-daemon.sh` treats a missing Bun
  as a state, not an error; the version check logs it once and moves on; an ACP-based engine
  (codex, gemini, ...) that needs the worker says so and names the fix instead of failing on a
  missing file. The npm package ships the prebuilt worker as before.
- A busy port no longer starts a second server somewhere else. If the port answers as Walnut, the
  message says "already running, open this address"; if another program holds it, it says so and
  points to `--port`.
- Node older than 22 gets one plain sentence with the `nvm` two-liner (`bin/open-walnut.js`,
  `.npmrc engine-strict`, `prestart`), not a stack trace from an unsupported syntax.

### Changed

- **`sharp` is optional.** Image compression for sessions degrades to sending the picture as-is when
  sharp is not installed (logged once), so an `npm install` never fails over libvips.
- **Older Linux (glibc before 2.29)**: better-sqlite3 has to compile there, which needs Python 3.8+
  and GCC 10+. `npm start` now checks for the built module first and, when it is missing, prints
  the exact install commands for the box (`gcc10-c++`, `python3.8`, the `CC=/CXX=/PYTHON=` line)
  instead of letting the compile fail minutes in with an unrelated error. Recipe in
  `GETTING_STARTED.md`.

### Added

- `scripts/onboarding-test/`: a harness that provisions a throwaway EC2 box (AL2, AL2023, ARM,
  Ubuntu), runs the README route and the npm route as a new user would, records a video, and
  tears the machine down. CI gained an `onboarding` job that does the same on Ubuntu and macOS
  runners with Bun deliberately absent.

## [0.4.0] - 2026-09-02

### Changed

- **Search runs on Walnut's own hybrid index.** Tasks, sessions, notes, memory files and skills
  now live in one SQLite file (`~/.open-walnut/search.sqlite`): a keyword index built on a
  tokenizer that splits `camelCase`/`snake_case`/`kebab-case` identifiers into their parts and
  indexes Chinese as ordered character pairs, plus quantized vectors used only to rescore the
  keyword candidates. Cold interactive search went from seconds to milliseconds, and queries like
  `operator` now find `PlatformEventOperator`, which no configuration of the previous engine could
  do. Embedding models are ONNX presets chosen with `WALNUT_SEARCH_V2_EMBED_MODEL`
  (`qwen3-0.6b` default, `e5-small` for a smaller/faster index); `WALNUT_SEARCH_V2_SEMANTIC=0`
  gives keyword-only search with no model at all.
- Search index maintenance moved to `/api/search-index/*`. `/api/qmd/*` still answers as an alias,
  and the frozen `/api/v1/qmd/status` keeps its path and payload shape for the iOS app.
- **Settings → Search & Embeddings** no longer has a model picker or a download step: the model is
  fetched automatically on first use into `~/.open-walnut/models/`. The panel shows index health,
  per-kind document counts, a rebuild button, and the excluded-folders list.

### Removed

- The `@tobilu/qmd` search engine and everything built on it: four separate index databases, the
  fork-based background indexer, the native GGUF model loader, and the postinstall patches that
  had to rewrite the library's compiled output on every install. Retired `search:` config keys
  (`qmd_model`, `rrf_alpha`, `enabled`) are ignored rather than rejected, so old config files
  keep working.

### Upgrade notes

After upgrading, these are dead weight and safe to delete by hand (Walnut never touches them
again, and nothing recreates them):

```bash
rm -f ~/.open-walnut/{memory,notes,task,session}-search.sqlite*   # old index databases
rm -f ~/.open-walnut/memory-index.sqlite*                        # older memory FTS index, retired with them
rm -rf ~/.cache/qmd                                              # old GGUF model cache
```

Nothing needs to be re-indexed: the new index has been building itself in the background since the
release that introduced it.

## [0.3.0] — 2026-07-16

Walnut goes mobile. **71 commits** since 0.2.0 add a native iOS companion app and the
self-hosted cloud relay that powers it, plus a hardened cloud-exposed surface and a
rebuilt single-timeline session chat.

### Highlights

- **Native iOS companion app** — a SwiftUI app (TestFlight beta) to check tasks, browse
  sessions, and read/edit notes from your phone, with Apple Notes / Apple Reminders-style
  interfaces, QR-code pairing (scan from the console, zero typing), and a live view of any
  machine's Claude Code session with in-app chat.
- **Self-hosted cloud companion** — an optional EC2 relay (AWS CDK infra included) with
  device auth and a versioned `/api/v1` facade that bridges your phone to your machines over
  HTTPS, including a git smart-HTTP endpoint so data-repo sync runs over 443.
- **Single-timeline session chat** — session chat is now one append-only timeline of blocks
  (system events and tool-failure state included), replacing the previous multi-stream view.
- **Hardened cloud surface** — the cloud-exposed bridge tightens CORS and secret exposure,
  with authoritative session-status reconciliation across the direct-connect bridge.

### Added

#### iOS companion app
- Native SwiftUI companion app with a primary-side auto-sync loop.
- QR-code pairing — scan from the web console to connect, no manual tokens.
- Sessions tab: browse and open any machine's session, with transcript tails and a live
  talk / conversation view.
- Tasks tab (Apple Reminders style) and Apple Notes-class WYSIWYG note editing (in-place
  table editing, Format drawer, floating glass accessory bar, keyboard avoidance).
- In-app log capture + auto-upload for TestFlight debugging.

#### Cloud companion & sync
- EC2 cloud companion: CDK infrastructure, device auth, and a read-only `/api/v1` facade.
- Git smart-HTTP endpoint for data-repo sync over 443; task projection export and
  read-only `GET /api/v1/tasks`.
- Cloud direct-connect bridge with authoritative session-status reconciliation.

#### Sessions & focus
- Read-only session projection and a Sessions tab in the task panel.
- Focus Bar state derived from tasks with UI-preferences sync; whole-group drag with a
  floating stacked preview and target-tier highlight.
- ACP-dialect id threading (msgId / messageIds / seq) and a stream-convergence sentinel
  with post-compact usage re-seed.

#### Memory & skills
- Bounded global memory with a unified skill system.

### Changed
- Session chat rebuilt as a single append-only timeline of blocks.
- Default-model config dropped — "Auto" now means no `--model` flag.
- History view delivers system events and tool-failure state; CLI-injected
  task-notification echoes are hidden from the main chat.

### Fixed
- **Security:** hardened the cloud-exposed surface (bridge, CORS, secret exposure) and
  scrubbed PII test fixtures and an internal proxy codename.
- iOS chat freeze after the first reply (stall watchdogs + queued SSE event); 90s bridge
  flap eliminated for fast conversation open.
- Idle-debt conservation so a late companion idle can't complete the next turn.
- Atomic JSON writes rename within the target dir (fixes `EXDEV` on Linux tmpfs).
- Cloud mode no longer lazy-inits the QMD store on search/index-status; per-note semantic
  embedding gated off in cloud mode.
- README star-chart embed fix.

## [0.2.0] — 2026-06-25

The first major update since the initial release: **503 commits** that turn Walnut
from a task-and-session dashboard into a full AI-native workspace — a Notion/Obsidian-class
notes vault, a resilient remote-session daemon, live workflow visualization, per-session
diff review, and zero-config onboarding.

### Highlights

- **Notes vault** — a Notion/Obsidian-class multi-file notes system with a TipTap WYSIWYG
  editor, wiki-links, tables, image paste, attachments, slash commands, and hybrid
  (semantic + keyword) search. The agent reads and writes your notes as first-class context.
- **Per-session diff review** — a GitHub-style "Changed" view for every session: review
  exactly what the agent changed, leave line-range comments, and reply inline.
- **Live workflow visualization** — dynamic multi-agent workflows render as a real-time
  phase flow-graph with per-subagent drill-in and full transcripts; reconstructed on reload.
- **Resilient remote-session daemon** — a new transport architecture (bun binary + SSH
  tunnel + FIFO) keeps remote Claude Code sessions alive across tunnel/daemon crashes,
  with chunked auto-deploy that survives corporate SSH proxies.
- **Zero-config onboarding** — unified credential resolver auto-detects Bedrock/Anthropic
  credentials from config, `settings.json`, env, and `~/.aws`; three setup paths get you
  running out of the box.
- **Multi-conversation agents** — each agent now has multiple independent conversations
  (fresh context per tab) with automatic knowledge distillation into agent memory.

### Added

#### Notes & Knowledge
- Notion/Obsidian-class notes editor: WYSIWYG (TipTap), wiki-links, tables, image paste,
  per-line Tab indent, paste-URL-as-hyperlink, and file attachments.
- Multi-file notes page with an Obsidian-like folder tree, drag-to-move, breadcrumbs,
  and in-tree reveal/locate.
- Hybrid notes search (semantic + keyword) with relevance bands.
- Slash-command panel in notes — `/task` inserts clickable task references.
- Global notes section with autosave; unified Markdown editor shell across all surfaces.
- Notes context injected into the main agent + a context inspector UI.
- Repository environment memory layer and working-memory scratchpad.

#### Sessions
- Per-session **Changed view**: GitHub-style diff, line-range drag comments, persistence,
  and three compare modes with an explanatory schematic.
- **Dynamic-workflow visualization**: live phase flow-graph, per-subagent drill-in,
  collapsible/full-screen panel, transcript lazy-loading, and reload reconstruction.
- Resilient remote-session daemon: bun-based transport, source-deploy fallback, graceful
  upgrade, and chunked auto-deploy for SSH-proxy environments.
- Embedded terminal in the session panel (persisted via `dtach`).
- VS Code-style file explorer + file intelligence (Edit diff view, clickable paths, FileViewer).
- Quick Start session panel, instant session switching (client-side history + stream cache),
  session retry, and `/session` command with fuzzy path picker and live SSH auto-complete.
- Two-panel session layout by default, draggable divider, panel count selector, pin-to-right.

#### Tasks & Focus
- 3-tier pinned system — **Focus / Next / Satellite** (+ Wait tier) with drag-to-pin/reorder.
- Lightweight virtual task groups (fork + manual multi-select + agent tool).
- Fork-in-Walnut with multi-level child task nesting and AI-generated fork titles.
- `HUMAN_VERIFIED` and `POST_WORK_COMPLETED` task phases; phase pickers with ⚡ indicators.
- Sprint as a first-class citizen (query filter, REST API, interactive picker).
- Quick Add, date pills/pickers, focus-override, cross-source task migration.

#### Agent & Models
- Multi-conversation per agent + on-demand agent creation + memory distillation.
- Opus 4.8 added and set as the default model; catalog-driven model resolution with
  adaptive thinking support and per-provider model catalogs.
- New agent tools: `ask_question`, `pin_task`, `files_glob`/`files_grep`, unified `files_*`
  URI-addressed tool group.
- Execution / Plan mode toggle in the main chat; Claude Code Teams tab UI.
- Skills page — browse, search, edit, enable/disable skills (local + remote discovery).

#### Onboarding, Settings & Providers
- Zero-config onboarding via a unified credential resolver (Bedrock auto-detect).
- AI Providers settings with a catalog UI, active selector, provider adapters, Ollama
  dynamic models, and Tavily web-search support.
- Auto-save settings sections (manual Save removed).

#### Voice & Observability
- Speech-to-Text with a mic button on all text inputs; system-audio capture; whisper-server
  daemon engine with VAD, prompt biasing, and an expanded model catalog.
- Forensic observability layer: wide-event recorder, invariant engine, auto-incidents,
  and session self-report.
- In-app notification store, toaster, and error bridge.

### Changed
- Renamed brand from **Walnut** to **Open Walnut**.
- Consolidated task-row actions into a kebab menu; unified pill-style action buttons and SVG icons.
- Simplified `TodoPanel` (View dropdown + status dots) and session-panel headers.
- URL state sync — UI layout encoded into the URL for deep linking.

### Performance
- Real-token compaction gate fixes the "context never converges / hits 1M" failure.
- Lazy-load subagent content (fixes 40s session loading); CSS-promotion full-screen with
  zero re-mount.
- Event-bus interest set skips global subscribers on high-frequency events (fixes event-loop
  starvation); write-invalidated read cache + slimmer task payloads (15s timeouts → tens of ms).
- Async task operations with optimistic updates; deferred Markdown serialization.

### Fixed
- 246 fixes spanning session status correctness (false-zombie kills, fake `session:error`,
  mid-turn QUEUED stalls, premature idle completion), notes flicker/drag duplication,
  daemon reconnection and replay, STT mic detection, and many UI papercuts.

## [0.1.0] — 2026-03-08

First public release: a Personal AI powered by Claude.

- Claude Code Web UI: spawn, monitor, and chat with sessions from a real-time dashboard.
- 4-layer task hierarchy (Category → Project → Task → Subtask) with a 7-phase lifecycle.
- AI agent with 30+ tools (tasks, memory, sessions, search, cron, coding).
- Persistent memory system (SQLite FTS5 + BGE-M3 embeddings).
- Multi-session orchestration, local-first storage, self-hosted, CLI + Web, heartbeat,
  cron jobs, plugin system, and git-sync.

[0.3.0]: https://github.com/EvanZhang008/open-walnut/releases/tag/v0.3.0
[0.2.0]: https://github.com/EvanZhang008/open-walnut/releases/tag/v0.2.0
[0.1.0]: https://github.com/EvanZhang008/open-walnut/releases/tag/v0.1.0
