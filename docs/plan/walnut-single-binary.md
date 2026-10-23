# Walnut as one file

Status: in progress, 2026-10-22. Decision: Walnut moves to bun completely (runtime,
tests, installs); Node stays only where a tool needs it (the Playwright runner).

## Goal

Walnut runs from one compiled file per platform, like Claude Code and like
Walnut's own session daemon. A person installs nothing first: no Node, no bun,
no npm, no compiler, no sudo. Big parts that only some people use are
downloaded the first time they are used. The same file serves every way Walnut
reaches a machine:

- the first install (`curl -fsSL .../install.sh | sh`), Homebrew and the Mac app;
- a host server: the Mac pushes the file to the host over the daemon's
  existing chunked SSH path and starts it there; the host needs no network;
- an update, which swaps one file.

The only thing a person does by hand is sign in to the services they use.

## Why

Today Walnut ships as Node plus an npm-installed `node_modules`. The
self-contained Linux archive (0.6.16, 305 MB compressed, about 1.07 GB unpacked)
does not run on a glibc 2.26 system at all, measured on one: its Node needs
glibc 2.28, and the native modules built on Ubuntu 24.04 need up to 2.29.

| Part of the archive | Needs glibc |
|---|---|
| Node 22 (official build) | 2.28 |
| better-sqlite3 (built on Ubuntu 24.04) | 2.29 |
| node-pty, the SDK's vendored ripgrep | 2.28 |
| sharp, onnxruntime-node | 2.14 to 2.17 |

A host server installs its dependencies on the host with npm, so it also needs
Node 22 or newer, network access to the registry, and a C++20 compiler. Each
of these is a step a person has to take, and the reason a host server did not
start on a machine where the session daemon, a bun-compiled file, runs fine.

## How others do it

| Project | Build | What a person gets |
|---|---|---|
| Claude Code | `bun build --compile` | one file (216 MB on macOS arm64; the bun runtime plus a 157 MB `__BUN` segment of its own code and assets) |
| T3 Code | Node single executable (SEA) | an executable plus a small `node_modules` beside it for node-pty; SQLite through the built-in `node:sqlite` |
| Tailscale | Go | one static file |
| Walnut session daemon | `bun build --compile` | one file (61 MB) |

The common shape: compile once on the builder, ship one file, download big
optional parts on demand (Ollama's models, VS Code's extensions).

Bun over a Node single executable: the daemon already proves a bun-compiled
file runs on the glibc 2.26 system, bun has SQLite and a pseudo terminal built
in (`bun:sqlite`, `Bun.Terminal`), and official Node builds need glibc 2.28.

One toolchain from development to release, like every project above: a Go
project uses `go` for dependencies, tests and builds, and the bun-shipped
TypeScript projects (OpenCode, for one) use `bun install`, `bun test` and
`bun build --compile`, with Node only for the Playwright test runner in CI. The
runtime the tests run on is the runtime people get.

## Size: what stays in the file and what is downloaded

Measured in the 0.6.16 Linux archive:

| Part | Size | Where it goes |
|---|---|---|
| `@openai/codex-linux-x64` | 301 MB | Nowhere. It is a hard dependency of the Codex ACP adapter, but Walnut never runs it: a Codex session always uses the person's own Codex (`CODEX_PATH`, fail-closed, `src/providers/acp-session.ts`). Left out of the bundle. |
| `onnxruntime-web` | 141 MB | Nowhere. A dependency of the embedding library that the server never loads. |
| `onnxruntime-node`, `@huggingface/transformers` | 82 MB | Component `embedding`, downloaded when search by meaning is turned on. The model itself is already downloaded on first use. |
| Node runtime | 120 MB | Replaced by the bun runtime inside the file (about 60 MB). |
| `sharp` and its libvips | 17 MB | Component `images`, downloaded when an image first needs resizing. |
| Speech runtime | | Already a downloaded component (`stt-runtime-*` releases). |
| `esbuild` | 11 MB | Replaced by bun's own transpiler for plugin code. |
| Everything else (Express, the SDKs, the web app) | about 250 MB as installed | Bundled and minified into the file. |

