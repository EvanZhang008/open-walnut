/**
 * Rhythm's ops (for sessions, the App and notice buttons) and one read-only tool (for
 * routine watchers). The host names them `walnut_rhythm_<name>`.
 *
 * Reach: the everyday actions (`status`, starting and stopping a block, ending a break)
 * are `remote: 'allow'`, so Ask Walnut can run them from a session when someone says
 * "start a pomodoro on this task". They only move Rhythm's own timers. A routine gets
 * `status` alone: a run starts only when the person asks, never from a schedule.
 * `macos_shortcuts_install` stays in-process: it writes files and opens a dialog on the
 * Mac's screen, which should always follow a human's click in the App.
 */
import type { PluginOpDefinition, WalnutServerApi } from '@open-walnut/plugin-api/server'
import * as actions from './actions'
import type { RhythmRuntime } from './runtime'

type Handler = (args: Record<string, unknown>) => Promise<unknown>

const MINUTES = { type: 'integer', description: 'Minutes' }
const TASK_ID = { type: 'string', description: 'The task this focus block is for (optional)' }

interface OpSpec {
  name: string
  title: string
  description: string
  readonly: boolean
  remote: 'allow' | 'deny'
  properties?: Record<string, unknown>
}

export const OP_SPECS: OpSpec[] = [
  {
    name: 'status', title: 'Rhythm status', readonly: true, remote: 'allow',
    description: 'Read whether Rhythm is off or running a focus block or its break (with when the run started and ends), the last run, quiet mode and today\'s scorecard. Read-only.',
    properties: { refresh: { type: 'boolean', description: 'Re-check whether the macOS shortcuts are installed' } },
  },
  {
    name: 'focus_start', title: 'Start a focus block', readonly: false, remote: 'allow',
    description: 'Start a focus block (a pomodoro), optionally for one task. Only when the person asked for one: Rhythm is off until they start it. Walnut goes quiet until it ends, then its break counts down, then Rhythm asks once whether to start the next block and stays off if nobody does. Refused while a block is already running; during a break it starts the next block now (Focus now). mode "rest" starts a rest instead (as focus_rest).',
    properties: {
      mode: { type: 'string', enum: ['focus', 'rest'], description: 'focus (default): a focus block; rest: a rest of `minutes` (default the break length), with no quiet and no Do Not Disturb' },
      taskId: TASK_ID,
      minutes: { ...MINUTES, description: 'Block length in minutes (default from settings, 1 to 180)' },
      breakMinutes: { ...MINUTES, description: 'Length of the break after this block in minutes (default from settings, 1 to 60); the long break keeps its own length' },
      spotify: { type: 'string', description: 'A Spotify playlist link or URI to play in the Spotify app on this Mac while the block runs; it pauses when the block ends. Omit for no Spotify.' },
      remember: { type: 'boolean', description: 'Keep minutes and breakMinutes as the defaults for the next block (the settings). Only when the person picked them.' },
      dnd: { type: 'boolean', description: 'Turn macOS Do Not Disturb on for this block (default: the "Mac Do Not Disturb during focus blocks" setting). Rhythm leaves a Focus the person turned on alone, and macOS turns its own Do Not Disturb off when the block ends.' },
    },
  },
  {
    name: 'focus_dnd', title: 'Do Not Disturb for this block', readonly: false, remote: 'allow',
    description: 'Turn macOS Do Not Disturb on (until the running focus block ends) or off for the block running now. Rhythm never replaces a Focus the person turned on, and turns off only the Do Not Disturb it turned on itself. On is refused when no block runs (it never starts one); off works any time and ends only Rhythm\'s own. Answers where Do Not Disturb stands, including why it could not turn on.',
    properties: { on: { type: 'boolean', description: 'true: on until the block ends; false: off now' } },
  },
  {
    name: 'focus_rest', title: 'Rest now', readonly: false, remote: 'allow',
    description: 'Rest now, only when the person asked: during a focus block, the block ends here (logged for the time it ran, not counted toward the long break) and its break starts at once; while Rhythm is off, a rest of its own. Quiet and Do Not Disturb end with the block. When the rest runs out, Rhythm asks once about the next block. Refused during a break.',
    properties: { minutes: { ...MINUTES, description: 'Rest length in minutes (default the block\'s break, else the setting; 1 to 60)' } },
  },
  {
    name: 'focus_extend', title: 'Extend', readonly: false, remote: 'allow',
    description: 'Add time to the focus block or the break running now (Extend, More break). A longer block keeps Walnut quiet and Do Not Disturb on until its new end. Refused while Rhythm is off; it never starts a run.',
    properties: { minutes: { ...MINUTES, description: 'Minutes to add (default 5, 1 to 60)' } },
  },
  {
    name: 'focus_stop', title: 'Stop the focus block', readonly: false, remote: 'allow',
    description: 'Stop the running focus block or break and end the cycle; Rhythm is off after it. A stopped block is not counted as completed.',
  },
  {
    name: 'dnd_setting', title: 'Mac Do Not Disturb setting', readonly: false, remote: 'allow',
    description: 'Turn the "Mac Do Not Disturb during focus blocks" setting on or off. On: every focus block started without its own pick turns macOS Do Not Disturb on until it ends (needs the two Rhythm shortcuts, added once from the Rhythm App). Changes only this setting.',
    properties: { on: { type: 'boolean', description: 'true: on; false: off' } },
  },
  {
    name: 'break_skip', title: 'End the break', readonly: false, remote: 'allow',
    description: 'End the running break early. Rhythm is off after it until the next Start; the block cycle continues, so the long break still comes.',
  },
  {
    name: 'music_tracks', title: 'List the focus music', readonly: true, remote: 'allow',
    description: 'List the audio files (m4a, mp3, wav) in the focus music folder on this Mac, in play order, with their absolute paths, and the Spotify playlists Rhythm offers (with whether Spotify is installed here). Read-only. The App and the phone play the files; nothing here plays sound.',
  },
  {
    name: 'focus_music', title: 'Switch the block\'s music', readonly: false, remote: 'allow',
    description: 'Switch the music of the focus block running now, without stopping it: a Spotify playlist that plays in the Spotify app on this Mac, or none (spotify empty) to pause the Spotify the block was playing. A folder track plays in the browser that picked it, so the console plays that itself. Refused when no block runs; it never starts one.',
    properties: { spotify: { type: 'string', description: 'A Spotify playlist link or URI; empty for no Spotify' } },
  },
  {
    name: 'spotify_preview', title: 'Preview a Spotify playlist', readonly: false, remote: 'allow',
    description: 'Play 15 seconds of a Spotify playlist in the Spotify app on this Mac, so the person hears it before picking it; then the block\'s own playlist comes back, or Spotify pauses. stop: true ends a preview early.',
    properties: { uri: { type: 'string', description: 'The playlist link or URI' }, stop: { type: 'boolean', description: 'End the preview playing now' } },
  },
  {
    name: 'spotify_playlist_add', title: 'Add a Spotify playlist', readonly: false, remote: 'allow',
    description: 'Keep a Spotify playlist (by its share link) in the list Rhythm offers as focus music. It plays in the Spotify app on this Mac when a block starts with it. Changes only Rhythm\'s own list.',
    properties: { link: { type: 'string', description: 'The playlist link (https://open.spotify.com/playlist/...) or URI' }, name: { type: 'string', description: 'A name to show (default: the playlist\'s own)' } },
  },
  {
    name: 'spotify_playlist_remove', title: 'Remove a Spotify playlist', readonly: false, remote: 'allow',
    description: 'Take a playlist off Rhythm\'s focus music list. It stays in Spotify.',
    properties: { uri: { type: 'string', description: 'The playlist link or URI' } },
  },
  {
    name: 'music_folder_open', title: 'Open the focus music folder', readonly: false, remote: 'deny',
    description: 'Show the focus music folder in Finder, so the person can add or remove tracks. Mac only.',
  },
  {
    name: 'macos_shortcuts_install', title: 'Install the Rhythm shortcuts', readonly: false, remote: 'deny',
    description: 'Prepare the "Walnut Do Not Disturb Until" and "Walnut Focus Off" shortcuts and open each missing one in Shortcuts, which asks the person to add it with one click. Mac only.',
  },
  {
    name: 'macos_privacy_open', title: 'Open Full Disk Access settings', readonly: false, remote: 'deny',
    description: 'Open System Settings at Privacy & Security, Full Disk Access, so the person can let Walnut read the Mac\'s Focus state. Mac only.',
  },
]

