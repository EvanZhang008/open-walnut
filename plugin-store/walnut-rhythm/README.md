# Rhythm (walnut-rhythm)

Focus blocks you start yourself, for Walnut. Rhythm is **off until you press Start**: it never starts, counts or records anything on its own.

- **A run starts only when you start it.** Press Start (in the sidebar ring, the Rhythm App, the phone, or by asking Ask Walnut) and a focus block runs, optionally tied to a task. Its minutes are logged on that task when it ends.
- **The break follows by itself, then Rhythm asks once.** When the block ends its break counts down (a long break every fourth block). When the break ends, Rhythm asks once whether to start the next block. If you do not, it stays off.
- **Quiet while you focus.** Walnut quiet mode stays on for the length of a block, and it can follow the Mac's own Focus as well.
- **Focus music from your own folder.** One click plays the tracks in a folder on your Mac (brown noise, rain, whatever you put there), looping, in the console, the Mac app and the phone, or a Spotify playlist in your own Spotify app on the Mac. You pick it, with the block and break lengths, right before Start, and the Start form says what will play. Music started with a block stops when the block ends.

It adds one App (Rhythm), eight ops, one read-only tool for routine watchers, and one skill that tells Ask Walnut when to use them.

## What it reads

Nothing about you. Rhythm does not read keyboard or app time, attention, or agent turns. What moves it is your own Start, Rest, Extend, Stop and End break, Walnut quiet mode, its settings, and the clock (a 30 second tick and one timer at the exact end of the running block or break). The clock only ever moves a run toward off: a restart, a reload, waking the Mac from sleep or opening another window never starts one. A run that ended while Walnut was down is closed quietly; a notice that would arrive more than 10 minutes late is not shown.

## What happens when

| Moment | What Rhythm does |
|---|---|
| Off (the start, and after every run) | The sidebar ring shows **Rhythm is off** with a pause glyph. No countdown, because nothing counts. After a run it names the last run ("Last run 10:05 to 10:35"). Its popover holds the Start form (below). |
| You pick and press Start | The Start form, the same in the ring's popover and the Rhythm App (the phone has its own): **Focus** (15, 25, 45, 60, or type 5 to 180 minutes), **Break** (5, 10, 15, or type 1 to 60), **Music** (No music, a track from the folder, or a Spotify playlist), and one line saying plainly what Start plays ("Start plays Brown Noise on this device, until the block ends"). The lengths you start with become the next defaults (they are the `focus_minutes` and `break_minutes` settings); the music pick is kept per device. |
| The block runs | Walnut quiet mode on until the block ends: no toast, sound, phone push, or count or dot on the sidebar (and macOS Do Not Disturb until the block ends, if you turned that on). The ring turns blue, counts the block down and says when it started and ends. **Rest now** ends it early and starts its break at once (the time it ran is logged; it does not count toward the long break), **+5 min** adds time (quiet and Do Not Disturb run to the new end), **Stop block** ends it; Rhythm is off after it. |
| The block ends | Quiet off, the minutes logged on the task, and the break starts by itself (the break picked at Start, or `long_break_minutes` every `long_break_every` blocks). One notice says so, with **End break** and **Another block**. The ring turns green and counts the break down; its popover offers **Focus now** (the next block, at once), **+5 min break** and **End break**. |
| The break ends | One notice, "Break over. Start the next block?", with **Start next block** and **Not now**. Either way, or with no answer at all, Rhythm is off until the next Start. |

## Focus music