First measurement (step 0, macOS arm64, bun 1.3.9): `bun build --compile
src/cli.ts` bundles 3638 modules in under one second into a 78 MB file, before
the web assets. Budget: the core file stays under 150 MB unpacked and under
60 MB compressed; a CI check fails the build past it.

## Components

A component is a versioned, platform-specific archive on a GitHub prerelease
(`component-<name>-<version>`). The compiled file pins the SHA-256 of the tar
inside each archive (`src/core/components/manifest-data.ts`), so an archive is
trusted because this Walnut names it, and a published version never changes its
bytes. Walnut downloads one when a feature that needs it is first used, checks
the tar while it unpacks it, and renames it into
`~/.open-walnut/components/<name>/<version>/<platform>/` only when it matches.
The speech runtime uses the same downloader and tar reader.

- A feature whose component is missing says so in its own place ("Downloading
  search by meaning, 40 MB") and starts working when the download finishes.
- No core feature needs a component: tasks, sessions, the board, notes, keyword
  search and the tunnel all work from the file alone.
- A host without internet access installs an archive placed in
  `components/.downloads/`. Sending it there from the Mac is not built yet.

## One runtime

Everything runs on bun: the server, the tests, the dev server, the build
scripts. There is no second runtime to keep in step.

- SQLite is `src/lib/sqlite.ts`: the better-sqlite3 API the code was written
  against (41 files), provided over `bun:sqlite`. better-sqlite3 cannot load on
  bun at all: it calls V8's C++ API directly (333 uses, no N-API), and bun runs
  on JavaScriptCore. During the move the module still hands Node processes
  better-sqlite3; that branch goes when nothing runs on Node.
  `tests/lib/sqlite.test.ts` pins the differences it covers: no busy timeout by
  default, `null` for a missing row, Uint8Array BLOBs, no `pragma`/`pluck`/
  `raw`/`backup`, named parameters only in strict mode.
- On macOS, bun:sqlite would load Apple's system SQLite, so the darwin files
  carry an upstream one instead: `scripts/build-sqlite-dylib.mjs` compiles the
  pinned release (universal, macOS 13+) and the file unpacks it with its tree;
  `walnut __selftest` fails when Apple's is the one loaded. The dylib is built
  with clang on macOS, so every job that builds the files runs on a macOS
  runner, which also signs the darwin-x64 file with `codesign`.
- The terminal uses `Bun.Terminal` (no native module).
- Plugin TypeScript loads directly (bun runs TypeScript), so the plugin loader
  needs no esbuild.
- N-API modules (sharp, onnxruntime-node, node-pty) load on bun; the big ones
  are components, outside the file.

## Developer experience

A developer installs bun once and nothing else:

```sh
curl -fsSL https://bun.sh/install | bash
bun install
bun run dev
bun run test
bun run build:binary   # the file for this machine; any other target too
```

- Dependencies: `bun install` with `bun.lock`; patches through bun's own
  `patchedDependencies`.
- Tests: vitest keeps its API and files and runs on bun (`bun --bun vitest`).
  bun 1.3.9 had a bug that made this unsafe (a reused worker exited after its
  first file and the run still exited 0); bun 1.4.4 fixed it, and the run
  checks that the number of files that ran equals the number collected.
- The binary tier boots the compiled file as a real server and runs the
  black-box suites against it (Playwright, the live tiers).
- Production on the Mac runs the file (`scripts/deploy-committed.sh` builds
  it, smoke-boots it, keeps the last good one for rollback). One build-binary
  run makes the Mac's file and the four Linux files, staged side by side
  (`<stage>/dist-bin/walnut-<target>`) so a host server takes the same commit's
  file; the runtime tree is unpacked into `<stage>/runtime/`, not the data home.
  The way back from a bad file is the last good file (the LKG rollback); there
  is no other runtime to deploy, and `WALNUT_DEVPROD_RUNTIME=node` is refused.
  `WALNUT_DEVPROD_REHEARSAL=1` runs the whole deploy on a private port and data
  dir (AGENTS.md, "Production Server Safety").
- Every dev script runs on bun: `bun run start` and `bun run dev:ephemeral`
  build dist/ and run `bun dist/cli.js`, the sandbox (`scripts/walnut-sandbox.sh`)
  and the onboarding harness do the same, and the build runs its node-shebang
  tools (tsup, vite) on bun with `--bun`. The server bundle is byte-identical to
  a node-run build; the web bundle differs in one equivalent token of vite's
  preload helper.
- `npm install -g open-walnut` keeps working for people who use npm: the
  package becomes a small launcher whose optional dependencies are one package
  per platform holding the file (the way esbuild and the Codex CLI ship).
- The Mac app installs the file with the install.sh it carries, for Get Started
  and for "Set Up Now" on a folder (its data then lives there). A setup an older
  app built as an npm checkout in `<data home>/source` moves to the file on its
  next launch. A checkout the user picks runs on bun (at least the bun its
  package.json pins).

## The cloud companion

The companion box (`scripts/cloud/setup.sh`, `scripts/cloud/ensure-harness.sh`,
`scripts/cloud/companion-launch.mjs`, `src/core/companion-build/`) moves in two
phases.

**Phase A (done): the box runs the dist on bun.** setup.sh builds the base tree
with bun (`bun install --frozen-lockfile`, `bun --bun run build`, the web app
with vite on bun), and the unit starts `<bun> dist/cli.js web`. The launcher
drop-in takes its runtime from the unit's first word, or bun from PATH, never
node. A box set up before keeps its old unit, which names node, until setup.sh
writes it again; a deploy to such a box has to run setup.sh (or rewrite the
unit) once Walnut no longer runs on Node. The launcher and the harness seed
script run on bun (the seed script with `--no-install`, so bun never fetches a
missing package from the registry). Node and npm stay on the box for one
reason: third-party agent CLIs (Codex and others) and Claude Code's npm
fallback install from npm. The Mac still sends a dist (`/bridge/build`), and the
box installs its dependencies in `deps/<hash>` (`installScript` in
`src/core/host-server/install.ts`), as before.

The gap phase A leaves: a Mac that runs the compiled file has no dist to send
(`runningDist()` is null there), so it cannot update its companion. The
Settings line says so ("the companion still takes only a built checkout"). A
Mac running a built checkout (`bun dist/cli.js web`) still can.

**Phase B (planned): the box runs the compiled linux-arm64 file.** Host servers
already install the file over SSH (`fileInstallScript`, `createHostFileSource`
in `src/core/host-server/`); the companion takes the same file through its door.

1. Wire (`wire.ts`): `BUILD_SCHEMA` 2. The box status says which kinds it takes
   (`takes: ['dist', 'file']`) and its file target (`linux-arm64`, from
   `host-target.ts`). The install request gains a file kind:
   `{ id, kind: 'file', version, commit, sha256 }` (no dependencies, no
   package.json). The upload stays the chunked PUT; the package is the file's
   gz instead of the dist tgz. A schema 1 box gets a dist, as today. The
   status names the runtime it runs (today `node: process.version`, which on
   bun is a compatibility string).
2. Mac (`mac.ts`): for a box that takes a file, the package comes from
   `createHostFileSource` (the sibling file in the stage's `dist-bin/`, a build
   of the checkout, or a published release), so the companion and every host
   server run the same file of the same build. A compiled-file Mac and a box
   that takes only a dist: the state names the one-time fix (run setup.sh on
   the box again).
3. Box (`box.ts`, `box-smoke.ts`): a file install runs `fileInstallScript` with
   the companion's root (unpack, sha256, `--version`, `__selftest`, `.ready`
   last); the smoke boot runs `app/<id>/walnut web` with its own data, daemon
   and runtime dirs. Prune keeps current, trial and the running build, as now.