function handlers(runtime: RhythmRuntime): Record<string, Handler> {
  return {
    status: (args) => actions.status(runtime, args),
    focus_start: (args) => actions.focusStart(runtime, args),
    focus_stop: () => actions.focusStop(runtime),
    focus_rest: (args) => actions.focusRest(runtime, args),
    focus_extend: (args) => actions.focusExtend(runtime, args),
    focus_dnd: (args) => actions.focusDnd(runtime, args),
    dnd_setting: (args) => actions.dndSetting(runtime, args),
    break_skip: () => actions.breakSkip(runtime),
    music_tracks: () => actions.musicTracks(runtime),
    music_folder_open: () => actions.musicFolderOpen(runtime),
    focus_music: (args) => actions.focusMusic(runtime, args),
    spotify_preview: (args) => actions.spotifyPreview(runtime, args),
    spotify_playlist_add: (args) => actions.spotifyPlaylistAdd(runtime, args),
    spotify_playlist_remove: (args) => actions.spotifyPlaylistRemove(runtime, args),
    macos_shortcuts_install: () => actions.shortcutsInstall(runtime),
    macos_privacy_open: () => actions.privacyOpen(runtime),
  }
}

/** On a cloud replica: Rhythm's timers live on the primary, so nothing here acts. */
function replicaHandlers(): Record<string, Handler> {
  const refuse: Handler = async () => {
    throw new Error('Rhythm runs on your primary Walnut; this is a cloud replica.')
  }
  const out: Record<string, Handler> = {}
  for (const spec of OP_SPECS) out[spec.name] = spec.name === 'status' ? async () => ({ version: 1, replica: true }) : refuse
  return out
}

export function registerOps(walnut: WalnutServerApi, runtime: RhythmRuntime | null): void {
  const table = runtime ? handlers(runtime) : replicaHandlers()
  for (const spec of OP_SPECS) {
    const handler = table[spec.name]!
    const definition: PluginOpDefinition = {
      name: spec.name,
      title: spec.title,
      description: spec.description,
      readonly: spec.readonly,
      remote: spec.remote,
      inputSchema: { type: 'object', properties: spec.properties ?? {} },
      handler: (args) => handler(args ?? {}),
    }
    walnut.registry.op(definition)
  }
  // Routine watchers take a tool list rather than calling ops. Read-only on purpose: a
  // routine fires on a schedule, and a run must never start without the person.
  for (const name of ['status'] as const) {
    const spec = OP_SPECS.find((one) => one.name === name)!
    walnut.registry.tool({
      name,
      description: spec.description,
      inputSchema: { type: 'object', properties: spec.properties ?? {}, additionalProperties: false },
      execute: (input) => table[name]!(input ?? {}),
    })
  }
}
