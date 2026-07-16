# iOS Automated Bug Discovery Harness

Three independent layers, all runnable unattended:

## 1. Monkey walk (`monkey.sh`)

Random UI exploration on the simulator driven by Maestro + the accessibility
tree. Each round: dump the view hierarchy, pick a random tappable element,
tap/swipe/type, screenshot, and **hang-check** (a `simctl spawn launchctl`
liveness probe plus a screenshot-diff stall detector). Crashes are caught by
scanning `~/Library/Logs/DiagnosticReports` for new `.ips` files after every
action; hangs are caught when the same screenshot hash repeats across N
actions that should have changed the screen.

    ./monkey.sh <udid> <rounds>        # e.g. ./monkey.sh booted 200

Artifacts land in `runs/<timestamp>/`: `actions.log` (replayable action
sequence), screenshots per step, any crash reports, and a `verdict.txt`.

## 2. Stress scenarios (`stress-*.yaml`)

Deterministic Maestro flows targeting the known-risky seams:

- `stress-chat-stream.yaml` — send a prompt that elicits a VERY long streaming
  reply, then interact (scroll, tab-switch, background/foreground) DURING the
  stream. Catches main-thread saturation (the freeze class).
- `stress-rapid-nav.yaml` — rapid tab switching + open/close session pages
  ×20. Catches leaked SSE clients / store lifecycle races.
- `stress-composer.yaml` — paste a 10k-char message, attach 5 images, spam
  send/retry with the network toggled off/on (`simctl status_bar` +
  Network Link Conditioner). Catches send-path no-loss regressions.

## 3. AI-driven exploration (Claude + Maestro MCP)

The `ai-explore.md` prompt file drives a Claude agent that plays "hostile QA":
it reads the view hierarchy, forms hypotheses ("what if I background the app
mid-recording?"), executes them via the Maestro MCP tools, and files findings
with repro steps. Run it via the Walnut repo's Agent tooling — one agent per
surface (Chat / Sessions / Notes / Tasks / Settings) in parallel.

## Freeze forensics

If the app freezes during ANY layer, capture a hang dump before killing it:

    xcrun simctl spawn booted spindump <pid> 5 -file /tmp/walnut-hang.txt

On device, MetricKit hang diagnostics (CrashReporter.swift) upload the stack
via AppLog on the next launch — check `/tmp/open-walnut/ios-client/`.
