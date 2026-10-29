# Public leak scan

Walnut is public, and so is everything it publishes beside the git history: the npm
packages, the GitHub Release assets (the Mac app's `.dmg` included), the site on Cloudflare
Pages, and the Actions logs. The pre-push scan reads only what a push adds to git. This
scan covers the rest.

## Pieces

| File | What it does |
|---|---|
| `core.mjs` | Matching: regex rules for shapes, hashed term rules for exact words. |
| `leak-scan.mjs` | The CLI. Scans files and directories, opens `.tgz`/`.tar`/`.zip`/`.gz` (and mounts a `.dmg` on macOS), reads binaries through their printable runs. Exit 0 clean, 1 hits, 2 error. `--redact` prints the rule and the place, never the text. |
| `build-rules.mjs` | Compiles a private rule source (TSV, plus name lists) into the rule file the CLI reads. Terms are stored only as hashes. |
| `../site-deploy.sh` | Deploys `site/` of a commit to Pages, after the scan passes on exactly the files it uploads. Refuses without rules. |
| `../../.github/workflows/leak-audit.yml` | Scans every finished run's logs, every release's assets, and daily the npm packages, the live site, the source tree and recent issue and PR text. |

## Rules

The rule source holds the words in the clear, so it never enters this repo. Its format:

```
label<TAB>kind<TAB>value[<TAB>allow pattern...]
```

`kind` is `regex`, `regex-cs` (case-sensitive), `term` or `term-cs`. A term matches on word
boundaries whatever joins its words (`a b` matches `a-b`, `a_b`, `a.b`); a case-sensitive
term never matches inside an `UPPER_SNAKE` identifier. An allow pattern drops a regex hit
whose surrounding text matches it (a documented placeholder, say).

```bash
bun scripts/leak-scan/build-rules.mjs rules.tsv --names names.txt internal-name --out rules.json
bun scripts/leak-scan/leak-scan.mjs --rules rules.json --redact some-package.tgz site/
```

CI reads the rule file from the `LEAK_SCAN_RULES` Actions secret (the JSON, or base64 of
it). A fork has no secret, and the workflow's jobs run only in the upstream repository.

A hit fails the run. The run's log names the rule and the file; scan the same artifact
locally without `--redact` to see the text.
