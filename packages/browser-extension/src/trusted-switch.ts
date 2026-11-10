/**
 * The browser's `debugger` permission (Chrome only; Firefox has no such permission for extensions)
 * and the person's two switches over its uses, in the popup's Settings:
 *
 *   - real input for agents (agent-trusted.ts): the permission AND `realInput`;
 *   - live pictures (agent-live.ts): the permission AND `livePictures` not turned off.
 *
 * Since 2026-11-09 the Chrome manifest lists `debugger` as a REQUIRED permission (the user: "we
 * need make it fully capable using debug"). Walnut's extension is always loaded unpacked from the
 * folder Walnut sets up (extension-install.ts), and Chrome grants an unpacked extension's new
 * permissions on reload with no prompt (chrome_extension_registrar_delegate.cc
 * CheckPermissionsIncrease: an unpacked location is trusted), so every copy holds it after its next
 * self-update. A copy that somehow lacks it (permissions.contains false) still asks for it in the
 * person's click: the Settings switches, or the grant page (grant.ts).
 *
 * Both uses are on by default while the permission is held. `realInput` follows the permission
 * until the person sets the switch themselves (`realInputBy: 'person'`): a value an older build
 * stored by itself (its migration, a grant for live pictures) is not their choice and gives way;
 * a choice of theirs, on or off, is kept. Why an unmarked `false` gives way (review 2026-11-09):
 * the key came only in a build of the same day that no release carried, whose migration stored
 * `false` whenever the then optional permission was not held, the usual state; a false the person
 * set there cannot be told from those, and the switch is one click to turn off again. A required
 * permission cannot be removed, so turning both
 * switches off leaves it held and unused.
 */
import { more } from './agent-api'
import { ext, isFirefox } from './ext'

export const REAL_INPUT_KEY = 'realInput'
/** Set to 'person' when the person themselves set `realInput` (the Settings switch). */
export const REAL_INPUT_BY_KEY = 'realInputBy'
export const LIVE_PICTURES_KEY = 'livePictures'

const DEBUGGER = { permissions: ['debugger'] }

export const debuggerGranted = (): Promise<boolean> => (isFirefox ? Promise.resolve(false) : more.permissions.contains(DEBUGGER).catch(() => false))

/**
 * Real input as stored now: the person's own choice when they made one, else whether the permission
 * is held (stored so, for a reader of storage alone). The background runs it at start.
 */
export async function migrateRealInput(): Promise<boolean> {
  const got = await ext.storage.local.get([REAL_INPUT_KEY, REAL_INPUT_BY_KEY]).catch(() => ({} as Record<string, unknown>))
  const v = got[REAL_INPUT_KEY]
  if (got[REAL_INPUT_BY_KEY] === 'person' && typeof v === 'boolean') return v
  const held = await debuggerGranted()
  if (v !== held) await ext.storage.local.set({ [REAL_INPUT_KEY]: held }).catch(() => undefined)
  return held
}

/** Whether the person turned live pictures off (they are on by default). */
async function livePicturesWanted(): Promise<boolean> {
  const got = await ext.storage.local.get(LIVE_PICTURES_KEY).catch(() => ({} as Record<string, unknown>))
  return got[LIVE_PICTURES_KEY] !== false
}

/** Real input: the permission and the switch (on unless the person turned it off). */
export async function realInputOn(): Promise<boolean> {
  if (isFirefox) return false
  const flag = await migrateRealInput()
  return flag && await debuggerGranted()
}

/** Live pictures: the permission, and not turned off. */
export async function livePicturesOn(): Promise<boolean> {
  if (isFirefox) return false
  return await debuggerGranted() && await livePicturesWanted()
}

/** What the popup's two switches show: real input, live pictures, and whether the permission is held. */
export async function trustedInputState(): Promise<{ available: boolean; on: boolean; livePictures: boolean; permission: boolean }> {
  if (isFirefox) return { available: false, on: false, livePictures: false, permission: false }
  return { available: true, on: await realInputOn(), livePictures: await livePicturesOn(), permission: await debuggerGranted() }
}

/**
 * The real-input switch, straight from the person's click: stored as their choice before anything
 * is awaited (a popup closed meanwhile never runs what comes after). On asks Chrome for the
 * permission in the same click (held already: Chrome answers yes at once, no box); a no puts the
 * switch back. Answers whether real input is on now.
 */
export function setTrustedInput(on: boolean): Promise<boolean> {
  if (isFirefox) return Promise.resolve(false)
  const stored = ext.storage.local.set({ [REAL_INPUT_KEY]: on, [REAL_INPUT_BY_KEY]: 'person' }).catch(() => undefined)
  if (!on) return stored.then(() => false, () => false)
  return more.permissions.request(DEBUGGER).catch(() => false).then(async (granted) => {
    await stored
    if (!granted) await ext.storage.local.set({ [REAL_INPUT_KEY]: false }).catch(() => undefined)
    return granted
  })
}

/** The live pictures switch, from the person's click (same rule as setTrustedInput). Answers whether live pictures are on now. */
export function setLivePictures(on: boolean): Promise<boolean> {
  if (isFirefox) return Promise.resolve(false)
  const stored = ext.storage.local.set({ [LIVE_PICTURES_KEY]: on }).catch(() => undefined)
  if (!on) return stored.then(() => false, () => false)
  return more.permissions.request(DEBUGGER).catch(() => false).then(async (granted) => { await stored; return granted })
}

/**
 * The grant page's Allow (grant.ts), straight from the person's click, for a copy that lacks the
 * permission: live pictures on and Chrome's permission asked, nothing awaited before the request.
 * Real input is left as it is (it follows the permission unless the person chose). Answers whether
 * live pictures are on now.
 */
export function grantLivePictures(): Promise<boolean> {
  return setLivePictures(true)
}