4. Launcher (`companion-launch.mjs`): `isReady` takes `.ready` with either
   `walnut` or `dist/cli.js`. A file starts as `app/<id>/walnut web`, a dist as
   `<runtime> app/<id>/dist/cli.js web`; `stopStaleServer` learns the file's
   command line too (it matches `cli.js` today). The drop-in from
   ensure-harness.sh, and its rollback branch, name the file when the base is
   one. The file's runtime tree goes to `<root>/runtime` in the service user's
   home (`WALNUT_RUNTIME_DIR`), never root's code tree; trees are named by
   build, so a trial and the current build share the dir.
5. setup.sh, later: the base tree becomes the release file from install.sh,
   and the launcher a subcommand of the file. Then bun leaves the box, and Node
   stays only for npm-installed agent CLIs.

Proof before it ships: the box tests for both kinds; the launcher tests; a
linux-arm64 container (Docker on an arm64 Mac, no systemd) that runs the
launcher on a temp root while a test Mac server pushes a file through the door
(install, smoke, trial, current, then a broken file that is given up); and a
schema 1 box still updated with a dist. It was not done in the bun move
because it changes both sides of a live protocol with a version handshake,
and the end-to-end proof needs the real box, which this work may not touch.

## CI: every system, old and new

Part of the requirement, not an extra. A release is published only when the
file passes on every row:

