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
`scripts/cloud/companion-launch.mjs`, `src/core/companion-build/`) runs the
compiled file, and takes it from the Mac the way it took a dist.

**The package (done).** The Mac sends its companion the same file its host
servers run, built for the box (`createHostFileSource`: the sibling file in the
stage's `dist-bin/`, a build of the checkout's commit, or a published release),
packed with a small plain-JS shim (`src/core/companion-build/package.ts`,
`shim.ts`):

    package/walnut         the compiled file for the box's target
    package/dist/cli.js    starts ../walnut with the same arguments

Every box, of any age, starts a build as `<runtime> app/<id>/dist/cli.js`: its
install check (`--version`), its smoke boot and its launcher. So the door stays
schema 1 and the install request is the one a box always took, with an empty
dependency set. A box set up before the move to bun keeps its unit and launcher
on node, installs the package with its own code, smoke-boots it through the
shim on node, and from its next start runs the file: no step on the box. A Mac
that runs the compiled file updates its companion like any other.

**Running inside the file.** Once the box runs the file, its own box code
starts the next build's `dist/cli.js` with the file told to be bun
(`BUN_BE_BUN=1`, `bunCommand` in `src/lib/runtime.ts`); the shim drops that before it
starts `../walnut`. The shim also keeps the file's pid under the launcher, so a
file whose shim was killed hard is stopped by the next start instead of
holding the port.

**The runtime a build needs.** A dist runs only on the runtime its smoke boot
passed on: the box writes it to `app/<id>/.runtime` and the launcher skips a
current dist for another runtime (the base tree runs, and the Mac sends the file
again) and gives up such a trial. A dist with no record came from a box that did
everything on node. A build of the file runs under either. This is what keeps a
box whose unit moved from node to bun (setup.sh run again) from starting a build
it got on node forever.

**setup.sh.** A new box's base tree is built with bun (`bun install
--frozen-lockfile`, `bun --bun run build`) and its unit starts
`<bun> dist/cli.js web`. Node and npm stay on the box only for third-party agent
CLIs and Claude Code's npm fallback.

Proof: the box, launcher, package and shim tests; the e2e with the real
launcher and a real build (`tests/e2e/companion-build-update-e2e.test.ts`); and
a Linux container laid out like a box set up with the 0.6.17 setup.sh (a node
unit run by a supervisor loop, a 0.6.17 build the Mac pushed in
`companion/current`) that the Mac moves to two real compiled files of this tree,
that gives up a broken one, and that keeps the file when the unit then moves to
bun and the new launcher (`tests/e2e/old-box/run.sh`, which builds the files and
runs `tests/e2e/companion-old-box-e2e.test.ts`).

Later: the base tree becomes the release file from install.sh, and the
launcher a subcommand of the file. Then bun leaves the box too.

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
