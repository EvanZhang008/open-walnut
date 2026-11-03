/**
 * One item, read: every field with Copy (cleared from the clipboard after 30 s), secrets
 * hidden until Show, the live one-time code, sites, history and who may use it.
 */
import { useEffect, useState } from 'react'
import { copySecret, vaultApi, type VaultItem } from '@/api/vault'
import { useConfirm } from '@/hooks/useConfirm'
import { displayHost } from '../../../../src/core/vault/url-match'
import { passwordStrength } from '../../../../src/core/vault/strength'
import { ago, siteTile, typeLabel } from './passwords-model'
import { CopyIcon, EyeIcon, EyeOffIcon, LinkIcon, StarIcon, EditIcon, TrashIcon, RestoreIcon, CheckIcon, RobotIcon } from './pw-icons'

export const AGENT_ACCESS_TEXT = {
  never: 'Never: agents cannot use it',
  ask: 'Ask me each time',
  allow: 'Allow without asking',
} as const

export function SiteTile({ item, size = 34 }: { item: { title: string; urls?: string[] }; size?: number }) {
  const t = siteTile(item)
  return <span className="pw-tile" style={{ background: t.color, width: size, height: size, fontSize: Math.round(size * 0.45), borderRadius: Math.round(size * 0.24) }} aria-hidden="true">{t.letter}</span>
}

function useCopy(): [string | null, (key: string, text: string, itemId?: string) => void] {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (key: string, text: string, itemId?: string) => {
    void copySecret(text).then(() => {
      setCopied(key)
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
      if (itemId) void vaultApi.used(itemId).catch(() => {})
    })
  }
  return [copied, copy]
}

