# Logging — Quick Reference

**Full implementation details: `.claude/skills/walnut-ops/SKILL.md`** (incident investigation
playbook, always-on sentinels, levels, redaction patterns, browser log persistence
architecture, investigation commands).

## Essentials

- `import { log } from '../logging/index.js'` → `log.<subsystem>.info('msg', { fields })`;
  child loggers via `log.agent.child('loop')`. `initLogging()` once at startup.
- All lines pass `redactSensitiveText()` before hitting disk (API keys, AWS creds, bearer
  tokens, PEM blocks, `password=`/`token=` values → `[REDACTED]`).
- Browser `console.log/warn/error` are persisted to the same disk log with
  `subsystem: 'browser'` (`console.debug` is NOT — never rely on it). Investigate frontend
  issues with `walnut logs -s browser` — the disk log survives page refresh.
