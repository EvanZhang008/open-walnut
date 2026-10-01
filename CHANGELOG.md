# Changelog

All notable changes to Open Walnut are documented here. This project follows
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may include
breaking changes).

## [Unreleased]

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
  section as notes. Twice a day the same workflow publishes `main` as
  `X.Y.(Z+1)-nightly.YYYYMMDD.N` under the `nightly` dist-tag when `main` moved and the quick
  test baseline passes, so `npm install -g open-walnut@nightly` follows the repository without
  waiting for a release. See [Releasing](docs/reference/releasing.md).

### Changed

- **Host problems show the moment the notifications panel opens.** A remote host that cannot be
  reached, or a Claude Code that is missing or not signed in, now counts as an error: it leads the
  All view the panel opens on, and the Errors view, as the same row as on the Home card (the
  sentence, the Retry or Check again button, `Show details` for the reason and Open Settings), in
  the card's order and without the dismiss button. A host's failed attempts sit under its row
  instead of in a second block naming the same host, and the Errors badge counts each problem host
  once. A problem dismissed on the Home card stays out of these views too. System is back to
  long-running status: its `Remote hosts` list still names every host once (dismissed ones
  included), and its badge no longer counts hosts. A pending ask still opens Needs Action first.

### Fixed

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
