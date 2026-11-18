/**
 * What `walnut browser status` and the browser_status op say when no browser lets agents in: a
 * browser the person disconnected or turned off a moment ago is named, so nobody waits for it, and
 * one that went quiet with agents still on (quit, or no window open) is named with when it last
 * reached Walnut, so nobody asks the person to turn on a switch that is on (hub.ts lastGone,
 * `gone` in GET /api/v1/browser/status).
 */
export interface GoneBrowser { label: string; at?: string; why: 'off' | 'disconnected' | 'quiet' }

export function noBrowserLine(gone?: GoneBrowser): string {
  if (gone?.why === 'disconnected') return `Not connected: the person disconnected ${gone.label} from Walnut. Ask them to connect it again (the Walnut extension popup, Connect).`
  if (gone?.why === 'off') return `Not connected: the person turned agents off in ${gone.label} (the Walnut extension popup, Settings, "Let Walnut agents use this browser").`
  if (gone?.why === 'quiet') return `Not connected: ${gone.label} last reached Walnut${gone.at ? ` at ${gone.at}` : ''} with agents still on. The browser was quit or has no window open (closing its last window stops the extension); it reconnects by itself once the person opens it.`
  return 'No browser reaches Walnut now: the browser with the Walnut extension is closed or has no window open, or its agents switch is off (the extension popup, Settings).'
}

/** The next step for the agent, by why no browser is there. */
export function noBrowserNext(gone?: GoneBrowser): string {
  if (gone?.why === 'disconnected') return 'Ask the user to connect the Walnut extension again (its popup, Connect).'
  if (gone?.why === 'quiet') return 'Tell the user in one line that their browser is closed (or has no window open) and the step waits until they open it; never open it yourself.'
  return 'Ask the user to open their browser, and turn on "Let Walnut agents use this browser" in the Walnut extension popup, Settings, if it is off.'
}
