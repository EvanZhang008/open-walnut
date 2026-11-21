/**
 * The server's side of the focus_workspace switch, on the box that holds the focus (the leader):
 * at start the focus file and its quiet hold agree again, and the switch turned off ends a focus
 * left on and the scopes plugins' holds carried, whether or not any window is open to ask.
 */
import { bus, EventNames } from '../event-bus.js'
import { log } from '../../logging/index.js'
import { focusSpacesFlag } from './flag.js'

/** server.ts unsubscribes it by this name when it stops. */
const SUBSCRIBER = 'focus-spaces-switch'

async function endFocusSpaces(): Promise<void> {
  const [{ leaveFocus }, { dropQuietScopes }] = await Promise.all([
    import('./active.js'),
    import('../quiet/quiet-state.js'),
  ])
  await leaveFocus()
  await dropQuietScopes()
}

async function follow(): Promise<void> {
  try {
    if (await focusSpacesFlag.on()) {
      const { reconcileFocusQuiet } = await import('./active.js')
      await reconcileFocusQuiet()
    } else {
      await endFocusSpaces()
    }
  } catch (err) {
    log.notif.warn('focus spaces could not follow the experiment switch', { error: String(err) })
  }
}

export async function startFocusSpaces(): Promise<void> {
  bus.subscribe(SUBSCRIBER, async (event) => {
    if (event.name !== EventNames.CONFIG_CHANGED) return
    if (!(await focusSpacesFlag.on())) await endFocusSpaces().catch((err) => {
      log.notif.warn('focus spaces could not end with the experiment', { error: String(err) })
    })
  }, { global: true, interest: [EventNames.CONFIG_CHANGED] })
  await follow()
}
