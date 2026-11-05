// A Claude CLI stand-in that starts (the daemon gets its pid) and exits in error before any output,
// as a CLI whose first request fails does. Used by tests/e2e/engine-split.test.ts.
setTimeout(() => { process.stderr.write('First request failed before a reply\n'); process.exit(1); }, 750);
