/**
 * The person's switch for real input (agent-trusted.ts): the browser's optional `debugger`
 * permission, off until they turn it on. Chrome only; Firefox has no such permission for
 * extensions. Kept apart from agent.ts so the popup can use it with nothing else.
 */
import { more } from './agent-api'
import { isFirefox } from './ext'

export async function trustedInputState(): Promise<{ available: boolean; on: boolean }> {
  if (isFirefox) return { available: false, on: false }
  return { available: true, on: await more.permissions.contains({ permissions: ['debugger'] }).catch(() => false) }
}

/**
 * Call straight from the person's click: the browser asks them only inside that click, so
 * nothing may be awaited before the request.
 */
export function setTrustedInput(on: boolean): Promise<boolean> {
  if (isFirefox) return Promise.resolve(false)
  return on
    ? more.permissions.request({ permissions: ['debugger'] }).catch(() => false)
    : more.permissions.remove({ permissions: ['debugger'] }).then(() => false, () => true)
}
