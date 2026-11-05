/**
 * The screens before the vault: first-time setup (master password, then the recovery kit:
 * the Secret Key and the recovery code), unlock, and a forgotten master password (the
 * recovery code sets a new one, then a new kit). Nothing typed here is kept anywhere: no draft,
 * no storage, cleared from state as soon as it was used.
 */
import { useEffect, useRef, useState } from 'react'
import { copySecret, vaultApi, VaultApiError, type RecoveryKit, type VaultStatus } from '@/api/vault'
import { passwordStrength, type StrengthLevel } from '../../../../src/core/vault/strength'
import { KeyIcon, LockIcon, CopyIcon, CheckIcon } from './pw-icons'
import { log } from '@/utils/log'
import { unlockFootText } from './unlock-words'
import { HintInput, ShowHint, hintError } from './HintField'

const LEVEL_TEXT: Record<StrengthLevel, string> = {
  very_weak: 'Very weak', weak: 'Weak', fair: 'Fair', strong: 'Strong', very_strong: 'Very strong',
}
const LEVEL_STEP: Record<StrengthLevel, number> = { very_weak: 1, weak: 2, fair: 3, strong: 4, very_strong: 5 }

export function StrengthMeter({ password }: { password: string }) {
  const s = passwordStrength(password)
  const step = password ? LEVEL_STEP[s.level] : 0
  return (
    <div className={`pw-meter pw-meter-${password ? s.level : 'empty'}`} aria-label={password ? `Strength: ${LEVEL_TEXT[s.level]}` : undefined}>
      <div className="pw-meter-bars">{[1, 2, 3, 4, 5].map((i) => <span key={i} className={i <= step ? 'on' : ''} />)}</div>
      <span className="pw-meter-text">{password ? LEVEL_TEXT[s.level] : ''}</span>
    </div>
  )
}

function errorText(err: unknown): string {
  if (err instanceof VaultApiError) return err.message
  return err instanceof Error ? err.message : String(err)
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button type="button" className="pw-btn pw-btn-small" onClick={() => { void copySecret(text).then(() => setCopied(true)) }}>
      {copied ? <CheckIcon /> : <CopyIcon />} {copied ? 'Copied' : label}
    </button>
  )
}

/**
 * The recovery kit's two codes, its download, and the person's confirmation that it is saved.
 * The new code lives only here (Walnut keeps none), so the server marks the kit unsaved until
 * `confirm` reaches it, and the page asks before a reload would lose it.
 */
