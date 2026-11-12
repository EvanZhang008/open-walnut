# Changelog

All notable changes to Open Walnut are documented here. This project follows
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may include
breaking changes).

## [Unreleased]

## [0.6.32] - 2026-11-12

### Added

- A designed agent cursor, four looks, picked in Settings
- Price Fable 5.2 at its published rates
- The page logs how much it holds every five minutes, beside the Mac app's memory lines
- Agenda and Scratchpad get their own Side bar group
- The debugger is required in Chrome, so live pictures, agent screenshots and real input work everywhere in the agent window
- An agent's cursor in the page, and Act in tab joins the task's tab group
- Show it live on a covered agent window
- Live pictures of a covered agent window through the debugger
- At most 2 test servers at once on a Mac, and a long idle limit yields to a waiting one
- The side panel's bar reads as designed, its composers pick mode and model, and the page chip says it is the page
- Agents fill a saved login's one-time code with fill_code, never seeing it, under fill_login's rules; a fresh sign-in's yes covers its code once
- Watching rows drag to the user's own order
- Keep each routine's run history, show missed runs, retry a broken start in its slot, offer a catch-up run
- Show each check's time limit, say a kill at the limit, and let trigger_test wait out long checks
- Walnut-net 0.2.1 downloads are checked against pinned checksums
- Dictate to the clipboard from the composer
- A reworded ask is the same decision, never news
- Tasks nobody started fold under their own Not started section
- Filters that file mail into a folder of the account
- Walnut.passwords.state and unlock, so a plugin can save a secret when Passwords is locked
- Move between sessions from the keyboard, complete and go on, Undo for task actions
- Reviewers give a score (function, UX, UI) on their reply; Engines compared shows it per task and per engine
- One column per model line, a one-line verdict, add an engine on a model and an off switch in Settings
- Share new tasks between coding engines and compare them on Usage & Costs
- A thread push opens the VP's Threads with that thread visible
- Walnut.passwords.save keeps a secret the person typed in a plugin's App
- Drag, wheel and in-box scroll, type at a point and slowly, annotated screenshots, zoom, page dialogs, clicks by words across frames
- Find the dev servers a session started, open them in its Web view, stop one
- Stream binary route responses with cancellation
- Mail lists each area's router with its live state, and the Org chart draws it beside the VPs
- One mail router per area, beside the VPs, with its routing shown on every email
- A linked pull request's live status on the task, a failed check wakes its agent, a merge completes it
- Several terminals per session, split panes, docked under Changed
- Call Ask Walnut "Quick question" and the main task "CEO" everywhere a person reads
- Every letter says who sent it; Inbox Triage keeps routing rules
- The fallback engine reads a session's usage-limit stop from the wait's own record
- A new task starts on the fallback engine while the default engine is out of usage
- An opened org chart project is the tree of its tasks, each with its status icon
- A closed org chart card says how many it has open and what it is doing
- Live Browser view stream, Take over and Hand back, sign-in hand-off, one tab group per task
- One taskbar for the whole app, and Minimize on every session panel
- The taskbar's chips are only sessions the user minimized; the rest go to Recent at its right end

### Fixed

