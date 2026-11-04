/**
 * What a tab an agent's tab opened inherits from it (agent-page.ts adoptOpened), and which tabs
 * count as handed over (agent.ts: agents act there with the browser-wide switch off). Pure, so a
 * test reads the rules (tests/core/browser-control/extension-tab-kind.test.ts).
 */
import type { AgentTab } from './agent-shared'

/**
 * A popup's record: the opener's owner; `fromPerson` when the opener is the person's tab (handed or
 * taken) or one opened from it (its page reaches theirs through `opener`); `viaHanded` only when the
 * chain starts at a tab the person handed over in the side panel, never at one an agent took.
 */
export function popupRecord(opener: AgentTab, url?: string): AgentTab {
  const fromPerson = !!(opener.handed || opener.taken || opener.fromPerson)
  const viaHanded = !!(opener.handed || opener.viaHanded)
  return {
    owner: opener.owner, ...(opener.who ? { who: opener.who } : {}), history: url ? [url] : [], popup: true,
    ...(fromPerson ? { fromPerson } : {}), ...(viaHanded ? { viaHanded } : {}),
  }
}

/** A tab the person handed over from the side panel, or one such a tab opened (directly or through another popup). */
export const inHandedReach = (rec: AgentTab | undefined): boolean => !!(rec?.handed || rec?.viaHanded)
