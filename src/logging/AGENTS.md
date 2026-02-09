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

## File Structure

```
src/logging/
├── levels.ts          # Log level types and severity ordering
├── logger.ts          # File transport (JSON lines, daily rolling, auto-prune after 3 days)
├── subsystem.ts       # createSubsystemLogger() factory + colored stderr output
├── redact.ts          # Sensitive data masking (runs before every file write)
└── index.ts           # Barrel: pre-created loggers (log.*) + initLogging()
```
