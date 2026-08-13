---
name: walnut-logging
description: Logging system details for src/logging/ — logger API & child loggers, log levels, automatic secret redaction, browser console log persistence (how to investigate frontend issues from disk logs). Use when adding logging or investigating issues via /tmp/open-walnut logs.
---

# Logging System — Implementation Details

For log locations and CLI commands, see project `CLAUDE.md`.

## Using Loggers in Code

```typescript
import { log } from '../logging/index.js';

// Use pre-created loggers
log.bus.info('event emitted', { name: 'task:created', traceId: 'abc123' });
log.agent.error('tool failed', { toolName: 'search', error: err.message });

// Create child loggers for sub-modules
const loopLog = log.agent.child('loop');
loopLog.info('round 3/10');  // → tag: agent/loop
```

Call `initLogging()` once at startup (creates the log directory, prunes old files). After that, use `log.<subsystem>` anywhere.

## Log Levels

| Level | Label | Color | Severity |
|---|---|---|---|
| `trace` | TRC | gray | 0 (lowest) |
| `debug` | DBG | cyan | 1 |
| `info` | INF | green | 2 |
| `warn` | WRN | yellow | 3 |
| `error` | ERR | red | 4 |
| `fatal` | FTL | bg-red | 5 (highest) |

## Redaction

All log lines pass through `redactSensitiveText()` before being written to the file. The following patterns are automatically replaced with `[REDACTED]`:

- **API keys**: OpenAI / Anthropic `sk-...` keys
- **AWS credentials**: `AKIA...` access key IDs, `aws_secret_access_key`, `aws_session_token`
- **Bearer tokens**: `Authorization: Bearer <token>`
- **PEM blocks**: `-----BEGIN ... PRIVATE KEY-----` through `-----END ... PRIVATE KEY-----`
- **Generic secrets**: Values after `password=`, `secret=`, `token=`, `api_key=`, `apikey=`

## Scroll-jump / flicker sentinels (session chat)

Always-on, anomaly-gated tripwires in `web/src/components/sessions/SessionChatHistory.tsx` (added for inc-1786553756848 / inc-1786603990062 — "scrolling up teleports to top / jitters"). If a scroll bug report comes in, grep these FIRST:

```bash
grep -a 'scroll-jump\|scroll-flicker\|scroll-mount' /tmp/open-walnut/open-walnut-<date>.log
```

| Line | Fires when | Context carried |
|---|---|---|
| `[scroll-jump:<sid8>#<uid>] teleport` | single scroll event dTop<-2000 or dSh<-1000 | top/sh/ch + msgs/blocks/hidden/trunc/streaming/atBot |
| `[scroll-jump:…] anchor-clamped-to-top` | "Show earlier" restore computed negative scrollTop | dist |
| `[scroll-flicker:<sid8>#<uid>] mid-scroll\|stationary` | \|dSh\|>150 while scrolled up; aggregated 1 line/2s (n/net/max); `stationary` = 500ms poll caught content shifting with no scroll | same as above |
| `[scroll-mount:<sid8>#<uid>]` | every mount/session-switch | path |

Reading them: `#<uid>` separates multiple mounts of the same session (SessionPanel / FocusDock / popout / second tab) — interleaved series from two mounts look like ONE container flapping without it. `blocks>0 streaming=true` at fire time → absorption-collapse class; `blocks=0 streaming=false` → layout/CSS class (the content-visibility bug was found this way). Known root causes + fixes: memory `scroll_jump_to_top_two_root_causes`; regression test `tests/e2e/browser/scroll-jump-on-absorption.spec.ts`.

The heavier per-tick `[scroll:…]` logging stays OFF by default (`localStorage.setItem('open_walnut_scroll_debug_on','1')` + reload to enable) — the sentinels above are the always-on layer.

## Browser Console Log Persistence

Browser-side `console.log/info/warn/error` are intercepted and persisted to the same log file with `subsystem: 'browser'`. This is critical for debugging frontend issues — browser console is lost on refresh, but these logs survive.

### How to investigate frontend issues

```bash
# View all browser logs
walnut logs -s browser

# Follow browser logs in real-time
walnut logs -f -s browser

# Filter browser errors only
walnut logs -s browser --json | jq 'select(.level == "error")'

# Search for a specific error
walnut logs -s browser --json | jq 'select(.message | contains("TypeError"))'
```

### Architecture

```
Browser console.log() → monkey-patch (preserves DevTools output)
  → Ring buffer (max 200 entries, dedup consecutive identical messages)
  → Flush every 2s or when 50 entries buffered
  → WebSocket RPC 'browser:logs' { entries[] }
  → On page unload: sendBeacon POST /api/browser-logs (fallback)
  → Backend: writeLogEntry({ subsystem: 'browser', ... })
  → /tmp/walnut/walnut-YYYY-MM-DD.log (same file as server logs)
```

### Log entry format

Each browser log entry in the JSON log file has:
- `subsystem: "browser"` — filter key
- `level` — mapped from browser: `log`→`info`, `warn`→`warn`, `error`→`error`
- `browserLevel` — original browser level (e.g. `"log"` vs `"info"`)
- `message` — first argument stringified (max 2000 chars)
- `args` — remaining arguments (max 1000 chars, optional)
- `url` — page pathname (optional)
- `count` — dedup count when same message repeated consecutively (optional)

### Key files

| File | Purpose |
|------|---------|
| `web/src/utils/browser-logger.ts` | Frontend interceptor: monkey-patch, ring buffer, WS send, sendBeacon fallback |
| `src/web/routes/browser-logs.ts` | Backend: WS RPC handler + REST endpoint, rate limiting, writeLogEntry |

### Safety mechanisms

- **No recursion**: `console.debug` is NOT intercepted (WS client uses debug for its own logging)
- **Rate limiting**: 500 entries per 10s window per WS client (backend silently drops excess)
- **Ring buffer**: Max 200 entries in memory — no unbounded growth when WS is disconnected
- **Truncation**: message ≤ 2000 chars, args ≤ 1000 chars (both frontend and backend enforce)
- **Serialization safety**: Handles circular refs, DOM nodes, Error objects, functions — all wrapped in try-catch

## File Structure

```
src/logging/
├── levels.ts          # Log level types and severity ordering
├── logger.ts          # File transport (JSON lines, daily rolling, auto-prune after 3 days)
├── subsystem.ts       # createSubsystemLogger() factory + colored stderr output
├── redact.ts          # Sensitive data masking (runs before every file write)
└── index.ts           # Barrel: pre-created loggers (log.*) + initLogging()
```
