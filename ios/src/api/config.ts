/**
 * Connection config — server URL (AsyncStorage) + device token (Keychain).
 *
 * Values are hydrated once at app start into a module-level cache so the REST
 * client can read them synchronously on every request.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'

const URL_KEY = 'walnut.serverUrl'
const NAME_KEY = 'walnut.deviceName'
const TOKEN_KEY = 'walnut_device_token'

let cachedUrl: string | null = null
let cachedToken: string | null = null

export async function hydrateConfig(): Promise<{ serverUrl: string | null; token: string | null; deviceName: string | null }> {
  const [serverUrl, deviceName] = await Promise.all([
    AsyncStorage.getItem(URL_KEY),
    AsyncStorage.getItem(NAME_KEY),
  ])
  let token: string | null = null
  try {
    token = await SecureStore.getItemAsync(TOKEN_KEY)
  } catch {
    // Keychain unavailable (fresh simulator edge cases) — treat as unset.
  }
  cachedUrl = serverUrl
  cachedToken = token
  return { serverUrl, token, deviceName }
}

export function getBaseUrl(): string | null {
  return cachedUrl
}

export function getToken(): string | null {
  return cachedToken
}

/** Normalize a user-entered server URL: add scheme, strip trailing slash. */
export function normalizeServerUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '')
  if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`
  return url
}

export async function saveConfig(serverUrl: string, token: string, deviceName?: string): Promise<void> {
  const url = normalizeServerUrl(serverUrl)
  cachedUrl = url
  cachedToken = token || null
  await AsyncStorage.setItem(URL_KEY, url)
  if (deviceName) await AsyncStorage.setItem(NAME_KEY, deviceName)
  if (token) {
    await SecureStore.setItemAsync(TOKEN_KEY, token)
  } else {
    await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {})
  }
}

export async function clearConfig(): Promise<void> {
  cachedUrl = null
  cachedToken = null
  await AsyncStorage.multiRemove([URL_KEY, NAME_KEY])
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {})
}

/**
 * Parse a `wn://pair?name=<device>&token=<token>` pairing URI.
 * Manual query parsing — React Native's URL lacks searchParams support.
 */
export function parsePairingUri(text: string): { name?: string; token: string } | null {
  const match = text.trim().match(/^wn:\/\/pair\?(.+)$/i)
  if (!match) return null
  const params: Record<string, string> = {}
  for (const pair of match[1].split('&')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    try {
      params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1))
    } catch {
      // Malformed percent-encoding — skip this param.
    }
  }
  if (!params.token) return null
  return { name: params.name, token: params.token }
}
