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

swiftc \
    "$ROOT/desktop/LinkPolicy.swift" \
    "$ROOT/tests/desktop/link-policy-tests.swift" \
    -o "$OUT_DIR/walnut-link-policy-tests"
"$OUT_DIR/walnut-link-policy-tests"

swiftc \
    "$ROOT/desktop/BundledRuntime.swift" \
    "$ROOT/tests/desktop/bundled-runtime-tests.swift" \
    -o "$OUT_DIR/walnut-bundled-runtime-tests"
"$OUT_DIR/walnut-bundled-runtime-tests"

swiftc \
    "$ROOT/desktop/AppBuiltCheckout.swift" \
    "$ROOT/tests/desktop/app-built-checkout-tests.swift" \
    -o "$OUT_DIR/walnut-app-built-checkout-tests"
"$OUT_DIR/walnut-app-built-checkout-tests"

swiftc \
    "$ROOT/desktop/AppLink.swift" \
    "$ROOT/desktop/BundledRuntime.swift" \
    "$ROOT/desktop/CommandLineTool.swift" \
    "$ROOT/tests/desktop/app-link-tests.swift" \
    -o "$OUT_DIR/walnut-app-link-tests"
"$OUT_DIR/walnut-app-link-tests"

swiftc \
    "$ROOT/desktop/AppUpdateMachine.swift" \
    "$ROOT/tests/desktop/app-update-tests.swift" \
    -o "$OUT_DIR/walnut-app-update-tests"
"$OUT_DIR/walnut-app-update-tests"

swiftc \
    "$ROOT/desktop/DesktopDiagnostics.swift" \
    "$ROOT/tests/desktop/server-lock-tests.swift" \
    -o "$OUT_DIR/walnut-server-lock-tests"
"$OUT_DIR/walnut-server-lock-tests"

if [ "$(uname -s)" = Darwin ]; then
    swiftc -D WALNUT_DEMO_TESTS \
        "$ROOT/tests/desktop/demo-app-tests.swift" \
        "$ROOT/desktop/DemoApp.swift" \
        "$ROOT/desktop/BundledRuntime.swift" \
        "$ROOT/desktop/ClaudeSignInBridge.swift" \
        "$ROOT/desktop/QuietKeyWindow.swift" \
        "$ROOT/desktop/WebContentProcess.swift" \
        -framework Cocoa -framework WebKit \
        -o "$OUT_DIR/walnut-demo-app-tests"
    "$OUT_DIR/walnut-demo-app-tests"

    swiftc \
        "$ROOT/tests/desktop/claude-sign-in-tests.swift" \
        "$ROOT/desktop/ClaudeSignInBridge.swift" \
        -framework Cocoa -framework WebKit \
        -o "$OUT_DIR/walnut-claude-sign-in-tests"
    "$OUT_DIR/walnut-claude-sign-in-tests"
fi
