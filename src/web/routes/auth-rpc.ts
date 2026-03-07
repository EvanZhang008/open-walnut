/**
 * WebSocket auth RPC method.
 *
 * After connecting to /ws, remote clients send:
 *   { type: "req", id: "...", method: "auth", payload: { key: "wlnt_sk_..." } }
 *
 * This validates the key and marks the WS client as authenticated.
 * Localhost clients are auto-authenticated (no auth RPC needed).
 */

import { registerMethod } from '../ws/handler.js'
import { validateApiKey } from '../middleware/auth.js'
import { log } from '../../logging/index.js'

/**
 * Register the 'auth' RPC method on the WebSocket handler.
 */
export function registerAuthRpc(): void {
  registerMethod('auth', async (payload) => {
    const { key } = (payload ?? {}) as { key?: string }

    if (!key || typeof key !== 'string') {
      throw new Error('Missing or invalid key')
    }

    const name = await validateApiKey(key)
    if (!name) {
      throw new Error('Invalid API key')
    }

    log.ws.info('WS client authenticated', { keyName: name })
    return { authenticated: true, keyName: name }
  })
}