export function RecoveryKitCard({ kit, confirmLabel, onConfirmed }: { kit: RecoveryKit; confirmLabel: string; onConfirmed: () => void }) {
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  const confirm = async () => {
    setBusy(true); setError('')
    try {
      await vaultApi.confirmRecoveryKit()
      onConfirmed()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pw-kit" data-testid="pw-kit-card">
      <div className="pw-kit-part">
        <div className="pw-kit-head"><b>Secret Key</b><CopyButton text={kit.secretKey} label="Copy" /></div>
        <div className="pw-secret-key" data-testid="pw-secret-key">{kit.secretKey}</div>
        <p className="pw-kit-note">With your master password, it opens your vault on a new machine or from a backup.</p>
      </div>
      <div className="pw-kit-part">
        <div className="pw-kit-head"><b>Recovery code</b><CopyButton text={kit.recoveryCode} label="Copy" /></div>
        <div className="pw-secret-key" data-testid="pw-recovery-code">{kit.recoveryCode}</div>
        <p className="pw-kit-note">If you forget your master password, it lets you set a new one.</p>
      </div>
      <button type="button" className="pw-btn pw-btn-block" onClick={() => downloadRecoveryKit(kit)}>Download recovery kit</button>
      <label className="pw-check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I saved my recovery kit somewhere safe, away from this computer.
      </label>
      {error && <div className="pw-hint pw-hint-bad" role="alert">{error}</div>}
      <button type="button" className="pw-btn pw-btn-primary pw-btn-block" disabled={!saved || busy} onClick={() => void confirm()}>{confirmLabel}</button>
    </div>
  )
}

/** The recovery kit as a screen of its own: after setup and after a recovery. */
export function KitScreen({ kit, title, sub, onDone }: { kit: RecoveryKit; title: string; sub: string; onDone: () => void }) {
  return (
    <div className="pw-gate">
      <div className="pw-gate-card pw-gate-wide" data-testid="pw-kit">
        <div className="pw-gate-icon"><KeyIcon size={30} /></div>
        <h1>{title}</h1>
        <p className="pw-gate-sub">{sub}</p>
        <RecoveryKitCard kit={kit} confirmLabel="Open Passwords" onConfirmed={onDone} />
      </div>
    </div>
  )
}

/** A new master password, typed twice, with the strength meter. */
function NewPasswordFields({ pw, pw2, setPw, setPw2, idPrefix, autoFocus }: { pw: string; pw2: string; setPw: (v: string) => void; setPw2: (v: string) => void; idPrefix: string; autoFocus?: boolean }) {
  const strength = passwordStrength(pw)
  const strongEnough = pw.length >= 10 && LEVEL_STEP[strength.level] >= 3
  return (
    <>
      <label className="pw-field-label" htmlFor={`${idPrefix}-1`}>{idPrefix === 'pw-setup' ? 'Master password' : 'New master password'}</label>
      <input data-no-draft="secret" id={`${idPrefix}-1`} className="pw-input" type="password" autoComplete="new-password" autoFocus={autoFocus} value={pw} onChange={(e) => setPw(e.target.value)} />
      <StrengthMeter password={pw} />
      <label className="pw-field-label" htmlFor={`${idPrefix}-2`}>{idPrefix === 'pw-setup' ? 'Confirm master password' : 'Confirm new master password'}</label>
      <input data-no-draft="secret" id={`${idPrefix}-2`} className="pw-input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      {pw2 && pw !== pw2 && <div className="pw-hint pw-hint-bad">The two passwords differ.</div>}
      {pw && !strongEnough && <div className="pw-hint">At least 10 characters and Fair or better.</div>}
    </>
  )
}

function newPasswordOk(pw: string, pw2: string): boolean {
  return pw.length >= 10 && LEVEL_STEP[passwordStrength(pw).level] >= 3 && pw === pw2
}

/** A kit to show, with its words; the app shows it above everything until it is confirmed. */
export interface KitToShow { kit: RecoveryKit; title: string; sub: string }

const KIT_SUB = 'Keep it on paper or in a safe place, away from this computer. The recovery code opens your vault if you forget your master password, so guard the kit like a house key.'

export function SetupFlow({ onKit }: { onKit: (k: KitToShow) => void }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ok = newPasswordOk(pw, pw2) && !hintError(hint, pw)

  const create = async () => {
    if (!ok) return
    setBusy(true); setError('')
    try {
      const r = await vaultApi.setup(pw, hint.trim())
      setPw(''); setPw2(''); setHint('')
      onKit({ kit: r, title: 'Save your recovery kit', sub: KIT_SUB })
      log.info('passwords', 'vault set up', {})
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pw-gate">
      <form className="pw-gate-card" onSubmit={(e) => { e.preventDefault(); void create() }}>
        <div className="pw-gate-icon"><KeyIcon size={30} /></div>
        <h1>Set up Passwords</h1>
        <p className="pw-gate-sub">Your logins, codes and keys, encrypted on the computer Walnut runs on. Pick a master password you can remember; a few random words work well.</p>
        <NewPasswordFields pw={pw} pw2={pw2} setPw={setPw} setPw2={setPw2} idPrefix="pw-setup" autoFocus />
        <HintInput id="pw-setup-hint" value={hint} onChange={setHint} password={pw} />
        {error && <div className="pw-hint pw-hint-bad" role="alert">{error}</div>}
        <button type="submit" className="pw-btn pw-btn-primary pw-btn-block" disabled={!ok || busy}>{busy ? 'Creating…' : 'Create vault'}</button>
      </form>
    </div>
  )
}

/** A wait the server asked for (too many wrong tries), counted down. */
function useWait(initialMs: number) {
  const [waitUntil, setWaitUntil] = useState(initialMs > 0 ? Date.now() + initialMs : 0)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!waitUntil) return
    const t = window.setInterval(() => { if (Date.now() >= waitUntil) setWaitUntil(0); tick((n) => n + 1) }, 1000)
    return () => window.clearInterval(t)
  }, [waitUntil])
  const waitS = waitUntil ? Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000)) : 0
  return { waitS, slowFor: (ms: number) => setWaitUntil(Date.now() + ms) }
}