| Platform | Systems |
|---|---|
| Linux x64, glibc | glibc 2.17 (CentOS 7), 2.26 (openSUSE Leap 15.2), 2.27 (Ubuntu 18.04), 2.28 (Debian 10), Ubuntu 20.04, 22.04, 24.04, newest Fedora |
| Linux x64, musl | Alpine, oldest and newest supported |
| Linux arm64 | Ubuntu 20.04 and 24.04, Debian 12 |
| macOS | oldest bun supports (13), and the newest; arm64 and x64 |
| Old CPUs | Linux x64 builds use bun's `baseline` target (no AVX2) |
| Old kernels | One VM job at bun's kernel floor: containers share the runner's kernel, so they cannot test this |

Each row runs the same check: start the file in an empty home directory, serve
`/api/config`, create and read a task (SQLite), open a terminal (pty), start a
session daemon, load a test plugin, download and use one component, run
`walnut update` to a test release, and stop cleanly.

## Steps

| Step | Work | Done when |
|---|---|---|
| 0 | Spike: compile the server, shim SQLite, run `walnut web` on the glibc 2.26 host from an empty home | The list of what breaks, and nothing that cannot be fixed |
| 1 | SQLite through src/lib/sqlite.ts; the server runs on bun from source; bun install and patches | The test tiers pass on bun as they did on Node |
| 2 | Components: the general downloader; embedding and images move to it; Codex and onnxruntime-web leave the bundle | Core features work with no component; each feature downloads its component on first use |
| 3 | The binary build, web assets inside, the size budget check | One file per platform within budget |
| 4 | The binary tier and the CI matrix as the release gate | Every row green |
| 5 | Install, Homebrew, the Mac app and self-update use the file | A first install on the glibc 2.26 host takes one command |
| 6 | Host servers use the file; npm on the host and its Node and compiler installs are removed | A host from an empty home runs Walnut and carries the tunnel without a manual step |
| 7 | Production on the Mac runs the file | A week of daily use without a regression |
| 8 | The Node archive stays two releases as a fallback, then goes; the better-sqlite3 branch and every Node-only path go | Nothing in the repo runs on Node except the Playwright runner |

## Open questions

- Plugins run as full code in the file's runtime. A plugin that needs a Node
  native module must ship one built for bun's N-API; the internal tunnel plugin
  is the first to try.
- The session daemon and the server could become one file (`walnut daemon`).
  It saves a separate deploy but makes every daemon update ship the whole
  server; decided after step 6.
- bun's own floor (kernel and glibc) is taken from its documentation until the
  CI rows prove it.
