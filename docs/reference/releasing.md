# Releasing

How a change in `main` reaches an install, in both directions: how we publish, and how
an install finds out and updates.

## The two channels

| Channel | npm dist-tag | What it is | How it is cut |
|---|---|---|---|
| stable | `latest` | A tagged release `vX.Y.Z` with a CHANGELOG section | Automatic, once a day: the newest nightly that has been out 24 hours. By hand: `npm run release -- patch\|minor\|major` |
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
   minor, `fix`/`perf` patch.
2. **Smoke** (Linux and macOS, in parallel). Each runner installs that exact nightly from
   npm the way the updater does (npm 12, the same `--allow-scripts` list), starts it on a
   fresh HOME and requires `/api/system/health` to answer. Every npm install updates itself
   on restart and nothing rolls a broken update back, so a release must start on a machine
   that has never run Walnut.
3. **Publish.** It checks out the candidate, installs with `npm ci`, sets the version and
   runs `npm publish --provenance --access public` (`prepublishOnly` builds and checks the
   tarball as for any publish), waits until npm serves the version as `latest`, tags
   `vX.Y.Z` on the candidate, and opens the GitHub Release. npm holds a version it accepted
   for minutes before it serves it, and the run queued behind this one reads npm to learn
   whether the version is out: on 2026-10-09 two runs planned 0.6.7 two minutes apart, the
   second found nothing at the registry and npm refused its publish with 409 "Cannot
   publish over previously staged version". So the job ends only once npm serves the
   version to that same check, and npm's refusal of this very version (held or published) counts as
   published; the tag step still requires the tag on the candidate.
4. **Roll main.** A `release: X.Y.Z` commit on `main` moves the released entries from
   Unreleased under `## [X.Y.Z] - date`, keeps the entries written since the candidate, and
   sets the version in `package.json` and `package-lock.json`. A push that loses the race
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
nightly without the 24 hour soak and the smoke installs and starts it, but nothing is
published (`gh workflow run release.yml -f channel=stable -f dry_run=true`). To pause automatic releases, disable the Release
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
| field | the version on npm today, started, updates itself to "current": the update every existing install will take |
| archive | `scripts/runtime-bundle/build.mjs` builds the self-contained archive of "older" for this machine; `scripts/install.sh` finds it on a local server laid out like GitHub Releases, checks it and installs it |
| archive-serve | that install serves, finds `claude` and answers a session with no Node on PATH, and its updater says `walnut update` |
| archive-brew | the Homebrew formula written for it installs from a scratch tap and passes `brew test` (Homebrew comes with both runner images) |
| archive-app | (macOS) `Walnut.app`, built from this commit by `desktop/build.sh`, installs that archive on its first launch with the `install.sh` inside it, serves the console with no Node on PATH, takes its server with it when it dies, and starts again without downloading (`scripts/desktop-smoke.mjs`) |
| archive-update | that install, started, updates itself to "current" through its own Node's npm |

The two update scenarios use `registry.mjs`, a local registry that serves the chosen
tarballs under chosen dist-tags and passes every other package through to npm, with
`WALNUT_UPDATE_REGISTRY_URL` and `npm_config_registry` pointing at it. Locally, run
`pack.mjs` only in a copy of the tree (it rebuilds `dist/` and refuses to touch a git clone
outside CI), then `node scripts/release-rehearsal/run.mjs --packs <out>/packs.json --field latest`.

The rehearsal runs on `macos-26` and `ubuntu-24.04`, so it builds the darwin-arm64 and
linux-x64 archives. CI job `archive-targets` builds the other two a release ships
(darwin-x64 on `macos-26-intel`, linux-arm64 on `ubuntu-24.04-arm`) from the same packed
commit and runs each the way `release-archives.yml` does (`run.mjs --archive`: install.sh,
serve and a session with no Node on PATH). CI OK needs it, so no target is first built at
release time: 0.6.4's darwin-x64 archive was (2026-10-06), and failed.

## Self-contained archives, install.sh and Homebrew

Every stable release also ships one archive per platform (`open-walnut-X.Y.Z-<darwin|linux>-<arm64|x64>.tar.gz`):
the newest Node 22 from nodejs.org, checked against its SHASUMS256.txt, used as an npm prefix
with `open-walnut@X.Y.Z` installed into it by that Node's own npm, the other platforms' native
binaries dropped, and two launchers (`bin/walnut`, `bin/open-walnut`) that run that Node on that
package. `scripts/runtime-bundle/build.mjs` builds it for the machine it runs on and refuses a
version whose updater does not know the layout. Each native module must load in the archive,
except one whose package ships no binary for that platform: onnxruntime-node 1.24 has none for
darwin-x64, so that archive goes without semantic search and Walnut answers with keyword search.

