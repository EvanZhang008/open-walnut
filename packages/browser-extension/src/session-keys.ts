/**
 * Every key this extension keeps in storage.session, and what an extension reload does to it.
 * Chrome clears storage.session when the extension reloads (self-update.ts reloads for every new
 * build Walnut deploys) and when the browser quits, while a reload keeps every window, tab and
 * tab group with the same ids (2026-11-10: after a self-update the agent window was no longer
 * known, the next open made a second one, and a task's own tab read as the person's).
 *
 *   - `kept`: names a live window, tab or group, or what an agent holds, so it must outlive a
 *     reload: agent-keep.ts mirrors it into storage.local and puts it back after a reload, each id
 *     only while it still names the same thing. Never after a browser start, which gives new ids.
 *   - `lost`: fine to lose with the reload, and why.
 *
 * tests/core/browser-control/extension-session-keys-guard.test.ts reads every storage.session key
 * from the source and fails on one that is not listed here.
 */
export const SESSION_KEYS = {
  agentWindow: { kept: 'the agent window, while that window still exists' },
  agentPage: { kept: 'the agent window\'s own page, while that tab is still in it showing that page' },
  agentTabs: { kept: 'what each task holds, while its tab is in the same window on the same site' },
  agentMade: { kept: 'tabs made for agents, so a leftover is still tidied once no agent holds it' },
  agentGroups: { kept: 'each task\'s group in the agent window, while that group is still there' },
  agentPersonGroups: { kept: 'each task\'s group in a window of the person\'s, while that group is still there' },
  agentFilled: { kept: 'sites an owner signed in on: no page script runs there for it (no ids, only sites)' },
  agentTampered: { kept: 'pages an agent\'s script touched: no sign in there until the page loads again' },
  agentDownloads: { kept: 'whose downloads are whose (download ids, which a reload keeps)' },
  debuggerCancelledAt: { kept: 'the person\'s Cancel on the debugging bar: nothing attaches by itself for a while' },
  agentAlive: { lost: 'the mark that storage.session was not cleared: a reload clearing it is what it tells' },
  vaultSession: { lost: 'the unlock mark: a token an earlier run left counts only under Walnut\'s own setting (walnut-api.ts)' },
  lastActive: { lost: 'the auto-lock clock, which starts again with the next use' },
  clipboardCopied: { lost: 'a hash of a copied secret never goes to disk; self-update.ts waits for its clear instead' },
  panelAsk: { lost: 'a question left for a side panel, taken within a minute' },
  panelHand: { lost: 'the popup\'s question left for a side panel, taken within a minute' },
  panelVault: { lost: 'the vault state a panel last showed, asked again when it opens' },
  pendingSave: { lost: 'a login offered for save: holds a password, never on disk' },
  pendingPrev: { lost: 'a login a newer one replaced: holds a password, never on disk' },
  seenUsername: { lost: 'a username seen on a sign-in page, seen again on the next one' },
  connecting: { lost: 'a connect page in progress, opened again from the popup' },
  menus: { lost: 'the in-page menu open now: its page\'s script went with the reload' },
  frames: { lost: 'frames that may be filled, told again by each page' },
  generated: { lost: 'a password the menu made: never on disk' },
  lastLogin: { lost: 'the login last filled on a tab, for its code page' },
} as const satisfies Record<string, { kept: string } | { lost: string }>

export type SessionKey = keyof typeof SESSION_KEYS
/** The keys that outlive a reload (agent-keep.ts). */
export type KeptKey = { [K in SessionKey]: typeof SESSION_KEYS[K] extends { kept: string } ? K : never }[SessionKey]
export const KEPT_KEYS = (Object.keys(SESSION_KEYS) as SessionKey[]).filter((k): k is KeptKey => 'kept' in SESSION_KEYS[k])
