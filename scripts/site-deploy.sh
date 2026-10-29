#!/usr/bin/env bash
# Deploys site/ as a COMMIT holds it to Cloudflare Pages (openwalnut.dev), after the public
# leak scan passes on exactly the files being uploaded (scripts/leak-scan/README.md).
#
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... bash scripts/site-deploy.sh [<commit>] [<branch>]
#
# <commit> defaults to HEAD, <branch> to main (any other branch gives a preview alias,
# <branch>.open-walnut.pages.dev). The rules file comes from WALNUT_LEAK_RULES or
# `git config walnut.leakRules`; with none the deploy refuses: every Pages deployment stays
# public at its own URL for good, so an unscanned upload cannot be taken back by the next one.
set -euo pipefail
cd "$(dirname "$0")/.."
commit="${1:-HEAD}"
branch="${2:-main}"
rules="${WALNUT_LEAK_RULES:-$(git config --path --get walnut.leakRules || true)}"
if [ -z "$rules" ] || [ ! -f "$rules" ]; then
  echo "site-deploy: no leak-scan rules (set WALNUT_LEAK_RULES or git config walnut.leakRules); not deploying." >&2
  exit 1
fi
: "${CLOUDFLARE_API_TOKEN:?site-deploy: CLOUDFLARE_API_TOKEN is not set}"
: "${CLOUDFLARE_ACCOUNT_ID:?site-deploy: CLOUDFLARE_ACCOUNT_ID is not set}"
command -v bun >/dev/null || { echo "site-deploy: bun is not on PATH, so the leak scan cannot run; not deploying." >&2; exit 1; }
sha="$(git rev-parse --verify "$commit^{commit}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git archive "$sha" site | tar -x -C "$work"
if ! bun scripts/leak-scan/leak-scan.mjs --rules "$rules" "$work/site"; then
  echo "site-deploy: the leak scan found something in site/ at ${sha:0:9} (above); not deploying." >&2
  exit 1
fi
(cd "$work" && npx -y wrangler@4 pages deploy site --project-name=open-walnut --branch="$branch" --commit-hash="$sha")
