#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${TMPDIR:-/tmp}/walnut-process-output-reader-tests"

swiftc \
    "$ROOT/desktop/DesktopDiagnostics.swift" \
    "$ROOT/tests/desktop/process-output-reader-tests.swift" \
    -o "$OUT"
"$OUT"