Rhythm ships no audio. It plays the files in one folder on the Mac: by default `focus-music` in the plugin's data directory (`~/.open-walnut/plugin-data/walnut-rhythm/focus-music`, made on first use; `plugin-data/` is machine-local and never synced), or the folder named in `music_folder`. Only the folder's own `.m4a`, `.mp3` and `.wav` files count, sorted by name with numbers in order, so `01 Brown Noise.m4a` plays first. Those three formats play on every surface (Chromium, Safari, the Mac app's WebKit, the phone); other audio files, and names with `..` (the file route refuses those), are named as skipped. A file added later shows up on the next Refresh.

| Where | What it does |
|---|---|
| Rhythm App, Focus music | **Play** / **Stop** (one click each), the volume, Repeat one, In order or Shuffle, the track list, the folder with **Open folder** (Finder) and **Refresh**. |
| The Start form | Its **Music** pick plays when you press Start: a track starts on the device you clicked, a Spotify playlist in Spotify on the Mac. Until you pick, `music_with_focus` decides (on: the current track; off: no music). **Preview** beside each choice plays 10 seconds of a track here, or 15 seconds of a playlist in Spotify on the Mac; picking, another preview or closing the list ends it. |
| While a block runs | The ring's popover and the App's focus card say what plays now ("Playing Brown Noise on this device until the block ends"), with **Pause** / **Resume** for it (the block runs on), and offer the same list, with Preview, to switch the music, No music included, without stopping the block. The switch is also what the next Start plays on that device. |
| Stars | The star beside each sound keeps it at the top of every music list (right under No music), on every device; the stars live on the Mac with Rhythm's state. |
| Goal | The Start form's **Goal** field says what the block is for. The ring's popover names it in its header and offers **Edit goal** while the block runs; the App shows it above the countdown. It also goes into the block's notices, the day log and the task's log, and "Another block" keeps it. |
| Rhythm App, Spotify playlists | The playlists the Start form offers, **Deep Focus** to begin with. Paste a playlist's share link to add one (its name comes from Spotify), **Remove** to take it off. |
| iPhone, Settings, Focus music | The same Play / Stop, volume, order and tracks, plus the Start form's lengths and music (a track plays on the phone, a Spotify playlist on the Mac) and stopping a block. Keeps playing with the screen locked and in other apps; Lock Screen controls stop it. |

How it plays:

- The sound belongs to the device that clicked. A block started by an agent or on another device never starts sound here, so two windows never play over each other.
- Music started with a block, or while one runs, is tied to it and stops when the block ends or is stopped. Music started while idle plays until you stop it.
- The tracks stream through Walnut's raw file route, which answers byte ranges, so an 8 hour file starts at once and is never copied. On a cloud companion the phone reads them from the Mac through the bridge.
- One track on repeat loops on its own (the phone uses a gapless looper). The console's player is one audio element for the whole page, so moving to another screen never stops it. Track, order and volume are kept per device.
- On the phone, a call or an alarm pauses the music and it comes back when iOS allows.

### Spotify

Rhythm never downloads or streams Spotify audio. A Spotify pick plays in your own Spotify app on the Mac, through its supported AppleScript commands (`play track "spotify:playlist:..."`, `pause`): Start plays the playlist, and the block's end or Stop pauses it (only when Spotify is running; it never opens Spotify to pause). The first time, macOS asks whether Walnut may control Spotify (System Settings, Privacy & Security, Automation). If Spotify is not installed, the form says so and offers no playlists; if it is closed, Start opens it; if it does not start playing (not signed in, say), the block still runs and the form says why. Only links that look like a Spotify playlist, album, artist, show or track reach the script.

## Settings

All keys live under `plugins.walnut-rhythm` and show up in the Rhythm App's settings.

| Key | Default | Meaning |
|---|---|---|
| `focus_minutes` | 25 | Length of a focus block. |
| `break_minutes` | 5 | Length of the break after a block. |
| `long_break_minutes` | 15 | Length of the long break. |
| `long_break_every` | 4 | Every Nth block is followed by the long break. |
| `focus_quiets_walnut` | true | Walnut quiet mode for the length of each block. |
| `mirror_macos_focus` | true | Walnut goes quiet while a macOS Focus is on. |
| `macos_focus_shortcuts` | false | Mac Do Not Disturb during focus blocks: each block turns it on until it ends, through two Shortcuts you add once. A Focus you turned on yourself is left alone. The Start form and the running block's popover can change it for one block. |
| `music_folder` | empty | Folder on this Mac whose m4a, mp3 and wav files are the focus music. `~/` works. Empty uses the plugin's own `focus-music` folder. |
| `music_with_focus` | true | Until a device picks its Start music, Start plays the current track there (off: no music). Music started with a block stops when the block ends. |

The stand-up reminder an older version had (it counted keyboard time on its own) is gone, and so are its settings (`reminder_every_minutes`, `away_reset_minutes`, `snooze_minutes`, `stand_break_minutes`, `quiet_hours`, `defer_for_natural_pause_minutes`). Left in config.yaml they are ignored.

## Ops

Ops are named `walnut_rhythm_<name>`. The everyday ones can be called from any Walnut session (`walnut tools call walnut_rhythm_focus_start '{"taskId":"..."}'`), only when the person asked; the Finder and macOS ones only run from the App.

| Op | Arguments | Does |
|---|---|---|
| `status` | `refresh?` | Read-only. Off or running, the run's start and end, the last run, quiet holds, macOS state, today's scorecard. |
| `focus_start` | `taskId?`, `goal?`, `minutes?`, `breakMinutes?`, `spotify?`, `remember?`, `dnd?`, `mode?` | Start a block, with its break length and, on the Mac, a Spotify playlist (link or URI) that plays until it ends. `remember` keeps the lengths as the defaults (the Start forms send it). Refused while one is running; during a break it starts the next block now. With `focus_rest`, the only things that start a run. |
| `focus_rest` | `minutes?` | Rest now: during a block it ends there and its break starts; while off, a rest of its own (no quiet, no Do Not Disturb). `focus_start` with `mode: "rest"` does the same. Refused during a break. |
| `focus_extend` | `minutes?` | Add time (default 5) to the block or break running now. Refused while off. |
| `focus_stop` | | Stop the block or break and end the cycle; Rhythm is off after it. |
| `break_skip` | | End the running break early; Rhythm is off after it. |
| `music_tracks` | | Read-only. The tracks in the focus music folder, in play order, with their paths on the Mac, and the Spotify playlists (with whether Spotify is installed). |
| `focus_goal` | `goal` | Set, change or (empty) clear the running block's goal. Refused when no block runs. |
| `focus_music_pause` | `paused` | Pause or play on the running block's Spotify music on the Mac; the block runs on. A folder track pauses in the browser that plays it. |
| `music_star` | `key`, `on` | Star (`on: true`) or unstar a sound: `track:<id>` or `spotify:<uri>`. Starred sounds sit on top of the music list on every device. |
| `focus_music` | `spotify?` | Switch the running block's Spotify music: a playlist plays on the Mac, empty pauses the one the block played. A folder track plays in the browser that picked it. Refused when no block runs; it never starts one. |
| `spotify_preview` | `uri?`, `stop?` | 15 seconds of a playlist in Spotify on the Mac, then the block's own playlist comes back, or Spotify pauses. `stop: true` ends it early. |
| `spotify_playlist_add` | `link`, `name?` | Keep a Spotify playlist for the Start form. |
| `spotify_playlist_remove` | `uri` | Take one off Rhythm's list (it stays in Spotify). |
| `music_folder_open` | | Show the focus music folder in Finder (Mac only, in-process only). |
| `macos_shortcuts_install` | | Prepare and open the two shortcuts (Mac only, in-process only). |
| `focus_dnd` | `on` | Turn Mac Do Not Disturb on (until the block ends) or off for the running block. |
| `dnd_setting` | `on` | The `macos_focus_shortcuts` setting, from the App's switch. |
| `macos_privacy_open` | | Open System Settings at Full Disk Access (Mac only, in-process only). |

Only `status` is also registered as a tool, for routine watchers: a routine runs on a schedule, and a run never starts without you. The App updates live from the plugin event `plugin:walnut-rhythm:state`.

## macOS Focus

**Following the Mac's Focus.** With `mirror_macos_focus` on, Rhythm reads two files every 30 seconds: `~/Library/DoNotDisturb/DB/Assertions.json` (a Focus is on while `data[0].storeAssertionRecords` is not empty) and `~/Library/DoNotDisturb/DB/ModeConfigurations.json` (for the Focus's name). While one is on, Walnut quiet mode shows "macOS Focus: <name>". Only these two files are read, never a folder scan. Those files sit behind Full Disk Access, so Rhythm reads them through Walnut's one grant for it (`walnut.macos.readProtectedFile`): the program to allow is Walnut, the same row in System Settings that stops the file popups in sessions, never the `node` running the server. When it is refused, the App says so and Rhythm checks again every 10 minutes. A Focus turned on by a schedule may not appear in that file.

