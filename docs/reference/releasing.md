# Releasing

How a change in `main` reaches an install, in both directions: how we publish, and how
an install finds out and updates.

## The two channels

| Channel | npm dist-tag | What it is | How it is cut |
|---|---|---|---|
| stable | `latest` | A tagged release `vX.Y.Z` with a CHANGELOG section | Automatic, once a day: the newest nightly that has been out 24 hours. By hand: `bun run release -- patch\|minor\|major` |
| nightly | `nightly` | The newest commit on `main` that CI passed | GitHub Actions, about every six hours, when that commit is not the last nightly already |

`npm install -g open-walnut` gives the stable channel. `npm install -g open-walnut@nightly`
switches an install to nightly; the installed version (`X.Y.Z-nightly.YYYYMMDD.N`) is how
the install knows which channel it follows, so it keeps following nightly until `@latest`
is installed again. Pre-1.0, a minor bump may carry breaking changes (see CHANGELOG).

## Automatic stable releases

Nobody has to cut a stable release. Once a day, jobs `promote-*` of the same workflow
promote a nightly that users on the nightly channel have run for a day. They check whenever
CI finishes on `main` (`workflow_run`) and on the workflow's one schedule
(`7,17,27,37,47,57 * * * *` UTC), and a check does nothing until the last stable is 23
hours old (`MIN_GAP_HOURS`). A run by hand skips the gap.

GitHub runs few of this repo's scheduled runs: 10 of about 75 in the 25 hours to 2026-10-03
13:00 UTC, with gaps of three to five hours, and a `release:` commit starts no CI run. So
the schedule asks every ten minutes, and every scheduled run checks both channels (each
job keeps its own gap). With one cron per channel, the only run in the two hours after a
nightly came due was the stable one, and that nightly waited seven hours. Each publishing
job has its own queue (`release-nightly`, `release-promote`, one per release tag): a
running publisher is never cancelled, and two runs that planned the same release run its
steps one after the other, the second finding everything done.

1. **Plan** (`scripts/stable-promote.mjs plan`). The candidate is the newest nightly
   published at least 24 hours ago; the registry records each version's commit as
   `gitHead`. The job does nothing, and says why in its log, when there is no such nightly,
   when it is the code `latest` already ships, when it does not descend from that release,
   when CI did not pass on it (CI includes the release rehearsal below), or when nothing
   since the last release is something a user would notice. That last test reads the
   commits (Conventional Commits): a `feat`, `fix` or `perf`, or a written entry under
   `## [Unreleased]`, releases; `docs`, `test`, `chore`, `ci` and the like alone release
   nothing. The version follows release-please's pre-1.0 rules: a breaking change (`feat!:`,
   or a `BREAKING CHANGE:` footer) makes the next minor and anything else the next patch,
   so a release a day does not run the minor number up. From 1.0 on: breaking major, `feat`
   minor, `fix`/`perf` patch. The candidate's commit must hold `scripts/release-build.mjs` and
   `scripts/release-unpack.sh` (the matrix rows and the publish job run them from it), so a
   nightly from before either waits for a newer one.
2. **Smoke** (Linux and macOS, in parallel). Each runner installs that exact nightly from
   npm the way the updater does (npm 12, the same `--allow-scripts` list), starts it on a
   fresh HOME and requires `/api/system/health` to answer. Every install updates itself on
   restart, and only a version that exits before it serves is gone back from on its own (one
   that serves and misbehaves stays), so a release must start on a machine that has never
   run Walnut.
3. **Build, matrix, publish.** Job `promote-build` builds the candidate once, at the stable
   version (`scripts/release-build.mjs`), and keeps its assets as a workflow artifact. Job
   `promote-files` runs those very files through the binary matrix (`binary-matrix.yml`,
   called with them), reporting that version, beside the smoke. Job `promote` then unpacks
   the artifact's `.gz` files, each checked by both of its `SHA256SUMS` lines
   (`scripts/release-unpack.sh`), packs and publishes those bytes (the platform packages, then
   `open-walnut`, with provenance; it builds nothing), waits until npm serves the version as
   `latest`, tags `vX.Y.Z` on the candidate, opens the GitHub Release as a draft, attaches the
   files (`scripts/release-attach.sh`, `SHA256SUMS` last), and makes it public as the latest
   release only once `SHA256SUMS` is on it. npm holds a version it accepted
   for minutes before it serves it, and the run queued behind this one reads npm to learn
   whether the version is out: on 2026-10-09 two runs planned 0.6.7 two minutes apart, the
   second found nothing at the registry and npm refused its publish with 409 "Cannot
   publish over previously staged version". So the job ends only once npm serves the
   version to that same check, and npm's refusal of this very version (held or published) counts as
   published; the tag step still requires the tag on the candidate.
4. **Roll main.** A `release: X.Y.Z` commit on `main` moves the released entries from
   Unreleased under `## [X.Y.Z] - date`, keeps the entries written since the candidate, and
   sets the version in `package.json` (`bun.lock` holds no version). A push that loses the race
   to another push on `main` starts again from the new `main`, five times; after that the
   job fails, because a `main` left unrolled would repeat this release's notes in the next
   one.

