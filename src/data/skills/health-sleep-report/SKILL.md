---
name: health-sleep-report
description: >-
  Report on the user's recent sleep from Apple Health: the last 7 nights against
  their own 28-night baseline, with plain flags and the prior day's context. Use
  when the user asks "how did I sleep", "sleep report", "am I sleeping enough",
  or wants their sleep compared with their work.
---

# Sleep report

A short, honest read of the last week of sleep, measured against the user's own
baseline. Not a diagnosis.

## 1. Read the data

```
walnut tools call health_sleep '{"last_nights":7}'
```

The answer holds `nights` (one per wake date), `averages` for the 7 nights,
`baseline28` (the 28 nights before them, with its own `n`), and `caveats`.

Night statuses:

- `ok`: a full night.
- `in_bed_only`: only time in bed was recorded (an iPhone without an Apple
  Watch records nothing else). Bedtime, wake and `inBedMin` are real,
  `asleepMin` is null. Say "only time in bed was recorded" and report those
  three; never estimate sleep from time in bed, and skip every sleep flag below
  except bedtime drift.
- `no_main_night`: only naps were recorded for that wake date; say so.
- `missing`: nothing arrived.

A night that carries `unrecordedGaps` had sleep recorded close to it with
nothing recorded in between (that sleep is listed under `naps`). Walnut cannot
tell a real wake from a recording gap such as a flat battery, so say the
recording has a gap and give the gap (`min`) and the sleep after it
(`otherSleepMin`). Never state that night's wake time, bedtime or hours asleep
as fact, and leave it out of the short sleep flag.

If it answers `connected: false`, or most nights read `status: missing`, run
`walnut tools call health_status '{}'` and tell the user what it shows (last
upload, which types have data). A type in `unknown_or_denied` means either the
permission is off or there is no such data: say both, never pick one.

Then read the prior day for context:

```
walnut tools call day_review '{"date":"<the day before the latest wake date>"}'
```

Use only the sections it returns. Anything listed in `unavailable` is missing:
say so, never fill it in.

## 2. Flags

Raise a flag only when the numbers support it, and say which numbers:

- **Short sleep**: a night with `asleepMin` under 360 (6 hours), or a 7-night average under 6 hours.
- **Bedtime drift**: bedtimes spread over more than 60 minutes across the week, or the average bedtime more than 45 minutes later than `baseline28.bedtime`.
- **Low deep sleep**: `stages.deepMin` under 45 on nights where `stagesCoverage` is at least 0.8. Skip this flag when stages are missing or coverage is low, and say why.
- **HRV below baseline**: the 7-night `hrvSdnn` average more than 10% below `baseline28.hrvSdnn`, and only when `baseline28.n` is at least 14.
- **Resting heart rate up**: the 7-night `restingHr` average more than 3 count/min above `baseline28.restingHr`, again only when the baseline has at least 14 nights.

When `baseline28.n` is small, say the baseline is thin and compare nothing
against it.

## 3. Join work and sleep

From the prior day's `day_review`, note what may relate to the latest night:
tasks finished late, long evening screen or app time, a heavy calendar. Offer it
as a possible link, never as a cause.

## 4. Write it

- One screen: the week in two sentences, then the flags, then the work context.
- Minutes as hours and minutes (7h 12m). Bedtimes as local clock times.
- Always state the caveats from the answer in one short line each: stages from
  a consumer wearable are estimates, HRV here is SDNN (not RMSSD, so it is not
  comparable with RMSSD apps), and this is not medical advice. Suggest a
  clinician for anything that worries the user.
- No medical claims, no diagnoses, no supplement or drug advice.

## Privacy rule

Walnut serves health data only to sessions on this Mac and never syncs or
relays the samples. If a health read is refused, say so and stop: no other call
is a way around that. What you write about the data (a letter, a chat reply) is
ordinary Walnut content and syncs like any other letter. So summarize: never paste raw series or long lists of readings.
Never write health numbers into MEMORY.md or USER.md (or notes and tasks)
unless the user asks you to.
