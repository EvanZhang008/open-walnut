# Public leak scan

Walnut is public: its git history, and everything it publishes beside it (the npm packages,
the GitHub Release assets with the Mac app's `.dmg`, the site on Cloudflare Pages, the Actions
logs). `scan-git.mjs` is the one gate for the history; `leak-scan.mjs` covers the rest. Both
read the same rules.

## The git gate (`scan-git.mjs`)

Every way a change reaches GitHub runs it, and none can skip it:

| Path | How |
|---|---|
| a commit | `.husky/pre-commit` (`--staged`) and `.husky/commit-msg` (`--message-file`); a clone with no hooks of its own gets the same from the maintainer's global hooks |
| a push | `.husky/pre-push` runs `scan-push.sh` first, before the type check: every commit and annotated tag the push publishes |
| a land | the land runs `--range <main>..<tip> --strict` before it writes main |
| GitHub | `.github/workflows/leak-gate.yml`: every push and pull request scans its new commits and the whole history; a schedule catches bot pushes |
| an agent's edit | the maintainer's write-time hook runs `--text <path>` on the new content |

It reads each commit one by one (a word added and removed inside one push is still public):
added lines with their file and line, file names, the text inside binaries, the message, the
author and committer. It applies the committed shapes (`shapes.tsv`: credential formats),
the private rules (terms hashed), gitleaks, and three file rules: a file over 2 MB, a file of
private data (under `.open-walnut/` or `.claude/projects/`, a session transcript `.jsonl` or a
store file outside `tests/fixtures/`), and a picture, video or sound outside the asset folders.

A hit prints the rule and the place (`src/a.ts:12 (commit 1a2b3c4d5e)`) and blocks; the fix is
to reword it with neutral invented words. There is no option to skip a check, and the
maintainer's agents are refused any command that skips a hook (`--no-verify`, `-c
core.hooksPath`, `HUSKY=0`). Strict mode (the maintainer's machines, where
`~/.config/walnut-leak` exists, and CI upstream) refuses to judge without the private rules or
gitleaks. A range is judged by its BASE commit's own `scripts/leak-scan` and `.gitleaks.toml`,
so a change cannot loosen the scan that judges it.

History hits found when a rule is added are fixed forward, never rewritten: their
fingerprints sit in the private rules' baseline (`build-rules.mjs --baseline`) and gitleaks'
in `.gitleaksignore`, both bound to the old commit, so only new commits are judged in full.

## Pieces

| File | What it does |
|---|---|
| `core.mjs` | Matching: regex rules for shapes, hashed term rules for exact words. |
| `leak-scan.mjs` | The CLI. Scans files and directories, opens `.tgz`/`.tar`/`.zip`/`.gz` (and mounts a `.dmg` on macOS), reads binaries through their printable runs. Exit 0 clean, 1 hits, 2 error. `--redact` prints the rule and the place, never the text. |
| `scan-git.mjs` | The git gate (above). Exit 0 clean, 1 hits, 2 could not check. |
| `scan-push.sh` | The pre-push half: reads a pre-push hook's refs and runs `scan-git.mjs` on each pushed range and tag. |
| `shapes.tsv` | Committed shape rules (credential formats), for everyone, contributors and forks included. |
| `build-rules.mjs` | Compiles a private rule source (TSV, plus name lists) into the rule file the CLI reads. Terms are stored only as hashes. |
| `../site-deploy.sh` | Deploys `site/` of a commit to Pages, after the scan passes on exactly the files it uploads. Refuses without rules. |
| `../../.github/workflows/leak-audit.yml` | Scans every finished run's logs, every release's assets, and daily the npm packages, the live site, the source tree and recent issue and PR text. |

## Rules

The rule source holds the words in the clear, so it never enters this repo. Its format:

```
label<TAB>kind<TAB>value[<TAB>allow pattern...]
```

`kind` is `regex`, `regex-cs` (case-sensitive), `term` or `term-cs`, each optionally ending in
`@source`: a source-only rule judges only what git publishes, never a build artifact or a
third-party tree, where the word is ordinary English or table bytes. A term matches on word
boundaries whatever joins its words (`a b` matches `a-b`, `a_b`, `a.b`); a case-sensitive
term never matches inside an `UPPER_SNAKE` identifier. An allow pattern drops a regex hit
whose surrounding text matches it (a documented placeholder, say).

A regex must not open with a repeated character class (`[a-z0-9.]+@example\.com`): the
engine retries it from every position of a long run of that class, so one base64 blob in a
bundle takes seconds and a release takes hours (a 60 minute job timed out on one). Start it
at the literal and put the class in a lookbehind: `(?<=[a-z0-9.])@example\.com`. The build
and the scan both refuse such a rule.

A binary is read through its printable runs, and a phrase never spans two of them. A word
of five letters or fewer counts there only in a run of 16 bytes or more whose 48 bytes on
each side read as text: at least 30% words of three or more plain letters (lower case,
Capitalized or ALLCAPS) and spaces, or 50% such words with camelCase allowed at a character
entropy under 4.8 bits. Compressed data makes such a word by chance, every file of a build
carries the same compressed blobs, and a run of random letters, digits and punctuation is
mostly "plain" characters, so a share of those is no test (2026-10-31). Random printable
bytes, base64 and source map mappings pass the word test about once in 300 tries.

A file whose bytes were already scanned in the same run is counted as a copy and not scanned
again: a release's platform archives and the archive inside the Mac app share most of their
dependency tree.

`--skip-deps` leaves out the dependencies a package carries (a `node_modules` directory
beside a `package.json`), never the package itself. The release job uses it: the runtime in a
release holds Walnut's own dist and its whole third-party tree, whose docs and test fixtures
name real companies, sample account ids and test keys that are not Walnut's words.

```bash
bun scripts/leak-scan/build-rules.mjs rules.tsv --names names.txt internal-name --out rules.json
bun scripts/leak-scan/leak-scan.mjs --rules rules.json --redact some-package.tgz site/
```

CI reads the rule file from the `LEAK_SCAN_RULES` Actions secret (the JSON, base64 of it, or
base64 of its gzip: a secret holds 48 KB at most). A fork has no secret, and the workflow's jobs run only in the upstream repository.

A hit fails the run. The run's log names the rule and the file; scan the same artifact
locally without `--redact` to see the text.