- **Built by** `.github/workflows/release-archives.yml`, which job `promote` (or `stable`)
  starts once the GitHub Release is open: one runner per platform builds from the version npm
  serves, installs the result with `install.sh` and serves a session with no Node on PATH, then
  job `publish` attaches the archives, and only after them `SHA256SUMS` and `install.sh`. Job
  `homebrew` writes the formula from that `SHA256SUMS` (`scripts/homebrew/formula.mjs`),
  installs it from GitHub with brew, runs `brew test` and attaches `open-walnut.rb`. A platform
  that failed is left out and the run is red; "Re-run failed jobs" finishes the set. By hand:
  dispatch it with any released version to rebuild its archives. Job `support` runs first
  (`build.mjs --check`): a version whose updater predates the archive gets no archives and the
  run stays green. That is every release up to 0.6.2, and a stable promoted from a nightly built
  before the archive existed.
- **`install.sh`** (`curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh | sh`)
  reads the version from the newest release's `SHA256SUMS`; in the minutes before a release's
  archives are up it takes the newest release that has one for this platform (GitHub's API).
  It checks the download against `SHA256SUMS`, runs the new `walnut --version` before it touches
  anything, and swaps the old copy aside so a failure leaves one in place.
- **Homebrew**: the tap `EvanZhang008/homebrew-tap` copies the newest release's `open-walnut.rb`
  (its own workflow, hourly). The formula keeps the archive packed through `install` and unpacks
  it in `post_install_steps`: Homebrew rewrites the install name of every Mach-O file in a keg it
  builds, and one prebuilt native module has no header room for that, so `brew install` failed.
- **The Mac app**: job `mac-app` (`.github/workflows/mac-app.yml`) builds one `Walnut.app` per
  Mac architecture from the release's tag, each carrying that release's archive for it
  (`Contents/Resources/release/v<version>/`, beside the release's `SHA256SUMS`;
  `scripts/desktop-carry-release.mjs`), signs it with the Developer ID Application identity
  (hardened runtime, `desktop/Walnut.entitlements`), notarizes and staples the app and then its
  DMG, has Gatekeeper assess the DMG with a browser's quarantine mark on it, launches the mounted
  app on a fresh `HOME`, and only then attaches `Walnut-arm64.dmg` and `Walnut-x64.dmg`. On the
  Apple silicon runner the arm64 app must install what it carries with every release URL dead;
  the x64 app takes the path an Intel DMG takes on Apple silicon and downloads the arm64 build.
  The app comes from the tag; the smoke that launches it comes from the workflow's own commit (a
  second checkout in `harness/`), so a fix to the check reaches every release it judges, and it
  still starts an app older than itself. `app_ref` on a dispatch builds another commit's app on a
  released Walnut, through every check, and never attaches it. The identity
  (`MACOS_CERT_P12_BASE64`, `MACOS_CERT_P12_PASSWORD`) and the notary key
  (`APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, an App Store Connect API
  key with the Developer role) are secrets of the `release` environment, which only `main` may
  deploy to; the identity goes into a keychain made for the job and deleted after it. Without
  them the apps are built ad-hoc and kept as workflow artifacts, never attached. A release older
  than the carrying app gets none. The app is a signed shell that is never modified: its first
  launch starts by itself (no setup screen), runs the bundled `install.sh` on what it carries (or
  downloads it with a progress bar read off curl's, `OPEN_WALNUT_PROGRESS=1`) and opens the
  console, and the runtime it installed updates itself like any archive install. A team's first
  notarizations can take over an hour, later ones minutes: a job that waited 45 minutes fails
  naming the submission, and runs again once `xcrun notarytool info <id>` says Accepted.
- **The cask**: once both DMGs are attached, job `cask` downloads them back from the release,
  writes `walnut.rb` with both sha256s (`arch arm: "arm64", intel: "x64"`;
  `scripts/homebrew/cask.mjs`), installs it from GitHub with `brew install --cask` (Homebrew
  quarantines it, as a browser does), requires Gatekeeper to see a notarized Developer ID app,
  and attaches `walnut.rb`. The tap's workflow copies it to `Casks/walnut.rb` with the formula:
  `brew install --cask evanzhang008/tap/walnut`.
- **Updates**: the archive carries `runtime/open-walnut-runtime.json`. The updater
  (`src/core/self-update/install-kind.ts`) sees it and installs a newer release with the
  archive's own Node and npm into the archive's own prefix (`walnut update`, and on start), never
  with whatever `npm` is first on PATH. A Homebrew install updates the same way, inside its keg.

## Cutting a stable release by hand

For a release that should not wait for the schedule, or an exact version:

```bash
npm run release -- patch          # or minor, major, or an exact 0.6.0
npm run release -- patch --dry-run
```

`scripts/release.mjs` refuses to start when the branch is not `main`, `main` is not at
`origin/main`, CI did not pass on that commit (or is still running), the tag exists,
`package.json`, `package-lock.json` or `CHANGELOG.md` has uncommitted edits, or
`CHANGELOG.md` has an empty `## [Unreleased]` section. Other uncommitted work in the tree
is fine and stays as it is: the release commit is HEAD plus those three files, built
through a private index, so nothing else that is staged or edited can slip into it.

Then it moves the Unreleased section under `## [X.Y.Z] - date` (and opens a fresh empty
Unreleased), sets the version in `package.json` and `package-lock.json`, commits
`release: X.Y.Z`, tags `vX.Y.Z` and pushes both atomically. Nothing is built or published
on the machine that runs it.

The push of the tag starts `.github/workflows/release.yml`, job `stable`: it checks the tag
against `package.json`, checks CI again (`scripts/ci-gate.mjs release HEAD`; a release
commit only rolls the version and CHANGELOG, so its parent's result counts), installs with
`npm ci` (exactly the lockfiles, never rewritten, so the build is not stamped dirty),
runs `npm run lint`, and runs `npm publish --provenance --access public`. `prepublishOnly` does the real build (`WALNUT_REQUIRE_BUN=1 npm run
build`, the web app, `scripts/check-publish.mjs` against the tarball), so a publish can
never ship a stale or partial `dist/`. The job then creates a GitHub Release whose notes
are the version's CHANGELOG section.

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
and a commit older than the nightly pipeline itself, leave a warning on the run: either
means the lookup went wrong. The last nightly's commit is the `gitHead` npm
records for the version under the `nightly` dist-tag (`scripts/nightly-version.mjs last`).
A `nightly` git tag used to say it, until 2026-10-03, when GitHub refused to move it: the
newest green commit trailed a `main` whose newest commit changed a workflow (see the token
rule above). Otherwise it checks that commit out, installs, sets the version with
`scripts/nightly-version.mjs` (next patch of the newer of `package.json` and the `latest`
version on npm, `-nightly.<UTC day>.<run number>`; the release commit an automatic stable
pushes gets no CI run, so the newest green commit can still name the previous version),
publishes under `--tag nightly`, and waits until npm serves that version
(`scripts/nightly-version.mjs wait`; npm takes minutes to process a version it accepted).
The job's queue starts the next check only after that, so it never reads the nightly
before this one and publishes the same commit twice. It
does not rerun the tests: CI already ran them on that exact commit, and a red `main` simply
means the nightly stays on the last green one. The version bump is never committed: a
nightly's version lives in the registry only, and `package.json` on `main` names the last
stable release.

## What "CI passed" means

`scripts/ci-gate.mjs` reads the CI workflow (`ci.yml`) through `gh api`: the newest push
run for the commit, and in it the `CI OK` job, which aggregates the blocking jobs (build,
quick tests, fresh-machine onboarding, remote host). Report-only jobs do not count. Both
channels require it, because every npm install updates itself on restart: a release that
reaches npm reaches every install. Locally the release script asks the same question
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

## npm 12

npm 12 changed two install defaults that Walnut depends on, and the 0.6.0 publish stopped
on the first one:

- **Tarball URL dependencies are refused** (`EALLOWREMOTE`). `web/` takes `xlsx` from the
  SheetJS CDN on purpose (current releases are not on the registry), so
  `scripts/postinstall.mjs` passes `--allow-remote=root` to the `web/` install under npm 12.
- **A dependency's install script runs only when allowed.** better-sqlite3 and node-pty
  fetch their native binaries in theirs, so without it Walnut cannot open its database.
  `allowScripts` in `package.json` allows them for a checkout and for `npm rebuild` inside
  the installed package. A global install has no project to allow them in, so the update
  that `open-walnut web` and `open-walnut update` run passes `--allow-scripts` with the same
  list (`INSTALL_SCRIPT_PACKAGES` in `src/core/self-update/install-kind.ts`; a test keeps it,
  `allowScripts` and the lockfile in step). A plain `npm install -g open-walnut` still
  lands without the binaries; the first start notices (`src/core/native-abi-preflight.ts`)
  and runs `npm rebuild` in the package once, which takes about 15 seconds.

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

The running server never replaces its own files: `dist/` is hundreds of content-hashed
chunks the server imports lazily, and replacing them under a live process makes the next
lazy import fail (the same reason `scripts/dev-prod.sh` runs a staged copy). An update is
applied by a restart, in one of two ways:

- `open-walnut update` installs the newer version now through the package manager that
  installed Walnut (npm, pnpm, bun or yarn, read off the install path; for a self-contained
  archive, the archive's own Node and npm) and reminds you that
  a running server keeps the old code until restarted. `--check` only reports;
  `--channel stable|nightly` follows the other channel.
- `open-walnut web` installs a newer published version before it listens, then starts
  again as the new code (the first process stays as a thin parent and forwards signals).
  This is on by default for npm installs whose directory the process can write; a
  read-only prefix prints the `sudo` command and starts as it is. Turn it off in
  Settings > General > `Install updates on start`, with `updates.auto: false` in
  `config.yaml`, or with `WALNUT_NO_AUTO_UPDATE=1`. A failed install, or a registry that does
  not answer, prints one line and starts the current version.

## Checklist for a release

1. `## [Unreleased]` in CHANGELOG.md says what changed, for a person who installs from npm.
2. `main` is pushed and CI passed on it (the script checks, and so does the workflow).
3. `npm run release -- <bump>`.
4. Watch the Release workflow; the GitHub Release appears when npm has the version.
5. An install on the stable channel shows the new version in its System card within a day,
   or at once after `Check now`.
