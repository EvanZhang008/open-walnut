---
name: walnut-places
description: >-
  Answer questions about where the user has been, from the visits Walnut on the
  iPhone records once the user turns Places on: "where was I on Tuesday", "how
  long was I at the office this week", "when did I get home", "have I been to the
  gym lately". Use when the user asks about places they went or time spent at one.
---

# Places

Walnut on the iPhone records the places the user visits only after they turn
Places on, and only from then on. There is no history from before that, and
nothing to import. iOS records a visit when the user stays somewhere for a
while, so a quick stop may be missing, and there is never a route between visits.

## 1. Read the visits

```
walnut tools call places_visits '{"last_days":7}'
```

Other windows: `{"from":"2026-10-01","to":"2026-10-03"}` (dates are inclusive),
or one place: `{"last_days":30,"place":"gym"}`.

The answer holds `visits` (oldest first) and `places` (the same visits grouped by
place, longest total first). Per visit:

- `arrival`, `departure`: local time with the offset of where the visit was.
- `durationMin`: the length. Null when either end is unknown.
- `status`: `ended`; `ongoing` (still there, the length counts to now);
  `departure_unknown` (iOS never reported leaving, or Places stopped recording
  first: say the length is unknown, never guess it).
- `arrivalUnknown`: iOS saw only the departure.
- `name`, `address`: what the phone looked up. Null when it could not: describe
  the visit by time, never by coordinates.

## 2. When the answer is empty or carries a `message`

Call `walnut tools call places_status '{}'` and pass its `message` on in your own
words. It says whether Places is off, whether location access is not set to
Always, or whether the phone has not checked in for a while. Do not explain how
the data reaches this Mac, and do not walk the user through Settings.

## 3. Answer

- Lead with the answer to what was asked ("You got to the office at 9:12 and
  left at 6:40, 9 h 28 min").
- For a week, use `places`: a few lines, the main places with their totals.
- Say plainly what is missing (a day with no visit, an unknown departure). Never
  fill a gap.

## Privacy

Where the user goes is personal. Walnut serves it only to sessions on this Mac
and never syncs it. What you write about it is ordinary Walnut content that
syncs, so summarize: never paste coordinates or a list of addresses, and never
write places into MEMORY.md, USER.md, notes or tasks unless the user asks.
