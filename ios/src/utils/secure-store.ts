/**
 * Secure storage wrapper using expo-secure-store (iOS Keychain).
 */

import * as SecureStore from 'expo-secure-store'

const KEYS = {
  SERVER_URL: 'walnut_server_url',
  API_KEY: 'walnut_api_key',
  PUSH_TOKEN: 'walnut_push_token',
} as const

export async function getServerUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS.SERVER_URL)
}

export async function setServerUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.SERVER_URL, url)
}

export async function getApiKey(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS.API_KEY)
}

export async function setApiKey(key: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.API_KEY, key)
}

export async function getPushToken(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS.PUSH_TOKEN)
}

export async function setPushToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.PUSH_TOKEN, token)
}

export async function clearAll(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS.SERVER_URL)
  await SecureStore.deleteItemAsync(KEYS.API_KEY)
  await SecureStore.deleteItemAsync(KEYS.PUSH_TOKEN)
}

export async function isConfigured(): Promise<boolean> {
  const url = await getServerUrl()
  const key = await getApiKey()
  return !!(url && key)
}