The notes are the Unreleased section as it stood at the candidate. When nobody wrote one,
they are the `feat` subjects (Added) and the `fix`/`perf` subjects (Fixed), so a
user-facing CHANGELOG entry is still the better habit. A failed run is the only thing that
needs a person: GitHub mails it. When it failed before Publish, nothing was published. When
it failed after (the tag, the GitHub Release or the roll), fix the cause and re-run the
failed jobs: each step skips what an earlier attempt finished (a version already on npm, a
tag already on the candidate, a Release that exists, a `main` that already has the
section), so a rerun completes the release without publishing anything twice. A rerun is
the only way back: the next plan sees that version on npm and never returns to it.
`tests/scripts/release-promote-steps.test.ts` runs these steps against a scratch repository
with fake `npm`, `curl` and `gh`, a rerun and a racing `main` included.

Tag and commit are pushed with the job's own token, which starts no workflow, so the tag
cannot publish a second time through job `stable` and the release commit gets no CI run of
its own (it changes only the version files and CHANGELOG).

That token has no `workflows` permission, and GitHub then lets it point a ref only at a
commit whose `.github/workflows` match the tip of `main`: it compares a new or moved ref
with the default branch, not with the ref's old value or the commit's parent. The candidate
is a day old, so when `main` changed a workflow since, the tag goes on a child of the
candidate with the candidate's tree and `main`'s workflows (its message names the
candidate). The package source is the same, since workflows never ship; npm's provenance
names the candidate itself. A tag push GitHub refuses is retried against a fresh `main`
five times.

To promote now instead of waiting for the schedule: Actions, Release, Run workflow, channel
`stable` (the same plan and smoke run). With `dry_run` ticked the plan takes the newest
nightly without the 24 hour soak, the build and the binary matrix run, and the smoke installs
and starts it, but nothing is published (`gh workflow run release.yml -f channel=stable -f dry_run=true`). To pause automatic releases, disable the Release
workflow's schedule or the workflow itself in the Actions tab; nightlies stop with it.

## What CI proves before anything ships

Both channels publish only a commit whose `CI OK` passed (see below), and `CI OK` needs:

| Job | What it proves |
|---|---|
| Lint & build | `tsc`, the full build, the plugin packages |
| Test (quick, three shards), Test (frontend) | ~1,500 pure-logic files and the web suites; quick is judged against its recorded baseline, and every file of each shard must report |
| Test (slow) | ~1,000 tests that start real daemons, servers, git and the local embedder; must pass (`--retry=2` absorbs a runner hiccup, three failures in a row is a failure) |
| Test (e2e, four shards) | ~130 files of real servers and daemons with a mock CLI; judged against `tests/setup/known-failures-e2e.json`, and each shard uploads its failures as `known-failures-e2e-<shard>` |
| Fresh machine (Linux, macOS) | the README's two install routes on a machine without Bun or Claude Code |
| Remote host | Walnut provisions a clean Linux dev box over real ssh and starts a session there |
| Release rehearsal (Linux, macOS) | the package this commit would publish, end to end (next section) |
| Release rehearsal, field update (Linux, macOS) | the versions on npm today, installed as people installed them, update to this commit as a release publishes it and keep their work (the field rehearsal, below) |

The binary matrix (`binary-matrix.yml`, its own workflow) must pass on the same commit too: the
compiled file on old and new glibc, musl, arm64 and x64 Linux, both Macs and an old kernel, with
nothing installed but the file. A release also calls it (`workflow_call` with `files`, `version`
and `ref`) on the very files it is about to publish; that call skips the build, checks out the
built commit, has its own concurrency group per run and is never cancelled.

One more suite runs on every push and reports without blocking: the Playwright browser
suite (eight shards, summary per shard in the run page).

The jobs that install the published package or a packed tarball resolve its dependencies
fresh from npm, so they meet the registry as a user does, mid-publish of someone else's
packages included. npm serves a family published together (the AWS SDK, hundreds of
packages) one package at a time over several minutes, and an install in that window fails
with ETARGET for a version that is there minutes later (2026-10-09: nine jobs). Those
installs run through `scripts/npm-registry-lag.mjs`, which runs one again after 1, 2 and 4
minutes while npm names a version it does not serve yet; any other failure ends at once.
Ratchet: `tests/scripts/npm-registry-lag.test.ts`.

### The release rehearsal

`scripts/release-rehearsal/` installs the package exactly as a user does, on a machine that
has never run Walnut, without publishing anything. `pack.mjs --rehearsal` builds this commit
as the next patch ("current") and as a lower prerelease of the same code ("older"), each its
own build because the version is baked into the bundles. `run.mjs` then runs, each in its
own npm prefix, HOME, data dir and daemon dir, with a mock `claude`
(`tests/providers/mock-claude.mjs`) on PATH:

