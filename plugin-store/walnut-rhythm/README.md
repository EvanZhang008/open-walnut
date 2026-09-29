# Rhythm (walnut-rhythm)

Focus blocks and movement breaks for Walnut. Rhythm does three things:

- **A stand-up reminder that knows when you are at the keyboard.** After an hour of continuous keyboard time it asks you to stand up, with Start break and Snooze buttons. Start break counts a short break down in the sidebar, and the sitting count starts when it ends. Time you spent away already counts as moving, so it never nags someone who just came back from a walk.
- **A focus block (a pomodoro) tied to a task.** Pick a task, start 25 minutes, and the block's minutes are logged on that task when it ends. Then a short break, and a long break every fourth block.
- **Quiet while you focus.** Walnut quiet mode stays on for the length of a block, and it can follow the Mac's own Focus as well.

It adds one App (Rhythm), eight ops, two tools for routine watchers, and one skill that tells Ask Walnut when to use them.

## The three signals it uses

1. **Attention.** Rhythm reads two events Walnut already produces. `time:banked` is the console's own attention record (the browser sends a batch about once a minute); phone time and agent time are ignored, because neither is you at the keyboard. `time:outside` is the Mac-wide frontmost-app stream, sent when Time's app tracking is on (Settings, Screen Tracking); it already leaves out a locked screen and idle stretches over two minutes. Without app tracking, Rhythm only sees time spent in Walnut itself.
2. **Agent turns.** A hook on turn start and turn end. When the reminder is due while an agent is answering, Rhythm waits for the turn to finish so the reminder lands at a natural pause, but never longer than `defer_for_natural_pause_minutes`.
3. **The clock.** A 30 second tick, one timer at the exact end of the running block or break, your quiet hours, and Walnut quiet mode.

The sitting streak works like the chapters in Time: a gap of `away_reset_minutes` with no attention ends it, and the next attention starts a new one. A silent hour is not sitting. The streak is saved in the plugin's data directory, so a server restart keeps it unless the restart took longer than the away threshold.

## What happens when

| Moment | What Rhythm does |
|---|---|
| All the time you sit | A small ring at the bottom of the sidebar, above Voice, fills up toward the next reminder. Click it for **Stand up now** (starts the stand-up break) or **Start focus block**. |
| An hour at the keyboard | The ring turns orange and a "Stand up" reminder appears with **Start break** and **Snooze 10 min**. Ignored, it comes back after another hour. |
| You press Start break (or Stand up now) | The ring turns green and counts down the stand-up break (`stand_break_minutes`, 10 by default). **End break** ends it early. When it runs out, a "Break over" notice sounds and the ring starts filling toward the next stand-up. |
| You walk away while it is waiting | The reminder is withdrawn and counted as a break taken. |
| A focus block starts | Walnut quiet mode on until the block ends (and macOS Do Not Disturb, if you turned that on). The ring turns blue and counts the block down. |
| The block ends | Quiet off, the minutes logged on the task, and "Focus block done, stand up" with **Start break**, **Skip break** and **Another block**. |
| The block's break ends | "Break over" with **Start next block** and **Done for today**. |

