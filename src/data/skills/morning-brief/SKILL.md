---
name: morning-brief
description: >-
  Write the user's morning brief: last night's sleep against their baseline,
  yesterday in one paragraph, and today's calendar and focus, sent as one inbox
  letter. Use when the morning-brief routine wakes on health:sleep-ready, or when
  the user asks for a morning brief or "what does today look like".
---

# Morning brief

One letter the user reads over breakfast. It runs from the `morning-brief`
routine template (it wakes on `health:sleep-ready`) or on request.

## 1. Read

```
walnut tools call health_sleep '{"last_nights":1}'
walnut tools call day_review '{"date":"<yesterday>"}'
walnut tools call day_review '{"date":"<today>","sections":"calendar,focus,tasks"}'
```

- `health_sleep` gives last night and `baseline28` (the 28 nights before it).
  Read the night's `status`:
  - `ok`: a full night, use it as below.
  - `in_bed_only`: write "Only time in bed was recorded" with the time in bed,
    bedtime and wake. No hours asleep, no stages, no baseline comparison of
    sleep.
  - `no_main_night`: write "No main night was recorded, only naps" and give the
    nap lengths from `naps`.
  - `missing`, or the routine woke on a `missing` event: write "No sleep data
    arrived for last night".
  If the night carries `unrecordedGaps`, sleep was recorded close to it with
  nothing in between: write "The sleep recording has a gap" with the gap's
  minutes and the sleep after it, and do not give the wake time or hours asleep
  as fact.
  Never guess a number the answer does not hold.
- Use only the sections `day_review` returns. Every entry in `unavailable` is
  missing: leave it out or name it as missing, never invent it.

## 2. Write the letter

Send ONE letter:

```
walnut tools call human_inbox_send '{"type":"info","subject":"Morning brief: <weekday>","markdown":"..."}'
```

Body, in this order, one phone screen:

1. **Sleep**: hours asleep, bedtime and wake, and one comparison with the
   baseline when `baseline28.n` is at least 14 (for example "40 minutes less than
   your usual"). Mention stages only when `stagesCoverage` is at least 0.8.
2. **Yesterday**: tasks completed, time on tasks, anything notable, in two sentences.
3. **Today**: the calendar in time order, and the focus state if Rhythm is installed.
4. One line of caveat: consumer sleep stages are estimates and this is not
   medical advice.

Keep it factual and calm. No scores, no medical claims, no advice beyond what
the numbers plainly show.

## Privacy rule

Walnut serves health data only to sessions on this Mac and never syncs or
relays the samples. If a health read is refused, say so and stop: no other call
is a way around that. What you write about the data (a letter, a chat reply) is
ordinary Walnut content and syncs like any other letter. So summarize: never paste raw series or long lists of readings.
Never write health numbers into MEMORY.md or USER.md (or notes and tasks)
unless the user asks you to.