| Scenario | Pass means |
|---|---|
| install | `npm install -g` with npm 12 and the updater's `--allow-scripts` list works, and `--version` names it |
| serve | `open-walnut web` answers health, the SPA and `/api/v1/status`, and finds `claude` |
| session | a session started through `POST /api/v1/sessions` answers, then answers a second message sent to the live CLI |
| restart | after a server restart the history is intact and a third message is answered |
| update | "older", started, updates itself to "current" before it serves |
| archive | `scripts/runtime-bundle/build.mjs` builds the self-contained archive of "older" for this machine; `scripts/install.sh` finds it on a local server laid out like GitHub Releases, checks it and installs it |
| archive-serve | that install serves, finds `claude` and answers a session with no Node on PATH, and its updater says `walnut update` |
| archive-brew | the Homebrew formula written for it installs from a scratch tap and passes `brew test` (Homebrew comes with both runner images) |
| archive-app | (macOS) `Walnut.app`, built from this commit by `desktop/build.sh`, installs that archive on its first launch with the `install.sh` inside it, serves the console with no Node on PATH, takes its server with it when it dies, and starts again without downloading (`scripts/desktop-smoke.mjs`) |
| archive-update | that install, started, updates itself to "current" through its own Node's npm |

The update scenarios use `registry.mjs`, a local registry that serves the chosen
tarballs under chosen dist-tags and passes every other package through to npm, with
`WALNUT_UPDATE_REGISTRY_URL` and `npm_config_registry` pointing at it. Locally, run
`pack.mjs` only in a copy of the tree (it rebuilds `dist/` and refuses to touch a git clone
outside CI), then `bun scripts/release-rehearsal/run.mjs --packs <out>/packs.json`.

The rehearsal runs on `macos-26` and `ubuntu-24.04`, so it builds the darwin-arm64 and
linux-x64 archives. CI job `archive-targets` builds the other two a release ships
(darwin-x64 on `macos-26-intel`, linux-arm64 on `ubuntu-24.04-arm`) from the same packed
commit and runs each the way `release-archives.yml` does (`run.mjs --archive`: install.sh,
serve and a session with no Node on PATH). CI OK needs it, so no target is first built at
release time: 0.6.4's darwin-x64 archive was (2026-10-06), and failed.

### The field rehearsal

The update every existing npm install takes, rehearsed on every push (CI job `field`,
`scripts/release-rehearsal/field.mjs`). Its start points are the versions on npm today:
`latest`, `nightly` (the nightly channel follows that tag), and the newest stable still in the
Node form (a full package with `dist/` and `node_modules`) once `latest` is no longer one. Each
is installed from the real registry, the way a person installed it. What it updates to is this
commit as a release publishes it now: `field-packs.mjs build` compiles this runner's file at two
versions above every start point (prereleases of the patch above npm's `latest` and `nightly`,
so a version skew never skips it) and packs the launcher and the platform packages of each with
`npm-packages.mjs`. A local registry serves them under the dist-tags, and also the start
point's own document, so a tag can name it before the update arrives. Once a scenario is over,
its server and daemon are stopped and only its logs stay, so a run holds one install at a time.

| Scenario | Pass means |
|---|---|
| field | a fresh install, started, installs the release with its own startup update and serves it: the launcher and this machine's file, nothing of the Node package left; then the release's own `walnut update` takes the version after it |
| field-work | an install in use (a task, a session whose CLI stays alive, its history) restarts into the update with its daemon still running, as a person's does: the task, the history and the session (a third message) are there, the old daemon and its CLI are gone, and the SQLite files the old version wrote pass `integrity_check` and take a write under bun:sqlite; then the release's own startup update takes the version after it and the session answers a fourth message |
| field-cli | an install in use runs its own `walnut update` while it serves; the old server keeps answering, and its restart is the release with the task, the history and the session |
| field-hand | the same with `npm install -g open-walnut@<release>` typed by hand (no `--allow-scripts`) |
| field-lag | the release's file for this machine is not on the registry yet when the old version updates: the update fails and npm keeps the old version, which serves; once the file is there, the next start is the release |
| field-unscripted | `npm install -g` typed by hand while that file is not on the registry yet, with install scripts off (npm 12 without `--allow-scripts`): the launcher alone is installed, and once the file is there the first start fetches it and serves |
| field-archive | (a stable start point) the self-contained archive its GitHub Release ships, installed by that release's own `install.sh` from a local copy of the release and put to work, restarts into the update: its own Node's npm puts the launcher and this machine's file into the archive's prefix, `node bin/open-walnut.js` and `node dist/cli.js` (what the archive and a 0.6.x Mac app start) both run the file, the work is kept and the old daemon is gone; then the release's `walnut update` takes the version after it |

Locally: `bun scripts/release-rehearsal/field-packs.mjs build --out <dir> --allow-checkout` in a
copy of the tree (or `field-packs.mjs pack --files <dir of walnut-<target> files> --version <v>`
for files built already), then `bun scripts/release-rehearsal/run.mjs --field latest
--field-packs <dir>/field.json`; `--field-from <versions>` and `--field-only <scenarios>` narrow it.

## What a release ships: the compiled file

