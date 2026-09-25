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

Search order on each host: Walnut's own build, then a system `dtach` on PATH,
then compiling this source. With none of those (no compiler, or a failed build)
the terminal still opens, as a plain shell labelled "Not persistent" with the
install command and a Retry; only an ssh failure blocks it. See
`src/web/terminal/dtach-check.ts`.

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
