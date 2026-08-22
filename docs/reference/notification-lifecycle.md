# Notification Lifecycle (the condition system)

Every notification is a projection of a CONDITION, and a condition has a state
machine — never fire-and-forget:

```
FIRING ──(matching success signal)──▶ RECOVERED   (green "Recovered ✓", leaves Errors rail)
   │
   ├──(owning entity dies)──────────▶ EXPIRED     ("Session ended" / "Stale")
   └──(one-shot, 48h sweep)─────────▶ EXPIRED     ("Stale")
```

Permissions got this first (allowed / denied / expired, commit 0d9c7783);
errors joined in 29eee93d + this change. The state lives on the notification
record (`resolved`), the identity of the condition is `recoveryKey`.

## The four lifecycle contracts

| Contract | Meaning | Recovery / terminal signal | recoveryKey shape |
|---|---|---|---|
| edge | a retried operation; success = recovered | failure→success transition (recovery-transition tracker) | `route:<METHOD> <path>`, `plugin:<id>`, `git`, `git:compaction`, `backup`, `disk`, `bus:<subscriber>:<event>`, `task-db-writers` |
| liveness | bound to an entity with a lifespan | entity's next clean result = recovered; entity death = expired | `session:<sid>`, `task:<taskId>` |
| boot | a process-lifetime fact | server startup IS the recovery | `server-lifecycle` |
| one-shot | a completed past event; nothing can recover | 48h keyless debris sweep → Stale | none + `// lifecycle: one-shot` comment |

## Invariants (each is load-bearing)

- `recoveryKey` identifies the CONDITION; `dedupScope` identifies the CARD.
  Several cards may share one condition (a plugin's http/sync/reconciler cards
  all retire on one sync success).
- Recovery fires on transitions only, never on healthy ticks (a 30s poll must
  not become a permanent store scan). `createRecoveryTransitionTracker` +
  `isFailing()` pre-checks keep the healthy hot path allocation-free.
- Recovery clears the error-TTL absorber for its scopes: a re-failure right
  after recovery must notify fresh, not inherit suppression.
- Recovery never re-badges (`read` untouched) — it is good news.
- Expiry never fabricates an outcome: an expired permission reads "Session
  ended", an expired error reads "Stale", neither claims Approved/Recovered.
- Marking failing and keying the card must be one move
  (`publishSessionErrorNotification`) — a card keyed but never marked failing
  can never be retired; that class of bug is why the helper exists.

## Enforcement

`tests/core/notifications/lifecycle-ratchet.test.ts` fails CI on any
`publishErrorNotification` call site that neither passes `recoveryKey` nor
carries a `// lifecycle: one-shot` declaration. The log-error bridge derives
keys automatically (`meta.recoveryKey` > `meta.pluginId` > session/obs root +
sessionId/taskId > non-core subsystem root), so ad-hoc `log.error` calls join
the system without ceremony; core-subsystem logs without ids stay keyless and
fall to the debris sweep.

## Where things live

- State + stamps: `src/core/notifications/store.ts` (`recoverNotifications`,
  `expireErrorNotifications`, `expireKeylessErrorNotifications`)
- Key derivation: `src/core/notifications/log-error-bridge.ts`
- Transition gating: `src/core/notifications/recovery-transition.ts`
- Route normalization: `src/core/notifications/route-condition.ts`
- Death expiry + boot reconcile: `src/core/notifications/permission-expiry.ts`
  wired beside `healStalePendingPermissions` in `src/web/server.ts`
- Signal seams: request-logger middleware (routes), event-bus (subscriber
  pairs), instance-lock watchdog (db writers), session:result handler
  (session/task), plugin sync poll, git tick, backup scheduler,
  disk-watermark `onRecovered`