The stand-up reminder waits during a focus block (the block's own break handles it), inside quiet hours, and while Walnut quiet mode is on. It fires once they end if you are still sitting.

## Settings

All keys live under `plugins.walnut-rhythm` and show up in Settings, Plugins, Rhythm.

| Key | Default | Meaning |
|---|---|---|
| `reminder_every_minutes` | 60 | Keyboard minutes before the stand-up reminder (15 to 240). |
| `away_reset_minutes` | 5 | This long with no attention counts as a break, and the count starts over. |
| `snooze_minutes` | 10 | How long Snooze waits. |
| `stand_break_minutes` | 10 | Length of the stand-up break that Start break and Stand up now count down (1 to 60). |
| `quiet_hours` | `22:00-08:00` | Local window with no stand-up reminders. Empty turns it off. Windows across midnight work. |
| `defer_for_natural_pause_minutes` | 5 | Longest wait for an agent turn to finish before reminding. 0 never waits. |
| `focus_minutes` | 25 | Length of a focus block. |
| `break_minutes` | 5 | Length of the break after a block. |
| `long_break_minutes` | 15 | Length of the long break. |
| `long_break_every` | 4 | Every Nth block is followed by the long break. |
| `focus_quiets_walnut` | true | Walnut quiet mode for the length of each block. |
| `mirror_macos_focus` | true | Walnut goes quiet while a macOS Focus is on. |
| `macos_focus_shortcuts` | false | Each block turns macOS Do Not Disturb on and off through two Shortcuts. |

## Ops

Ops are named `walnut_rhythm_<name>`. The everyday ones can be called from any Walnut session (`walnut tools call walnut_rhythm_focus_start '{"taskId":"..."}'`); the install op only runs from the App.

| Op | Arguments | Does |
|---|---|---|
| `status` | `refresh?` | Read-only. Streak, next reminder, running block, quiet holds, macOS state, today's scorecard. |
| `focus_start` | `taskId?`, `minutes?` | Start a block. Refused while one is running. |
| `focus_stop` | | Stop the block or break and end the cycle. |
| `break_done` | | Log a stand-up that already happened, with no timer; the sitting count starts over. |
| `break_snooze` | `minutes?` | Snooze the stand-up reminder. |
| `break_start` | | Start a timed break: the one a finished block earned, or else the stand-up break. The sitting count starts when it ends. |
| `break_skip` | | Skip the waiting break, or end the running one early. |
| `macos_shortcuts_install` | | Prepare and open the two shortcuts (Mac only, in-process only). |

`status` and `focus_start` are also registered as tools, for routine watchers. The App updates live from the plugin event `plugin:walnut-rhythm:state`.

## macOS Focus

**Following the Mac's Focus.** With `mirror_macos_focus` on, Rhythm reads two files every 30 seconds: `~/Library/DoNotDisturb/DB/Assertions.json` (a Focus is on while `data[0].storeAssertionRecords` is not empty) and `~/Library/DoNotDisturb/DB/ModeConfigurations.json` (for the Focus's name). While one is on, Walnut quiet mode shows "macOS Focus: <name>" and stand-up reminders wait. Only these two files are read, never a folder scan. Some macOS versions only allow that read with Full Disk Access; when it is refused, the App says so and Rhythm checks again every 10 minutes. A Focus turned on by a schedule may not appear in that file.

Rhythm owns one quiet hold. When a focus block and a macOS Focus overlap, the hold names both and lasts until both are over. Rhythm never removes a quiet hold you set yourself.

**Driving Do Not Disturb.** A plugin cannot switch the Mac's Focus directly, but Shortcuts can. The Rhythm App's **Install shortcuts** button prepares two shortcuts, `Walnut Focus On` and `Walnut Focus Off`, each one "Set Focus: Do Not Disturb" action. It converts each to a binary plist, signs it with `shortcuts sign --mode anyone`, and opens it, so Shortcuts shows its Add Shortcut dialog: one click for each. With `macos_focus_shortcuts` on, each block runs `shortcuts run "Walnut Focus On"` at the start and `Walnut Focus Off` at the end, with a 10 second limit. A failed run is shown in the App and logged once; it never stops the block.

## What it deliberately does not do

- It does not count phone time or agent time as sitting.
- It does not remind you on a cloud replica: the primary Walnut owns the timers, so you are never reminded twice.
- It does not add shortcuts behind your back. Nothing is added to Shortcuts without your click, and nothing under Shortcuts runs unless `macos_focus_shortcuts` is on.
- It does not turn Do Not Disturb back off when the plugin is disabled in the middle of a block.
- It does not send letters or phone pushes of its own. Reminders are Walnut notices, which Walnut keeps quiet during quiet mode.
- It keeps no history beyond one small file per day (`days/<date>.json` in the plugin's data directory).

## Development

```bash
npm run build:plugins                      # once, from the repo root
node packages/plugin-cli/dist/cli.js build --root plugin-store/walnut-rhythm
node packages/plugin-cli/dist/cli.js validate --root plugin-store/walnut-rhythm
npm run test:focus tests/plugins/walnut-rhythm
```

The decisions live in pure modules with their own tests: `presence.ts` (the streak), `scheduler.ts` (the reminder), `focus.ts` (the block cycle and the quiet hold), `clock.ts`, `macos-focus.ts` and `macos-shortcuts.ts`. `runtime.ts` applies them and is tested on a fake clock and a fake host.
