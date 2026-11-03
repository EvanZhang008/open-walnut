/**
 * Plain export: every item in one file, for a move to another manager or a paper
 * copy. The route asks for the master password again before it makes one.
 * CSV uses Bitwarden's columns (most managers read them); JSON keeps everything.
 */
import type { VaultItem } from './types.js'

function csvCell(v: string | undefined): string {
  const s = v ?? ''
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function exportItems(items: VaultItem[], format: 'csv' | 'json'): string {
  const live = items.filter((i) => !i.trashedAt)
  if (format === 'json') {
    return JSON.stringify({ format: 'walnut-passwords-export', version: 1, exportedAt: new Date().toISOString(), items: live }, null, 2)
  }
  const head = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp'
  const rows = live.filter((i) => i.type === 'login' || i.type === 'note').map((i) => [
    i.tags?.[0], i.favorite ? '1' : '', i.type === 'note' ? 'note' : 'login', i.title, i.notes,
    (i.fields ?? []).map((f) => `${f.name}: ${f.value}`).join('\n'), i.sensitive ? '1' : '0',
    (i.urls ?? []).join(','), i.username, i.password, i.totp,
  ].map(csvCell).join(','))
  return [head, ...rows].join('\n') + '\n'
}