function Field({ label, value, secret, mono, copyKey, copied, onCopy, extra }: {
  label: string; value: string; secret?: boolean; mono?: boolean; copyKey: string; copied: string | null
  onCopy: (key: string, text: string) => void; extra?: React.ReactNode
}) {
  const [shown, setShown] = useState(false)
  return (
    <div className="pw-f">
      <div className="pw-f-label">{label}</div>
      <div className="pw-f-row">
        <span className={`pw-f-value${mono || (secret && shown) ? ' pw-mono' : ''}${secret && !shown ? ' pw-dots' : ''}`} data-testid={`pw-field-${copyKey}`}>
          {secret && !shown ? '••••••••••••' : value}
        </span>
        <span className="pw-f-actions">
          {secret && (
            <button type="button" className="pw-icon-btn" aria-label={shown ? `Hide ${label}` : `Show ${label}`} title={shown ? 'Hide' : 'Show'} onClick={() => setShown((s) => !s)}>
              {shown ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          )}
          <button type="button" className="pw-icon-btn" aria-label={`Copy ${label}`} title="Copy" onClick={() => onCopy(copyKey, value)}>
            {copied === copyKey ? <CheckIcon /> : <CopyIcon />}
          </button>
        </span>
      </div>
      {extra}
    </div>
  )
}

function TotpField({ itemId, copied, onCopy }: { itemId: string; copied: string | null; onCopy: (k: string, t: string) => void }) {
  const [code, setCode] = useState<{ code: string; period: number; remaining: number; at: number } | null>(null)
  const [, tick] = useState(0)
  useEffect(() => {
    let alive = true
    let timer = 0
    const load = async () => {
      try {
        const c = await vaultApi.totp(itemId)
        if (!alive) return
        setCode({ ...c, at: Date.now() })
        timer = window.setTimeout(load, c.remaining * 1000 + 50)
      } catch { if (alive) setCode(null) }
    }
    void load()
    const t = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => { alive = false; window.clearTimeout(timer); window.clearInterval(t) }
  }, [itemId])
  if (!code) return null
  const left = Math.max(0, code.remaining - Math.floor((Date.now() - code.at) / 1000))
  const shown = `${code.code.slice(0, Math.ceil(code.code.length / 2))} ${code.code.slice(Math.ceil(code.code.length / 2))}`
  const frac = left / code.period
  return (
    <div className="pw-f">
      <div className="pw-f-label">Verification code</div>
      <div className="pw-f-row">
        <span className="pw-f-value pw-totp" data-testid="pw-totp">{shown}</span>
        <span className="pw-f-actions">
          <svg className={`pw-ring${left <= 5 ? ' pw-ring-low' : ''}`} width="28" height="28" viewBox="0 0 22 22" aria-label={`${left} seconds left`}>
            <circle cx="11" cy="11" r="9" className="pw-ring-bg" />
            <circle cx="11" cy="11" r="9" className="pw-ring-fg" strokeDasharray={`${(frac * 56.5).toFixed(2)} 56.5`} transform="rotate(-90 11 11)" />
            <text x="11" y="14.5" textAnchor="middle">{left}</text>
          </svg>
          <button type="button" className="pw-icon-btn" aria-label="Copy verification code" title="Copy" onClick={() => onCopy('totp', code.code)}>
            {copied === 'totp' ? <CheckIcon /> : <CopyIcon />}
          </button>
        </span>
      </div>
    </div>
  )
}

export function ItemView({ item, onEdit, onChanged }: { item: VaultItem; onEdit: () => void; onChanged: (item: VaultItem | null) => void }) {
  const [copied, copyRaw] = useCopy()
  const copy = (key: string, text: string) => copyRaw(key, text, item.id)
  const [busy, setBusy] = useState(false)
  const confirm = useConfirm()
  const act = async (fn: () => Promise<VaultItem | null>) => {
    setBusy(true)
    try { onChanged(await fn()) } finally { setBusy(false) }
  }
  const strength = item.password ? passwordStrength(item.password) : null
  const trashed = !!item.trashedAt

  return (
    <div className="pw-detail" data-testid="pw-detail">
      <div className="pw-detail-head">
        <SiteTile item={item} size={52} />
        <div className="pw-detail-title">
          <h2>{item.title}</h2>
          <span className="pw-detail-type">{typeLabel(item.type)}{item.sensitive ? ' · Sensitive' : ''}</span>
        </div>
        <div className="pw-detail-actions">
          {!trashed && (
            <>
              <button type="button" className={`pw-icon-btn${item.favorite ? ' pw-fav-on' : ''}`} aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'} title="Favorite" disabled={busy}
                onClick={() => void act(() => vaultApi.favorite(item.id, !item.favorite))}><StarIcon filled={!!item.favorite} /></button>
              <button type="button" className="pw-btn" onClick={onEdit}><EditIcon /> Edit</button>
            </>
          )}
          {trashed && <button type="button" className="pw-btn" disabled={busy} onClick={() => void act(() => vaultApi.restore(item.id))}><RestoreIcon /> Restore</button>}
        </div>
      </div>

      <div className="pw-card">
        {item.username && <Field label="Username" value={item.username} copyKey="username" copied={copied} onCopy={copy} />}
        {item.password && (
          <Field label="Password" value={item.password} secret copyKey="password" copied={copied} onCopy={copy}
            extra={strength && <div className={`pw-strength-tag pw-strength-${strength.level}`}>{strength.level.replace('_', ' ')}</div>} />
        )}
        {item.totp && <TotpField itemId={item.id} copied={copied} onCopy={copy} />}
        {item.type === 'api_key' && item.envName && <Field label="Environment variable" value={item.envName} mono copyKey="env" copied={copied} onCopy={copy} />}
        {item.card?.number && <Field label="Card number" value={item.card.number} secret mono copyKey="card" copied={copied} onCopy={copy} />}
        {item.card?.holder && <Field label="Cardholder" value={item.card.holder} copyKey="holder" copied={copied} onCopy={copy} />}
        {(item.card?.expMonth || item.card?.expYear) && <Field label="Expires" value={`${item.card?.expMonth ?? ''}/${item.card?.expYear ?? ''}`} copyKey="exp" copied={copied} onCopy={copy} />}
        {item.card?.code && <Field label="Security code" value={item.card.code} secret copyKey="cvv" copied={copied} onCopy={copy} />}
        {item.fields?.map((f, i) => <Field key={i} label={f.name} value={f.value} secret={f.hidden} copyKey={`f${i}`} copied={copied} onCopy={copy} />)}
      </div>

      {!!item.urls?.length && (
        <div className="pw-card">
          <div className="pw-f-label pw-card-label">Websites</div>
          {item.urls.map((u) => (
            <a key={u} className="pw-site" href={u} target="_blank" rel="noopener noreferrer">
              <span>{displayHost(u)}</span><LinkIcon />
            </a>
          ))}
        </div>
      )}

      {item.notes && (
        <div className="pw-card">
          <div className="pw-f-label pw-card-label">Notes</div>
          <div className="pw-notes">{item.notes}</div>
        </div>
      )}

      <div className="pw-card pw-agent-card">
        <span className="pw-agent-icon"><RobotIcon /></span>
        <div>
          <div className="pw-f-label">Agent access</div>
          <div className="pw-f-value">{AGENT_ACCESS_TEXT[item.agentAccess ?? 'ask']}</div>
        </div>
      </div>

      {!!item.passwordHistory?.length && (
        <details className="pw-card pw-history">
          <summary>Password history ({item.passwordHistory.length})</summary>
          {item.passwordHistory.map((h, i) => (
            <Field key={h.replacedAt + i} label={`Until ${new Date(h.replacedAt).toLocaleString()}`} value={h.password} secret copyKey={`h${i}`} copied={copied} onCopy={copy} />
          ))}
        </details>
      )}

      {!!item.passkeys?.length && (
        <div className="pw-card"><div className="pw-f-label">Passkeys</div><div className="pw-f-value">{item.passkeys.length} kept from your import (signing in with them comes in a later version)</div></div>
      )}

      <div className="pw-meta">
        {item.tags?.length ? <div className="pw-tags">{item.tags.map((t) => <span key={t} className="pw-tag">{t}</span>)}</div> : null}
        <div>Changed {ago(item.updatedAt)} · Created {new Date(item.createdAt).toLocaleDateString()}{item.usedAt ? ` · Last used ${ago(item.usedAt)}` : ''}</div>
      </div>

      <div className="pw-detail-foot">
        {!trashed && <button type="button" className="pw-btn pw-btn-danger-text" disabled={busy} onClick={() => void act(() => vaultApi.trash(item.id))}><TrashIcon size={15} /> Delete</button>}
        {trashed && (
          <button type="button" className="pw-btn pw-btn-danger" disabled={busy} onClick={() => void (async () => {
            if (!(await confirm({ title: `Delete "${item.title}" forever?`, message: 'It cannot be restored afterwards.', confirmLabel: 'Delete forever', danger: true }))) return
            await act(async () => { await vaultApi.remove(item.id); return null })
          })()}>
            <TrashIcon size={15} /> Delete forever
          </button>
        )}
        {trashed && <span className="pw-hint">Deleted {ago(item.trashedAt)}. Items here are removed for good after 30 days.</span>}
      </div>
    </div>
  )
}
