---
name: decision-permission-bypass-capability
description: DECISION - every Claude CLI session preauthorizes runtime Bypass changes; persist mode only after CLI confirmation (2026-07). Read before changing session permission-mode handling.
---

# Decision: Preauthorize Bypass, persist confirmed mode

## Summary

Every Claude CLI process is launched with `--dangerously-skip-permissions`, regardless of its
initial permission mode. The flag grants the capability to enter Bypass later; it does not make
Bypass active. Runtime mode changes are persisted only after `set_permission_mode` succeeds and
echoes the requested mode.

## Context

A session launched in Plan mode rejected a later JSON Stream switch to `bypassPermissions`
because startup had not authorized that capability. Walnut swallowed the CLI error and
optimistically persisted Bypass, so the UI showed Bypass while the CLI kept requesting
permission.

Separately, permission approvals travel Walnut-to-CLI through daemon `sendRaw`; they are not
echoed in stdout. The daemon therefore retained and replayed an already answered pending request.

## Evidence

- Claude CLI error: `Cannot set permission mode to bypassPermissions because the session was not
  launched with --dangerously-skip-permissions`.
- The public ACP adapter enables `allowDangerouslySkipPermissions`, supplies the initial
  `permissionMode`, and applies runtime mode changes through `setPermissionMode`, propagating
  failures instead of changing local state first.
- A successful FIFO write of a matching `control_response` is the daemon's delivery
  acknowledgement; stdout cannot provide one.

## Decision

- Add `--dangerously-skip-permissions` to fresh, resume, bridge-resume, and inline-subagent CLI
  spawns.
- Treat `set_permission_mode` errors as errors and keep the last confirmed mode.
- Update local mode, daemon policy, and persisted session mode only after a matching CLI echo.
- Gracefully resume old live processes once when they lack the startup capability.
- Clear daemon `pendingCtrl` only after a matching `control_response` is fully written to FIFO.

## Do-not-rebuild

- Do not infer active Bypass from the startup capability flag.
- Do not persist or display a requested mode before the CLI confirms it.
- Do not rely on stdout to acknowledge outbound permission responses.
- Do not directly signal remote PIDs from Walnut; use the daemon's SIGINT-first stop path.

## References

- `src/providers/claude-code-session.ts`
- `src/providers/daemon-core.ts`
- `src/providers/daemon-standalone.ts`
- `src/providers/daemon-source.ts`
- https://github.com/agentclientprotocol/claude-agent-acp
