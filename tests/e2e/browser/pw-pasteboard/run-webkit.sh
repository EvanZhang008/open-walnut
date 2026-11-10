#!/bin/bash
# Starts Playwright's WebKit on macOS with its own pasteboard (private-pasteboard.m). Playwright's
# pw_run.sh runs under /bin/bash, and macOS drops every DYLD_* variable a protected binary inherits,
# so the library is named here, at the exec of the WebKit binary itself, as pw_run.sh names its
# frameworks. WALNUT_PW_WEBKIT_RUN: Playwright's pw_run.sh; WALNUT_PW_PASTEBOARD_DYLIB: the library.
d=$(cd "$(dirname "${WALNUT_PW_WEBKIT_RUN:?}")" && pwd -P) || exit 1
export DYLD_FRAMEWORK_PATH="$d" DYLD_LIBRARY_PATH="$d" DYLD_INSERT_LIBRARIES="${WALNUT_PW_PASTEBOARD_DYLIB:?}"
exec "$d/Playwright.app/Contents/MacOS/Playwright" "$@"
