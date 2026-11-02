/**
 * `walnut.ui.useDraft`: the words a user is typing in a plugin's box (code, a note, an answer),
 * kept in Walnut's draft store (utils/drafts.ts, hooks/useDraft.ts) like every Walnut input box:
 * written as they are typed, kept across a plugin reload, a page reload, a visit elsewhere and an
 * app restart, in this browser's localStorage and the server's machine-local copy
 * (WALNUT_HOME/local/drafts.json, never git, never ui-prefs), one key per draft, so a hundred
 * problems' drafts never evict or overwrite each other. 2026-11-02, a practice plugin moving onto
 * walnut.ui.useView: a draft there rode ui-prefs (a PUT every 800 ms into the synced config) and
 * shared one key per name, last writer wins across devices.
 *
 * Kept under `draft:plugin:<plugin id>:<name>[:<id>]`. Another window's change to the same draft
 * shows when the box mounts again, never while it is on screen (`followElsewhere: false`), since
 * Walnut cannot see whether a plugin's editor has the focus. `clear()` after a send or a save:
 * the draft goes, everywhere.
 */
import { useDraft } from '@/hooks/useDraft'
import { draftKey } from '@/utils/drafts'
import type { PluginUseDraft } from './types'

const NAME = /^[A-Za-z0-9][\w-]{0,63}$/

export function createPluginUseDraft(pluginId: string): PluginUseDraft {
  return function useDraftOfPlugin(name: string, options?: { id?: string }) {
    if (!NAME.test(name)) throw new Error('walnut.ui.useDraft name must be 1-64 letters, digits, "_" or "-"')
    const id = options?.id
    const key = id === undefined ? draftKey('plugin', pluginId, name) : draftKey('plugin', pluginId, name, id)
    const draft = useDraft(key, { followElsewhere: false })
    return [draft.text, draft.setText, () => draft.clear()]
  }
}
