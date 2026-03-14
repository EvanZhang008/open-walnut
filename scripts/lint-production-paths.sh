#!/usr/bin/env bash
# Lint guard: detect hardcoded references to ~/.open-walnut/ outside allowed files.
#
# Layer 4 of the production-data protection stack.
# Catches patterns like:  homedir() + '.open-walnut'   or   HOME + '.open-walnut'
# in TypeScript/JavaScript source files.
#
# Allowed files can annotate intentional uses with:  // safe: production-path
#
# Exit 0 = clean, Exit 1 = violations found.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Files that legitimately reference the production path
ALLOWED_FILES=(
  "src/constants.ts"
  "tests/helpers/live.ts"
  "tests/setup/global-setup.ts"
)

# Build grep exclusion args
EXCLUDE_ARGS=()
for f in "${ALLOWED_FILES[@]}"; do
  EXCLUDE_ARGS+=("--glob=!${f}")
done

# Patterns that indicate hardcoded production paths
# Match: homedir() ... '.open-walnut'  or  HOME ... '.open-walnut'  (same line)
PATTERNS=(
  "homedir\\(\\).*\\.open-walnut"
  "HOME.*\\.open-walnut"
)

VIOLATIONS=0

for pattern in "${PATTERNS[@]}"; do
  # Use grep (rg) if available, fall back to grep -rn
  if command -v rg &>/dev/null; then
    matches=$(cd "$REPO_ROOT" && rg -n \
      --type ts --type js \
      --glob '!node_modules/**' \
      --glob '!dist/**' \
      --glob '!web/node_modules/**' \
      "${EXCLUDE_ARGS[@]}" \
      "$pattern" 2>/dev/null || true)
  else
    matches=$(cd "$REPO_ROOT" && grep -rn \
      --include='*.ts' --include='*.js' --include='*.mjs' \
      --exclude-dir=node_modules --exclude-dir=dist \
      -E "$pattern" . 2>/dev/null \
      | grep -v 'src/constants.ts' \
      | grep -v 'tests/helpers/live.ts' \
      | grep -v 'tests/setup/global-setup.ts' || true)
  fi

  # Filter out lines with the safe annotation
  if [ -n "$matches" ]; then
    filtered=$(echo "$matches" | grep -v 'safe: production-path' || true)
    if [ -n "$filtered" ]; then
      echo "$filtered"
      VIOLATIONS=$((VIOLATIONS + $(echo "$filtered" | wc -l)))
    fi
  fi
done

if [ "$VIOLATIONS" -gt 0 ]; then
  echo ""
  echo "ERROR: Found $VIOLATIONS hardcoded production path reference(s)."
  echo "Fix: use WALNUT_HOME from constants.ts, or annotate with // safe: production-path"
  exit 1
fi

echo "lint-production-paths: clean"
exit 0
