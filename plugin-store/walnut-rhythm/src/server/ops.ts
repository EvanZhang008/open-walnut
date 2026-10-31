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
    description: 'Start a focus block (a pomodoro), optionally for one task. Only when the person asked for one: Rhythm is off until they start it. Walnut goes quiet until it ends, then its break counts down, then Rhythm asks once whether to start the next block and stays off if nobody does. Refused while a block is already running.',
    properties: { taskId: TASK_ID, minutes: { ...MINUTES, description: 'Block length in minutes (default from settings, 1 to 180)' } },
  },
  {
    name: 'focus_stop', title: 'Stop the focus block', readonly: false, remote: 'allow',
    description: 'Stop the running focus block or break and end the cycle; Rhythm is off after it. A stopped block is not counted as completed.',
  },
  {
    name: 'break_skip', title: 'End the break', readonly: false, remote: 'allow',
    description: 'End the running break early. Rhythm is off after it until the next Start; the block cycle continues, so the long break still comes.',
  },
  {
    name: 'music_tracks', title: 'List the focus music', readonly: true, remote: 'allow',
    description: 'List the audio files (m4a, mp3, wav) in the focus music folder on this Mac, in play order, with their absolute paths. Read-only. The App and the phone play them; nothing here plays sound.',
  },
  {
    name: 'music_folder_open', title: 'Open the focus music folder', readonly: false, remote: 'deny',
    description: 'Show the focus music folder in Finder, so the person can add or remove tracks. Mac only.',
  },
  {
    name: 'macos_shortcuts_install', title: 'Install the Rhythm shortcuts', readonly: false, remote: 'deny',
    description: 'Prepare the "Walnut Focus On" and "Walnut Focus Off" shortcuts and open each in Shortcuts, which asks the person to add it with one click. Mac only.',
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
    break_skip: () => actions.breakSkip(runtime),
    music_tracks: () => actions.musicTracks(runtime),
    music_folder_open: () => actions.musicFolderOpen(runtime),
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