Rhythm owns one quiet hold. When a focus block and a macOS Focus overlap, the hold names both and lasts until both are over. Rhythm never removes a quiet hold you set yourself.

**Driving Do Not Disturb.** A plugin cannot switch the Mac's Focus directly, but Shortcuts can. The Rhythm App's **Add shortcuts** button prepares two shortcuts: `Walnut Do Not Disturb Until Block Ends` (Get Dates from Input, then "Set Focus: Do Not Disturb on until" that date) and `Walnut Focus Off` ("Set Focus: Do Not Disturb off"). It converts each to a binary plist, signs it with `shortcuts sign --mode anyone`, and opens it, so Shortcuts shows its Add Shortcut dialog: one click for each, once. At Start Rhythm first reads the Mac's Focus state: when any Focus is already on, it leaves it alone and says so. Otherwise it runs `shortcuts run "Walnut Do Not Disturb Until Block Ends" --input-path <file>` with the block's end time, then reads macOS again and keeps the id of the Do Not Disturb that started. macOS holds the end time itself, so Do Not Disturb ends on time even if Walnut or the Mac restarted in between. A Stop runs `Walnut Focus Off`, but only while that same Do Not Disturb is still on: one you turned off and on again yourself has another id and stays. The record lives in `state.json`, so a restart of Walnut mid-block still knows which one is Rhythm's. Every failure (the shortcuts not added, macOS keeping the Focus state private, a run that fails, a run that starts nothing) is said in the block's popover and the App; it never stops the block. The older `Walnut Focus On` shortcut (on until turned off), an early `Walnut Do Not Disturb Until` (set no end time) and `Walnut Do Not Disturb Until End` (handed its output back, so macOS asked before each first run) are no longer run, and the App says you can delete them. Add shortcuts only adds a name that is missing, so whenever the "on" shortcut's actions change it gets a new name (a test pins the two together). A test copy of Walnut (an ephemeral server, data in the temp folder) reads the Mac's Focus but never changes Do Not Disturb or Spotify, since it holds a copy of the real Walnut's running block; `WALNUT_RHYTHM_REAL_MAC=1` lets a test drive them on purpose.

