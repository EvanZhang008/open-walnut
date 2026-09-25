---
name: walnut-rhythm
description: Start, stop and read Rhythm focus blocks (pomodoros tied to a task) and answer or snooze its stand-up reminder. Use when someone asks for a pomodoro, a focus block, a break, or to snooze or silence the stand-up reminder.
---

# Rhythm: focus blocks and stand-up breaks

Rhythm is a Walnut plugin. It counts time at the keyboard, reminds the person to stand up after a stretch of it, and runs focus blocks (pomodoros) that can be tied to a task. Walnut goes quiet while a block runs.

Every op below is called with `walnut tools call <op> '<json args>'`. Read `walnut_rhythm_status` first whenever the answer depends on what is running.

## When to call what

| The person says | Call |
|---|---|
| "start a pomodoro", "focus on this for 25 minutes", "start a focus block on this task" | `walnut_rhythm_focus_start` with `taskId` (the task you are working in, if any) and optional `minutes` |
| "stop the timer", "cancel the pomodoro", "I'm done focusing" | `walnut_rhythm_focus_stop` |
| "start my break", "ok, break time" after a block ended | `walnut_rhythm_break_start` |
| "skip the break", "keep going" | `walnut_rhythm_break_skip`, then `walnut_rhythm_focus_start` if they want another block |
| "snooze the stand-up reminder", "remind me later" | `walnut_rhythm_break_snooze` with optional `minutes` |
| "I stood up", "I took a walk", "done" to the reminder | `walnut_rhythm_break_done` |
| "how long have I been sitting", "how much did I focus today", "is a block running" | `walnut_rhythm_status` |

## Ops

- `walnut_rhythm_status` `{ refresh?: boolean }`: read-only. Returns the sitting streak (`sitting.sittingMs`), the next reminder (`reminder.phase`, `reminder.dueAt`, `reminder.pausedBy`), the running block (`focus.phase` is `idle`, `focus`, `break_due` or `break`, with `focus.endsAt` and `focus.title`), quiet mode (`quiet.holds`), macOS state, and `today` (focus minutes, blocks, breaks taken, reminders fired).
- `walnut_rhythm_focus_start` `{ taskId?: string, minutes?: integer }`: starts a block. Refused while one is already running; stop it first only if the person asked for a new one.
- `walnut_rhythm_focus_stop` `{}`: stops the block or break and ends the cycle. A stopped block does not count as completed.
- `walnut_rhythm_break_start` `{}`: starts the break a finished block earned (the long break every Nth block).
- `walnut_rhythm_break_skip` `{}`: skips the waiting or running break.
- `walnut_rhythm_break_snooze` `{ minutes?: integer }`: the reminder returns after that many minutes at the keyboard.
- `walnut_rhythm_break_done` `{}`: records a break and starts the sitting count over.

Each mutating op answers `{ message, state }`; relay `message` in one sentence.

## Rules

- Tie a block to a task only with a real task id (the task you are in, or one the person named). Never invent one.
- Do not start a block, snooze, or log a break unless the person asked. These are their timers.
- The stand-up reminder already waits during focus blocks, quiet hours, Walnut quiet mode and a macOS Focus. Do not add your own reminders on top of it.
- `macos_shortcuts_install` is not for you: it opens dialogs on the Mac's screen, so it only runs from the Install shortcuts button in the Rhythm app.
- Settings (reminder interval, block and break lengths, quiet hours) live under `plugins.walnut-rhythm` and are edited in Settings, Plugins, Rhythm. Point the person there rather than changing config yourself.