A version is the compiled Walnut, one file per target with everything inside
(`scripts/build-binary.mjs`, bun's `--compile`): `darwin-arm64`, `darwin-x64`, `linux-x64`,
`linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`. Each channel builds them once, in a build
job (`stable-build`, `nightly-build`, `promote-build`), from the commit it publishes, at the
version it publishes (`scripts/release-build.mjs`: it stamps the version into `package.json`,
runs `bun scripts/build-binary.mjs --all` on one Linux runner, as the binary matrix does, runs
the runner's own file's `--version`, and lays out the release assets). The assets travel as a
workflow artifact (`release-files-<channel>`): the binary matrix runs those very bytes, and the
publish job, which builds nothing, unpacks them (`scripts/release-unpack.sh`, both
`SHA256SUMS` lines of each file) and packs the npm packages of them. So what npm and the GitHub
Release get is what the matrix ran. Both channels also publish only a commit whose push run of
`binary-matrix.yml` passed (`scripts/ci-gate.mjs`).

- **npm** (`scripts/npm-packages.mjs`): one package per target, `@open-walnut/<target>`, holding
  the file with `os`, `cpu` and (Linux) `libc` set so npm installs only the one that matches the
  machine; then `open-walnut`, a launcher with no dependencies but those six as
  `optionalDependencies` pinned to its own version. Its `bin/open-walnut.js`
  (`scripts/npm-launcher/launch.js`) runs the installed file with the same arguments and exit
  code, and tells it how it was started (`OPEN_WALNUT_PACKAGE_ROOT`,
  `OPEN_WALNUT_LAUNCHED_FILE`, `OPEN_WALNUT_RELAUNCH`) so its update goes through npm.
  `dist/cli.js` is the same launcher, for what started Walnut as `node <package>/dist/cli.js`
  before (an archive's restart, an older Mac app). The file needs no Node, so the launcher must
  not need a new one: it is CommonJS in ES2017 on Node 8 APIs, and its entries are ES5 up to a
  version check that names the no-Node install (`tests/scripts/npm-launcher-node-floor.test.ts`;
  an ES module launcher died with a SyntaxError on Node 12, Debian 11's and Ubuntu 22.04's apt
  Node). It starts the file in its own directory, or in that path made again when npm replaced
  it underneath (a 0.6.x Mac app runs its server in the package root, and bun refuses a deleted
  directory). The platform packages go first, the launcher last, and the launcher only once
  installers see every platform package (`waitUntilVisible`, up to 20 minutes, else the launcher
  is not published): the launcher moves the dist-tag the update check reads, and npm finishes an
  install without an optional dependency it cannot find yet. Its one install script
  (`lib/postinstall.js`) checks that this machine's file came with it, fetches it when npm left
  it out (a registry that does not serve it yet; `lib/fetch-platform.js`, checked against the
  registry's sha512), and otherwise fails the install, so npm puts back the version before (npm
  10, 11 and 12 all do): a 0.6.x Node release restarts into the launcher without checking. A
  start that finds no file (an install that ran no scripts) fetches it the same way. A package
  already on the registry is skipped, and npm's refusal of a version it holds counts as
  published, so a re-run finishes a publish that stopped half way. Every manifest carries
  `gitHead`, the commit it was built from, which `nightly-version.mjs` and `stable-promote.mjs`
  read.
- **GitHub Release** (stable only; `scripts/release-files.mjs`, `scripts/release-attach.sh`):
  `walnut-<version>-<target>.gz` for each target (gzip -9), `install.sh`, and `SHA256SUMS`, which
  lists every `.gz` and the plain file inside it (`walnut-<version>-<target>`), uploaded last so
  the release never lists a checksum for a file that is not up yet. The release is made as a
  draft and goes public (as the latest) only once `SHA256SUMS` is on it, so
  `releases/latest/download` never serves a release without its files. A release that has
  `SHA256SUMS` already has its files, and a re-run uploads nothing again; a `gh` that cannot
  list the assets stops the script instead of uploading over a finished release.
- **`install.sh`** (`curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh | sh`):
  POSIX sh. Picks the target (`uname`, and on Linux musl when `ldd --version` says so or
  `/lib/ld-musl-*` exists; `OPEN_WALNUT_TARGET` overrides), reads the newest version from the
  latest release's `SHA256SUMS` (while a release's files are not up yet, the newest release with
  this target's and its `SHA256SUMS`, from GitHub's API), downloads the `.gz`, checks it and the file inside against
  `SHA256SUMS`, runs its `--version`, then installs Claude Code's way:
  `~/.local/share/open-walnut/versions/<version>/walnut`, `bin/walnut` linking the version in use
  (swapped with one rename), `open-walnut-install.json` naming the layout and target, and
  `walnut`/`open-walnut` in `~/.local/bin` linking `bin/walnut`. The version before stays for a
  rollback, and so does a version a server still runs from (each server marks its own in
  `running/<pid>`); older ones go, and only in a root its marker was in before the run, and
  only directories holding a `walnut` (the Node archive's `app/` only while no process runs
  from it). It takes the updater's lock (`.update.lock`, whose `owner` names a pid and when
  that process started, so a reused pid is no holder; a stale lock is taken over one taker at a
  time, `src/core/self-update/install-lock.ts`) and waits a minute for an update in progress.
  The whole script is one `main` called on its last line, so a download cut short runs
  nothing. `OPEN_WALNUT_VERSION` must be a version; a refusal from GitHub's API (its limit for
  an address without a login) says so and names `OPEN_WALNUT_VERSION`. A version with no file (a release
  from before it) still installs its Node archive, and an archive install moves to the file on
  its next install. The musl build links the C++ runtime (Alpine's `libstdc++` and `libgcc`):
  when the file cannot start on a musl system without it, install.sh names the `apk add` line
  (and so does the npm launcher, on its loader's exit 127). A release on this disk
  (`OPEN_WALNUT_RELEASE_BASE_URL=file://...`, the Mac app's) may hold the plain file instead of
  the `.gz`. Ratchets: `tests/scripts/install-sh.test.ts` (sh and dash),
  `tests/scripts/file-distribution.e2e.test.ts` (the real compiled file at two versions, end to end).
- **Homebrew** (`scripts/homebrew/formula.mjs`): the formula names each Mac's and glibc Linux's
  `.gz` and its sha256, keeps it packed through `install` and unpacks it in `post_install_steps`
  (`install_gzipped_executable`): Homebrew rewrites every Mach-O and ELF file in a keg it builds,
  and the file must keep its signature and the program it carries. Job `homebrew` of
  `release-archives.yml` writes it from the release's `SHA256SUMS`, installs it from GitHub with
  brew, runs `brew test` and attaches `open-walnut.rb`; the tap `EvanZhang008/homebrew-tap` copies
  the newest release's (its own workflow, hourly). Inside a keg the file leaves its updates to
  `brew upgrade open-walnut`.
- **The Mac app**: job `mac-app` (`.github/workflows/mac-app.yml`) builds one `Walnut.app` per
  Mac architecture from the release's tag, each carrying that release's file for it, unpacked
  (`Contents/Resources/release/v<version>/`; `scripts/desktop-carry-release.mjs`, which refuses a
  file its checksums or its Mach-O header disown). The signed build signs the carried file with
  the Developer ID identity, the hardened runtime and `desktop/walnut-file.entitlements` (its
  JavaScript engine compiles code at run time: without `allow-jit` it runs about eight times
  slower), writes a checksum of its own for it, and then signs the app over it
  (`desktop/Walnut.entitlements`), notarizes and staples the app and then its DMG, has Gatekeeper
  assess the DMG with a browser's quarantine mark on it, launches the mounted app on a fresh
  `HOME`, and only then attaches `Walnut-arm64.dmg` and `Walnut-x64.dmg`. On the Apple silicon
  runner the arm64 app must install what it carries with every release URL dead; the x64 app
  takes the path an Intel DMG takes on Apple silicon and downloads the arm64 build. The app comes
  from the tag; the smoke that launches it comes from the workflow's own commit (a second
  checkout in `harness/`), so a fix to the check reaches every release it judges, and it still
  starts an app older than itself (one that carries a Node archive). `app_ref` on a dispatch
  builds another commit's app on a released Walnut, through every check, and never attaches it.
  The identity (`MACOS_CERT_P12_BASE64`, `MACOS_CERT_P12_PASSWORD`) and the notary key
  (`APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, an App Store Connect API
  key with the Developer role) are secrets of the `release` environment, which only `main` may
  deploy to; the identity goes into a keychain made for the job and deleted after it. Without
  them the apps are built ad-hoc and kept as workflow artifacts, never attached. The app's first
  launch starts by itself (no setup screen), runs the bundled `install.sh` on what it carries
  (or downloads it with a progress bar read off curl's, `OPEN_WALNUT_PROGRESS=1`), starts the
  server as `bin/walnut web` and opens the console. The app updates itself from these same DMGs
  (see Updates below), so their names and the app's `WalnutUpdateFeed` must stay as they are. A
  team's first notarizations can take over an hour, later ones minutes: a job that waited 45
  minutes fails naming the submission, and runs again once `xcrun notarytool info <id>` says
  Accepted.
- **The cask**: once both DMGs are attached, job `cask` downloads them back from the release,
  writes `walnut.rb` with both sha256s (`arch arm: "arm64", intel: "x64"`;
  `scripts/homebrew/cask.mjs`), installs it from GitHub with `brew install --cask` (Homebrew
  quarantines it, as a browser does), requires Gatekeeper to see a notarized Developer ID app,
  and attaches `walnut.rb`. The tap's workflow copies it to `Casks/walnut.rb` with the formula:
  `brew install --cask evanzhang008/tap/walnut`.
- **Updates**: see "How an install updates" below. The Mac app updates itself as a whole, T3
  Code's flow (`desktop/AppUpdater.swift`, `desktop/README.md#updates`): it checks the releases
  page 15 seconds after launch and every 4 minutes, offers `Walnut-<arch>.dmg` once the release
  has it, downloads it when the user says so, accepts it only when it satisfies the running app's
  designated requirement, and on "Restart to update" swaps itself and relaunches; the new app then
  installs the Walnut it carries over an older one. The cask says `auto_updates true` for it.

`release-archives.yml` is what a stable gets after npm and its GitHub Release: job `files`
asks the release whether it has the files, then `homebrew`, `mac-app` and the Node archives.

## Node archives (to be removed)

Until two stable releases after the first that ships the compiled file, every stable release
also gets the self-contained Node archives it shipped before, one per platform
(`open-walnut-X.Y.Z-<darwin|linux>-<arm64|x64>.tar.gz`), as a fallback for the installs made
from them. Remove jobs `support`, `build` and `publish` of `release-archives.yml` then, with
`scripts/runtime-bundle/` and the archive cases in `scripts/install.sh`,
`scripts/homebrew/formula.mjs`, `desktop/BundledRuntime.swift` (`Layout.archive`) and
`scripts/desktop-smoke.mjs` (each is marked). Every archive install has by then updated itself
onto the launcher package, and the next install.sh run moves it to the file.

An archive is the newest Node 22 from nodejs.org, checked against its SHASUMS256.txt, used as an
npm prefix with `open-walnut@X.Y.Z` installed into it by that Node's own npm (now the launcher
and this platform's file), and two launchers (`bin/walnut`, `bin/open-walnut`) that run that
Node on that package. `scripts/runtime-bundle/build.mjs` builds it for the machine it runs on
and refuses a version whose updater does not know the layout (the launcher package always
does). One runner per platform builds it from the version npm serves, installs the result with
`install.sh` and serves a session with no Node on PATH, then job `publish` adds their lines to
the release's `SHA256SUMS` (`scripts/release-archive-sums.sh`, before any upload: it lists the
assets, downloads `SHA256SUMS` only when the release has one and fails when that download does,
and writes nothing that would drop a compiled file's line) and attaches the archives and that
`SHA256SUMS`. Job `files` fails, rather than read "no files", when GitHub does not answer or
when a release holds the darwin-arm64 `.gz` that its `SHA256SUMS` does not list. The archive carries
`runtime/open-walnut-runtime.json`: the updater (`src/core/self-update/install-kind.ts`) sees it
and installs a newer release with the archive's own Node and npm into the archive's own prefix,
never with whatever `npm` is first on PATH. A version whose updater predates the archive (up to
0.6.2) gets none.

## Cutting a stable release by hand

For a release that should not wait for the schedule, or an exact version:

```bash
bun run release -- patch          # or minor, major, or an exact 0.6.0
bun run release -- patch --dry-run
```

`scripts/release.mjs` refuses to start when the branch is not `main`, `main` is not at
`origin/main`, CI did not pass on that commit (or is still running), the tag exists,
`package.json` or `CHANGELOG.md` has uncommitted edits, or
`CHANGELOG.md` has an empty `## [Unreleased]` section. Other uncommitted work in the tree
is fine and stays as it is: the release commit is HEAD plus those two files, built
through a private index, so nothing else that is staged or edited can slip into it.

Then it moves the Unreleased section under `## [X.Y.Z] - date` (and opens a fresh empty
Unreleased), sets the version in `package.json` (`bun.lock` holds no version), commits
`release: X.Y.Z`, tags `vX.Y.Z` and pushes both atomically. Nothing is built or published
on the machine that runs it.

The push of the tag starts `.github/workflows/release.yml`. Job `stable-build` checks the tag
against `package.json`, checks CI and the binary matrix again (`scripts/ci-gate.mjs release
HEAD`; a release commit only rolls the version and CHANGELOG, so its parent's result counts),
installs with `bun install --frozen-lockfile` (exactly the lockfiles, never rewritten, so the
build is not stamped dirty; `scripts/postinstall.mjs` installs `web/` frozen too when `CI` is
set), runs `bun run lint` and builds the files (`scripts/release-build.mjs`). Job
`stable-files` runs them through the binary matrix. Job `stable` packs those files and
publishes the platform packages and then `open-walnut` (`scripts/npm-packages.mjs publish --tag
latest --provenance`), drafts a GitHub Release whose notes are the version's CHANGELOG section,
attaches the files to it (`scripts/release-attach.sh`) and makes it public.

So the CHANGELOG discipline is the release discipline: write the user-facing entry under
`## [Unreleased]` with the change, and the next release, automatic or by hand, carries it.

## Nightlies

Job `nightly` of the same workflow checks whenever CI finishes on `main` and on every
scheduled run (above), and runs by hand (`workflow_dispatch`, with a `force` input
for a republish). A check publishes only when the `nightly` dist-tag is at least 4.5 hours
old (`scripts/nightly-version.mjs due`), so nightlies come about every six hours while
`main` moves. The gap is short of six hours because GitHub runs this repo's schedule only
every 3 to 6.5 hours, whatever the cron says: at 5.5 hours, a check that found the nightly
5.4 hours old handed the commit to one five hours later (2026-10-05). It asks for the newest commit
on `main` whose CI run passed (`scripts/ci-gate.mjs last-green main`): it walks the last 40
commits of `origin/main` in git, newest first, and asks GitHub about each one by its sha,
passing over a commit with no CI run (docs only, a release commit), a red, running or
cancelled one. It never reads the branch's run list: on 2026-10-05 that list answered from
a stale index for six hours (118 runs where there were 190, the newest a week old), and every
nightly took a week-old commit for the newest green one and published nothing. It does
nothing when no commit qualifies, when that commit is already the last nightly's, or when it
is not a descendant of it (a nightly must never move installs backwards). That last case,
and a commit older than the compiled file's release build (`scripts/release-build.mjs`),
leave a warning on the run. The last nightly's commit is the `gitHead` npm
records for the version under the `nightly` dist-tag (`scripts/nightly-version.mjs last`).
A `nightly` git tag used to say it, until 2026-10-03, when GitHub refused to move it: the
newest green commit trailed a `main` whose newest commit changed a workflow (see the token
rule above). Otherwise it checks that commit out, installs, sets the version with
`scripts/nightly-version.mjs` (next patch of the newer of `package.json` and the `latest`
version on npm, `-nightly.<UTC day>.<run number>`; the release commit an automatic stable
pushes gets no CI run, so the newest green commit can still name the previous version),
builds the files at that version (job `nightly-build`), runs them through the binary matrix
(`nightly-files`), and then job `nightly` asks again, right before it publishes, whether this
commit is still the next nightly (the same commit as the last nightly: skip; not a descendant
of it: a warning and nothing published; `force` overrides both), publishes the platform packages
of those files and then `open-walnut` under `--tag nightly` (a nightly has no GitHub Release:
its files live only in the run's artifact, for seven days), and waits until npm serves that
version (`scripts/nightly-version.mjs wait`; npm takes minutes to process a version it
accepted). The publish job's queue starts the next one only after that, so it never reads the
nightly before this one and publishes the same commit twice. Two runs that overlap may each
build and run the matrix before one of them finds it has nothing to publish. It
does not rerun the tests: CI already ran them on that exact commit, and a red `main` simply
means the nightly stays on the last green one. The version bump is never committed: a
nightly's version lives in the registry only, and `package.json` on `main` names the last
stable release.

## What "CI passed" means

`scripts/ci-gate.mjs` reads two workflows through `gh api`: in CI (`ci.yml`), the newest push
run for the commit and in it the `CI OK` job, which aggregates the blocking jobs (build,
quick tests, fresh-machine onboarding, remote host; report-only jobs do not count); then, only
for a commit CI passed, the newest push run of `binary-matrix.yml` for it, whose own
conclusion is the answer (every row). Both must be green. Both channels require it, because
every install updates itself on restart: a release that reaches npm reaches every install.
A commit whose matrix run was cancelled by a newer push is passed over like one whose CI was. Locally the release script asks the same question
through your signed-in `gh`; when `gh` is missing it says so and goes on, since the
workflow asks again before it publishes.

Why the version shape: it is semver, so the registry and the update check order nightlies
by day and run; `0.5.2-nightly.*` sorts below the stable `0.5.2` that eventually carries
the same work, so a release always outranks the nightlies before it; and the identifier
`nightly` is what the install reads to pick its channel.

## Authentication: npm trusted publishing

No npm token is stored in the repository or in GitHub secrets. The workflow has
`permissions: id-token: write` (and `actions: read`, for the CI check), and npm (11.5.1 or newer; the jobs install npm 12) exchanges
the GitHub OIDC token for a short-lived publish credential. `--provenance` attaches the
build attestation that npm shows on the package page.

One-time setup, by the package owner, signed in with two-factor authentication (npm
refuses it from a token that bypasses 2FA, which is what a publish token is):

```bash
npm login        # interactive, with your 2FA
npm trust github open-walnut --file release.yml --repo <owner>/open-walnut
```

or on npmjs.com: package `open-walnut` > Settings > Trusted publisher > GitHub Actions,
with the repository and the workflow file name `release.yml` (no environment). Until that
is done, the publish step fails with an authentication error and nothing else happens;
re-run the job afterwards (`gh run rerun <run-id> --failed`) and it publishes.

### npm packages

The six platform packages need the same, once, and npm sets up a trusted publisher only for
a package that exists. So before the first release that ships the file, the owner:

1. Creates the npm organization `open-walnut` (the `@open-walnut` scope), free for public
   packages.
2. Builds and publishes the platform packages once by hand, from a checkout at that release's
   commit, signed in with 2FA (`--provenance` only works from CI):

   ```bash
   bun install --frozen-lockfile
   bun scripts/release-build.mjs --version <x.y.z> --out /tmp/walnut-release
   for t in darwin-arm64 darwin-x64 linux-arm64 linux-x64 linux-arm64-musl linux-x64-musl; do
     npm publish "/tmp/walnut-release/npm/@open-walnut/$t" --access public --tag latest
   done
   ```

   (or any version, a `0.0.0-bootstrap.0` under `--tag bootstrap`: the release publishes its own
   versions on top). Leave `open-walnut` itself to the workflow.
3. Sets the trusted publisher on each: `npm trust github @open-walnut/<target> --file
   release.yml --repo <owner>/open-walnut`, or on npmjs.com as above.

Until a platform package has its trusted publisher, the release fails at that package, before
the launcher: nothing a user installs changes. `scripts/npm-packages.mjs publish` skips the
packages already up, so a re-run after the setup finishes the publish.

## npm 12

npm 12 changed two install defaults that Walnut depended on, and the 0.6.0 publish stopped
on the first one:

- **Tarball URL dependencies are refused** (`EALLOWREMOTE`). `web/` takes `xlsx` from the
  SheetJS CDN on purpose (current releases are not on the registry). A checkout installs
  with Bun, which takes it as `web/bun.lock` pins it; when a checkout is installed with npm
  anyway, `scripts/postinstall.mjs` passes `--allow-remote=root` to the `web/` install under npm 12.
- **A dependency's install script runs only when allowed.** Walnut no longer needs one. The
  platform packages run no install script and build nothing, and a checkout installs with Bun.
  The launcher's own postinstall only checks for its file; without it, as in
  `npm i -g open-walnut` typed with npm 12, the first start fetches the file instead. The
  update that `open-walnut web` and `open-walnut update` run passes npm
  `--allow-scripts=open-walnut`, that one script and nothing else, because the postinstall is
  what lets npm roll back when the platform file cannot be fetched (0.6.x's own update passes
  a list that names it too).

The release jobs install `npm@12`, not `npm@latest`, so the next major is taken on purpose
rather than discovered in a publish.

## How an install learns about a release

`src/core/self-update/` (checker, install kind, channel) and the surfaces that read it:

- The server asks `https://registry.npmjs.org/-/package/open-walnut/dist-tags` 20 seconds
  after it listens, then every 24 hours (an hour after a failure), 5 second deadline, in
  memory only. It compares its own version with the tag of its channel.
- The answer shows in the notification panel's System section (`Open Walnut` card), as an
  accent dot on the System rail, on the Settings build line, in `open-walnut doctor`, and
  once on stderr when `open-walnut web` runs in a terminal.
- `GET /api/system/update` serves the cached answer; `POST /api/system/update/check` asks
  now.
- A checkout run from source (`.git` next to `package.json`), a cloud replica, a test
  process and `WALNUT_NO_UPDATE_CHECK=1` never check.

## How an install updates

The running server never replaces its own files: the new version goes beside it, and an
update is applied by a restart. How Walnut was installed decides how it updates
(`src/core/self-update/install-kind.ts`, which reads it off the running file, never off a
guess):

| Install | Seen as | Update |
|---|---|---|
| `install.sh` (and the Mac app) | `binary`: the file is `<root>/versions/<v>/walnut` beside `open-walnut-install.json` | the same platform package an npm install gets, `@open-walnut/<target>@<v>` from the registry the update check reads, checked against its sha512 integrity, unpacked into `versions/<v>/` and run (`--version`), then `bin/walnut` swapped with one rename (`src/core/self-update/binary-install.ts`). The version before stays for a rollback, and any version a running server marked (`running/<pid>`); one update per root at a time (a lock naming its owner, taken over once that process is gone) |
| npm (pnpm, bun, yarn) | `npm`: started through the launcher, which names its package | `npm install -g open-walnut@<v>` through the manager that installed it; the restart runs the launcher again, which finds the new platform package |
| Homebrew | `other`: the file is inside a `Cellar/open-walnut/` keg | `brew upgrade open-walnut` (Walnut only names it) |
| A keg of the 0.6.x archive formula whose updater moved it onto the npm launcher | `npm` with the archive's prefix inside the keg, plus `homebrewKeg` | the archive's npm, as that formula promised; the update card and `walnut update` add that `brew upgrade open-walnut` moves it to the file, only while the tap's formula is newer than the keg's own version and not older than what the keg runs (`src/core/self-update/homebrew-keg.ts`) |
| A Node archive (until removed) | `npm` with the archive's own prefix | the archive's own Node and npm, into its prefix |

- `walnut update` installs the newer version now (as above) and reminds you that a running
  server keeps the old code until restarted. `--check` only reports;
  `--channel stable|nightly` follows the other channel.
- `open-walnut web` installs a newer published version before it listens, then starts
  again as the new code (the first process stays as a thin parent and forwards signals).
  The restart runs what started it: the `bin/walnut` link (now the new version) for the
  file, the launcher for npm. This is on by default for file and npm installs whose
  directory the process can write; a read-only prefix prints what to do and starts as it is. Turn it off in
  Settings > General > `Install updates on start`, with `updates.auto: false` in
  `config.yaml`, or with `WALNUT_NO_AUTO_UPDATE=1`. A failed install, a file download longer
  than a minute (a launcher such as the Mac app waits for the port), or a registry that does
  not answer, prints one line and starts the current version; a signal while it runs cleans
  up and starts nothing. After an npm install, the launcher must start the new version (npm
  can skip its platform package): one more install, else the version before goes back. The
  restarted server writes the file named in `WALNUT_STARTUP_READY_FILE` once it listens; one
  that exits non-zero before that is gone back from (the link, or `npm install -g` of the
  version before), and the new version is held back until a newer release
  (`src/core/self-update/held-versions.ts`: `<root>/bad/<v>` for the file, the machine-local
  `~/.open-walnut/local/update-bad/<v>` for npm; a binary install moved back by hand holds back
  the newer version it still has beside it). `walnut update` installs a held version when asked;
  `walnut update --auto` (what the Mac app runs while its server is up, starting that server with
  `WALNUT_LAUNCHER_UPDATES=1` so it never updates before listening) keeps `updates.auto` and the
  held versions.

## Checklist for a release

1. `## [Unreleased]` in CHANGELOG.md says what changed, for a person who installs from npm.
2. `main` is pushed and CI passed on it (the script checks, and so does the workflow).
3. `bun run release -- <bump>`.
4. Watch the Release workflow; the GitHub Release appears when npm has the version.
5. An install on the stable channel shows the new version in its System card within a day,
   or at once after `Check now`.
