---
name: weekly-health-trend
description: >-
  Compare this week's sleep and activity with last week's, next to how much the
  user worked, with honest small-sample caveats. Use for the Sunday 19:00
  weekly-health-trend routine, or when the user asks for a weekly health trend,
  "week over week", or how work and sleep moved together.
---

# Weekly health trend

Week over week: this week (the 7 days ending today) against the 7 days before.

## 1. Read

```
walnut tools call health_sleep '{"last_nights":14}'
walnut tools call health_daily '{"last_days":14,"metrics":"activity,vitals,workouts"}'
```

Split both answers into the two weeks yourself (the newest 7 entries are this
week). The time on tasks for the same 14 days:

```
walnut tools call time_summary '{"days":14}'
```

Use only these named reads. If one is refused, say what was refused and stop:
health data is only available to sessions on this Mac, and no other call is a
way around that.

If `health_sleep` answers `connected: false`, say Apple Health is not connected
and stop.

## 2. Compare

For each week: average hours asleep, average bedtime, nights under 6 hours,
steps per day, exercise minutes, resting heart rate, HRV (SDNN), and hours of
human time on tasks.

- Count only nights and days with data. Report how many each week had
  ("5 of 7 nights recorded"). A night with status `in_bed_only` counts for
  bedtime and time in bed only (its `asleepMin` is null): say "only time in bed
  was recorded" for those nights and leave them out of hours asleep. A night
  with `unrecordedGaps` has a recording gap: leave it out of hours asleep and
  bedtime, and say how many nights had one.
- With fewer than 5 recorded nights or days in either week, say the comparison
  is too thin to mean much, and show the numbers without calling a trend.
- A change is worth naming only when it is large next to the week's own spread
  (for example more than 30 minutes of sleep, or more than 10% for HRV).
- Work and sleep: say whether heavier work weeks lined up with shorter or later
  sleep. Two weeks cannot show cause; say "moved together", never "caused".

## 3. Write it

A short letter or reply: a small table (this week, last week, change), then
three plain sentences. End with the caveats in one line: consumer sleep stages
are estimates, HRV is SDNN (not RMSSD), and this is not medical advice.

## Privacy rule

Walnut serves health data only to sessions on this Mac and never syncs or
relays the samples. What you write about the data (a letter, a chat reply) is
ordinary Walnut content and syncs like any other letter. So summarize: never paste raw series or long lists of readings.
Never write health numbers into MEMORY.md or USER.md (or notes and tasks)
unless the user asks you to.
