# Releasing

How a change in `main` reaches an install, in both directions: how we publish, and how
an install finds out and updates.

## The two channels

| Channel | npm dist-tag | What it is | How it is cut |
|---|---|---|---|
| stable | `latest` | A tagged release `vX.Y.Z` with a CHANGELOG section | `npm run release -- patch\|minor\|major` on a clean, pushed `main` |
| nightly | `nightly` | The newest commit on `main` that CI passed | GitHub Actions, twice a day, when that commit is not the last nightly already |

`npm install -g open-walnut` gives the stable channel. `npm install -g open-walnut@nightly`
switches an install to nightly; the installed version (`X.Y.Z-nightly.YYYYMMDD.N`) is how
the install knows which channel it follows, so it keeps following nightly until `@latest`
is installed again. Pre-1.0, a minor bump may carry breaking changes (see CHANGELOG).

## Cutting a stable release

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
commit only rolls the version and CHANGELOG, so its parent's result counts), installs,
runs `npm run lint`, and runs `npm publish --provenance --access public`. `prepublishOnly` does the real build (`WALNUT_REQUIRE_BUN=1 npm run
build`, the web app, `scripts/check-publish.mjs` against the tarball), so a publish can
never ship a stale or partial `dist/`. The job then creates a GitHub Release whose notes
are the version's CHANGELOG section.

So the CHANGELOG discipline is the release discipline: write the user-facing entry under
`## [Unreleased]` with the change, and the release is a one-liner later.

## Nightlies

Job `nightly` of the same workflow runs on a schedule (`17 5,17 * * *` UTC) and by hand
(`workflow_dispatch`, with a `force` input for a republish). It asks for the newest commit
on `main` whose CI run passed (`scripts/ci-gate.mjs last-green main`), and does nothing
when there is none among the last 30 runs, when that commit is already the `nightly` tag,
or when it is not a descendant of that tag (GitHub's runs list can show a finished run as
still running for a minute or two, so the newest green may be an older commit, and a
nightly must never move installs backwards). Otherwise it checks that commit out, installs, sets the version with
`scripts/nightly-version.mjs` (next patch of `package.json`, `-nightly.<UTC day>.<run
number>`), publishes under `--tag nightly`, and moves the `nightly` tag to the commit. It
does not rerun the tests: CI already ran them on that exact commit, and a red `main` simply
means the nightly stays on the last green one. The version bump is never committed: a
nightly's version lives in the registry only, and `package.json` on `main` keeps naming the
last stable release.

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
