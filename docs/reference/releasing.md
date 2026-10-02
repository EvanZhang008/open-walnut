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
promote a nightly that users on the nightly channel have run for a day. The schedule checks
every hour (`37 * * * *` UTC) and a check does nothing until the last stable is 23 hours old
(`MIN_GAP_HOURS`), because GitHub delays scheduled runs under load and sometimes drops them:
one daily slot could skip a day without anyone noticing, an hourly check costs an hour at
most. A run by hand skips the gap.

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
   tarball as for any publish), tags `vX.Y.Z` on the candidate, and opens the GitHub
   Release.
4. **Roll main.** A `release: X.Y.Z` commit on `main` moves the released entries from
   Unreleased under `## [X.Y.Z] - date`, keeps the entries written since the candidate, and
   sets the version in `package.json` and `package-lock.json`. When the push loses a race
   three times the job warns and stops: the package is out, and the next nightly still
   builds above it (see Nightlies).

The notes are the Unreleased section as it stood at the candidate. When nobody wrote one,
they are the `feat` subjects (Added) and the `fix`/`perf` subjects (Fixed), so a
user-facing CHANGELOG entry is still the better habit. A failed run is the only thing that
needs a person: GitHub mails it, and nothing was published.

Tag and commit are pushed with the job's own token, which starts no workflow, so the tag
cannot publish a second time through job `stable` and the release commit gets no CI run of
its own (it changes only the version files and CHANGELOG).

To promote now instead of waiting for the schedule: Actions, Release, Run workflow, channel
`stable` (the same plan and smoke run). To pause automatic releases, disable the Release
workflow's schedule or the workflow itself in the Actions tab; nightlies stop with it.

## What CI proves before anything ships

Both channels publish only a commit whose `CI OK` passed (see below), and `CI OK` needs:

| Job | What it proves |
|---|---|
| Lint & build | `tsc`, the full build, the plugin packages |
| Test (quick), Test (frontend) | ~300 pure-logic files and the web suites; quick is judged against its recorded baseline |
| Test (slow) | ~1,000 tests that start real daemons, servers, git and the local embedder; must pass (`--retry=2` absorbs a runner hiccup, three failures in a row is a failure) |
| Fresh machine (Linux, macOS) | the README's two install routes on a machine without Bun or Claude Code |
| Remote host | Walnut provisions a clean Linux dev box over real ssh and starts a session there |
| Release rehearsal (Linux, macOS) | the package this commit would publish, end to end (next section) |

Two more suites run on every push and report without blocking until they have a recorded
baseline: the e2e tier (real servers with a mock CLI; each run uploads its failures as the
`known-failures-e2e` artifact, the baseline that will let new failures block) and the
Playwright browser suite (eight shards, summary per shard in the run page).

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

The two update scenarios use `registry.mjs`, a local registry that serves the chosen
tarballs under chosen dist-tags and passes every other package through to npm, with
`WALNUT_UPDATE_REGISTRY_URL` and `npm_config_registry` pointing at it. Locally, run
`pack.mjs` only in a copy of the tree (it rebuilds `dist/` and refuses to touch a git clone
outside CI), then `node scripts/release-rehearsal/run.mjs --packs <out>/packs.json --field latest`.

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

Job `nightly` of the same workflow checks every 30 minutes (`17,47 * * * *` UTC) and runs by
hand (`workflow_dispatch`, with a `force` input for a republish). A scheduled check
publishes only when the `nightly` dist-tag is at least 5.5 hours old
(`scripts/nightly-version.mjs due`), so nightlies come about every six hours and a dropped
run costs half an hour (the 06:17 run of 2026-10-02, when the schedule was a plain six-hourly
cron, never ran at all). It asks for the newest commit
on `main` whose CI run passed (`scripts/ci-gate.mjs last-green main`), and does nothing
when there is none among the last 30 runs, when that commit is already the `nightly` tag,
or when it is not a descendant of that tag (GitHub's runs list can show a finished run as
still running for a minute or two, so the newest green may be an older commit, and a
nightly must never move installs backwards). Otherwise it checks that commit out, installs, sets the version with
`scripts/nightly-version.mjs` (next patch of the newer of `package.json` and the `latest`
version on npm, `-nightly.<UTC day>.<run number>`; the release commit an automatic stable
pushes gets no CI run, so the newest green commit can still name the previous version), publishes under `--tag nightly`, and moves the `nightly` tag to the commit. It
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
  installed Walnut (npm, pnpm, bun or yarn, read off the install path) and reminds you that
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
