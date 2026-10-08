---
name: walnut-calendar
description: >-
  Read and edit the user's real calendars (macOS Calendar: iCloud, Google,
  Exchange accounts) through Walnut's /api/calendar REST endpoints. Use when
  asked about the user's schedule, meetings, or availability, or to create,
  move, retime, or delete calendar events, or to hide one event in Walnut
  only. Covers listing events in a date range, enumerating calendars, and
  write-back that syncs to the cloud provider via macOS.
---

# Walnut Calendar API

Walnut exposes the Mac's calendars (every account added in macOS System
Settings → Internet Accounts: iCloud, Google, Exchange, …) over REST. Edits
write back through macOS EventKit, so a change made here syncs to the source
calendar without a separate login. For "remove/skip this meeting", hide it in
Walnut by default. Hiding is local, reversible, per-occurrence, and not a decline.

Base URL: `http://localhost:3456/api/calendar` (Walnut server).

## Two ways in, and one way never to use

Inside a Walnut session, prefer the ops (they work from remote hosts too):

```bash
walnut tools call calendar_query '{"from":"2026-08-03","to":"2026-08-09"}'
walnut tools call calendar_event_create '{"calendar_id":"<id>","title":"Dentist","start":"2026-08-05T15:00:00","end":"2026-08-05T16:00:00"}'
walnut tools call calendar_event_update '{"id":"<id>","start":"2026-08-06T15:00:00","end":"2026-08-06T16:00:00"}'
walnut tools call calendar_event_delete '{"id":"<id>"}'
walnut tools call calendar_event_visibility '{"id":"<id>","hidden":true}'
```

The REST endpoints below do the same on the Mac. **Never** write calendars by
running Walnut's calendar helper binary, AppleScript, or `osascript` against
Calendar.app: those bypass Walnut, so open calendar views do not update until
the next background poll (up to 15 minutes).

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
#      "calendarName", "accountName", "color", "location?", "readonly?",
#      "status?", "selfStatus?", "hidden?" } ],
#     "sources": [ { "id": "eventkit", "available", "enabled", "reason?",
#      "message?", "lastRefresh?" } ] }

# Add fresh=1 when a stale answer would be worse than a slow one (~0.25s extra):
# it bypasses the read cache and re-reads macOS.
curl -s 'http://localhost:3456/api/calendar/events?from=2026-08-27&to=2026-08-27&fresh=1'

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

### Cancelled and declined events (read this before reporting a schedule)

Two optional fields say whether a meeting is actually happening. Both are
absent for ordinary personal events, which means "nothing to report" — never
read a missing field as "confirmed".

| field | values | meaning |
|---|---|---|
| `status` | `confirmed`, `tentative`, `canceled` | the meeting's own state |
| `selfStatus` | `pending`, `accepted`, `declined`, `tentative`, `delegated` | the user's response to the invite |

`status: "canceled"` events are **still returned**. An invitation the organizer
cancelled stays in the macOS store (often re-titled `Canceled: …`) until someone
processes the cancellation, so the API reports it and marks it rather than
quietly dropping it. When summarising a day, exclude `status: "canceled"` and
`selfStatus: "declined"` entries from "what you have on", or call them out as
cancelled/declined — do not present either as a meeting the user is attending.

### Freshness

`sources[0].lastRefresh` is when Walnut last read macOS. Reads are served from a
short-lived cache (default 60s), and macOS syncs Exchange/Google on its own
schedule on top of that, so a change made in Outlook seconds ago may not be
visible yet. Use `fresh=1` to skip Walnut's cache; if an event still looks wrong
after that, the lag is macOS↔provider sync, not Walnut, and the fix is on the
Mac (open Calendar.app and press ⌘R).

## Write

Only calendars with `readonly: false` accept writes (a write to a read-only
calendar returns 409). Agents may update or delete only private blocks with
proven Walnut ownership and no attendees or another organizer. Old blocks
without an ownership stamp are protected too. Never infer ownership from a
plain title or from "no attendees".

Invited events and non-Walnut events require the person to use the calendar UI.
It names the event, the organizer, and the recurring-series risk before asking
for confirmation on the Mac. A REST flag or a conversational "yes" is not an
approval. Protected update/delete returns `human-approval-required`, pointing
to Hide event. Never retry through the native helper or another calendar API.
An invited recurring occurrence can affect the entire series and notify the
organizer, even when EventKit is asked to change only that occurrence. Protected
confirmation is Mac-only, not relayed through the cloud companion; hide works
through both.

```bash
# Create (end defaults are NOT applied server-side — always send end)
curl -s -X POST http://localhost:3456/api/calendar/events \
  -H 'Content-Type: application/json' \
  -d '{"calendarId":"<id from /sources>","title":"Dentist",
       "start":"2026-08-05T15:00:00","end":"2026-08-05T16:00:00"}'
# All-day: use date-only start/end (end inclusive) and "allDay": true.

# Move / retime / rename a private Walnut-created block (start AND end required)
curl -s -X PATCH 'http://localhost:3456/api/calendar/events/<url-encoded id>' \
  -H 'Content-Type: application/json' \
  -d '{"start":"2026-08-06T15:00:00","end":"2026-08-06T16:00:00","title":"Dentist (moved)"}'

# Delete a private Walnut-created block. Use hide for remove/skip a meeting.
curl -s -X DELETE 'http://localhost:3456/api/calendar/events/<url-encoded id>'
```

## Hide an event in Walnut only

Hiding leaves the event in the user's calendar (nothing is deleted or edited in
macOS, Google or Exchange) and only removes it from Walnut's views and reads.
It works on read-only events too. For a recurring event the id names one
occurrence, and only that occurrence is hidden.

```bash
# Hide (hidden:false shows it again). Repeating a call is harmless.
curl -s -X PATCH 'http://localhost:3456/api/calendar/events/<url-encoded id>/visibility' \
  -H 'Content-Type: application/json' -d '{"hidden":true}'
# → { "id", "hidden", "changed", "sources" }

# Hidden events are left out of GET /events; include_hidden=1 returns them
# marked "hidden": true (use this to find one to show again).
curl -s 'http://localhost:3456/api/calendar/events?from=2026-08-03&to=2026-08-09&include_hidden=1'
```

- Take the id from `GET /events`. A missing event answers 404. A source without
  read-by-id support may ask you to query the event's date range first.
- Personal AI tools: `calendar_event_visibility {id, hidden}`, and
  `calendar_query` with `include_hidden: true`.

## Error codes

| HTTP | code | meaning |
|---|---|---|
| 400 | `usage` | bad params / date format |
| 403 | `permission-denied` | macOS Calendar access not granted (Full Access) |
| 403 | `human-approval-required` | protected update/delete; use Hide event instead |
| 403 | `approval-canceled` | the person canceled the Mac confirmation; nothing changed |
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
