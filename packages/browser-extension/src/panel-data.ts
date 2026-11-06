/**
 * What the side panel keeps of the connected Walnut between opens (sidepanel.ts, panel-snap.ts):
 * the Walnut it framed last time and the words its Ask and Tasks views showed. Both belong to that
 * connection only, so a disconnect (the person's, or Walnut refusing this browser) removes them,
 * and an open panel sees `panelServer` go and closes its Walnut frames (sidepanel.ts).
 */
import { ext } from './ext'

export const PANEL_SERVER_KEY = 'panelServer'
export const PANEL_SNAPS_KEY = 'panelSnaps'
/** That Walnut opens the panel as its own Ask (its panel answer's `askPanel`): the frame starts in that shape. */
export const PANEL_ASK_KEY = 'panelAskUi'

export async function clearPanelData(): Promise<void> {
  await ext.storage.local.remove([PANEL_SERVER_KEY, PANEL_SNAPS_KEY, PANEL_ASK_KEY])
}
