#!/usr/bin/env bash
# ci-remove-node.sh: takes Node off a CI runner's PATH (node, npm, npx, corepack).
#
# Walnut builds and tests with bun alone; only the Playwright runner needs Node,
# and its jobs install their own. GitHub's Linux images come with a Node on PATH,
# so a step that still needed one would quietly use it there and fail on a
# machine without it. The jobs that build and test run this first, so any such
# step fails in CI instead. `bun run` puts its own `node` shim (bun itself) on
# PATH for the scripts it starts, which is how a package script's `node` keeps
# working with no Node installed.
#
# GitHub-hosted runners only: it refuses anywhere else, a self-hosted runner or a
# local Actions emulator included, where the Node it deletes is a real machine's.
set -euo pipefail

if [ "${CI:-}" != "true" ] || [ "${GITHUB_ACTIONS:-}" != "true" ] || [ "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]; then
  echo "ci-remove-node.sh removes files from PATH; it runs on GitHub-hosted runners only" >&2
  exit 2
fi

for tool in node npm npx corepack; do
  # Bounded: a PATH can hold the same tool in more than one directory.
  for _ in 1 2 3 4 5 6; do
    p="$(command -v "$tool" 2>/dev/null)" || break
    echo "removing $tool at $p"
    # The image's tools are root's; sudo only for a directory this user cannot write.
    if [ -w "$(dirname "$p")" ]; then rm -f "$p"; else sudo rm -f "$p"; fi
    hash -r
  done
  if command -v "$tool" >/dev/null 2>&1; then
    echo "::error::$tool is still on PATH ($(command -v "$tool")) after removing it"
    exit 1
  fi
done
echo "no node, npm, npx or corepack on PATH: this job runs on bun alone"
