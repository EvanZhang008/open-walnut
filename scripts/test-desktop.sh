#!/bin/bash
set -euo pipefail

# Pure-logic tests for the Mac app shell. Each suite compiles one Foundation-only
# source file with its test file into a plain binary (no AppKit, no WebKit), so
# this runs anywhere swiftc does.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${TMPDIR:-/tmp}"

swiftc \
    "$ROOT/desktop/DesktopDiagnostics.swift" \
    "$ROOT/tests/desktop/process-output-reader-tests.swift" \
    -o "$OUT_DIR/walnut-process-output-reader-tests"
"$OUT_DIR/walnut-process-output-reader-tests"

swiftc \
    "$ROOT/desktop/WebContentPolicy.swift" \
    "$ROOT/tests/desktop/webcontent-policy-tests.swift" \
    -o "$OUT_DIR/walnut-webcontent-policy-tests"
"$OUT_DIR/walnut-webcontent-policy-tests"
