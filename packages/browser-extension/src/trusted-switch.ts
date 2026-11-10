/**
 * The person's two uses of the browser's optional `debugger` permission (Chrome only; Firefox has
 * no such permission for extensions), each with its own switch in the popup's Settings:
 *
 *   - real input for agents (agent-trusted.ts): the permission AND `realInput` in storage.local;
 *   - live pictures while Walnut's agent window is covered (agent-live.ts): the permission AND
 *     `livePictures` not turned off (on by default once the permission is held: 2026-11-09, the
 *     user wants the Browser view live with no friction).
 *
 * Before this build, holding the permission WAS real input. So the first time this build reads
 * `realInput` and finds none stored, it stores whether the permission is held now
 * (migrateRealInput): a person who had real input on keeps it, and a grant made later for live
 * pictures alone never turns real input on. The permission is removed only when neither use wants
 * it. Kept apart from agent.ts so the popup and the grant page can use it with nothing else.
 */
import { more } from './agent-api'
import { ext, isFirefox } from './ext'

export const REAL_INPUT_KEY = 'realInput'
export const LIVE_PICTURES_KEY = 'livePictures'

const DEBUGGER = { permissions: ['debugger'] }

export const debuggerGranted = (): Promise<boolean> => (isFirefox ? Promise.resolve(false) : more.permissions.contains(DEBUGGER).catch(() => false))

/** Once: a `realInput` never stored becomes whether the permission is held now. The flag after. */
export async function migrateRealInput(): Promise<boolean> {
  const got = await ext.storage.local.get(REAL_INPUT_KEY).catch(() => ({} as Record<string, unknown>))
  const v = got[REAL_INPUT_KEY]
  if (typeof v === 'boolean') return v
  const held = await debuggerGranted()
  await ext.storage.local.set({ [REAL_INPUT_KEY]: held }).catch(() => undefined)
  return held
}

/** Whether the person turned live pictures off (they are on by default). */
async function livePicturesWanted(): Promise<boolean> {
  const got = await ext.storage.local.get(LIVE_PICTURES_KEY).catch(() => ({} as Record<string, unknown>))
  return got[LIVE_PICTURES_KEY] !== false
}

/** Real input: the permission and the person's switch. */
export async function realInputOn(): Promise<boolean> {
  if (isFirefox) return false
  const flag = await migrateRealInput()
  return flag && await debuggerGranted()
}

/** Live pictures while the agent window is covered: the permission, and not turned off. */
export async function livePicturesOn(): Promise<boolean> {
  if (isFirefox) return false
  return await debuggerGranted() && await livePicturesWanted()
}

/** What the popup's two switches show: real input, live pictures, and whether the permission is held. */
export async function trustedInputState(): Promise<{ available: boolean; on: boolean; livePictures: boolean; permission: boolean }> {
  if (isFirefox) return { available: false, on: false, livePictures: false, permission: false }
  return { available: true, on: await realInputOn(), livePictures: await livePicturesOn(), permission: await debuggerGranted() }
}

/** Neither use wants the permission any more: it goes. */
async function dropIfUnused(): Promise<void> {
  const got = await ext.storage.local.get([REAL_INPUT_KEY, LIVE_PICTURES_KEY]).catch(() => ({} as Record<string, unknown>))
  if (got[REAL_INPUT_KEY] === true || got[LIVE_PICTURES_KEY] !== false) return
  await more.permissions.remove(DEBUGGER).catch(() => undefined)
}

/**
 * Call straight from the person's click: the browser asks them only inside that click, so
 * nothing may be awaited before the request. The switch is stored before the request (a popup
 * closed meanwhile never runs what comes after it) and put back if Chrome's answer is no; without
 * the permission it means nothing anyway. Answers whether real input is on now.
 */
export function setTrustedInput(on: boolean): Promise<boolean> {
  if (isFirefox) return Promise.resolve(false)
  if (on) {
    const stored = ext.storage.local.set({ [REAL_INPUT_KEY]: true }).catch(() => undefined)
    return more.permissions.request(DEBUGGER).catch(() => false).then(async (granted) => {
      await stored
      if (!granted) await ext.storage.local.set({ [REAL_INPUT_KEY]: false }).catch(() => undefined)
      return granted
    })
  }
  // Off: the switch alone; the permission stays while live pictures use it.
  return ext.storage.local.set({ [REAL_INPUT_KEY]: false }).then(dropIfUnused).then(() => false, () => false)
}

/**
 * The live pictures switch, from the person's click (same rule as setTrustedInput).
 * `heldBefore`: whether the permission was held before this click. A grant made for live pictures
 * alone never turns real input on, so real input is stored off then (it meant nothing without the
 * permission). Answers whether live pictures are on now.
 */
export function setLivePictures(on: boolean, heldBefore: boolean): Promise<boolean> {
  if (isFirefox) return Promise.resolve(false)
  if (on) {
    const stored = ext.storage.local.set({ [LIVE_PICTURES_KEY]: true, ...(heldBefore ? {} : { [REAL_INPUT_KEY]: false }) }).catch(() => undefined)
    return more.permissions.request(DEBUGGER).catch(() => false).then(async (granted) => { await stored; return granted })
  }
  return ext.storage.local.set({ [LIVE_PICTURES_KEY]: false }).then(dropIfUnused).then(() => false, () => false)
}

/**
 * The grant page's Allow (grant.ts), straight from the person's click: live pictures on and
 * Chrome's permission asked, nothing awaited before the request. What real input should be is read
 * in the same click, not when the page opened (review 2026-11-09: a page left open for hours held a
 * stale "no permission" and wrote real input off over the person's fresh choice). Real input is
 * written only when it means nothing yet: never stored (the background's migration stores one, so
 * this is rare), or stored on while the permission was not held at the click (a grant for live
 * pictures alone must not bring that old switch back to life). Answers whether live pictures are on now.
 */
export function grantLivePictures(): Promise<boolean> {
  if (isFirefox) return Promise.resolve(false)
  // Started before the request and not awaited: reading them takes nothing from the click.
  const before = Promise.all([
    ext.storage.local.get(REAL_INPUT_KEY).catch(() => ({} as Record<string, unknown>)),
    debuggerGranted(),
  ])
  const stored = ext.storage.local.set({ [LIVE_PICTURES_KEY]: true }).catch(() => undefined)
  return more.permissions.request(DEBUGGER).catch(() => false).then(async (granted) => {
    await stored
    const [got, held] = await before
    const v = got[REAL_INPUT_KEY]
    if (typeof v !== 'boolean' || (v && !held)) await ext.storage.local.set({ [REAL_INPUT_KEY]: false }).catch(() => undefined)
    return granted
  })
}
