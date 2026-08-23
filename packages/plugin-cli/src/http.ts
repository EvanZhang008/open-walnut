const DEFAULT_API_URL = 'http://127.0.0.1:3456'

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const base = process.env.OPEN_WALNUT_API_URL ?? DEFAULT_API_URL
  const response = await fetch(new URL(path, base), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Walnut API returned ${response.status}`)
  return body as T
}
