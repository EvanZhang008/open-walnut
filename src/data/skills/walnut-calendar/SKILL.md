---
name: walnut-calendar
description: >-
  Read and edit the user's real calendars (macOS Calendar: iCloud, Google,
  Exchange accounts) through Walnut's /api/calendar REST endpoints. Use when
  asked about the user's schedule, meetings, or availability, or to create,
  move, retime, or delete calendar events. Covers listing events in a date
  range, enumerating calendars, and write-back that syncs to the cloud
  provider via macOS.
---

# Walnut Calendar API

Walnut exposes the Mac's calendars (every account added in macOS System
Settings → Internet Accounts: iCloud, Google, Exchange, …) over REST. Edits
write back through macOS EventKit, so a change made here shows up in Google
Calendar / iCloud within seconds — no separate login or OAuth involved.

Base URL: `http://localhost:3456/api/calendar` (Walnut server).

## Date format contract (IMPORTANT)

All dates are **tz-less local ISO** — the server's local wall time, never a
`Z` or `+hh:mm` suffix:

- Timed: `2026-08-05T09:00:00`
- All-day / date-only: `2026-08-05`

## Read

```bash
# Events in a date range (inclusive days)
curl -s 'http://localhost:3456/api/calendar/events?from=2026-08-03&to=2026-08-09'
# → { "events": [ { "id", "title", "start", "end", "allDay", "calendarId",
#      "calendarName", "accountName", "color", "location?", "readonly?" } ],
#     "sources": [ { "id": "eventkit", "available", "enabled", "reason?", "message?" } ] }

# List the calendars themselves (to pick a create target)
curl -s 'http://localhost:3456/api/calendar/sources'
# → { "sources": [...], "calendars": [ { "id", "title", "account", "color",
#      "readonly", "hidden" } ] }
```

- If `sources[0].available` is `false`, read `reason`/`message` — e.g.
  `permission-denied` means the user must grant Calendar access in System
  Settings → Privacy & Security → Calendars. `GET /events` still returns
  `{ events: [] }` in that case rather than erroring.
- Event ids of recurring occurrences look like `<baseId>#<epoch>`; treat the
  whole string as opaque and **URL-encode it** in paths (`#` → `%23`).

## Write

Only calendars with `readonly: false` accept writes (a write to a read-only
calendar returns 409).

```bash
# Create (end defaults are NOT applied server-side — always send end)
curl -s -X POST http://localhost:3456/api/calendar/events \
  -H 'Content-Type: application/json' \
  -d '{"calendarId":"<id from /sources>","title":"Dentist",
       "start":"2026-08-05T15:00:00","end":"2026-08-05T16:00:00"}'
# All-day: use date-only start/end (end inclusive) and "allDay": true.

# Move / retime / rename (start AND end required; PATCH only that occurrence
# for recurring events)
curl -s -X PATCH 'http://localhost:3456/api/calendar/events/<url-encoded id>' \
  -H 'Content-Type: application/json' \
  -d '{"start":"2026-08-06T15:00:00","end":"2026-08-06T16:00:00","title":"Dentist (moved)"}'

# Delete (only that occurrence for recurring events). Confirm with the user
# before deleting anything you did not just create.
curl -s -X DELETE 'http://localhost:3456/api/calendar/events/<url-encoded id>'
```

## Error codes

| HTTP | code | meaning |
|---|---|---|
| 400 | `usage` | bad params / date format |
| 403 | `permission-denied` | macOS Calendar access not granted (Full Access) |
| 404 | `not-found` | event id doesn't resolve |
| 409 | `readonly` | target calendar is read-only |
| 503 | `disabled` / `cloud` / `not-configured` | source off in Settings, cloud companion (no Mac calendars), or helper unavailable |
| 502 | other | EventKit helper failure — surface `message` to the user |

## Tips

- The Walnut web calendar (`/calendar`) live-updates after any write — no
  refresh call needed on your side.
- To answer "what's on my schedule", query a generous range and filter by
  `calendarName`/`accountName` yourself if the user means one account.
- Move = keep the duration: compute `new end = new start + (old end − old start)`.
