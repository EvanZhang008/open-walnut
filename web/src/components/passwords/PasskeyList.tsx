/**
 * The passkeys on one login (ItemView): each with its site, its account and when it was saved,
 * where it came from (made in Walnut, or brought by an import or Bitwarden), and Delete. The private
 * key is never in what a client reads (src/core/vault/passkey.ts publicPasskey), so nothing here can
 * show or copy one. Deleting removes it from Walnut only: the site keeps its record of it.
 */
import { useState } from 'react'
import { vaultApi, type VaultItem } from '@/api/vault'
import { useConfirm } from '@/hooks/useConfirm'
import { TrashIcon } from './pw-icons'

type Passkey = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' && v ? v : '')

function saved(pk: Passkey): string {
  const at = str(pk.creationDate)
  const when = at ? new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
  const from = pk.madeBy === 'walnut' ? 'Saved by Walnut' : 'Imported'
  return when ? `${from} ${when}` : from
}

export function PasskeyList({ item, onChanged }: { item: VaultItem; onChanged: (item: VaultItem) => void }) {
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const list = (item.passkeys ?? []) as Passkey[]
  if (!list.length) return null

  const remove = async (pk: Passkey) => {
    const site = str(pk.rpId) || 'this site'
    const ok = await confirm({
      title: `Delete this passkey for ${site}?`,
      message: `Walnut stops signing in to ${site} with it. The site still lists it: remove it there too, in its security settings.`,
      confirmLabel: 'Delete passkey', danger: true,
    })
    if (!ok) return
    setBusy(true); setError('')
    try {
      const { id: _i, createdAt: _c, updatedAt: _u, passwordHistory: _h, trashedAt: _t, usedAt: _x, ...input } = item
      const passkeys = list.filter((p) => p !== pk)
      onChanged(await vaultApi.update(item.id, { ...input, passkeys }, item.updatedAt))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <div className="pw-card" data-testid="pw-passkeys">
      <div className="pw-f-label pw-card-label">Passkeys</div>
      {list.map((pk, i) => (
        <div key={str(pk.credentialId) || i} className="pw-passkey" data-testid="pw-passkey">
          <div className="pw-passkey-text">
            <div className="pw-f-value">{str(pk.userName) || str(pk.userDisplayName) || 'Account'} <span className="pw-passkey-site">· {str(pk.rpId)}</span></div>
            <div className="pw-hint">{saved(pk)}</div>
          </div>
          {!item.trashedAt && (
            <button type="button" className="pw-btn pw-btn-danger-text" disabled={busy} data-testid="pw-passkey-delete"
              aria-label={`Delete the passkey for ${str(pk.rpId)}`} onClick={() => void remove(pk)}><TrashIcon size={14} /> Remove passkey</button>
          )}
        </div>
      ))}
      {error && <div className="pw-hint pw-hint-bad" role="alert">{error}</div>}
    </div>
  )
}
