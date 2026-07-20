# Permission Bypass Capability

Status: accepted and implemented 2026-07.

## Summary

Every Claude CLI process starts with `--dangerously-skip-permissions`,
regardless of its initial permission mode. The flag grants the capability to
enter Bypass later; it does not make Bypass the active mode. Walnut persists a
runtime mode change only after `set_permission_mode` succeeds and echoes the
requested mode.

## Context

A session launched in Plan mode rejected a later JSON Stream switch to
`bypassPermissions` because startup had not authorized that capability. Walnut
swallowed the CLI error and optimistically persisted Bypass, so the UI showed
Bypass while the CLI continued asking for permission.

Permission approvals travel from Walnut to the CLI through daemon `sendRaw`;
they are not echoed in stdout. The daemon therefore retained and replayed an
already answered pending request.

## Evidence

- The Claude CLI reports: `Cannot set permission mode to bypassPermissions
  because the session was not launched with
  --dangerously-skip-permissions`.
- The public ACP adapter enables `allowDangerouslySkipPermissions`, supplies
  the initial `permissionMode`, and applies runtime changes through
  `setPermissionMode`, propagating failures instead of updating local state
  first.
- A successful FIFO write of a matching `control_response` is the daemon's
  delivery acknowledgement. Stdout cannot provide that acknowledgement.

## Decision

- Add `--dangerously-skip-permissions` to fresh, resume, bridge-resume, and
  inline-subagent CLI spawns.
- Treat `set_permission_mode` failures as errors and keep the last confirmed
  mode.
- Update local mode, daemon policy, and persisted session mode only after a
  matching CLI echo.
- Gracefully resume an old live process once if it lacks the startup
  capability.
- Clear daemon `pendingCtrl` only after a matching `control_response` has been
  written completely to the FIFO.

## Do Not Rebuild

- Do not infer active Bypass mode from the startup capability flag.
- Do not persist or display a requested mode before the CLI confirms it.
- Do not use stdout as acknowledgement for outbound permission responses.
- Do not directly signal remote PIDs from Walnut. Use the daemon's
  SIGINT-first stop path.

## References

- [Claude session provider](../../src/providers/claude-code-session.ts)
- [Daemon core](../../src/providers/daemon-core.ts)
- [Standalone daemon](../../src/providers/daemon-standalone.ts)
- [Fallback daemon source](../../src/providers/daemon-source.ts)
- [Agent Client Protocol Claude adapter](https://github.com/agentclientprotocol/claude-agent-acp)