## What it deliberately does not do

- It does not start, count or record anything you did not start. Nothing counts in the background, and there is no keyboard or app tracking.
- It does not remind you on a cloud replica: the primary Walnut owns the timers, so you are never reminded twice.
- It does not add shortcuts behind your back. Nothing is added to Shortcuts without your click, and no shortcut runs unless you turned Mac Do Not Disturb on (the setting, or the switch for one block).
- It does not turn Do Not Disturb back off when the plugin is disabled in the middle of a block; macOS still ends it when the block would have.
- It does not send letters or phone pushes of its own. Reminders are Walnut notices, which Walnut keeps quiet during quiet mode.
- It ships, downloads and uploads no audio. It plays only the files you put in the folder, from where they are.
- It keeps no history beyond one small file per day (`days/<date>.json` in the plugin's data directory).

## Development

```bash
bun run build:plugins                      # once, from the repo root
bun packages/plugin-cli/dist/cli.js build --root plugin-store/walnut-rhythm
bun packages/plugin-cli/dist/cli.js validate --root plugin-store/walnut-rhythm
bun run test:focus tests/plugins/walnut-rhythm
```

The decisions live in pure modules with their own tests: `focus.ts` (the run and the quiet hold), `clock.ts`, `macos-focus.ts`, `macos-shortcuts.ts` and `music.ts` (which files are tracks). The console's player is `web/music.ts`; the phone's is `ios-native/Walnut/Stores/FocusMusicPlayer.swift`. `runtime.ts` applies them and is tested on a fake clock and a fake host; `tests/plugins/walnut-rhythm/never-starts-alone.test.ts` checks that nothing but a Start begins a run.
