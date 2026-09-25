# Vendored dtach 0.9

Upstream: https://github.com/crigler/dtach (GPL-2.0+, Ned T. Crigler). See `COPYING`.

## Why it's here

Walnut's embedded session terminal runs each shell under `dtach` so it survives
ssh/server death (close the browser, the remote build keeps running; reopen and
re-attach). dtach is preferred over tmux because it does **not** take over the
mouse or use an alternate screen — so the browser xterm.js keeps native scroll +
drag-select + copy. (tmux grabbed the mouse, which caused the "can't scroll /
screen full of `^[[A`" bug.)

dtach is not in the package repos of the dev hosts Walnut targets, so we ship the
source and compile it on demand (a single `gcc *.c -lutil` builds on both macOS
and Linux — no autotools needed).

Search order on each host: Walnut's own copy, then a system `dtach` on PATH,
then the prebuilt the package ships for that platform and arch, then compiling
this source. With none of those (no compiler, or a failed build) the terminal
still opens, as a plain shell labelled "Not persistent" with the install command
and a Retry; only an ssh failure blocks it. See `src/web/terminal/dtach-check.ts`.

## Prebuilt binaries

A Mac without the Xcode Command Line Tools has no compiler, so the npm package
also ships this source compiled. `scripts/build-dtach.sh` (run by
`scripts/build-daemon.sh`, so by every `npm run build`) compiles it with the
same `cc -O2 -I. *.c -lutil`, strips it, checks that `--help` prints the dtach
banner, and writes `dist/daemon-binaries/dtach-<platform>-<arch>` plus a
`.source-hash` sidecar (sha256 of these files). On a Mac it builds both
`dtach-darwin-arm64` and `dtach-darwin-x64`; on Linux it builds the host arch,
statically linked when the static libraries exist so one binary runs across glibc
versions. `package.json` `files` ships `dtach-*` (the big daemon binaries stay
out), and `scripts/check-publish.mjs` refuses to publish from a machine with a
working compiler when the host prebuilt is missing, stale, or not in the tarball.
Linux prebuilts will come from CI once a CI job runs this build; until then a
Linux host still compiles on demand. At runtime the binary is only a candidate:
it is copied to the host's cache path and must pass `--help` there, or Walnut
compiles instead. A build machine without a compiler skips the step with one line.

## How it's consumed

These `.c` / `.h` files are the **provenance copy**. At runtime the provisioner
reads the source from `src/web/terminal/dtach-sources.ts`, which embeds these
files base64-encoded so they bundle through tsup into `dist/`.

`config.h` here is a **hand-written portable** replacement for the autotools-
generated one — it branches on `__APPLE__` (util.h) vs Linux (pty.h) and defines
the feature macros the source references, so `./configure` is never needed.

## Refreshing the embed

If you update these sources, regenerate the embedded module:

```bash
cd vendor/dtach
node -e '
  const fs=require("fs"), files=["attach.c","main.c","master.c","dtach.h","config.h"];
  const enc=Object.fromEntries(files.map(f=>[f, fs.readFileSync(f).toString("base64")]));
  /* ...write src/web/terminal/dtach-sources.ts (see git history of that file) */
'
```

Keep `config.h` portable (no autotools macros beyond what the source uses) so the
single-command compile keeps working everywhere.
