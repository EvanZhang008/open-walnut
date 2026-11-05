/**
 * What `walnut browser status` and the browser_status op say when no browser lets agents in: a
 * browser the person disconnected or turned off a moment ago is named, so nobody waits for it
 * (hub.ts lastGone, `gone` in GET /api/v1/browser/status).
 */
export interface GoneBrowser { label: string; at?: string; why: 'off' | 'disconnected' }

export function noBrowserLine(gone?: GoneBrowser): string {
  if (gone?.why === 'disconnected') return `Not connected: the person disconnected ${gone.label} from Walnut. Ask them to connect it again (the Walnut extension popup, Connect).`
  if (gone?.why === 'off') return `Not connected: the person turned agents off in ${gone.label} (the Walnut extension popup, Settings, "Let Walnut agents use this browser").`
  return 'No browser lets agents in now (the Walnut extension popup, Settings, turns it on).'
}