export function UnlockScreen({ status, onUnlocked, onKit }: { status: VaultStatus; onUnlocked: () => void; onKit: (k: KitToShow) => void }) {
  const [mode, setMode] = useState<'unlock' | 'recover'>('unlock')
  const [pw, setPw] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [needKey, setNeedKey] = useState(!status.hasSecretKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // A wrong password shows the hint at once.
  const [wrong, setWrong] = useState(false)
  const { waitS, slowFor } = useWait(status.waitMs)
  const input = useRef<HTMLInputElement>(null)
  const unlock = async () => {
    if (!pw || busy) return
    setBusy(true); setError('')
    try {
      await vaultApi.unlock(pw, status.kdf, needKey ? secretKey : undefined)
      setPw(''); setSecretKey('')
      onUnlocked()
    } catch (err) {
      if (err instanceof VaultApiError && err.code === 'secret_key_needed') setNeedKey(true)
      if (err instanceof VaultApiError && err.code === 'unlock_slowed' && err.waitMs) slowFor(err.waitMs)
      if (err instanceof VaultApiError && err.code === 'wrong_password') setWrong(true)
      setError(errorText(err))
      setPw('')
      input.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'recover') return <RecoverFlow status={status} onBack={() => setMode('unlock')} onKit={onKit} />

  return (
    <div className="pw-gate">
      <form className="pw-gate-card" onSubmit={(e) => { e.preventDefault(); void unlock() }} data-testid="pw-unlock">
        <div className="pw-gate-icon pw-gate-icon-lock"><LockIcon size={28} /></div>
        <h1>Passwords are locked</h1>
        <p className="pw-gate-sub">Enter your master password to unlock{status.itemCount ? ` ${status.itemCount} items` : ''}.</p>
        <input data-no-draft="secret" ref={input} className="pw-input pw-input-big" type="password" autoComplete="current-password" autoFocus placeholder="Master password" aria-label="Master password"
          value={pw} onChange={(e) => setPw(e.target.value)} disabled={waitS > 0} />
        <ShowHint hint={status.hint} open={wrong} />
        {needKey && (
          <>
            <label className="pw-field-label" htmlFor="pw-sk">Secret Key (from your recovery kit)</label>
            <input data-no-draft="secret" id="pw-sk" className="pw-input pw-mono" autoComplete="off" spellCheck={false} placeholder="W1-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} />
          </>
        )}
        {error && <div className="pw-hint pw-hint-bad" role="alert">{waitS > 0 ? `Too many wrong tries. Try again in ${waitS} s.` : error}</div>}
        <button type="submit" className="pw-btn pw-btn-primary pw-btn-block" disabled={!pw || busy || waitS > 0 || (needKey && !secretKey)}>{busy ? 'Unlocking…' : 'Unlock'}</button>
        <button type="button" className="pw-link-btn" onClick={() => { setError(''); setMode('recover') }}>Forgot master password?</button>
        <p className="pw-gate-foot">{unlockFootText(status)}</p>
      </form>
    </div>
  )
}

/** A forgotten master password: the recovery code from the kit sets a new one. */
function RecoverFlow({ status, onBack, onKit }: { status: VaultStatus; onBack: () => void; onKit: (k: KitToShow) => void }) {
  const [code, setCode] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [needKey, setNeedKey] = useState(!status.hasSecretKey)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { waitS, slowFor } = useWait(status.waitMs)
  const ok = !!code.trim() && newPasswordOk(pw, pw2) && (!needKey || !!secretKey.trim()) && !hintError(hint, pw)

  const recover = async () => {
    if (!ok || busy) return
    setBusy(true); setError('')
    try {
      const r = await vaultApi.recover(code.trim(), pw, needKey ? secretKey.trim() : undefined, hint.trim())
      setCode(''); setSecretKey(''); setPw(''); setPw2(''); setHint('')
      onKit({ kit: r, title: 'Save your new recovery kit', sub: 'Your master password is set and every other window was locked. The old recovery code no longer works: save this new kit and throw the old one away.' })
      log.info('passwords', 'master password reset with the recovery code', {})
    } catch (err) {
      if (err instanceof VaultApiError && err.code === 'secret_key_needed') setNeedKey(true)
      if (err instanceof VaultApiError && err.code === 'unlock_slowed' && err.waitMs) slowFor(err.waitMs)
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (status.hasRecovery === false) {
    return (
      <div className="pw-gate">
        <div className="pw-gate-card" data-testid="pw-recover">
          <div className="pw-gate-icon pw-gate-icon-lock"><LockIcon size={28} /></div>
          <h1>No recovery code yet</h1>
          <p className="pw-gate-sub">This vault was set up before recovery codes, so only the master password opens it. Once you are in, make a recovery kit in Settings, Passwords.</p>
          <button type="button" className="pw-btn pw-btn-primary pw-btn-block" onClick={onBack}>Back to unlock</button>
        </div>
      </div>
    )
  }

  return (
    <div className="pw-gate">
      <form className="pw-gate-card" onSubmit={(e) => { e.preventDefault(); void recover() }} data-testid="pw-recover">
        <div className="pw-gate-icon pw-gate-icon-lock"><KeyIcon size={28} /></div>
        <h1>Set a new master password</h1>
        <p className="pw-gate-sub">Enter the recovery code from your recovery kit. Your items stay as they are.</p>
        <label className="pw-field-label" htmlFor="pw-rc">Recovery code</label>
        <input data-no-draft="secret" id="pw-rc" className="pw-input pw-mono" autoComplete="off" spellCheck={false} autoFocus placeholder="R1-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX" value={code} onChange={(e) => setCode(e.target.value)} />
        {needKey && (
          <>
            <label className="pw-field-label" htmlFor="pw-rsk">Secret Key (from the same kit)</label>
            <input data-no-draft="secret" id="pw-rsk" className="pw-input pw-mono" autoComplete="off" spellCheck={false} placeholder="W1-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} />
          </>
        )}
        <NewPasswordFields pw={pw} pw2={pw2} setPw={setPw} setPw2={setPw2} idPrefix="pw-recover" />
        <HintInput id="pw-recover-hint" value={hint} onChange={setHint} password={pw} />
        {error && <div className="pw-hint pw-hint-bad" role="alert">{waitS > 0 ? `Too many wrong tries. Try again in ${waitS} s.` : error}</div>}
        <button type="submit" className="pw-btn pw-btn-primary pw-btn-block" disabled={!ok || busy || waitS > 0}>{busy ? 'Checking…' : 'Set new master password'}</button>
        <button type="button" className="pw-link-btn" onClick={onBack}>Back to unlock</button>
      </form>
    </div>
  )
}

export function downloadRecoveryKit(kit: RecoveryKit): void {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  const when = new Date().toLocaleString()
  const html = `<!doctype html><meta charset="utf-8"><title>Walnut Passwords recovery kit</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;max-width:640px;margin:40px auto;color:#1d1d1f}h1{font-size:24px}.k{font:20px ui-monospace,Menlo,monospace;letter-spacing:1px;padding:14px 18px;border:2px solid #1d1d1f;border-radius:10px;margin:12px 0}.box{border:1px dashed #999;border-radius:10px;height:56px;margin:8px 0}small{color:#666}</style>
<h1>Walnut Passwords recovery kit</h1>
<p>Made ${esc(when)} on ${esc(location.host)}.</p>
<h3>Secret Key</h3><div class="k">${esc(kit.secretKey)}</div>
<small>With your master password, it opens your vault on a new machine or from a backup.</small>
<h3>Recovery code</h3><div class="k">${esc(kit.recoveryCode)}</div>
<small>Forgot your master password? In Passwords, choose "Forgot master password?" and enter this code to set a new one. Each code works once; Walnut then gives you a new kit.</small>
<h3>Master password</h3><div class="box"></div><small>Write it here by hand only if this paper is kept somewhere safe.</small>
<p>Anyone holding this kit can open your vault on the machine that holds it. Print it or keep it in a safe place, away from this computer. A newer kit replaces this one: its recovery code then stops working.</p>`
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'Walnut-Passwords-Recovery-Kit.html'
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