- A widening leaves the live end before the follow cut can undo it, and a cut never removes a row on screen
- A column following the live end cuts its chat back to the default tail
- A push during a list read waits for it, then reads its own job
- A clicked column wears no highlight: no tinted header, no accent line, no composer ring
- ModeBesideCorner is pure; each pane tells a sheet move outside its updater
- A later write for a task the list does not hold yet replaces its held edit
- A column's Complete toast names its task before the board's list has come
- A pane that goes full screen under a corner notice picks its mode afresh
- A compact file bar draws the Terminal dock toggle as its icon
- A column's Complete before the board's first list closes it at once
- The ask drawer returns focus only when it closes, not when React replays its effect
- On a phone a settings select is 44 px tall
- An agent step never reports input the page did not get, and reads take 3 calls
- The model catalog lives in a state dir, not the OS temp dir
- Phone pills keep their colour and the title its room; spec covers the asking tab and phones
- The browser pill's Sign in opens the asking tab; the guard catches wrappers
- Larger widens the browser pill's popover; a browser glyph on the phone
- Live servers and the browser show only as header pills
- A GitHub server error is tried again instead of ending the run
- The extensions' build number phases name the built Info.plist as input, so Xcode runs them after writing it
- The nightly extra tests set their daemon dir in a step, since a job's env cannot read the runner context and GitHub rejected the file
- The default branch reads every remote's main from the refs, so a second remote's branches count without that remote being configured
- A card follows the answer to its send, and every mic in a view says the same
- Place the HTML preview card as soon as the page reports its passage
- On a phone the Web view's server strip keeps the shown page's port in view
- Judge outward steps after the cursor; person's tab groups survive a reload; debugger holds end cleanly
- A task change reaches a host as its rows, not the whole task manifest
- The size notice repeats every 6 hours while free space is under the floor
- The panel's composer gives its mode and model their own line, and its first drawing shows them
- A request in flight to a daemon being replaced waits for the next one
- The dependency mirror leaves out tool caches, so a vite run elsewhere no longer voids its copy
- A reattach after a server restart keeps the window's screen
- Walnut never picks a host that cannot run Claude Code, and one nothing uses takes no card
- A question the person stopped is not asked again at the next turn's end
- Full screen hides the Terminal dock toggle, and the blank click spec finds blank bar
- The server's own timeout answer is said at once, not retried as a lost link
- The Routers list keeps the narrow drill down's measure
- The "still waiting" line counts from when the link's code went out
- On a phone the route line reads at 12 px and the routing buttons take a finger
- The event-loop alarm counts only stalls Walnut's own work caused
- The reconcile loop no longer asks again for its own question's echo
- A closed group's "Filter mails like these…" starts from its own mail
- A send written with the words folds to one closed line after them
- A darwin identity stamp that cannot sign leaves the file as bun wrote it
- Sweep unused stages again once the new server serves
- Hash daemon-over-busy.ts into the daemon version, and run the force twins test on Node
- An overdue swap fences file changes from its start on every path, and a self-ending skip asks again
- Every update path past a silent daemon, and no deferral without a clock
- An overdue update ends even when the old daemon's work never settles
- An overdue update gets past an older or stuck daemon too
- Bound every hold on a daemon update, the daemon's own refusal included
- Every chat page keeps the reader's place, and the question list opens only from its marker
- The restart alarm counts only starts on the build already running, not deploys
- A build takes its dependencies from its own mirror, so a checkout mid-merge cannot break it
- The clipboard mic needs no router, and voice WebKit specs pin Safari's agent in the open
- The sent text is the whole recording, transcribed once, unchanged
- An open Recent row stays readable on the selected row's fill
- A card header's pieces never overlap; the node's name gives way, the state and time stay whole
- A receiving task's ask keeps its decision across rewordings
- A decision is kept only across real rewordings, and what stays quiet survives a restart
- A wider window keeps a plugin dialog, a task's detail and a new session's draft open
- Delivery latency leaves out sleep and lines written earlier
- A session just continued after the usage limit reads as continuing, not ended
- A limit summary's count scrolls to the topmost of its rows
- An init processor's timeout bounds its action, not the whole run
- The widget's build-number script adds the version when its built Info.plist has none
- The words answering the person never fold, whatever line ends the turn
- A random mixed-case token is matched whole, so a short term among its base64url parts no longer fails the audit
- Heavy work holds off at a whole-Mac load spike, deploys wait out a busy Mac
- A cron push reads the one routine it names instead of the whole list
- A split pick of the default engine with no model of its own still falls back while that engine is out of usage
- The split's config fields stay out of a replica's copy; new task fields are listed as not drawn on rows; the split row's labels and model input pass the ratchets
- A task's review score merges part by part, also on a close of a closed task; the All view names a column with no model line; plainer words for unknown cost and reviewers
- The ops read a score by the same rule as the routes (any key case, text, refuse what cannot be read); another company's lower part still counts; a company keeps each part's latest; the default-model entry says so
- A queued close keeps its score through a later close and a replay onto a closed task; a reviewer on a model of no known company is an unknown company
- A close's score is kept offline too; one score rule online and offline; parts from two companies are no full verdict; an unknown reviewer company reads unknown, never 0%
- Review counts and costs are never a win; medians rest on fully scored tasks; a text score needs all three parts valid; only a reviewer with a verdict counts as checked
- A score ranks only with all three parts and says what it rests on; an offline reply's score is kept; an unusable score is refused; unknown reviewers count apart
- A task counts under the model line that cost most; the off switch keeps the entries; models only where an entry takes one; a cross-company review share
- Time and date work from recorded facts (a session's first turn, each completion), not from overwritten status moves
- Claude Code's own turn signals count as work; a resumed dead spawn dates the work from its reopen; open tasks newest first
- A failed start's empty session never dates or times the work that followed it
- A CLI that dies before its first reply, then closed, is never-started work
- Never-started tasks say so in the list; one engine stays one column under unknown model ids
- A start that never ran a turn is never finished work, on any engine; ranks rest on each metric's own samples
- The fair view has one column per split entry; tasks that never ran are not finished work
- Medians judged on finished work; one failure counts once; a reopen keeps the first completion
- Bounded turns, reviewers take none, failures kept; dollars decide a task's engine
- Requests with no token counts are unknown; tasks go to the column that carried them
- A start that failed before a session still counts; unknown usage reads as unknown
- Unknown usage is never cheapest; a fair view keeps tasks where the split put them; a failed first start keeps its pick
- One pick per task under double starts; a fair-test view; review costs and errors counted honestly
- Split picks survive queued starts; the comparison counts honestly
- Two task starts at once take different split entries
- The default branch is the one HEAD left most recently, so an old work branch as origin/HEAD or a stale origin/main never becomes it
- Picking a view in an Org node page's menu sticks while its threads read retries
- Messages never stay QUEUED behind a jammed queue, and the panel shows the server's word
- An ask that reached its target is never told "not taken", and a refused start says what to do
- No standing attachment-limit lines; a limit shows only where it is hit
- A task link in the phone Scratchpad sheet opens the task and closes the sheet
- An Org page whose first task load failed tries again and settles its node once it lands
- A changed e2e test runs under the e2e config, not the slow tier's
- A grouped read that failed on a dropped link loads again by itself
- One row per mail across folders, bodies fit the paper, and four small reader and Org fixes
- A drag, a dialog's OK and slow typing are judged before they act; older extensions are refused the new input; a dialog stops the step it cut short
- A table cell's bold no longer rewrites other text on save
- A slow first ui-prefs read no longer opens the default layout or overwrites the user's prefs
- Timeline notice rows start collapsed, the idle compaction row too
- A page selection the panel already read has its clearing told
- The origin badge reads 12 px on a phone
- The side panel drawer's title stays on one line
- A notice beside the full-screen sheet never takes a Tree Mode page away
- A covered agent window says why it has no picture
- A letter's origin lives on Letter, not on a thread turn
- An agent's new tab never focuses the agent window
- Escape closes a link tag's hover card
- The bridge's owner check reads the spawn journal again on a miss
- A finished session's stream capture goes after two days; the spawn journal proves residence
- A low disk prunes a finished task after an hour, and one failed sweep step never skips the rest
- The shipped Walnut skill lists thread_update's user_words, and its drift check runs in the quick tier
- The last press on a page no longer keeps what it pressed alive after it leaves
- A favorites or ordering read that crossed this tab's rename takes the new name
- A toast still settling keeps its mark when the corner remounts
- The asked prompt's disclosure stays light with dark ink, in both themes
- A pop-out mounts the plugin dialog host, as App does
- A composer that narrows only grows, so the transcript beside it keeps its end
- The launch log's millisecond fields come from one plain helper
- The launch hydration is a named method, so CI's compiler type-checks MainTabView's body again
- A question answered in its tag is not asked again at Stop, and a Stop hook's hold makes no card
- A routing rules file that cannot be read is never taken for no rules
- A start Walnut never took is asked again instead of ending the run
- A full-screen sheet is round at every corner: the sheet under it is not drawn
- Every editor that saves Markdown keeps the document's own bytes on the lines nobody edited
- A label cut in a long path stops at a slash, never at the bare verb
- A land never runs an e2e test with the slow config
- The tidy-up reads the task's status, not its phase; guards list Take over and the extension's CDP methods
- The view never freezes, no window or tab is taken from the person, groups fold, finished tasks' tabs close
- The push gate asks again for a job log GitHub has not served yet
- A changed e2e test runs under the e2e config in the local test layers
- Walnut-net 0.2.1 dials through the relay first, and logs each path's two ends
- A host whose link keeps dropping reads unstable, never "Connected"
- A message to a host nothing reaches waits for that host, and says so
- An op call whose answer is lost says what is known, and a resend runs it once

## [0.6.31] - 2026-11-11

### Added

- Attach any file in the composer, with per-file progress and retry
- --here-because keeps a run on the named Mac
- The attach button opens a file picker in the Mac app
- Attach any file, with per-file progress and retry
- Recent lists the tasks you opened, newest first, in one flat list
- A session the usage limit stopped continues by itself at the reset

### Fixed

- Changes.compute no longer holds the loop, and a recompute redoes only what changed
- The live draft hears the recorder's own audio, so the final text needs no second pass
- A whole id names that task, and menus are solid
- A search on Recent counts its own rows and says when no opened task matches
- Store the tasks opened lately as the union of every write
- A deleted task leaves Recent at once, never falling back to its read copy
- Keep the empty Recent tab on the bar; no Include Complete chip on a Recent search
- A search on Recent keeps only the hits that show the query
- Search on Recent narrows Recent; recent opens merge with the server before each PUT
- A Recent row with no session opens its details; search finds rows read by id
- Recent holds only a row opened from it; merge its opens at boot
- Dictation ends with the whole recording's words, and a context read back is heard again

## [0.6.30] - 2026-11-10

### Added

- Remote Hosts keeps what you typed, and a host's own settings live with it
- Remote Hosts is one list of machines
- Remote Hosts reads at a glance, and a draft row never replaces a saved host
- The rail's Agenda and Scratchpad open beside any page
- A low disk tells each open task whose own directory is over 5 GB to clear it
- Code blocks get a language label, syntax colors, Copy and Wrap on web and iOS
- What was open last opens next: the tab, the page over an Org chat, the shelves and filters
- The Action Button listens without opening Walnut, and only the person sends
- Permission prompts remember for the session or the project, deny with a note, answer by number keys
- Open owner-scoped dialogs without replacing active work
- Design C with a side bar for Chat, Passwords, Browser control and Settings
- The first page is New task over the task list, with the relay in its header
- The task panel and the draft composer can be hosted in a narrow desktop frame
- A new task with no folder can start in its own task directory
- Network capture, upload by selector, resize, console and muted agent tabs, so the old relay can retire
- Live Browser view in the task, window and tab in every answer, no second sign-in on a site the person has open
- One conversation per agent, the extension hands its Walnut page a browser key, and the third review round's fixes
- A lock reaches every open Walnut page at once, approvals show in Ask, and the second review round's fixes
- One unlock reaches Walnut's web pages too, the panel opens real in about 0.6 s, and the first review round's fixes
- The side panel and popup open as Walnut's regular Ask, with the vault behind a key
- One unlock on this computer reaches its browser extension, and a lock reaches an open popup at once
- Settings offers a generic Add a source before naming Bitwarden
- One switch turns filling and saving on web pages off, for a browser where another password manager fills
- An unlock that holds 48 hours everywhere, a master password hint, Bitwarden as its own source, and the second review round's fixes
- Org chart cards show names only and open for detail
- Walnut as the iPhone's password app
- A plugin's settings and sign-in live on its page in Apps, never in Settings
- Per-host start slots, file-aware placement, and starts that either start or fail with the reason
- A host daemon tells the server whether the process on its gateway socket is in the session
- Show why, the task's goal and last steps, check the asking process, and ask-and-end mode
- Consume signed steps once within their bound context
- A click on a zoomed tall picture fills the width, and the zoom scrolls
- Trigger_list takes name, state, task and limit, and answers one short row per trigger
- Ask here in the Changed tab opens the question card beside the diff passage
- The file page reads like a document: one quiet line, saving always live
- Tree Mode keeps up to three pages side by side, with a sibling page and light composers
- An App brief for the AI only, told once per session and after each compaction
- Talk to Walnut, press the Action Button and speak to the CEO chat
- The Side threads pop-up goes full screen like the session panel
- An outside reminder that owns sign-in holds Walnut's sign-in letters while it runs
- Config ssh_cert_letter false hands the certificate warning to another reminder
- Hide status sentences unless enabled in Display
- Draw Claude Code's error reply as its error row, as the web does
- Organize Home work by pin tier and project
- Home's taskbar keeps minimized sessions one click away

### Fixed

- A signal to the push gate ends its poll sleep too, so its output closes at once
- The notice corner drops a page's room when the page changes, and judges a left column without the room it took itself
- The scrollbar's room is measured once the global stylesheets are in, so code blocks no longer keep 6px of dead space under their track
- A spec that switches to WebKit in a Chromium project starts it without Chromium's --mute-audio
- Launch parity names the extension's own-task-dir start and the permission decisions read, so the ratchet passes
- On a phone, Show more and the Changed tab's compare and review controls are 44px targets with 12px text
- A death found by a send waits for that send's answer
- A store whose data home is gone opens afresh too
- A wiped store opens its fresh handle before it closes the old one
- A wiped data home no longer serves the previous test's SQLite rows
- A stop's ride-along save can be awaited, and status-push tests wait for it
- A turn generation is never reused, so a lane never takes the previous answer
- The leak audit scans the push gate sweep's logs too
- The push gate runs on a hidden ref and sweeps what a killed hook left
- A notice beside a full-screen sheet never folds the kanban to its narrow sections
- The board's sorts and the launch log fields type in steps, and slow expressions are flagged
- The phone's Board button is a 44px target; C68 reads "1 Needs you"
- The Org Threads transcript is stamped before its turn ends, and the reader double has every real method
- The own-share load reads give each blank-headed ps column its own -o
- The iOS job skips TalkRealServerUITests, which drives the home screen and needs a paired server
- Closing Changed raises no ResizeObserver loop error, and its scroll spec follows the chat rule
- A clone of another checkout never takes that checkout's branch as the default
- The comparison button and Hide whitespace are finger-sized on a phone
- A secret's Save that runs keeps its form, and a field put right drops its refusal
- Remote Hosts says each thing once, and a secret's form lands where Add's does
- Remote Hosts answers every press, in WebKit too
- Add host offers both ways in and lands on what it made
- Go there on a Scratchpad still saving opens it in a sheet at phone width
- The Org page settles its default node once the tasks are in, and keeps it
- The scratchpad keeps the first edit after a focus reload, and a stale first read never wins
- The moved scratchpad fills and scrolls, waits in the document, opens only once read
- One scratchpad editor per window; full screen starts beside the side bar
- A plugin's job bundle finds the packages Walnut carries
- The phone's direct send reads a daemon's error answer as no answer, never a death
- A move or switch leaves exactly one live session per task
- The darwin-arm64 daemon tests and the real-ps sweep test run only on a Mac
- Count the size walk in the daemon version hash and list the size notice's send
- Size notices skip org nodes while the org is off, never starve a directory, never block the daemon
- A low disk prunes old build output of tasks still running
- The kept Org page comes back only with a launch's restore; Threads retry waits out the companion's beat
- A phone that leaves while the stream to the Mac still opens is no mark against it either
- A Threads read the companion could not pass on is tried once more before the page says so
- A call the phone cancels is no mark against the Mac
- The Org node page's id no longer hides its view picker's own
- An Org node's chat keeps the screen at the accessibility text sizes
- The queue card shows what the person typed, where each line stands, and pictures as pictures
- The update test makes its DMG with the release build's sized, retried create, so one failed hdiutil create no longer fails a signed app
- Excuse only the lines Walnut recorded writing, not lines in its shape
- Hold only the writer's own lines to the Brief limit
- Idle open tasks lose their build output too; a full disk lets host commands through
- A received message's fold stays shut under a reader near the bottom
- A task settling another's ask reads the user's words there first
- His message outdates a thread's summary until the node rewrites it
- The session header's fit never changes boxes above it inside a ResizeObserver callback
- A stopped question's "Turn interrupted" stays on the question's page
- A task whose session host is gone is never stuck
- A trigger's name is a short label, never its prompt's opening
- Work a target runs after its turn (background jobs, a team, a wakeup) is a sign it took up the work
- A target that took up the work since the ask is never told silent
- A worker handed back while its own subtask or asked reply is at work waits on that task, not its lead
- Time Walnut was not running never counts against a reply deadline
- The Chinese certificate letter sets the user's renew step apart after a colon
- Memory saves take the shared file lock and refuse a stale hash before sending
- Memory_write takes exact-string edits and says whether the file changed
- One -o per blank-headed column, so Linux procps 3.3.10 reads every column
- The CLI's own window reading is lifted to what the session holds
- Judge an answer for the user where it really goes, up to the write
- An answer for the user never wakes a stopped or finished task
- The first page reads its tasks through a committed ref, and the relay panel's placing visibility is listed with main's highlight guard
- The key popover keeps a typed master password across a redraw too, and a guard lists every password field
- The agents switch's line in Browser control says what it does in the state it is in
- The first page hands over only the tab Send was pressed in, keeps a failed handoff's words, keeps task links inside the panel, and saves a todo once
- One holding per tab, a sign-in yes fills once on its site, and network answers judge the request they read
- Network reads keep site rules and masking, the live view and Stop answer only the owner, a fresh sign-in needs the person
- A popup redraw keeps the master password, Secret Key and server address the person typed
- A shrunk list keeps its room in the taker shape the column-aware stack reads
- Ask rows read their latest words from chat history too, an answer counts as read only on interaction, and the fourth review round's fixes
- Side panel hides a parked task by Home's own rule instead of reading the phase
- Side panel Tasks counts Focus as Home does, and a Needs you row says what the task asked
- Unlock to approve follows main's one-line approval rows
- A card folds its new answers behind one line under the summary
- Every card leads with a summary line, and the node is asked for a missing one
- Show a thread only once it has a real reply, one summary per card, and wake a node that left a thread too long
- Every GitHub read of the leak audit is tried again after a failure, so one HTTP 500 on a release asset no longer ends the audit
- The idle notice's new words move the history cache, and the recovery's compaction shares the quiet store
- The inline share clamps as Settings does; the opened row reads calmer
- The context share drops as soon as a compaction lands; a closed idle run stays closed
- Idle compaction never reads as Working, opens to its reason, and Compact context goes out once
- An opened project counts its tasks' asks, not its VP's threads
- Org chart detail ids are one to one with their row keys
- An opened org chart card lists its tasks' asks; narrow layout and empty VP stay names only
- The Minimize dash draws on the header row's middle, with a guard on every window button's icon
- A move for its files sets the repository up in its own window
- Review fixes for the window source
- A [1m] request caches its window apart from the plain model
- The window comes from what Claude Code reported, kept on disk; a name rule is only an estimate
- No text sends anyone to Settings for a plugin any more
- A part's own panels show on its parent's page, and a host row with a port stays remembered
- The turn readout names every model a switched turn ran on
- Typing after a space keeps a note's own bytes too
- Hash the caller-proof modules into the daemon version, run its twin test on Node, and keep the hello capability order the parity test pins
- Judge each asking process by its start time, from the daemon's own record
- A picture pasted from the clipboard is read from the paste's files
- Reads under a task that its record cannot answer go to the Mac
- The Action Button opens Walnut already listening, with no Live Activity
- Keep dense tasks reachable and body drags aligned
- A message an installed App sends through its own op call is named as that App
- An app update or a restart no longer turns the work card off for the stretch
- Ask here never covers its passage, quotes the file's line breaks, and never does nothing
- The selection bar opens its menus away from the words, and fits a narrow column
- Ask here in the Files tab opens its card on every view, at once
- The selection menu's Ask choice and Comment box are normal menus over the conversation
- Typing keeps a note's own bytes even where the editor cannot spell them back; phone tree-head name is a 44 px target
- An overloaded run lets the fixture port go before it stops
- A Playwright run never starts on a machine still overloaded after the wait
- A Playwright run never starts beside a live holder of the fixture port
- Every artifact download has its own step limit, and the binary matrix downloads a release's assets again when the first download hangs or ends without them
- Keep thread asks readable without faded clipping
- The iOS job restarts the simulator service once when xcodebuild still cannot see its booted iPhone, and a leg with no result bundle says so in one line
- A list that fills its column ends above the corner, so no row sits under a notice
- A brief handed to an earlier queued row keeps the order its notes were made in
- The App brief leads a batched line, reaches ACP starts, and moves with its row
- Keep the App brief out of tool results and parses, and tell it on every path
- The Threads jump bar stays when the last card for him is gone
- The session that asked hears the answer
- The chip flow's width types in steps, and the session-state tests know the boot window
- A cold resume past its cache runs on the current prompt; a person is answered first
- The reply language leaves the hints for the prompt; the org notes say one line
- A hint goes out only by its own triggers; the reply language never rides every message
- The Threads jump chip counts every closed thread, and the closed fold says it lists the newest
- Keep the drag preview under the grabbed point
- A full-screen sheet moves its whole left edge past the corner, and a task link keeps its arrow
- The corner stays bottom left in full screen, and an approval opens the task that asked
- A picture's HTML form sets loading before src
- Exact image names keep a pipe; failed pictures recover everywhere
- A pasted or cut image names the exact file it drew
- Images in a note show inline, with click to zoom
- A Talk card leaves the Lock Screen once its take is sent or deleted
- The phone's Threads list and its count come from one rule, and a failed read is never an empty list
- Every GitHub read of the test gate has a time limit, and the log says when it last heard
- The taskbar's card takes pictures, its scrollbar keeps the WebKit look, and Minimize joins the "..." menu
- Pin the folded file so compaction cannot reuse its identity
- The Changed button shows no count badge
- Focus Bar writes hold their rows until answered, and overlapping writes end in one pull
- Pinned thread jumps, a letter's task link on its own line
- A request keeps the fingerprint of the first answer that reached its asker
- A start killed while its CLI boots waits for it, and a machine-killed start recovers by itself
- A write still waiting for a connection when the page goes is sent at once
- Tappable Try Again, chip lines that never cover the rows below
- A sign-in ask is this machine's, a part of an answer keeps its order and direction
- One sign-in is one ask, checked against the live sign-in; an answered ask stays answered
- One notice per answer, cause and expiry; open error cards survive a full feed
- The iOS job waits until xcodebuild lists its booted simulator, and says so when it never does
- A rename or delete holds its moved task rows until the write answers
- Readable letter task row, retry feedback, kept task section folds
- Claude Code's own error reply is its error line, not an answer, and notice lines read at 13px in a darker grey
- A turn that ended on "Prompt is too long" never closes the work, and a restart mid-compaction resends what was owed
- Review round 7 fixes for the Org pages and task details
- The phone's page read of a session its host cannot read answers 503, not 404
- A model with a 1M window reads 1M, and the model list shows each model once
- An import an older build kept as Walnut's is put right, and an import that appears during a long read counts as outside

## [0.6.29] - 2026-11-08

### Fixed

- Sessions Walnut imported because they began outside stay outside, the Walnut and Outside average counts the days that have usage
- Keep git status out of every task row
- Reopening a running session shows its turn once; queue list gets a cross; stranded edits are kept
- Undo keeps the queue steady, Interrupt & send asks first, smaller rough edges from the last review round
- Folders with the same two-part name read apart, an imported terminal session never moves the bill cutoff
- A failed compaction reads as failed live as on reload, and Walnut's notice says only the cause
- Put right an outside look kept for a Walnut session on the server side, and keep the full read repeating while a transcript has not named its entrypoint yet
- Re-list sessions before routing a page, no throttle on the first look, count older transcripts that named no entrypoint
- Walnut's compaction notice says what it asked for, and its row says the size once
- A known session on a Walnut entrypoint is Walnut's even over an older outside look, a re-listed session of another name is not stored twice, label Codex VS Code and Walnut helper
- A Walnut session begun mid-pass is not Outside, SDK server sessions are Walnut's, the older overview honors the bill rule, big first messages keep their entrypoint, plainer bill note

## [0.6.28] - 2026-11-07

### Added

- A task tap opens its conversation, and Org nodes get Threads, Tasks and Brief pages
- By project folds completed tasks once, at the bottom
- Count Claude Code sessions no Walnut session started, and leave out what a cloud bill already covers
- Session.tag_requests also tags Walnut's one-shot calls, its server-side model calls and every ACP engine
- Session.tag_requests tags every model request of a Walnut session with its task id
- Codex sessions use the configured provider and model on every host, and ACP sessions take the task's permission posture
- Count Codex runs no Walnut session started, with their account and a Started by filter
- One decision shows once across a team, and an ask answered above leaves Needs you
- Import from Claude Code points Pi at Claude Code's gateway
- Refuse a Codex model run with no provider override after the subcommand
- A phone browser's sign-in renews itself, with a refresh token only the renewal sees
- Org side bar puts Threads first and opens a node on it
- WALNUT_EPHEMERAL_IDLE_MINUTES sets how long an idle ephemeral server lives
- No cold-cache line: once the cache expired, compacting is the user's call
- A message lined up for after the running turn is held in the queue until the turn ends; iOS fixes from the last review round
- The task panel keeps the tab the user is on
- Glanceable git state on task and session rows, live Changed tab
- Idle compaction at 85% of the session's auto-compaction limit, editable on its row
- Status groups fold by one rule: folded by default, folded again 15 minutes after opening
- Every notice shows in one bottom-left corner; an approval is one card with its buttons
- A phone Follow up names its thread on POST /api/v1/sessions/:id/messages
- Autofill on par with the big password managers, one extension for agents, and agent access the person sets

### Fixed

- Walnut's recovery compaction names itself on its row, and a cached history picks up the new notice
- Say that All also counts an imported usage bill, and that Started by covers Claude Code sessions too
- A reloaded panel never draws Walnut's queued /compact, and the recovery says which compaction runs
- A full outside read that fails between pages falls back too; name more Claude entrypoints; say what Billed directly is
- Walnut's own /compact reads as its notice, never the user's message
- A word that starts with digits is an opaque id, never read for a term in its parts
- An Org thread's Follow up takes pictures, and the inbox guards read the one task opener
- An outside Codex pass stops when its time budget is used up, also when a page took no time
- New ids work on a plain-http address, where crypto.randomUUID does not exist
- The selection bar hangs off the whole passage, and one guard checks the menu in every view
- A full read of a host's outside sessions that a lost link cut off falls back to the normal collection
- A session never stays stuck on "Prompt is too long"
- A usage scan a lost link cut off goes on, and the same request asked again takes it up
- Claude-outside-core is in both daemon hash lists
- The notice corner keeps inside a narrow left column too
- Selection pill boxes open in room the text makes, never over words
- Session panels stay readable in a narrow column
- Session menu Columns row shows numbers, not bars to count
- An isolated server starts, adopts and records no voice process unless WALNUT_STT_AUTO_SETUP=1
- The transcript head cache entry may be absent before it is read
- The notice corner sits next to the sidebar, over the page's left column
- Outside GETs try again past a 5xx for minutes, and a failure with no walnut of its own prints one scenario's logs
- A death this computer's shutdown causes is held as a restart loss, never handed back
- Every corner notice shows its whole message, with its command copyable
- Copy session.tag_requests to replicas
- Read Codex runs by engine capability and each machine once
- A person's picks run one at a time and the newest wins; picking the current engine again withdraws an unanswered pick
- A page with no token asks the renewal path only when its refresh cookie's mark is there
- A newer pick ends an older pick's retries, and a resume keeps the context it never read
- A rule with only a subject pattern reads "Subject matches ..."
- Run subject patterns in a linear-time matcher instead of guessing their cost
- A cut status question never answers the user's next message, and a switch never runs over a turn it could not stop
- Carried context is never lost between switches, and a stuck turn is stopped before the read
- An opaque id is matched whole, never by its letter and digit parts
- A switch with nothing to say runs no turn, survives a restart, and never resumes a broken session
- Fold checkpoints move to format 6 for the local-command echo rule
- A stop finds the recorded CLI gone when its pid now runs another program
- A test server ends with the process it works for, and its snapshot is copy-on-write
- Every mic in a phone task detail is a 44 px box
- An engine switch runs when the picker closes, and every panel follows the task's session
- The running-subtask cap counts on the started task's lead, whoever starts it
- The off-view note's Show runs the locate again on the tab it opens
- The notice corner sits at the bottom on a phone and keeps clear of the page's work
- A remote host's reboot resumes its sessions instead of handing them back first
- The empty filter row a removed chip leaves goes once the user moves on
- Mail and task detail on a phone keep 44 px targets
- A later check of the same conflict keeps Save's warning
- A start the user asked for is not held back by older plain starts the lower cap refuses
- A status fold waits only for a reader of the panel; the panel keeps a tab picked in a project jump
- The host's letter check takes same_ask_reason, as human_inbox_send does
- A message lined up for after the turn is also held during a turn only the session record knows
- The off-view note keeps its sentence whole and dismisses with the shared close icon
- One decision shows once when a task and its subtask ask the same
- A hook turned back on is in the list PATCH /api/hooks answers before it
- A right-click menu and its picker stay open when a live update above the row scrolls its list without moving it
- A status fold judges "on screen" by the panel's list area, and an on-screen heading keeps its place
- A revoke or the hard stop while a call waits starts nothing, and a call can run under one named grant
- An install past a tarball npm does not serve yet runs again, and a failure prints its own logs
- A Stop stays visible in the transcript, several withdrawals undo together, and a held-back queue can be sent in one tap
- New task draws its whole draft in the first frame
- Idle compaction threshold stays 45K under the limit; inline save reads fresh config
- The queue tray keeps the model name readable, shrinks with the keyboard at large text, and its times tick
- Idle compaction off by default (measured cost), stopped compaction hands back
- A Mac on a call is busy, and an owner's queue can lend a lane
- The first review round's findings, from login matching to agents that ask before they buy
- Undo restores a withdrawn message in its place, and the queue tray reads clearly
- A failed keychain probe also pauses secret reads, and the pause ends after six hours
- One gated reader for the keychain items the password manager reads back, registered in the keychain guard
- An Undo tap cannot become a second tap on the row that moves under it; the queue seat shows a tray
- Idle compaction says what it does, and runs before an idle reap
- A right-click menu stays open through a scroll that left its row in place; C50 judges the drag without other workers' frames
- Stop stays within reach while a draft is typed and asks before it sets waiting messages aside
- A message a Stop set aside can be corrected; the queue tray gets edit hints, an undo that says where it returns, and guards against double taps
- A run that waits its turn cleans up after itself and survives a dropped fleet read
- A fleet iOS run waits its turn when every Mac is busy, instead of failing

## [0.6.27] - 2026-11-06

### Added

- One tray for queued messages, a card where Stop landed, no stray stop on a double tap
- Compact big idle sessions before their prompt cache expires
- Stop a running session turn, steer it with a message, and manage the queue
- The phone can stop a running turn and interrupt it with a message
- A connection journal that tells a server restart from a failed node
- The side panel gets Ask, Tasks and Passwords tabs
- Host_exec strict stops at the first failing command and names it
- Agents reach every open tab, use any site without an ask, and Walnut's notes ride as hints
- A session creates a trigger while its Walnut server is away
- A node's turn in an old letter meets the one-place rule too
- Set up in Chrome from Settings, and the extension keeps up with every Walnut update
- A thread that waits on the user buzzes his phone
- Walnut in the browser side panel, asking about the page and acting in a tab the person hands it
- The phone link shows its QR code again
- One place per update, a thread's news never also a letter
- Task_history reads short: compact, limit, since

### Fixed

- A bulk result line's Retry and Undo act on its own job; specs wait out a cold fixture and a leaving lead row
- The interrupt route and Send now follow the boot-policy, agent-parity and picture-box rules
- The reader's own scroll back to the end turns following on again
- Daemon.pid is written before daemon.port
- Probe cli-fast's call path in a clean env, place import.meta.url reads by the source map
- Cli-fast runs strict, keeps import.meta.url to Walnut's files, and is probed before it lands
- Bun builds dist/cli-fast.js as CommonJS with bytecode, a data command starts ~5-10x faster
- The Browser extension pane is a settings section; the Devices spec counts only DELETEs
- The side panel's task reply is Walnut's answer box
- A retry of an interrupting send stops the turn only once
- A Connect press only dials; the host is read once on its new link
- The session host change meets its ratchets
- A fleet run reports when it started, not its simulator's UDID
- One place per update is prompt text only, no server refusal
- The shipped skill, the launch parity list and the hints e2e follow the object-context hint
- A fleet run says when it ran (UTC), how long, and its counts
- A strict pipe that failed in its middle is named by its line and member
- An edit to ios-fleet-test.sh during a run no longer breaks the run
- A fleet iOS run goes to the other Macs first, and to this Walnut's own Mac only when none can take it
- Side panel tabs keep a held selection, follow the page, hide a shown password
- A deploy no longer asks again to allow Walnut on the local network
- The extension setup's clipboard write hears its child's stdin
- A phone stays signed in past Safari's 7-day storage rule
- The compiled walnut file starts from bytecode, so every walnut call is ~650 ms faster
- The daemon version hash lists host-exec-clt.ts too
- A host that connects is read once, so its Overview card and profile fill without a press
- Host_exec at its cap waits for a slot instead of refusing, and a burst can no longer pass the cap
- A Mac without the Command Line Tools never shows their install dialog from host_exec
- A machine away during a relay change is still dialled on the relay it was last seen on
- Uninstall forgets the restart mark, so walnut calls stop waiting 45 s for a daemon that never comes
- An offline host network machine says it is offline, not that its daemon failed
- A shown value stays until a newer one comes, across failures, restarts and reopens
- One npm install at a time per Walnut, the server's own and `walnut update`'s
- A line the CLI read but never answered is sent again once
- A phone pan up while a reply streams stays where the finger left it
- Parenthesized noun lists and enumeration-comma items are not several things
- A thread's buzz holds the absence only while it still waits on him
- A decision is a thread's only through a task that one open thread went to
- A field rehearsal skips a start point published after its release was picked, and a failed field-start runs nothing
- The Org page's own overlays are solid, never see-through
- A host card never shows a bare "?": sessions from Walnut's records, every unknown says why

## [0.6.26] - 2026-11-05

### Added

- Drop the switch that refused Main's or a VP's 4th command
- Walnut agents use the person's own browser through the Walnut extension
- Deploys queue up, so production restarts at most once per 10 minutes
- A Walnut browser extension for Chrome and Firefox that fills and saves logins
- Phones & Cloud is four tabs, each saying what its way is
- A recovery code for a forgotten master password; agent choice moves to Settings
- Pin a thread to the top of the Threads view
- The Org page opens the org settings in place, beside Org chart
- Every box that writes to an AI takes pictures
- Remind Main and the VPs to hand work on instead of refusing their 4th command
- Tree Mode splits into two halves with a path bar, so the question and the level it was asked in sit side by side
- One daemon keeps each Walnut's settings apart
- Agents use vault items with the person's approval
- An encrypted password vault with its own app in Walnut
- A task keeps the user's unanswered messages, and Threads read their answers right
- Host_exec that stays out of the way, host_copy, Install that works on every host, and joined hosts that update their daemon
- One letter when macOS blocks Walnut from the local network
- Run the iOS tests on a Mac of the fleet from any task
- The Overview shows what it read at once and reads on a click
- A new import project goes under the VP of the other import projects
- The invite line names the coding agents and installs none
- Each Mac app release updates the previous release's app to itself first, and a failed automatic download is tried again
- The Org list puts a node's Threads first and counts them once, with no "N open"
- Talk to CEO opens a box for your words first, New task focuses the draft
- Main and a VP never do the work themselves: a 3-command rule Walnut enforces
- A click on a task row's project name shows every task of that project
- Only link tags fold into the header's tags control; Trigger, Worker and Leader stay on the row
- One phone link with its code inside, plugin-named tunnels, login retry for host uploads
- Talk to CEO opens a box first and sends only on Send
- A running Walnut installs a new release itself and restarts when the person is away
- A Thread waiting on the user is the CEO's or a VP's Needs you, and threads come first
- An Ask here answer is filed only from its own tag, with the thread id and name the question was sent with
- The full-screen sheet grows outward while its review column is open, so the chat keeps its width
- A kept row open beside the page wears a light tint, never a frame
- To read sits under Needs you, and every Needs you row says what to do with it
- To read sits under Needs you; every Needs you row says what to do with it
- The task and session menu, redesigned: Open, Window and Panels lead; Pin to, Dates and plugin fields are each their own group
- A tunnel plugin installs its tool by itself; found hosts wait for a yes
- A task with a locked session panel hangs under its row too, with an eye or a lock
- Every box that writes to an AI takes pictures
- Ask here asks in the view on screen, a reply is only its own question's answer, and long conversations get named outline sections
- VPs start by themselves in the background; Settings → Org turns the whole org off
- On the Mac too, as Needs you and a system notification
- Every email item offers Talk to CEO and New task
- Store plugins keep themselves current
- Waiting is only a real wait; a task's own build is Working; a finished result is To read
- `walnut approve` pauses a script until a person approves, with a tap or Face ID / Touch ID
- The Org page's Pinned is Home's Watching, one list
- The session header folds every label into one control and shows no run status
- Snooze a thread until a time, with a Snoozed section on Threads
- A task opens on Home from anywhere; the separate task page is gone
- POST /api/v1/content/draft gives a client without the web bundle the New task draft words
- Every pane split on the Org page drags
- Snooze until is the task menu's first row, with Watch beside it
- Every plugin's content offers Talk to CEO and New task, and nothing turns it into a task on its own
- The Org side bar opens into the full-screen sheet instead of widening
- Walnut for Windows, a one-file installer and its own window

### Fixed

- Every rehearsal's daemon outlives a restart of its server, as a person's does
- A self-call made for a caller elsewhere never counts as a private link
- A host network machine that comes back is dialled again
- A walnut call the exiting daemon never read waits for the next one
- A daemon update that meets a call in flight is asked again, not dropped
- A landing in Tree Mode measures under the gutter the reader will see
- A transcript is read whole once, not after every restart, eviction or 4 MB
- Gcc and dtach set up on a new host never read "Installing Claude Code"
- A walnut call the server still has when its daemon stops gets an answer
- A walnut call from outside any session is its host's one Walnut's, so it is answered while the Mac sleeps
- A session that starts while every panel is pinned keeps its column
- A read cut off by a server restart goes to the next server run
- A UI run writes its xctestrun with a python whose plistlib loads
- A walnut call's waiting notices go only to a terminal
- A fleet run's results come back through a Walnut restart
- A walnut call made while its host's daemon is replaced waits for the next one
- Every surface the user reads says the task's status in user-status words, never a phase name
- The CEO's and a VP's red is its threads, "0 threads" in grey, never its own Needs you
- The endpoint wait never continues over a Stop, a closed task, a stopped team or a message sent during its probe
- A turn that could not reach the model endpoint waits on its machine and continues by itself
- A session's own work after its turn is one list, and its drain is no turn end
- A host that does not answer is a 503 or 504, never a 500 card
- The companion's tunnel daemon is replaced by a newer build; extracted daemon harnesses name every free name they read
- A list drawn under a resting pointer holds still once its rows arrive
- Install moves an npm launcher aside so the native claude takes its place
- A fleet iOS run whose Mac replaced its daemon reads its result from the job's log
- A walnut call on a host waits out a server restart and a broken link, and runs once
- The terminal status pill shows words, never a raw status code
- The first launch waits for the server that owns the data dir, and nothing runs on in an ended login session
- Handlers act on the task list the page committed, never an interrupted render's
- A hidden Home chat's question marks no longer paint on the open page's title in WebKit
- A markdown table in a narrow pane keeps its words whole and scrolls sideways
- A scanned .dmg that will not detach is tried again, and then a warning, never a skip
- A compaction keeps the user's recent words, answered ones too, and task_history pages back
- A card's Decide line opens the Page at its choice; panel-count specs take turns
- Two Walnuts of different builds no longer swap a shared daemon back and forth
- The build clone reuses the checkout's built SQLite, so a deploy never downloads it again
- The question map's list grows to its longest title, so its rows show more
- Closing the split's left half in Safari keeps the typing focus, moving it to the composer that stays
- A compaction's summary or a hook's context starts no turn, so a question answered after a compaction keeps its answer
- A commit that adds a dependency installs its lockfile in the build clone
- A message's sender is its task's title, and a fork names its source once
- A daemon update waits for the host_exec runs on its host
- A fleet iOS run keeps its results when they cannot be fetched, and names its Xcode
- A letter note's answer read from its letter replaces the chat words an older Walnut kept
- A letter's thread holds only its own news, never a line naming another letter
- The Talk to CEO box is an AnswerBox with a kept draft and pictures
- The rehearsal's system PATH without Node is made again in the same dir on macOS 26
- One machine is one choice in every host picker
- A coding agent is installed only when the user asks
- The VP's command count resets only at a turn's end, and a long message has a free way out
- A Walnut notification's title attribute is its folded title
- A live install waits for one already running, and a server that cannot restart offers no Restart
- A drop between two rows lands on the row, never on the tier around them
- Every lifecycle wait has a deadline and a clear result
- A deploy's few seconds of failed recovery-status reads show no "Recovery status unavailable"
- A stop the host did not confirm is sent again instead of blocking the session for good
- Background checks on a Mac never read a keychain secret
- Launch parity no longer lists the outline's turn-titles route, which is gone
- The outline lists only what the user marked, never one row per message
- Found hosts read the server role, and the ssh sweep test waits for a yes
- A session's close never leaves the user's own items behind a clean Done
- The folder and project menus' pickers keep the row they were opened on
- A server restart's few seconds of failing host reads show no Reconnecting banner
- A deploy that changes the daemon keeps remote sessions connected
- The outline's turn-titles call is listed in the launch parity map
- A status section row renames from its title like every task row
- A task parked on its own build wears Working in its header and rows, never the hourglass
- Instruction notices are few and small, and a note in front of the user's words never hides them
- A session menu's Details opens the task even before Home's list has it
- No white scrollbar bar under code blocks in the Mac app
- A folded Needs you still shows its waiting approvals
- A closed overlay never takes Escape from the Ask drawer
- A machine found in ~/.ssh/config that joined is listed once
- The compiler hint names the host's own package manager
- The join waits for the network key while a new machine downloads walnut-net
- A new machine joins while the release cannot, with the preview build from npm
- The task kebab draws its three dots, so its ink sits on the header's line in every font
- The approval sheet stacks its buttons at accessibility text sizes, names Face ID or Touch ID by device, and the simulator signs with its software key
- A session writes its user_kind reason in the user's language
- Bring main's guard tests and two browser specs back to green
- One transfer for every reader of the same remote file at the same stat
- Mail receipts and thread titles in the user's language; a rewrite example is the line itself
- A path or a letter in agent text opens from every surface; proof stays where the user reads the result
- Take another change's unfinished link hunks back out of the task-page commit
- The Chat tab comes back to the chat you left
- A pipe whose reader went away never ends the daemon or the server
- Setup waits for the console without printing each refused try
- Walnut installs into Programs\walnut, and a replaced page load is no error
- The app installs with Bun from its own bun.lock
- A model catalog fetched before the settings read names the settings model too
- A waiting row's wait sentence is a third line under its title
- Every word Walnut writes onto a letter follows the user's language
- Default runs the user's settings model, never the CLI's own default
- A dev box found in ~/.ssh/config is dialled when Walnut runs a server there
- A read-only test server declares itself a probe so the daemon never hands it the real Walnut's calls
- A VP's task is titled "<project> VP", and open ones an older build named "<project> lead" are renamed
- Full screen is the pop-up sheet with margins again, not the whole window
- A transcript sweep the throttle turns away runs when its window ends
- A full pull that did not show an item never deletes its task
- A locate keeps its task shown wherever it lands or moves
- An open letter of a kind Walnut sends no more settles itself
- Other sessions' mail is never a person's word, and a progress-only turn end no longer settles requests
- One letter per question, triggers stop with their task, Walnut writes in the user's language, every turn is corrected
- A Windows PC joined over SSH keeps Walnut running after the SSH session ends
- End terminal says so when it could not confirm the terminal ended

## [0.6.25] - 2026-11-04

### Added

- Every view comes back as it was left, plugin pages included
- A Windows PC joins with one PowerShell line, and Walnut runs there in WSL
- Stop a whole project syncing, a batch at a time
- Send waits for the words still being spoken, then sends them once
- Send waits for the dictation in every composer with a mic
- One header and a side bar beside the chat; Changed, Files, Terminal and Board move into the kebab
- A tapped path opens from the host that has it, through GET /api/v1/files/locate
- The Task / Brief / Threads panel closes and comes back per node; the Threads tab shows a dot for news
- A clickable org, under-the-hood scenes and a small Walnut demo
- A minimal dark landing page with one download button
- Task providers lives under Tasks, a task plugin's page links to its rules, and the AI rule field fits its text
- Walnut-net 0.2.0 downloads are checked against pinned checksums
- Task providers cards: the plugin's tile and a one-line summary, hard rules as chips, a clear pass or fail line
- A turn-end ask names which of the user's kinds it is, or reads as a report to the lead
- The host network picks its relay, and a Mac with no companion takes machines in itself
- Import a Claude Code setup into pi, and name an ACP session's walnut calls
- A question reaches the user only when it is theirs, and Walnut checks the line
- The Threads view shows a thread only when it has something for the user; his reply sends it out at once
- Settings > Task providers: per-provider hard rules and an AI rule, pass or fail with a reason
- Walnut-net downloads are checked against pinned checksums
- The host network: a machine with no SSH joins with one link
- A focus block turns on Mac Do Not Disturb until it ends, quiet hides every rail badge, and Focus or Rest is the person's choice
- Local choice on create and Make local in the task menu for projects that sync
- Every doc comment shows in every view of the doc, the HTML preview included
- The task board's status sections: Watching on top, Waiting / snoozed by soonest wake
- A Threads card never echoes the user's own unanswered message back to him
- Google Docs style comments on a document, kept in a sidecar the AI replies and resolves in
- Private tasks stay local in projects that sync to an outside service
- A thread with nothing new for the user is pending and out of sight; one reply to two threads stays off both cards
- The session command is Ask Walnut, the hub is Tell Main
- Quote and Comment stay marked on the passage and wait above the composer; selection matches go with the selection
- Name the two chat commands by what answers: Quick Answer and Ask Claude Code
- A Threads card holds only its summary and what the user has not seen

### Fixed

- The service install asks a busy daemon again instead of giving up
- Step 2 of a join says why the login service did not install
- Stop dtach masters by their recorded pid, never by command-line pattern
- The last host network error that said this Mac says this machine
- The view-state scan judges a state by how it is set, not by its name
- Rewriting an unchanged kept view writes nothing, so two panels stop ping-ponging
- Each tab keeps its own view, and plugin drafts get walnut.ui.useDraft
- The Windows join checks the Ubuntu download without Get-FileHash
- Rehearsals pick their server port below the OS's ephemeral range
- The Windows join job builds its daemon, and net errors name this machine
- A session whose Walnut is on another machine runs that Walnut's walnut
- Stop processes by the pid that was recorded, never by name, pattern or port
- A build as root no longer reads Bun's /$bunfs/root/ paths as its own
- A doc comment's hover card follows pointer events, not mousemove
- The Windows join job builds its Linux file outside /root
- The Windows join job checks out the tree with LF endings
- The iOS locate route asks the server role, not CLOUD_MODE
- The companion applies security updates from the latest release daily and reboots when one needs it
- Full screen fills the page area edge to edge, not a bigger pop-up
- A highlight taken away repaints its words in WebKit, so a given-up comment leaves no paint
- A machine that joins keeps another Walnut's walnut command
- A daemon whose /tmp files were swept is found and handed over
- A person's own NEED_ACTION reads Needs you; browser specs follow the real-ask rule
- A new Mac finishes the join, and an older Walnut there is left alone
- A test run's request never starts a focus block, quiets the user or touches the Mac
- A doc comment opens in place, under its words, and the side column is gone
- Full screen is one state of the tab, so leaving it anywhere leaves it everywhere
- Only a test run's window takes its toggle's answer, and it rereads its view on a published change
- A test run's Quiet toggle stays in its own copy, so it never silences the user
- SentBy "person" holds only for text a person typed; every other line is framed at the send
- Only a real ask reaches Needs you, and every agent task read carries the live status
- A task under a new project name makes a Local project
- A machine that joins shows Connected at once, and connects by itself
- Ask for the reply language in the user's own language
- A host's name no longer starts or stops its Walnut server; a guard keeps every toggle label to its own words
- A live turn's fold keeps the saved fold's form, so nothing in it moves when the turn is saved
- A returned call last in the stream gives way to its saved twin, so a mid-turn save never shows it twice
- Pi's ACP adapter runs on the Node that runs pi, not on a second boot of the walnut file
- A clicked path missing on the session's host opens from the host that has it
- A task provider's name no longer flips its sync check; only the switch does
- Search keys follow the hit by path, wait out IME and the first answer, and every close drops a late answer
- The sidebar search starts at the top, a click previews a hit and keeps the search, a double click opens and closes it
- A message written during the turn-end status question waits for it instead of killing the worker
- A pi session starts without a version probe and reports its status at the turn end
- No script picks a simulator for its user; one helper resolves it
- A task kept out of a service asks the user nothing; Main hears one line a day
- A refresh restates only the Needs you items that changed since the node last told the user
- What the reader opened stays open across every handover, and a subagent's reader is one timeline
- The AI rule field is seven lines tall, so Walnut's default rule shows whole
- A Question stack push or pop stays under 50 ms of main thread (C38)
- A host whose daemon is the compiled walnut file runs ACP engines again
- A project move never sends a task to a new service
- A bulk result with failures keeps its Retry and Undo working for as long as its line shows, and the specs press a group tool through one hover-and-click
- On a slow phone a drawer opened before the page is drawn stays open, and its Ask Walnut goes home
- A history read asked after a turn boundary never joins a read started before it, and an opened notice stays open when its persisted row lands
- A streamed reply's own elements become its saved row, so a script block never reloads
- A settled reply keeps its cards and islands in the web views that drew them
- The no-end-time warning names only today's shortcut
- One painter for the selected-word echo, which ends when the user leaves the selection
- Do Not Disturb always ends with the block, and a test copy never touches the Mac
- A repository no host can clone moves from its bundle, and a shell edit counts as the session's change
- The host network survives bad configs, version bumps and a cut-short Remove
- A service only the user reads is never checked; kept tasks share one letter
- The tree snapshot never trusts a folder changed in the clock step its scan began in, so a note added right after a scan shows on a coarse clock
- The column follows a turn's last text when it lands in the commit that ends the turn
- A reply looks the same while it streams and after its persisted row replaces it
- Every notes search result leads with its file name and folder, and a file name's words find it
- The private tasks fields pass their ratchets: rows redraw on a sync hold, the draft's Sync chip maps to task_create local, the words stay on the Mac, and the skill is regenerated
- The Inbox shows only the inbox; the per-project strip is gone
- A message whose reply was not found, sent before that reply covered a later one, joins its exchange
- A pending thread is never called back by the tidy reminder; quiet threads are asked once and last
- A Threads card leaves out messages older than its last answer, and a click on a link in an answer stays a link

## [0.6.24] - 2026-11-03

### Added

- Import per-day token sums from a provider bill for the days before Walnut kept usage
- Import per-day token sums from a provider bill for the days before Walnut kept usage
- A task on a host the user registered uses the other hosts without a letter
- A picture reaches the model in the message, not as a path to Read
- Every page keeps the view it was left on
- Every new Claude Code session gets the Walnut tools, served by its own host daemon
- Threads read as conversations, and each node keeps them clean itself
- Comment beside Quote in the selection pill, and quotes stack in the composer until one send
- A picked task, note or file is drawn as a pill in the input bar, not as raw @[text]
- Styles and e2e scaffolding for the task-pill overlay (early draft)
- Draw @ task references as pills over the textarea (early draft)
- No chat shows a message hint; the raw view still does
- A compact brief_read for refreshes
- Session mode is a normal Claude Code session in Walnut
- Every hint says whose words it is, Walnut's built-in or the user's own
- A VP and Main follow the tasks that report to them the way a leader follows its workers
- ACP engines list Walnut's core tools, with tool_help and tool_call for the rest
- The tasks a reply is about, as live pills under Main's and a lead's replies
- Costs by week and month, by token type and kind of work, kept after transcripts go
- Switch the music during a block, and preview each choice first
- The model picker no longer has a custom model ID box
- The speed readout shows each subagent's model as its own row
- The Threads follow-up is an AnswerBox, and a reply names the task it made
- One answer box, cards for every Needs you, and the tasks a reply is about
- Pin tasks to an Org node, and a resizable Task rail
- Walnut AI with tools, and follow-ups in the Raycast chat
- A host offers MCP servers to other hosts only, and a tool's images land in the calling task's directory
- A task calls another host's MCP servers and web services, under the grant host_exec uses
- Threads view of the user's own requests to Main and the leads
- The overview charts each host's last 12 hours, and shows disk as a ring
- Message a found task, search notes and send a copied screenshot from Raycast
- A finished task's directory sheds its clean clones and build output after a day
- Pick the block's length and music at Start, Spotify included
- Pick the block's length and music at Start, Spotify included
- The Remote Hosts overview becomes a fleet dashboard with a diagram
- The wait is a header chip, fullscreen keeps side margins, and the folded question bar is a slim band
- Reach Walnut from a key anywhere on the Mac: Spotlight, Raycast and Alfred
- A task's status words are asked at its turn end, and status moves go up one level
- Run a command on another host under the user's grant, and secrets the Mac copies to the hosts the user picks
- A host's daemon starts again after a reboot, with no root
- Off until you press Start; a run is one block and its break, then it asks once
- The Brief is a document its node keeps current, and org nodes never read Needs you

### Fixed

- A person's own message carries the reply language, and his turn is corrected at its first wrong-language line
- A session process that exits with an error makes one card, not a second from its log line
- The sidebar holds the row being read when the smart group lands above it, in WebKit too
- The unsubscribe checklist hears Escape in WebKit; clipboard checks run in both engines
- The grouped inbox says an account stopped syncing, and a cold open reads each page once
- The add-account dialog never takes the caret back from a field being typed in
- A CLI that exited but is not reaped yet no longer holds its session
- A completed task's worker is stopped again after its turn-end summary
- Completing a task stops its ACP worker, and a long ACP turn is not cleared as stuck
- The keyword ask shows its answer: a script sits between the Script Filter and the Conditional
- Drop two stale routing tests a mis-staged commit brought back; name the import label through the host-label hook
- A test run's drafts stay in its own copy, and a cleared box reaches the server at once
- The JS twin sets its picture folders beside DAEMON_DIR, not in the send section
- The Comment box is an AnswerBox whose words are kept as a draft, and the pill memo keys on the query span's numbers
- The Walnut MCP mount asks isCompanion(), not raw CLOUD_MODE
- Answer only on the leader, read through role()
- A reload opens straight on the kept node and view, with no Task flash first
- The companion's Caddy admin API is root and caddy only, and Walnut listens on loopback
- The cloud companion gets its own hard-stop switch in Tasks using other hosts
- The mic no longer stalls mid-speech in the Mac app: echo cancellation is off for dictation
- A thread's older messages read their answers from the node's live session
- Fold checkpoint format 5, for the fold that reads the rotation's carry line
- Host bounds use plain aliases, not double-quoted ones the macOS SQLite refuses
- The wait chip reads the park through one helper, listed in the task-state ratchet
- A session on an already titled task is named after the task
- Task_list with a scope and no calling task follows the filters given
- A status question is answered in text, never with tools
- A write made as the page hides or leaves is sent with keepalive, at once
- An ACP engine's persona carries the skills index in a short form
- The Focus music screen keeps an action's answer until the block moves on
- A hand-back with no report asks in the words its last turn ended with
- Needs Action holds only live session asks, never letters
- A cron replay whose watcher starts behind the new process reads nothing, not a cut stream
- Review fixes for the wait-on-user and lead-ask commits
- An ask a worker addresses to its lead reads Waiting on its lead, not Needs you
- A wait on the user reads Needs you, a wait on a lead or task reads Waiting on it
- A trigger parks its task only with wait:true, and a turn that answered the user reports needs-you
- A data home with no git repo is unpaired, not a failed bridge push
- A model the local server lacks falls back to the main model
- An unknown argument key names its usual other name or the keys the op takes
- Regenerate the walnut skill's ops table, org_pin in registry order
- Threads card keeps a CJK title readable and reads the state names from the shared map
- Host_mcp_list and host_exec_stop wait for their route's answer, not the 10 s default
- A few seconds of stalled audio no longer says the mic is dead
- A not-started Board card has Start, and a narrowed Board closes its chat
- A folded host row is one line again, and the card holds still
- A wait a worker told its lead itself is not news in the lead's team note
- A stream file rotates while its session has a loop armed, carrying the loop
- A task whose status the server derives just after a park leaves Working
- A compiled Mac sets up a host's boot start from the walnut file in its daemon slot
- A word typed short anywhere in the query finds the title that names it in full
- A short word in a binary counts only where the bytes around it read as words
- A turn that answered the user never parks its task from its report
- The Spotlight task picker lists open tasks, and intents keep a path's query
- A machine stop in a lead's team note waits for the hour like the rest
- The pattern-kill guard passes the signal-call ratchet
- Needs you has its own heading, and every section heading wears its mark
- The host_exec redaction test builds its key armour from parts, and the scan allowlists it
- Keep only the build in use and the one before it in the host file cache
- A CLI's command line carries file paths, and a kill by name pattern is refused
- Host_exec runs under the session shell rule, not a bare $SHELL
- The iOS UI leg leaves the classes that drive the home screen to the Mac
- The notes in front of a person's message join the fold before it
- Home task sections are each task's user status, and a Waiting row says why

## [0.6.23] - 2026-11-02

### Added

- One cost chart with a Break down by switch, every breakdown per day
- The @ picker searches every source in All, and each reference tells the model what it is
- One link to every host; features ask link(host) instead of building an SSH target
- Every host says what it can do, and a task asks for a host by it
- A task named beside its written title reads its name once
- A task named beside its written title reads its name once
- While the user is away from Main's or a lead's chat, what needs him goes to his inbox in one thread; a report on request
- The Task rail beside the chat, every ask answered in its row
- Every hint reads in plain words, visible by default, never raw on any screen
- Ask here cards show the whole thread with their own scroll, and a vertical bar folds the pane
- A fleet overview of every host, for the user and for agents
- Every task a chat names reads as its name and opens the task
- Every task a chat names reads as its name, with its live status
- A named host never takes another machine's folder; a move clears what it carried from a shared checkout; placement weights
- Plugin jobs run under the daemon of the machine the user picks
- Keep Home and Org layout on disk, lock Org side panels, never reopen an overlay on load
- A Needs you ask comes in a one-click shape: yes or no, a choice, or text
- Each task writes what it waits on next; its lead, VP, Main or a person may change it
- @ sources: plugin-declared picker sources with tabs, Notes and Mail built in, source refs as reference cards
- One place decides a task's user state; snooze is first class; one set of names
- The home task panel opens Flat, its status sections in two-line rows
- Move a task to another host in one step, and place first starts by load
- The Brief is the AI's letter alone, in three sections; the Task view holds the asks
- A session whose working folder is gone continues in its task's directory

### Fixed

- Every take marker names the rows its line carries, and the fold spec reports its takes
- A fold line counts its messages and names no one
- The replica config copy names the capability tags, and an unknown capability reads by name
- A binary matrix row whose artifact download fails downloads once more
- Three regressions the browser and unit suites caught
- The continue-in-new-folder session action is mapped in the launch parity table
- A reply to the user in the wrong language is named on the next message, and every line he saw is judged
- A lead's team note comes at most hourly and carries no worker progress
- Fleet host cards sit in their Settings group as rows do, not as a card inside a card
- A newer push cancels only a pull request's run, so main gets a finished CI verdict again
- The fleet view asks server-role who it is, and its twin test keeps the exec guard on PATH
- The iOS job skips only the timed methods of TasksDerivedPerfTests
- History cache sees a transcript that grew under the same mtime
- The iOS job leaves wall-clock perf gates and fixture-server UI classes to the Mac
- The @ picker draws its row icons with the app's icons, not emoji
- The iOS job logs its failed tests instead of uploading its result bundle
- Opening a question's card moves the timeline once, and a grown card reveals itself after its glide
- The PDF page count shows the page a link jumped to
- A task row click hands on the task as it is now
- A turn that folds never moves a reader scrolled up into it
- Buffered reply text lands before the next event, in its own turn
- A page of older turns re-renders only its new rows
- A test run's preference writes stay in its own copy, never the user's files
- The tail window keeps raw bytes, a budget, and only for the sweep; a missing transcript is looked for once a minute
- The tail window of a big transcript is kept and grown by what was appended
- An opened send lists every task it reached, each a link to the task
- A transcript is stat-ed where it is, so a symlinked cwd no longer re-reads the whole file each minute
- A step made while the link is down shows on its return, and only an install keeps going without it
- The host's read copy goes gzipped, a tenth of the bytes on the shared SSH link
- A host server upgrade reads as the upload it is, and sends its build a few chunks at a time
- Home never draws nothing: with nothing else open, the task panel shows
- Tools call refuses a word after its arguments instead of dropping it
- GET /hosts/load is answered again: the move router mounts before the fleet view's /hosts/:host
- Fleet cards say phases in words, count short spans in minutes, and give reboot advice that works
- A send the server named never hides in "Ran a command" on the phone, and each name on a fold line keeps its own word
- The home panel's status sections read the shared user status, snooze included
- The jobs status read answers 200 where a plugin has no jobs
- A connected phone previews an HTML file whole, frames included
- A call still running folds with the steps before it, and the phone reads a send's tasks from the transcript
- Published installs patch codex-acp too; a restore load that does not answer fails the start
- A Codex session survives a Stop and a failed reload, and a fast send is never sent twice
- A sent message sits where Claude Code took it, on every chat surface
- The chat under the Task or Brief panel starts below its own header
- A move never removes what the target held, holds messages instead of waiting, and shows a refusal
- A snoozed ask reads its task's own start date; a sub-item that changes section is its own item
- A send delivered on its target's own host names its task, and a title never reads as the line's separator
- Refuse a walnut call the shell would cut a "$" amount from
- One fold rule: a failed call and the runtime's lines fold with the steps around them
- A read whose link dropped under it goes to the Mac once more
- A handed-on answer goes straight to the original asker; the reply language rides every org turn
- An instruction change is never longer than its block, and lines past USER.md's budget are never told as removed
- A trigger on the user's own ask never reads as an outside watch
- A task parks as Waiting only for a wait outside Walnut and the user
- The session menu gets back the rows its regroup dropped
- The real-CLI startup failure check runs in the live tier
- A host's SSH master says why it ended
- The quick tier is green on a busy Mac again, each cause fixed as a class
- The Mac app's DMG is sized with room and its create is retried

## [0.6.22] - 2026-11-01

### Added

- The lines the CLI put into a conversation show on the phone, one closed row each
- An html-app block draws its layout while it streams and becomes the running block in place
- An engine switch stays on the task's host, which runs ACP engines itself
- An html-app block shows its layout while it streams, runs its script only once complete
- What Walnut added to a message is hidden by default, shown from the bubble's long press
- Home task panel status sections, Watch, per-project counts and an Inbox project strip, with three layouts on trial
- Switch a task's engine inside the task, and resume the earlier session on the way back
- What Walnut added to a message is hidden by default, one click away, and each hint has its switch
- Plugins first in two groups, built-in apps last with their own switch
- A leak scan hit stops the release before npm and the GitHub Release

### Fixed

- No job runs on the retired macos-14 image; the port hold releases after the lane stops
- A finished reply waits for its question however slow history is
- A reply never shows without its question while a session opens
- The server holds its port before its daemon starts, so the daemon never takes it
- Main is green again: a request on its way is never settled, the new twin test runs on Node
- Drop the second copy of claudeCodeNotNeeded in local-daemon.ts
- Instruction notices send only what changed, and one session gets one notice once
- Test connection works for Ollama, no Claude Code warnings or seeded Claude defaults on a local setup
- A resumed CLI that fails at startup reads as exit 1 with its own message
- A fork's compaction no longer marks rules, place and hints told to the main conversation
- Two quick-tier tests red on macOS read what bun and SQLite actually do
- News reaches the user once: a lead that passed a result to Main says one line
- A session is titled from the person's words, never from the blocks Walnut put around them
- The send-boot-wait twins test gives its daemons a guarded PATH
- A start still spawning past the response budget says starting
- The AI title replaces a session title the launch made from the first message
- Background model calls wait for a busy local model server, and a timeout is named as one
- An ACP turn's result carries its answer; a worker leaves with its adapter; a loaded session follows the engine default model
- A data home inside another git repository gets a repository of its own
- The browser suite is green on a clean checkout, and three product errors it hid are fixed
- A second user on one machine gets their own runtime dir instead of a crash at start
- Test connection works for Ollama, no Claude Code warnings or seeded Claude defaults on a local setup
- The send-boot-wait twins test runs its JS twin on Node with the others
- Test connection works for Ollama, no Claude Code warnings or seeded Claude defaults on a local setup
- A remote host gets the real ACP worker, never the compiled file's placeholder
- A single tier keeps its rows when a status section under it opens
- A host chip click hands focus back to the search box, so typing and Escape still work in WebKit
- Status sections stay on when the Status pick adds Waiting or Complete to Open, and older completed tasks stay reachable under a chip
- The staged plugin source carries package.json and packages/
- A CLI still booting is not reaped for reading its first line late
- A second user on one machine gets their own runtime dir instead of a crash at start
- The quick and e2e reds the last bulk push left, and a draft scan that a comment blinded
- External plugins bundle against the deployed commit's own source
- Host chips wrap instead of scrolling so every chip takes a click; the picker picks folder and host only
- An open question over its review row never scrolls the timeline
- A worker lands in its lead's project unless the user named another
- Answered requests, overdue hand-ons, wake sources, re-checks, and the bug-fix rule
- A Mac that slept is not five minutes into an outage; agents' refused offline writes stop lettering the user
- An open question over its review row is most of the box tall
- Ask here review cards are one row until opened, open readable, and go full screen in place
- A status note's card reads "Status changed"
- Rendered bodies keep their DOM across re-renders; the Org chat stops flashing
- A person's words behind a status note keep their bubble, on the web and iOS
- One report per result, settled decision letters, reply language for leads, quoted approval
- A reconnect to the same daemon sends what it lacks, after the link's first seconds
- A session whose result saw its CLI gone stays stopped; two flaky tests made deterministic
- A publish that fails outside Walnut is tried again before the release stops

## [0.6.21] - 2026-10-31

### Added

- Run Walnut on your own models: with Ollama (or LM Studio/vLLM) as the AI provider and
  OpenCode, Goose, Codex or a custom ACP agent as the engine, nothing asks for Claude Code;
  watchers and AI task search run on your model, and every engine gets Walnut's session
  instructions ([Getting Started](GETTING_STARTED.md#path-d-models-on-your-own-machine-ollama-lm-studio-vllm)).

### Changed

- Walnut installs as one compiled file with everything inside, for macOS and for Linux with
  glibc or musl (Alpine, with `apk add libstdc++ libgcc`), on arm64 and x64. The one-line `install.sh`, Homebrew and the Mac app
  install it with nothing else on the machine, not even Node. `npm install -g open-walnut`
  installs a small launcher and only the package built for your machine
  (`@open-walnut/<target>`), with nothing to build. install.sh keeps each version in
  `~/.local/share/open-walnut/versions/` and switches with one link, so the version before stays
  for a rollback ([Getting Started](GETTING_STARTED.md#updating-and-rolling-back)), and
  `walnut web` and `walnut update` install new versions the same way. A new version that exits
  before it serves is gone back from on its own and skipped until a newer release. Homebrew installs update
  with `brew upgrade open-walnut`. An install from the self-contained Node archive keeps updating
  itself onto the new packages, and the archives are published for two more releases.
- Walnut runs on one runtime, bun, from a checkout to production. The server, its build, the
  tests and the dev scripts all run on bun; Node stays only under the Playwright test runner. To
  work on Walnut you install git and bun 1.4.4 or newer, then `bun install` and `bun run start`:
  nothing is compiled on install, and no Node is needed.
  Repo commands are `bun run <script>` (`bun run dev:ephemeral`, `bun run test:quick`,
  `bun run build:binary` for this machine's compiled file).
- A plugin's database binds a whole JS number as an `INTEGER` now (it was a `REAL`), and so
  does the test fake in `@open-walnut/plugin-api/testing`. Values compare and store the same in
  `INTEGER`, `REAL` and untyped columns; a `TEXT` column keeps `'3'` where an older Walnut wrote
  `'3.0'`, and `? / 2` divides as integers. Plugins that keep ids as text should bind strings
  ([Plugin development](docs/reference/plugin-development.md)).
- Big optional parts are components, downloaded the first time a feature needs them: search by
  meaning (`embedding`), image resizing (`images`) and, on macOS, audio capture. Tasks, sessions,
  the board, notes, keyword search and the tunnel all work from the file alone.
- A host server is the same compiled file: the Mac sends the file of its own build to the host
  over the session daemon's SSH path, so the host needs no Node, npm or compiler.
- `npm install -g open-walnut` keeps working and keeps updating through npm. What it installs is
  a small launcher plus the one package built for your machine, which holds the compiled file;
  the launcher needs any Node 18 or newer, and Walnut itself does not run on it.
- The deploy (`scripts/deploy-committed.sh`, `bun run dev:prod`) serves only the compiled file.
  `WALNUT_DEVPROD_RUNTIME=node` is gone: a build that fails after the switch rolls back to the
  last good file, and a deploy with no file to roll back to says so before it stops the old server.
- The Mac app's "Set Up Now" for a folder installs the self-contained Walnut with its data in that
  folder, the same way `install.sh` does, instead of cloning and building with npm. A setup an
  older version of the app built that way moves to the self-contained Walnut on its next launch
  and keeps its data. A source checkout picked in the app runs on bun.
- The setup and restore skills install Walnut with `install.sh`, and the README installs Claude
  Code with its own installer (`curl -fsSL https://claude.ai/install.sh | bash`), so no step a user
  takes needs npm.
- The setup wizard deploys the AWS companion from any install, the compiled file included: the
  file carries the CDK app and installs its dependencies with its own bun. The CDK itself still
  runs on Node, so that one step needs Node and npm on the machine.
- The cloud companion runs the compiled file too. The Mac sends its companion the same file its
  host servers run, built for the box, with a small `dist/cli.js` that starts it, so a box of
  any age takes it with the update path it already has: a box set up before keeps its service and
  its launcher, on node, and moves to the file at the Mac's next update, with nothing to do on the
  box. A Mac that runs the compiled file updates its companion like any other Mac.
  `scripts/cloud/setup.sh` builds a new box's base tree with bun, and its service starts
  `bun dist/cli.js web`; Node stays on the box only for agent CLIs installed from npm. A box whose
  service moves from node to bun skips a build it got on node and runs its base tree until the Mac
  sends the file.

## [0.6.20] - 2026-10-30

### Added

- Run Walnut on your own models: with Ollama (or LM Studio/vLLM) as the AI provider and
  OpenCode, Goose, Codex or a custom ACP agent as the engine, nothing asks for Claude Code;
  watchers and AI task search run on your model, and every engine gets Walnut's session
  instructions ([Getting Started](GETTING_STARTED.md#path-d-models-on-your-own-machine-ollama-lm-studio-vllm)).

### Changed

- Walnut installs as one compiled file with everything inside, for macOS and for Linux with
  glibc or musl (Alpine, with `apk add libstdc++ libgcc`), on arm64 and x64. The one-line `install.sh`, Homebrew and the Mac app
  install it with nothing else on the machine, not even Node. `npm install -g open-walnut`
  installs a small launcher and only the package built for your machine
  (`@open-walnut/<target>`), with nothing to build. install.sh keeps each version in
  `~/.local/share/open-walnut/versions/` and switches with one link, so the version before stays
  for a rollback ([Getting Started](GETTING_STARTED.md#updating-and-rolling-back)), and
  `walnut web` and `walnut update` install new versions the same way. A new version that exits
  before it serves is gone back from on its own and skipped until a newer release. Homebrew installs update
  with `brew upgrade open-walnut`. An install from the self-contained Node archive keeps updating
  itself onto the new packages, and the archives are published for two more releases.
- Walnut runs on one runtime, bun, from a checkout to production. The server, its build, the
  tests and the dev scripts all run on bun; Node stays only under the Playwright test runner. To
  work on Walnut you install git and bun 1.4.4 or newer, then `bun install` and `bun run start`:
  nothing is compiled on install, and no Node is needed.
  Repo commands are `bun run <script>` (`bun run dev:ephemeral`, `bun run test:quick`,
  `bun run build:binary` for this machine's compiled file).
- A plugin's database binds a whole JS number as an `INTEGER` now (it was a `REAL`), and so
  does the test fake in `@open-walnut/plugin-api/testing`. Values compare and store the same in
  `INTEGER`, `REAL` and untyped columns; a `TEXT` column keeps `'3'` where an older Walnut wrote
  `'3.0'`, and `? / 2` divides as integers. Plugins that keep ids as text should bind strings
  ([Plugin development](docs/reference/plugin-development.md)).
- Big optional parts are components, downloaded the first time a feature needs them: search by
  meaning (`embedding`), image resizing (`images`) and, on macOS, audio capture. Tasks, sessions,
  the board, notes, keyword search and the tunnel all work from the file alone.
- A host server is the same compiled file: the Mac sends the file of its own build to the host
  over the session daemon's SSH path, so the host needs no Node, npm or compiler.
- `npm install -g open-walnut` keeps working and keeps updating through npm. What it installs is
  a small launcher plus the one package built for your machine, which holds the compiled file;
  the launcher needs any Node 18 or newer, and Walnut itself does not run on it.
- The deploy (`scripts/deploy-committed.sh`, `bun run dev:prod`) serves only the compiled file.
  `WALNUT_DEVPROD_RUNTIME=node` is gone: a build that fails after the switch rolls back to the
  last good file, and a deploy with no file to roll back to says so before it stops the old server.
- The Mac app's "Set Up Now" for a folder installs the self-contained Walnut with its data in that
  folder, the same way `install.sh` does, instead of cloning and building with npm. A setup an
  older version of the app built that way moves to the self-contained Walnut on its next launch
  and keeps its data. A source checkout picked in the app runs on bun.
- The setup and restore skills install Walnut with `install.sh`, and the README installs Claude
  Code with its own installer (`curl -fsSL https://claude.ai/install.sh | bash`), so no step a user
  takes needs npm.
- The setup wizard deploys the AWS companion from any install, the compiled file included: the
  file carries the CDK app and installs its dependencies with its own bun. The CDK itself still
  runs on Node, so that one step needs Node and npm on the machine.
- The cloud companion runs the compiled file too. The Mac sends its companion the same file its
  host servers run, built for the box, with a small `dist/cli.js` that starts it, so a box of
  any age takes it with the update path it already has: a box set up before keeps its service and
  its launcher, on node, and moves to the file at the Mac's next update, with nothing to do on the
  box. A Mac that runs the compiled file updates its companion like any other Mac.
  `scripts/cloud/setup.sh` builds a new box's base tree with bun, and its service starts
  `bun dist/cli.js web`; Node stays on the box only for agent CLIs installed from npm. A box whose
  service moves from node to bun skips a build it got on node and runs its base tree until the Mac
  sends the file.

## [0.6.19] - 2026-10-27

### Added

- The live turn's received message and its tools are one fold row
- Every task gets a durable working directory; git work in temp dirs is refused
- Ask here opens Conversation Mode, questions fold to one line, the card has a mic
- Received messages always fold; the ack line only for agent messages
- Synced and scratch file areas beside plugin-data
- Session budgets on the per-request cost line
- Now on the Tasks board inherits a parent's start date, like the web
- An Org page of Main and the project leads, like a chat app's channels
- Dictation keeps working when the Mac is asleep or off
- A turn shows its answer; a turn that needed nothing is hidden
- The primary keeps a standing link to its own daemon, with no session needed
- Main and leads decide new task vs continue by deliverable
- Tasks board hides waiting tasks by default, like the web
- Chat on a lead is a plain chat with it, and the Tasks page hides the org
- One update notice for app restarts and web reloads
- One team charter in every role's default prompt
- Audiograms, heartbeat series and workout routes reach the Mac
- App state, so the AI beside an App sees what it shows
- Task rows keep to two lines, one size of pill, "+N" inside the tag
- Link tags live in the session header, and its pills share one size
- Database batch, a real fake database, and fixes from building an App
- A host starts a claude-code routine's run while the Mac is away
- A routine runs where its work runs
- A host's daemon keeps a routine's clock (clock-routine-v1)
- Eval-tuned instruction, and every turn and compaction carries it
- One pill style, and a link pill names its target on hover
- Pick the new session's model, effort and permissions
- A config.yaml edited outside Walnut takes effect like a save
- Archive from the question map; Conversation Mode folds questions
- A question card opens expanded when its answer has a table or diagram
- The companion keeps the same switches as a host
- What a replica does not keep goes to the Mac
- Quote a passage into the composer, keep painted boxes readable
- Show what a session's usage would cost on other models
- Confirm and execute each email action independently
- The tunnel runs on an always-on host by default
- The same copy defaults for every replica
- Every host keeps the companion's copy, pictures included
- A session's letter is saved on its host while the Mac is away
- A link pill shows its kind alone unless an id tells it apart
- Git sync stops writing the companion's data dir
- Show each model's cost as a table of tokens, unit price and cost
- Only the links a person comes back to become link tags
- Name the row "Transfer harness/host…"
- Chats on the companion stop depending on git sync
- Notes, memory and skills on the companion read the Mac's copies, never its git-written disk
- The Mac owns the cards, routines and prefs the box wrote
- The box's away reads take the Mac's copy or need the Mac
- Pictures pasted on the companion go to the Mac through its journal
- Note moves on the companion go into its journal; tag renames are note saves
- The companion's memory and skill reads take the Mac's copy; memory saves go into its journal
- "Transfer…" in the composer "+" menu, under Engine settings
- Walnut learns each host itself; a transfer message stays simple
- A file link says what the file is, in one or two words
- The companion's session readers read its sessions copy, and the Mac stops pushing it the session list
- A chat turn the companion answers while the Mac is away is a journal record
- The companion keeps the Mac's conversations and reads its chat from them
- Link pills lead with their kind, fold into a list, and open files
- Grouped inbox as two sections, every group open with all its mail
- The box operator can correct what a paired device is recorded as
- The companion keeps the Mac's sessions copy and lists sessions from it
- The companion's notes read the Mac's copy; its note saves go into its journal
- The companion keeps the Mac's notes, memory and skills copy
- A task created on the companion while the Mac is away goes into its journal
- The companion's inbox reads the Mac's copy; away flag changes go into its journal
- Away session changes go into the companion's journal too
- Away task writes go into the companion's journal, drained by the Mac
- Boards and the settings view from the Mac's copy; copies go again after an update
- Move a task to another engine or host; one session per task
- Plugins offer ready-made triggers, armed from the composer
- A main agent above the work, project leads, and an org chart
- Tag a session's task with the links it is about

### Fixed

- 26 tests the last bulk push left red, and four gaps they found
- A detached session still signs its messages with its task; the map button shows its ring after an Esc in WebKit
- Retry the source deploy over a fresh ssh before the 103 MB binary
- A task that lost its join key is joined by its ext id, not re-created
- A message still in the CLI's queue is unsettled, so it never shows twice
- Type the relayed daemon reply
- Answer the update poll from the last daemon reply
- Only a live session-server link turns a fork into a replay
- Embed only what changed, smaller embed worker, no blocking scans on the server loop
- The main agent stays active, delegates, and keeps a tracking note
- An error card is one cause, shown once, cleared by its own recovery
- A fork confirms its own start, and a copied conversation goes through a private stage
- A line handed back by a process end reaches the next process
- Job writes land in call order, restart tests start from disk, secret temps never sync
- The restart helper no longer counts transparent windows
- Restart in the update notice restarts unless something would really be lost
- A routing notice line the CLI reports taking counts as told
- The routing notice reaches an older Main or lead once, whichever path delivers
- Rank folder search by usage, not by the chat's cwd
- An npm install can deploy the AWS companion
- A person's words keep their bubble behind Walnut's notices; finished steps and no-action answers fold
- Automated messages wait behind a pending permission card, and the first mid-turn line is tracked
- Main hears count moves at most every half hour, and what newly needs the user at once
- A refused-create card retires after a restart once the task reaches the tracker
- Recordings do not outlive a delete made by an older build
- A read refused at once is never unhandled, and the exit record never throws
- Give each new child notice its own delivery identity
- A relayed read of a host that cannot be reached is not a relay fault, and a crash records what killed it
- The one-session-per-task triggers live on the connection, not the file
- The Mac never runs a slot its host started, and the card says the host starts it
- A cron in another zone says which zone its hours are in
- A task's badge lists its clock routines wherever the clock is
- Every run a host made reaches the server once
- A session on the CLI's default model starts the new one on Auto
- A session start reaches its host's copy at once
- Leave room for the suffix ssh adds while it binds a control socket
- Close the gaps a review found in what a replica keeps
- Deliver Tree Mode messages while a turn runs
- Diagrams are SVG, and compaction re-sends the full instruction
- Wrap crowded row metadata instead of squeezing titles
- A host's needs-the-server answer names the letter it can save
- Support Command-W and close after discard confirmation
- Keep sessions fully interactive in separate windows
- The companion's new needs-the-Mac reasons have their words
- Activate installed app updates with a confirmed restart
- The v1 attachment and folder deletes reach their routes
- Keep daemon launches stable and make system errors repairable
- Keep pop-out views in native app windows
- A direct host-to-host copy that worked counts as one
- Preserve plugin-local tags through remote pulls
- A named directory is where the workspace goes
- Keep transfer files where the daemon may copy them
- Make PDF previews fill the pane and support trackpad zoom
- A copy or journal step whose connection broke goes again
- Name internal hosts by their label; keep a note being typed

||||||| parent of 17b9c6050 (docs: install, update and release the compiled file)
## [0.6.18] - 2026-10-24

### Fixed

- The bun twin resets a ws:// bridge it gives up on under Bun 1.4.4
- A notarization poll that never reached Apple waits again

## [0.6.17] - 2026-10-23

### Added

- The companion keeps copies of requests, routines, favorites and personas

### Fixed

- A queued write waits out another process's journal lock instead of failing

## [0.6.16] - 2026-10-22

### Added

- The Mac keeps its cloud companion on the Mac's own build
- Transcribe a voice take while it is still being recorded
- Every server runs Qwen3-ASR locally and installs it by itself
- Show what a session cost, priced per request

### Fixed

- A delivery waits for a mid-turn write still out, so lines keep their order
- Send a dropped upload chunk again at once, in 1 MB chunks
- Scroll a tall permission card instead of cutting it off
- Look at an older companion again after ten minutes, not an hour
- Keep remote delivery working when the primary is offline
- Hash the session cost core into the daemon build and explain the new config maps

## [0.6.15] - 2026-10-21

### Added

- The replica is the default host server (D13)
- Notes, a new ask and the replica's logs while the Mac is away
- The console keeps writing tasks and sessions while the Mac is away
- The companion forwards through the stream link and boots by policy
- Replica servers keep copies of routines, conversations, config and prefs
- The console stays readable while the Mac is away
- Replica servers hold copies of sessions, requests, boards and inbox
- A replica answers host reads from its own copy
- The Mac drains journal v2 and keeps every away edit it can prove
- Offline journal v2 that survives daemon upgrades
- A compaction never leaves a session with its old place
- Every replica server holds an exact copy of the tasks

### Fixed

- A lock release writes over its token instead of cutting the file to zero
- The reconciler makes its dir on the first save, not at import
- The device token rides a subprotocol, not the URL
- The task copy's confirm, host restarts and older copies
- An away ask is adopted only from its own host, and survives a daemon death mid-start
- A rename or a complete is not undone by a list read that crossed it
- A link dialled again after a disconnect notices its next loss
- Away writes are checked, logged and deduped the way the Mac does them
- The console's task writes go to the Mac while it answers, and a live op holds its base
- Copies of routines, conversations, config and prefs hold when the Mac's store is odd
- Copy kinds keep what the Mac could not read, and every replica guard is tested
- Files in the Mac's data dir open from the companion's synced copy
- The reader keeps the sender readable on a narrow reader

## [0.6.14] - 2026-10-17

### Added

- The replica's front sends browsers to the Mac while it answers
- Walnut in a phone browser feels like a phone app
- A session hears where its task stands after a move
- A session filing work in another project says why
- A session's message to a completed task needs a reason
- A replica server boots safe by construction
- Pause sessions at verified lifetime budgets
- An install link opens Walnut on the plugin, from the Mac app, a browser or the CLI
- A plugin can restart an MCP server, at most once per two minutes
- A host answers its trigger ops while its Walnut is away

### Fixed

- A session record is born with the prompt it runs
- An auto-allowed prompt stays the daemon's, and a rename never drops an answer
- The companion transcribes phone recordings while the Mac sleeps
- A reply to a mail whose listing names no addresses still has its recipients
- A refused upload login says what ssh said
- An upload never rides the shared SSH connection
- Preserve Sol cache totals without guessing cost
- Reconcile session costs against response evidence
- Open tasks directly from Inbox letters without losing replies
- A phone pans a streaming transcript, and the page itself never moves
- The console fills a phone screen, one surface at a time
- Page conversation history by user turns
- Keep visible directories in sync with external changes
- Keep an early incoming-stream refusal from crashing the server
- Fit the default day and persist confirmed drag edits

## [0.6.13] - 2026-10-16

### Fixed

- A check's deadline counts awake time, not the time a Mac slept

## [0.6.12] - 2026-10-15

### Added

- Enforce status-only credentials and confirm host round trips
- One picker for model and effort, with live state, turn speed and context

### Fixed

- A setup runner stopped mid-write never starts its next step
- The CI gate asks GitHub again on a 5xx or a dropped connection
- A task's own event clears its level-snapshot mark in the tail fold again
- A host-resumed fire shows in the session's chat
- Render indented layouts inline and repeat the delivery contract
- Name task placement Pin and its lists Pins
- Repack right after a rewrite adoption, and judge repo size after maintenance
- Show when only background subagents are working

## [0.6.11] - 2026-10-14

### Fixed

- Open pages and boards follow a merge, and a popout never crashes on it
- Show model lists instantly and keep an interrupted reply as one retry notice
- A host resumes a session from before the spawn journal
- The open column never shifts on fold, and a merge never strands sessions
- A masked secret never reaches disk, and URL passwords stay hidden
- A message the phone sends runs once, whatever the retry path
- Header chips hold their place while the session record loads
- Show the first message as soon as a new session is sent
- Back to an agent, the Chat page is where the user left it
- Switching agents in the Chat drawer never says "no conversations" or forgets the open chat
- An ask's earlier chat is asked for again when the server ran out of time

## [0.6.10] - 2026-10-13

### Added

- The Mac app updates itself: a quiet check, a download you start from the sidebar, and Restart to update

## [0.6.9] - 2026-10-12

### Added

- A fire no server claimed wakes a stopped session on its host
- Session controls through a led host, and a host server that answers alone
- Streams ride a lane of their own, off the session SSH connection
- A Walnut server on a host, linked to its daemon only
- Time_report and time_timeline ops, a walnut-time-review skill, and four task API fixes
- Every follower server keeps the search index copy, not only the companion
- New events go to a default calendar, and a write without a grant fails at once
- One view of the leader on every follower, and the list of followers
- A first launch starts by itself, and the release gets a Homebrew cask
- A message the companion holds names the hop it waits on, and is delivered once when that hop is back
- Recently opened drawer on the Tasks tab
- Hide events locally, zoom the timeline and guard source writes
- Mark Inbox letters read the way Mail does: swipe right, Select, two fingers
- Haiku 5.5 replaces Haiku 4.5, and the AI search lane runs on Haiku

### Fixed

- A message to a task goes to its current session, as on the server
- A message to a task goes to its current session, as on the server
- An edited document is split into passages once, and reused vectors stay correct
- A real block right after a load-stretched one is code, not the machine
- The iPhone asks for Always once Walnut is open again, and the Places screen can ask again
- The session header takes the record's status when the stream gives none
- Streams wait for the lane while it dials again, off the session link
- The stream lane logs why its SSH connection ended
- The review skill reuses the vault's time-review topic, and list arguments take arrays
- A planned block matches the task that had the most time in it
- A watch left running overnight is not exercise, and plans match short names and CJK titles
- The default calendar row names the account
- Call the companion's search "Semantic search"
- A removed device stops getting notifications on every path that removes it
- Keep task menus stable across fractional zoom
- Bump the parse cache schema so idle sessions get sourceUuid
- A question sent mid-turn keeps its number; Archive instead of Done; amber open marks
- A master that is only slow is kept, and a relative age in an error no longer splits one card into two
- Helper model turns nobody waits on run in the utility band and queue behind the ones a person waits on
- A recovery survives a dead server's lock, and the companion stops carding its own deploys and the Mac's pushes
- Import the sessions a person started, by the CLI's own record
- Only a folder's own open work makes it shared

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
  `operator` now find `AcmeEventOperator`, which no configuration of the previous engine could
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
