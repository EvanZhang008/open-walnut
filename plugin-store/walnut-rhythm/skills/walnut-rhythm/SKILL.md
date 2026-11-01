---
name: walnut-rhythm
description: Start, stop and read Rhythm focus blocks (pomodoros, optionally tied to a task) and their breaks. Use when someone asks for a pomodoro, a focus block, a break, or whether a block is running.
---

# Rhythm: focus blocks the person starts

Rhythm is a Walnut plugin. It is off until the person starts a focus block (a pomodoro), optionally tied to a task. Walnut goes quiet while the block runs, the break follows by itself, and when the break ends Rhythm asks once whether to start the next block; with no answer it stays off. It counts nothing on its own: no keyboard time, no sitting time.

Every op below is called with `walnut tools call <op> '<json args>'`. Read `walnut_rhythm_status` first whenever the answer depends on what is running.

## When to call what

| The person says | Call |
|---|---|
| "start a pomodoro", "focus on this for 25 minutes", "start a focus block on this task" | `walnut_rhythm_focus_start` with `taskId` (the task you are working in, if any) and optional `minutes` / `breakMinutes` |
| "start a block with Deep Focus", "play my Spotify focus playlist with it" | `walnut_rhythm_focus_start` with `spotify` (a playlist link or URI from `music_tracks`' `spotify.playlists`) |
| "stop the timer", "cancel the pomodoro", "I'm done focusing" | `walnut_rhythm_focus_stop` |
| "end the break", "I'm back" during a break | `walnut_rhythm_break_skip`, then `walnut_rhythm_focus_start` if they want another block |
| "how much did I focus today", "is a block running", "when does it end" | `walnut_rhythm_status` |
| "what focus music do I have", "is my brown noise there" | `walnut_rhythm_music_tracks` |

## Ops

- `walnut_rhythm_status` `{ refresh?: boolean }`: read-only. Returns the run (`focus.phase` is `idle` (off), `focus` or `break`, with `focus.runStartedAt`, `focus.endsAt`, `focus.title`, and `focus.lastRun` when off), quiet mode (`quiet.holds`), macOS state, and `today` (focus minutes, blocks, breaks, blocks stopped early).
- `walnut_rhythm_focus_start` `{ taskId?: string, minutes?: integer, breakMinutes?: integer, spotify?: string, remember?: boolean }`: starts a block, then its break of `breakMinutes`. `spotify` plays that playlist in Spotify on the Mac until the block ends; the answer says when Spotify did not play (`spotifyError`), and the block runs anyway. Pass `remember: true` only when the person asked to change their default lengths. Refused while one is already running; stop it first only if the person asked for a new one.
- `walnut_rhythm_focus_stop` `{}`: stops the block or break and ends the cycle. Rhythm is off after it. A stopped block does not count as completed.
- `walnut_rhythm_break_skip` `{}`: ends the running break early. Rhythm is off after it.
- `walnut_rhythm_music_tracks` `{}`: read-only. The audio files in the focus music folder (`folder`, `tracks[].title`, `tracks[].file`), in play order, and `spotify` (`available`, `reason`, `playlists[].uri`, `playlists[].name`).
- `walnut_rhythm_spotify_playlist_add` `{ link, name? }` / `walnut_rhythm_spotify_playlist_remove` `{ uri }`: keep or drop a playlist in the Start form's list, when the person asks.

Each mutating op answers `{ message, state }`; relay `message` in one sentence.

## Rules

- Start a block only when the person asked for one in their own words. Never start one from a routine, a schedule, a guess that they are working, or to "keep the rhythm going". Rhythm is off until they start it, by design.
- Tie a block to a task only with a real task id (the task you are in, or one the person named). Never invent one.
- Do not add your own break or stand-up reminders on top of Rhythm. It asks once after each break; that is all the person wants.
- Folder music plays in the person's browser or phone, never from an op: you cannot start or stop that sound. Tell them to pick it in the Start form (the sidebar ring's popover or the Rhythm app; on the phone, Settings, Focus music). To add music, they put m4a, mp3 or wav files in the folder `music_tracks` names. A Spotify playlist is the one music an op can start, with `focus_start`, on the Mac. Never download music from Spotify or other services.
- `macos_shortcuts_install` is not for you: it opens dialogs on the Mac's screen, so it only runs from the Install shortcuts button in the Rhythm app.
- Settings (block and break lengths, quiet, music) live under `plugins.walnut-rhythm` and are edited in the Rhythm app. Point the person there rather than changing config yourself.
